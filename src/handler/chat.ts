/**
 * 对话处理：会话管理、占位消息、prompt 发送、轮询等待、最终回复
 */
import type { FeishuMessageContext, ResolvedConfig, LogFn } from "../types.js"
import type { OpencodeClient } from "@opencode-ai/sdk"
import * as sender from "../feishu/sender.js"
import {
  registerPending, unregisterPending,
  getSessionError, clearSessionError, clearRetryAttempts,
} from "./event.js"
import { SessionErrorDetected, extractSessionError, tryModelRecovery } from "./error-recovery.js"
import { buildSessionKey, getOrCreateSession } from "../session.js"
import { registerSessionChat } from "../feishu/session-chat-map.js"
import { extractParts, type PromptPart } from "../feishu/content-extractor.js"
import type * as Lark from "@larksuiteoapi/node-sdk"
import { subscribe } from "./action-bus.js"
import type { CardKitClient } from "../feishu/cardkit.js"
import { StreamingCard } from "../feishu/streaming-card.js"
import { handlePermissionRequested, handleQuestionRequested, type InteractiveDeps } from "./interactive.js"

export interface AutoPromptContext {
  readonly sessionId: string
  readonly sessionKey: string
  readonly chatId: string
  readonly deps: ChatDeps
}

export interface ChatDeps {
  config: ResolvedConfig
  client: OpencodeClient
  feishuClient: InstanceType<typeof Lark.Client>
  log: LogFn
  directory: string
  cardkit?: CardKitClient
  interactiveDeps?: InteractiveDeps
}

/** 最终回复：关闭流式卡片或更新占位消息 */
async function finalizeReply(
  streamingCard: StreamingCard | undefined,
  feishuClient: InstanceType<typeof Lark.Client>,
  chatId: string,
  placeholderId: string,
  text: string,
): Promise<void> {
  if (streamingCard) {
    await streamingCard.close(text)
  } else {
    await replyOrUpdate(feishuClient, chatId, placeholderId, text)
  }
}

/** 中断清理：删除流式卡片或占位消息 */
async function abortCleanup(
  streamingCard: StreamingCard | undefined,
  feishuClient: InstanceType<typeof Lark.Client>,
  placeholderId: string,
): Promise<void> {
  if (streamingCard) {
    await streamingCard.destroy()
  } else if (placeholderId) {
    await sender.deleteMessage(feishuClient, placeholderId).catch(() => {})
  }
}

