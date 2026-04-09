/**
 * 对话主处理链路。
 *
 * 负责把一条飞书消息完整走完：
 * 1. 绑定/恢复 OpenCode session
 * 2. 构造 prompt parts
 * 3. 发送 prompt
 * 4. 轮询等待输出稳定
 * 5. 把结果写回飞书
 * 6. 在异常时做恢复或友好报错
 */
import type { FeishuMessageContext, ResolvedConfig, LogFn } from "../types.js"
import type { OpencodeClient } from "@opencode-ai/sdk"
import * as sender from "../feishu/sender.js"
import {
  registerPending, unregisterPending,
  getSessionError, clearSessionError, clearRetryAttempts,
  clearNudge, isSessionPoisoned,
} from "./event.js"
import { SessionErrorDetected, extractSessionError, tryModelRecovery } from "./error-recovery.js"
import { buildSessionKey, getOrCreateSession, invalidateSession } from "../session.js"
import { registerSessionChat } from "../feishu/session-chat-map.js"
import { extractParts, type PromptPart } from "../feishu/content-extractor.js"
import { resolveUserName } from "../feishu/user-name.js"
import { fetchQuotedMessage } from "../feishu/quote.js"
import type * as Lark from "@larksuiteoapi/node-sdk"
import { subscribe } from "./action-bus.js"
import type { CardKitClient } from "../feishu/cardkit.js"
import { StreamingCard } from "../feishu/streaming-card.js"
import { handlePermissionRequested, handleQuestionRequested, type InteractiveDeps } from "./interactive.js"

/**
 * 向 Langfuse 发送轻量 trace，关联 sessionId 和飞书 userId。
 * Fire-and-forget：不阻塞主流程，失败只记 error 日志。
 */
