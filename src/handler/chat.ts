/**
 * 对话处理：会话管理、占位消息、prompt 发送、轮询等待、最终回复
 */
import type { FeishuMessageContext, ResolvedConfig, LogFn } from "../types.js"
import type { OpencodeClient } from "@opencode-ai/sdk"
import * as sender from "../feishu/sender.js"
import {
  registerPending, unregisterPending,
  getSessionError, clearSessionError,
  clearRetryAttempts, getRetryAttempts, setRetryAttempts, MAX_RETRY_ATTEMPTS,
  isModelError,
  type CachedSessionError,
} from "./event.js"
import { buildSessionKey, getOrCreateSession } from "../session.js"
import { extractParts, type PromptPart } from "../feishu/content-extractor.js"
import type * as Lark from "@larksuiteoapi/node-sdk"

/** 每个会话的活跃自动提示循环，用于用户介入时中断 */
const activeAutoPrompts = new Map<string, AbortController>()

export interface ChatDeps {
  config: ResolvedConfig
  client: OpencodeClient
  feishuClient: InstanceType<typeof Lark.Client>
  log: LogFn
  directory: string
}

export async function handleChat(ctx: FeishuMessageContext, deps: ChatDeps, signal?: AbortSignal): Promise<void> {
  const { content, chatId, chatType, senderId, shouldReply, messageType, rawContent, messageId } = ctx
  if (!content.trim() && messageType === "text") return

  const { config, client, feishuClient, log, directory } = deps
  const query = directory ? { directory } : undefined

  const sessionKey = buildSessionKey(chatType, chatType === "p2p" ? senderId : chatId)

  // 用户发新消息时中断该会话的自动提示循环
  const existing = activeAutoPrompts.get(sessionKey)
  if (existing) {
    existing.abort()
    activeAutoPrompts.delete(sessionKey)
    log("info", "用户介入，自动提示已中断", { sessionKey: sessionKey })
  }

  const session = await getOrCreateSession(client, sessionKey, directory)

  // 提取消息内容为 OpenCode parts
  const parts = await buildPromptParts(feishuClient, messageId, messageType, rawContent, content, chatType, senderId, log)
  if (!parts.length) return

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
    return
  }

  const timeout = config.timeout
  const thinkingDelay = config.thinkingDelay
  const pollInterval = config.pollInterval
  const stablePolls = config.stablePolls

  let placeholderId = ""
  let done = false
  let activeSessionId = session.id
  const timer =
    thinkingDelay > 0
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

  /** 自动提示循环：响应完成后自动发送"继续"推动 OpenCode 持续工作 */
  async function runAutoPromptLoop(activeId: string): Promise<void> {
    const { autoPrompt } = config
    if (!autoPrompt.enabled || !shouldReply) return

    const ac = new AbortController()
    activeAutoPrompts.set(sessionKey, ac)
    log("info", "启动自动提示循环", { sessionKey, maxIterations: autoPrompt.maxIterations })

    try {
      for (let i = 0; i < autoPrompt.maxIterations; i++) {
        await abortableSleep(autoPrompt.intervalSeconds * 1000, ac.signal)

        log("info", "发送自动提示", { sessionKey, iteration: i + 1 })

        clearSessionError(activeId)
        await client.session.prompt({
          path: { id: activeId },
          query,
          body: { parts: [{ type: "text", text: autoPrompt.message }] },
        })

        const text = await pollForResponse(client, activeId, { timeout, pollInterval, stablePolls, query, signal: ac.signal })
        if (text) {
          log("info", "自动提示响应", {
            sessionKey,
            iteration: i + 1,
            output: text,
          })
          await sender.sendTextMessage(feishuClient, chatId, text)
        }
      }

      log("info", "自动提示循环结束（达到最大次数）", { sessionKey: sessionKey })
    } catch (loopErr) {
      if ((loopErr as Error).name === "AbortError") {
        log("info", "自动提示循环被中断", { sessionKey: sessionKey })
      } else {
        log("error", "自动提示循环异常", {
          sessionKey,
          error: loopErr instanceof Error ? loopErr.message : String(loopErr),
        })
      }
    } finally {
      activeAutoPrompts.delete(sessionKey)
    }
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

    await replyOrUpdate(feishuClient, chatId, placeholderId, finalText || "⚠️ 响应超时")

    await runAutoPromptLoop(session.id)
  } catch (err) {
    // AbortError = 被新消息中断，清理占位消息后静默退出
    if (err instanceof Error && err.name === "AbortError") {
      log("info", "处理被中断", { sessionKey, sessionId: session.id })
      if (placeholderId) {
        await sender.deleteMessage(feishuClient, placeholderId).catch(() => {})
      }
      return
    }

    // pollForResponse 检测到 SSE 错误时直接携带 sessionError
    let sessionError: CachedSessionError | undefined
    if (err instanceof SessionErrorDetected) {
      sessionError = err.sessionError
      clearSessionError(session.id)
    } else {
      // promptAsync 的 HTTP 级错误（400/404），检查是否有 SSE 错误
      sessionError = getSessionError(session.id)
      clearSessionError(session.id)
    }

    if (sessionError) {
      log("info", "错误字段检查", {
        sessionKey,
        fields: sessionError.fields,
        isModel: isModelError(sessionError.fields),
      })
    }

    // 模型不兼容错误：用可用模型重试
    if (sessionError && isModelError(sessionError.fields)) {
      const attempts = getRetryAttempts(sessionKey)
      if (attempts < MAX_RETRY_ATTEMPTS) {
        try {
          let modelOverride: { providerID: string; modelID: string } | undefined
          try {
            modelOverride = await getGlobalDefaultModel(client, directory)
          } catch (configErr) {
            log("warn", "读取全局模型配置失败", {
              sessionKey,
              error: configErr instanceof Error ? configErr.message : String(configErr),
            })
          }
          if (!modelOverride) {
            log("warn", "全局默认模型未配置，放弃恢复", { sessionKey })
          } else {
            setRetryAttempts(sessionKey, attempts + 1)
            log("info", "使用全局默认模型恢复", {
              sessionKey,
              providerID: modelOverride.providerID,
              modelID: modelOverride.modelID,
            })

            clearSessionError(session.id)
            await client.session.promptAsync({
              path: { id: session.id },
              query,
              body: { ...baseBody, model: modelOverride },
            })

            const finalText = await pollForResponse(client, session.id, { timeout, pollInterval, stablePolls, query, signal })

            log("info", "模型恢复后响应完成", {
              sessionKey,
              sessionId: session.id,
              output: finalText || "(empty)",
            })

            clearRetryAttempts(sessionKey)
            await replyOrUpdate(feishuClient, chatId, placeholderId, finalText || "⚠️ 响应超时")

            log("info", "模型不兼容恢复成功", {
              sessionId: session.id,
              sessionKey,
              model: `${modelOverride.providerID}/${modelOverride.modelID}`,
              attempt: attempts + 1,
            })

            await runAutoPromptLoop(session.id)
            return
          }
        } catch (recoveryErr) {
          // AbortError during recovery = interrupted
          if (recoveryErr instanceof Error && recoveryErr.name === "AbortError") {
            log("info", "模型恢复被中断", { sessionKey })
            return
          }

          const errMsg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)
          if (recoveryErr instanceof SessionErrorDetected) {
            sessionError = recoveryErr.sessionError
            clearSessionError(session.id)
          } else {
            const sseError = getSessionError(session.id)
            if (sseError) {
              sessionError = sseError
              clearSessionError(session.id)
            } else {
              sessionError = { message: errMsg, fields: [] }
            }
          }
          log("error", "模型恢复失败", {
            sessionId: session.id,
            sessionKey,
            error: errMsg,
          })
        }
      } else {
        log("warn", "已达重试上限，放弃恢复", {
          sessionKey,
          attempts,
        })
      }
    }

    // 正常错误处理
    const thrownError = err instanceof Error ? err.message : String(err)
    const errorMessage = sessionError?.message || thrownError

    log("error", "对话处理失败", {
      sessionId: session.id,
      sessionKey,
      chatType,
      error: thrownError,
      ...(sessionError
        ? { sessionError: sessionError.message }
        : {}),
    })
    const msg = "❌ " + errorMessage
    await replyOrUpdate(feishuClient, chatId, placeholderId, msg)
  } finally {
    done = true
    if (timer) clearTimeout(timer)
    unregisterPending(activeSessionId)
  }
}

/**
 * 从全局配置读取默认模型（Config.model 字段），解析为 { providerID, modelID }。
 * 不在失败 provider 内搜索替代 — 只用用户明确配置的默认模型。
 */
async function getGlobalDefaultModel(
  client: OpencodeClient,
  directory?: string,
): Promise<{ providerID: string; modelID: string } | undefined> {
  const query = directory ? { directory } : undefined
  const { data: config } = await client.config.get({ query })
  const model = config?.model
  if (!model || !model.includes("/")) return undefined
  const slash = model.indexOf("/")
  const providerID = model.slice(0, slash).trim()
  const modelID = model.slice(slash + 1).trim()
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
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

/** pollForResponse 检测到 SSE 错误时抛出的异常 */
class SessionErrorDetected extends Error {
  constructor(public readonly sessionError: CachedSessionError) {
    super(sessionError.message)
    this.name = "SessionErrorDetected"
  }
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

/**
 * 可被 AbortSignal 中断的 sleep
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
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