export async function handleChat(ctx: FeishuMessageContext, deps: ChatDeps, signal?: AbortSignal): Promise<AutoPromptContext | undefined> {
  const { content, chatId, chatType, senderId, shouldReply, messageType, rawContent, messageId } = ctx
  if (!content.trim() && messageType === "text") return undefined

  const { config, client, feishuClient, log, directory } = deps
  const query = directory ? { directory } : undefined

  const sessionKey = buildSessionKey(chatType, chatType === "p2p" ? senderId : chatId)

  const session = await getOrCreateSession(client, sessionKey, directory)
  registerSessionChat(session.id, chatId, chatType)

  // 提取消息内容为 OpenCode parts
  const parts = await buildPromptParts(feishuClient, messageId, messageType, rawContent, content, chatType, senderId, log)
  if (!parts.length) return undefined

  log("info", "收到用户消息", {
    sessionKey,
    sessionId: session.id,
    chatType,
    senderId,
    messageType,
    shouldReply,
    content,
    parts,
  })

  const baseBody = { parts }

  // 静默监听模式：消息发给 OpenCode 作为上下文，不触发 AI 回复
  if (!shouldReply) {
    try {
      await client.session.promptAsync({
        path: { id: session.id },
        query,
        body: { ...baseBody, noReply: true },
      })
    } catch (err) {
      log("warn", "静默转发失败", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return undefined
  }

  const timeout = config.timeout
  const thinkingDelay = config.thinkingDelay
  const pollInterval = config.pollInterval
  const stablePolls = config.stablePolls

  let placeholderId = ""
  let done = false
  let activeSessionId = session.id
  let streamingCard: StreamingCard | undefined

  // 尝试创建流式卡片（fallback 到纯文本占位）
  if (thinkingDelay > 0 && deps.cardkit) {
    try {
      streamingCard = new StreamingCard(deps.cardkit, feishuClient, chatId, log)
      placeholderId = await streamingCard.start()
    } catch (err) {
      log("warn", "CardKit 创建失败，回退纯文本", {
        error: err instanceof Error ? err.message : String(err),
      })
      // 清理可能部分创建的卡片资源
      if (streamingCard) {
        await streamingCard.destroy().catch(() => {})
      }
      streamingCard = undefined
    }
  }

  // 如果没有流式卡片，使用传统占位消息
  const timer =
    !streamingCard && thinkingDelay > 0
      ? setTimeout(async () => {
          if (done) return
          try {
            const res = await sender.sendTextMessage(feishuClient, chatId, "正在思考…")
            if (done) return // 重新检查，防止发送期间主流程已结束
            if (res.ok && res.messageId) {
              placeholderId = res.messageId
              registerPending(activeSessionId, { chatId, placeholderId, feishuClient })
            }
          } catch (err) {
            log("warn", "发送占位消息失败", {
              chatId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }, thinkingDelay)
      : null

  // 订阅 action-bus 更新流式卡片 + 交互式卡片分发
  let cardUnsub: (() => void) | undefined
  {
    const card = streamingCard
    cardUnsub = subscribe(activeSessionId, (action) => {
      switch (action.type) {
        case "text-updated":
          if (card) {
            if (action.delta) {
              card.updateText(action.delta)
            } else if (action.fullText) {
              // snapshot-style 事件：用 fullText 替换整个 buffer
              card.replaceText(action.fullText)
            }
          }
          break
        case "tool-state-changed":
          if (card) card.setToolStatus(action.callID, action.tool, action.state)
          break
        case "permission-requested":
          if (deps.interactiveDeps) {
            handlePermissionRequested(action.request, chatId, deps.interactiveDeps, chatType)
          }
          break
        case "question-requested":
          if (deps.interactiveDeps) {
            handleQuestionRequested(action.request, chatId, deps.interactiveDeps, chatType)
          }
          break
      }
    })
  }

  try {
    // 清除前次遗留的 session error 缓存，避免 pollForResponse 误检测旧错误
    clearSessionError(session.id)

    await client.session.promptAsync({
      path: { id: session.id },
      query,
      body: baseBody,
    })

    const finalText = await pollForResponse(client, session.id, { timeout, pollInterval, stablePolls, query, signal })

    log("info", "模型响应完成", {
      sessionKey,
      sessionId: session.id,
      output: finalText || "(empty)",
    })

    // prompt 成功：重置 fork 计数
    clearRetryAttempts(sessionKey)

    await finalizeReply(streamingCard, feishuClient, chatId, placeholderId, finalText || "⚠️ 响应超时")

    if (config.autoPrompt.enabled && shouldReply) {
      return { sessionId: session.id, sessionKey, chatId, deps }
    }
    return undefined
  } catch (err) {
    // AbortError = 被新消息中断，清理占位消息后静默退出
    if (err instanceof Error && err.name === "AbortError") {
      log("info", "处理被中断", { sessionKey, sessionId: session.id })
      await abortCleanup(streamingCard, feishuClient, placeholderId)
      return undefined
    }

    // 提取会话错误信息（来自 SessionErrorDetected 或 SSE 缓存）
    const sessionError = extractSessionError(err, session.id)
    let displayError = sessionError

    // 模型不兼容错误恢复
    if (sessionError) {
      try {
        const recovery = await tryModelRecovery({
          sessionError, sessionId: session.id, sessionKey, client, directory,
          parts, timeout, pollInterval, stablePolls, query, signal, log,
          poll: pollForResponse,
        })

        if (recovery.recovered) {
          await finalizeReply(streamingCard, feishuClient, chatId, placeholderId, recovery.text || "⚠️ 响应超时")
          if (config.autoPrompt.enabled && shouldReply) {
            return { sessionId: session.id, sessionKey, chatId, deps }
          }
          return undefined
        }
        displayError = recovery.sessionError
      } catch (abortErr) {
        if (abortErr instanceof Error && abortErr.name === "AbortError") {
          log("info", "模型恢复被中断", { sessionKey })
          await abortCleanup(streamingCard, feishuClient, placeholderId)
          return undefined
        }
        throw abortErr
      }
    }

    // 正常错误处理
    const thrownError = err instanceof Error ? err.message : String(err)
    const errorMessage = displayError?.message || thrownError
    log("error", "对话处理失败", {
      sessionId: session.id, sessionKey, chatType,
      error: thrownError,
      ...(displayError ? { sessionError: displayError.message } : {}),
    })
    await finalizeReply(streamingCard, feishuClient, chatId, placeholderId, "❌ " + errorMessage)
  } finally {
    done = true
    if (timer) clearTimeout(timer)
    if (cardUnsub) cardUnsub()
    unregisterPending(activeSessionId)
  }
}

/**
 * 将飞书消息转换为 OpenCode prompt parts
 * 文本类型添加群聊发送者前缀；其他类型通过 content-extractor 提取
 */
async function buildPromptParts(
  feishuClient: InstanceType<typeof Lark.Client>,
  messageId: string,
  messageType: string,
  rawContent: string,
  textContent: string,
  chatType: "p2p" | "group",
  senderId: string,
  log: LogFn,
): Promise<PromptPart[]> {
  if (messageType === "text") {
    // 文本消息：沿用原有逻辑，群聊添加发送者前缀
    let promptText = textContent
    if (chatType === "group" && senderId) {
      promptText = `[${senderId}]: ${textContent}`
    }
    return [{ type: "text", text: promptText }]
  }

  // 非文本消息：通过 content-extractor 提取
  const parts = await extractParts(feishuClient, messageId, messageType, rawContent, log)

  // 群聊非文本消息：在 parts 前添加发送者前缀
  if (chatType === "group" && senderId && parts.length > 0) {
    return [{ type: "text", text: `[${senderId}]:` }, ...parts]
  }

  return parts
}

/**
 * 轮询等待 AI 响应稳定，返回最终文本。
 * 每次 poll 周期检查 SSE 缓存的 session error，检测到时立即终止并抛出异常。
 */
async function pollForResponse(
  client: OpencodeClient,
  sessionId: string,
  opts: {
    timeout: number
    pollInterval: number
    stablePolls: number
    query?: { directory: string }
    signal?: AbortSignal
  },
): Promise<string> {
  const { timeout, pollInterval, stablePolls, query, signal } = opts
  const start = Date.now()
  let lastText = ""
  let sameCount = 0

  let sessionIdle = false
  const unsub = subscribe(sessionId, (action) => {
    if (action.type === "session-idle") {
      sessionIdle = true
    }
  })

  try {
    while (Date.now() - start < timeout) {
      if (signal) {
        await abortableSleep(pollInterval, signal)
      } else {
        await new Promise((r) => setTimeout(r, pollInterval))
      }

      // 检查 SSE 缓存的 session error（FR-001）
      const sseError = getSessionError(sessionId)
      if (sseError) {
        throw new SessionErrorDetected(sseError)
      }

      // session.idle 提前退出：收到信号后最后 fetch 一次
      if (sessionIdle) {
        break
      }

      const { data: messages } = await client.session.messages({ path: { id: sessionId }, query })
      const text = extractLastAssistantText(messages ?? [])

      if (text && text !== lastText) {
        lastText = text
        sameCount = 0
      } else if (text && text.length > 0) {
        sameCount++
        if (sameCount >= stablePolls) break
      }
    }

    // 返回前再次检查 SSE 错误，防止 break 后遗漏的竞态错误
    const finalSseError = getSessionError(sessionId)
    if (finalSseError) {
      throw new SessionErrorDetected(finalSseError)
    }

    const { data: finalMessages } = await client.session.messages({ path: { id: sessionId }, query })
    return extractLastAssistantText(finalMessages ?? []) || lastText
  } finally {
    unsub()
  }
}

async function replyOrUpdate(
  feishuClient: InstanceType<typeof Lark.Client>,
  chatId: string,
  placeholderId: string,
  text: string,
): Promise<void> {
  if (placeholderId) {
    const res = await sender.updateMessage(feishuClient, placeholderId, text)
    if (!res.ok) {
      await sender.sendTextMessage(feishuClient, chatId, text)
    }
  } else {
    await sender.sendTextMessage(feishuClient, chatId, text)
  }
}

const idlePatterns = [
  /^(无|没有)(任务|变化|进行中)/,
  /空闲|闲置|等待(指令|中|新|你)/,
  /随时可(开始|开始新)/,
  /等你指令/,
]

/**
 * 检测 AI 响应文本是否表示空闲状态（无进行中任务）
 */
export function isIdleResponse(text: string, maxLength: number = 50): boolean {
  if (text.length >= maxLength) return false
  return idlePatterns.some(p => p.test(text))
}

/**
 * 执行一轮自动提示迭代：发送提示、等待响应、发送到飞书（空闲响应不发送）
 */
export async function runOneAutoPromptIteration(
  apCtx: AutoPromptContext,
  iteration: number,
  signal?: AbortSignal,
): Promise<{ text: string | null; isIdle: boolean }> {
  const { sessionId, chatId, deps } = apCtx
  const { config, client, feishuClient, log, directory } = deps
  const query = directory ? { directory } : undefined
  const { autoPrompt, timeout, pollInterval, stablePolls } = config

  log("info", "发送自动提示", { sessionKey: apCtx.sessionKey, iteration })

  clearSessionError(sessionId)
  await client.session.promptAsync({
    path: { id: sessionId },
    query,
    body: { parts: [{ type: "text", text: autoPrompt.message }] },
  })

  const text = await pollForResponse(client, sessionId, {
    timeout, pollInterval, stablePolls, query, signal,
  })

  if (!text) return { text: null, isIdle: false }

  const idle = isIdleResponse(text, autoPrompt.idleMaxLength)
  if (!idle) {
    log("info", "自动提示响应", { sessionKey: apCtx.sessionKey, iteration, output: text })
    await sender.sendTextMessage(feishuClient, chatId, text)
  }

  return { text, isIdle: idle }
}

/**
 * 可被 AbortSignal 中断的 sleep
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const onDone = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      onDone()
      reject(new DOMException("Aborted", "AbortError"))
    }
    const timer = setTimeout(() => {
      onDone()
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function extractLastAssistantText(
  messages: Array<{
    info: { role?: string; [key: string]: unknown }
    parts: Array<{ type?: string; text?: string; [key: string]: unknown }>
  }>,
): string {
  const assistant = messages.filter((m) => m.info?.role === "assistant").pop()
  const parts = assistant?.parts ?? []
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim()
}