function traceLangfuseUser(
  sessionId: string,
  userId: string,
  log: LogFn,
): void {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  if (!publicKey || !secretKey) return

  const baseUrl = process.env.LANGFUSE_BASEURL ?? "https://cloud.langfuse.com"
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64")

  // 完全异步上报，绝不等待它完成。
  fetch(`${baseUrl}/api/public/ingestion`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      batch: [{
        type: "trace-create",
        timestamp: new Date().toISOString(),
        body: { name: "feishu-message", sessionId, userId },
      }],
    }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch((err) => {
        log("error", "读取 Langfuse 错误响应失败", {
          status: res.status,
          error: err instanceof Error ? err.message : String(err),
        })
        return ""
      })
      log("error", "Langfuse trace API 失败", { status: res.status, body })
    }
  }).catch((err) => {
    log("error", "Langfuse trace 网络失败", {
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

/**
 * 读取当前 OpenCode 配置中的模型名。
 *
 * 这是 UI 增强信息，不是主链路必需，因此读取失败只返回 `undefined`，
 * 同时留下 error 日志供排查。
 */
async function fetchModel(
  client: OpencodeClient,
  log: LogFn,
  query?: { directory?: string },
): Promise<string | undefined> {
  try {
    const cfg = await client.config.get({ query })
    const m = cfg?.data?.model
    return typeof m === "string" ? m : undefined
  } catch (err) {
    // 模型信息只影响卡片辅助展示，但异常仍要留下 error 日志。
    log("error", "读取当前模型配置失败", {
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

/** 对话处理所需的运行依赖。 */
export interface ChatDeps {
  config: ResolvedConfig
  client: OpencodeClient
  feishuClient: InstanceType<typeof Lark.Client>
  log: LogFn
  directory: string
  cardkit?: CardKitClient
  interactiveDeps?: InteractiveDeps
}

/**
 * 收尾回复：优先关闭流式卡片，否则回落到更新/发送普通文本消息。
 */
async function finalizeReply(
  streamingCard: StreamingCard | undefined,
  feishuClient: InstanceType<typeof Lark.Client>,
  chatId: string,
  placeholderId: string,
  text: string,
  log: LogFn,
): Promise<void> {
  if (streamingCard) {
    await streamingCard.close(text)
  } else {
    await replyOrUpdate(feishuClient, chatId, placeholderId, text, log)
  }
}

/**
 * 处理一条飞书消息。
 *
 * `signal` 主要供未来可中断队列或外部取消场景使用；
 * 当前最重要的是把它继续透传给轮询等待逻辑。
 */
export async function handleChat(ctx: FeishuMessageContext, deps: ChatDeps, signal?: AbortSignal): Promise<void> {
  const { content, chatId, chatType, senderId, shouldReply, messageType, rawContent, messageId, parentId } = ctx
  // 纯文本空消息没有任何处理价值，直接忽略。
  if (!content.trim() && messageType === "text") return undefined

  const { config, client, feishuClient, log, directory } = deps
  const query = directory ? { directory } : undefined

  // 同一飞书聊天会稳定映射到同一个逻辑 sessionKey。
  const sessionKey = buildSessionKey(chatType, chatType === "p2p" ? senderId : chatId)

  // 绑定或恢复 OpenCode session，并刷新 session → 飞书聊天映射。
  const session = await getOrCreateSession(client, sessionKey, directory)
  registerSessionChat(session.id, chatId, chatType)
  traceLangfuseUser(session.id, senderId, log)
  // 用户有新消息时，说明插件不该再沿用之前的 idle 催促计数。
  clearNudge(session.id)

  // 提取消息内容为 OpenCode parts
  const parts = await buildPromptParts(feishuClient, messageId, messageType, rawContent, content, chatType, senderId, log, config.maxResourceSize, parentId)
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

  // 静默监听模式：消息只作为上下文送入 OpenCode，不给用户看到任何回复。
  if (!shouldReply) {
    try {
      await client.session.promptAsync({
        path: { id: session.id },
        query,
        body: { ...baseBody, noReply: true },
      })
    } catch (err) {
      log("error", "静默转发失败", {
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
  // `done` 用于避免 thinking timer 在主流程已结束后再异步发出占位消息。
  let done = false
  let activeSessionId = session.id
  let streamingCard: StreamingCard | undefined

  // 优先尝试 CardKit 流式卡片；失败时自动降级到纯文本占位。
  if (thinkingDelay > 0 && deps.cardkit) {
    try {
      streamingCard = new StreamingCard(deps.cardkit, feishuClient, chatId, log, {
        sessionId: session.id,
        directory,
        model: await fetchModel(client, log, query),
      })
      placeholderId = await streamingCard.start()
    } catch (err) {
      log("error", "CardKit 创建失败，回退纯文本", {
        error: err instanceof Error ? err.message : String(err),
      })
      // 清理可能部分创建成功的卡片/消息资源。
      if (streamingCard) {
        await streamingCard.destroy().catch((destroyErr) => {
          log("error", "回退前清理 StreamingCard 失败", {
            error: destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
          })
        })
      }
      streamingCard = undefined
    }
  }

  // 如果没有流式卡片，则在 thinkingDelay 到达后发一条传统“正在思考…”消息。
  const timer =
    !streamingCard && thinkingDelay > 0
      ? setTimeout(async () => {
          if (done) return
          try {
            const res = await sender.sendTextMessage(feishuClient, chatId, "正在思考…", log)
            // 发送是异步的，返回后要再次确认主流程还没结束。
            if (done) return
            if (!res.ok) {
              log("error", "发送占位消息失败", {
                chatId,
                sessionId: activeSessionId,
                error: res.error ?? "unknown",
              })
              return
            }
            if (res.messageId) {
              placeholderId = res.messageId
              // 只有传统占位消息路径需要注册 pending，让 event.ts 直接更新飞书消息内容。
              registerPending(activeSessionId, { placeholderId, feishuClient })
            }
          } catch (err) {
            log("error", "发送占位消息失败", {
              chatId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }, thinkingDelay)
      : null

  // 订阅 action-bus：文本/工具更新驱动流式卡片，权限/问答事件驱动交互卡片。
  let cardUnsub: (() => void) | undefined
  {
    const card = streamingCard
    cardUnsub = subscribe(activeSessionId, async (action) => {
      switch (action.type) {
        case "text-updated":
          if (card) {
            if (action.delta) {
              await card.updateText(action.delta)
            } else if (action.fullText) {
              // snapshot-style 事件：用 fullText 替换整个 buffer
              await card.replaceText(action.fullText)
            }
          }
          break
        case "tool-state-changed":
          if (card) await card.setToolStatus(action.callID, action.tool, action.state)
          break
        case "permission-requested":
          if (deps.interactiveDeps) {
            // 权限请求本身不阻塞主回复；作为独立交互卡片发给用户。
            handlePermissionRequested(action.request, chatId, deps.interactiveDeps, chatType)
          }
          break
        case "question-requested":
          if (deps.interactiveDeps) {
            // 问答请求同理，交由交互层处理。
            handleQuestionRequested(action.request, chatId, deps.interactiveDeps, chatType)
          }
          break
      }
    })
  }

  try {
    // 清除前次遗留的 session error 缓存，避免 pollForResponse 误检测旧错误。
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

    // prompt 成功：清空该 sessionKey 的自动恢复计数。
    clearRetryAttempts(sessionKey)

    await finalizeReply(streamingCard, feishuClient, chatId, placeholderId, finalText || "⚠️ 响应超时", log)
  } catch (err) {
    // 提取会话错误信息（来自 SessionErrorDetected 或 SSE 缓存）
    const sessionError = extractSessionError(err, session.id)
    let displayError = sessionError

    // Session 历史中毒检测优先于模型恢复：这类问题靠重试几乎不会好。
    if (sessionError && isSessionPoisoned(sessionError.fields)) {
      log("warn", "检测到 session 历史数据中毒，创建新 session", {
        sessionKey, oldSessionId: session.id, error: sessionError.message,
      })
      invalidateSession(sessionKey)
      await finalizeReply(streamingCard, feishuClient, chatId, placeholderId,
        "⚠️ 会话历史包含不兼容数据，已自动重置。请重新发送消息。", log)
      return
    }

    // 只有拿到了结构化 sessionError，才尝试做模型错误恢复。
    if (sessionError) {
      try {
        const recovery = await tryModelRecovery({
          sessionError, sessionId: session.id, sessionKey, client, directory,
          parts, timeout, pollInterval, stablePolls, query, signal, log,
          poll: pollForResponse,
        })

        if (recovery.recovered) {
          await finalizeReply(streamingCard, feishuClient, chatId, placeholderId, recovery.text || "⚠️ 响应超时", log)
          return
        }
        displayError = recovery.sessionError
      } catch (abortErr) {
        throw abortErr
      }
    }

    // 普通错误路径：把最合适的错误文案展示给用户。
    const thrownError = err instanceof Error ? err.message : String(err)
    const errorMessage = displayError?.message || thrownError
    log("error", "对话处理失败", {
      sessionId: session.id, sessionKey, chatType,
      error: thrownError,
      ...(displayError ? { sessionError: displayError.message } : {}),
    })
    await finalizeReply(streamingCard, feishuClient, chatId, placeholderId, "❌ " + errorMessage, log)
  } finally {
    done = true
    // 无论成功失败，都要把延迟占位计时器、订阅和 pending 状态回收掉。
    if (timer) clearTimeout(timer)
    if (cardUnsub) cardUnsub()
    unregisterPending(activeSessionId)
  }
}

/**
 * 将飞书消息转换为 OpenCode prompt parts。
 *
 * 额外处理：
 * - 引用消息会作为前缀注入
 * - 群聊消息会补发送者名称，避免模型分不清谁说的
 * - 文本消息走轻路径，非文本消息交给 content-extractor 深度解析
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
  maxResourceSize: number,
  parentId?: string,
): Promise<PromptPart[]> {
  // 引用消息前缀。
  let quotePrefix = ""
  if (parentId) {
    const quoted = await fetchQuotedMessage(feishuClient, parentId, log)
    if (quoted) {
      quotePrefix = `[回复消息]: ${quoted}\n---\n`
    }
  }

  // 群聊：解析用户名，便于给模型更清晰的上下文。
  const senderName = (chatType === "group" && senderId)
    ? await resolveUserName(feishuClient, senderId, log)
    : ""

  if (messageType === "text") {
    let promptText = textContent
    if (senderName) {
      // 群聊文本消息前面补 `[用户名]:`，帮助模型区分多说话人场景。
      promptText = `[${senderName}]: ${textContent}`
    }
    return [{ type: "text", text: quotePrefix + promptText }]
  }

  // 非文本消息：交给更专门的 extractor 处理资源、富文本和卡片结构。
  const parts = await extractParts(feishuClient, messageId, messageType, rawContent, log, maxResourceSize)

  // 非文本消息如果也有引用或群聊用户名前缀，则在最前面插一个 text part。
  const prefix = [quotePrefix, senderName ? `[${senderName}]:` : ""].filter(Boolean).join("")
  if (prefix && parts.length > 0) {
    return [{ type: "text", text: prefix }, ...parts]
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
    timeout?: number
    pollInterval: number
    stablePolls: number
    query?: { directory: string }
    signal?: AbortSignal
  },
): Promise<string> {
  const { timeout, pollInterval, stablePolls, query, signal } = opts
  // 轮询开始时间，用于超时判断。
  const start = Date.now()
  // 最近一次看到的 assistant 文本。
  let lastText = ""
  // 连续多少次轮询结果完全相同。
  let sameCount = 0

  // 通过 action-bus 感知 `session.idle`，让轮询可以提前结束。
  let sessionIdle = false
  const unsub = subscribe(sessionId, (action) => {
    if (action.type === "session-idle") {
      sessionIdle = true
    }
  })

  try {
    while (!timeout || Date.now() - start < timeout) {
      if (signal) {
        // 可中断睡眠：外部 abort 时能立刻退出，不必等整个 pollInterval。
        await abortableSleep(pollInterval, signal)
      } else {
        await new Promise((r) => setTimeout(r, pollInterval))
      }

      // 每个轮询周期都先检查 SSE 错误，保证异步失败能尽早终止。
      const sseError = getSessionError(sessionId)
      if (sseError) {
        throw new SessionErrorDetected(sseError)
      }

      // session.idle 提前退出：收到信号后跳出循环，再做最后一次 fetch。
      if (sessionIdle) {
        break
      }

      const { data: messages } = await client.session.messages({ path: { id: sessionId }, query })
      const text = extractLastAssistantText(messages ?? [])

      if (text && text !== lastText) {
        // 看到新文本：更新快照并重置稳定计数。
        lastText = text
        sameCount = 0
      } else if (text && text.length > 0) {
        // 文本没变：累计稳定次数，达到阈值后可认为输出基本结束。
        sameCount++
        if (sameCount >= stablePolls) break
      }
    }

    // 返回前再次检查 SSE 错误，防止 break 后遗漏竞态。
    const finalSseError = getSessionError(sessionId)
    if (finalSseError) {
      throw new SessionErrorDetected(finalSseError)
    }

    // 再 fetch 一次最终消息列表，尽可能拿到最完整文本。
    const { data: finalMessages } = await client.session.messages({ path: { id: sessionId }, query })
    return extractLastAssistantText(finalMessages ?? []) || lastText
  } finally {
    unsub()
  }
}

/**
 * 如果已有占位消息则优先更新；更新失败再退回发送新文本消息。
 */
async function replyOrUpdate(
  feishuClient: InstanceType<typeof Lark.Client>,
  chatId: string,
  placeholderId: string,
  text: string,
  log: LogFn,
): Promise<void> {
  if (placeholderId) {
    const res = await sender.updateMessage(feishuClient, placeholderId, text, log)
    if (!res.ok) {
      // 占位消息更新失败时，至少要保证用户能看到最终文本。
      log("error", "更新占位消息失败，回退发送新消息", {
        chatId,
        placeholderId,
        error: res.error ?? "unknown",
      })
      const fallbackRes = await sender.sendTextMessage(feishuClient, chatId, text, log)
      if (!fallbackRes.ok) {
        log("error", "回退发送飞书文本消息失败", {
          chatId,
          placeholderId,
          error: fallbackRes.error ?? "unknown",
        })
      }
    }
  } else {
    const res = await sender.sendTextMessage(feishuClient, chatId, text, log)
    if (!res.ok) {
      log("error", "发送飞书文本消息失败", {
        chatId,
        error: res.error ?? "unknown",
      })
    }
  }
}

/**
 * 一个可被 AbortSignal 中断的 sleep。
 *
 * 轮询等待和未来可中断处理链路都依赖它。
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

/**
 * 从 session 消息列表里抽取最后一条 assistant 文本。
 *
 * 当前策略只拼接 `type === "text"` 的 parts，
 * 因为真正展示给用户的最终回复也只关心这些文本块。
 */
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
