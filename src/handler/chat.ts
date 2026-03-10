/**
 * 对话处理：会话管理、占位消息、prompt 发送、轮询等待、最终回复
 */
import type { FeishuMessageContext, ResolvedConfig, LogFn } from "../types.js"
import type { OpencodeClient } from "@opencode-ai/sdk"
import * as sender from "../feishu/sender.js"
import { registerPending, unregisterPending, getSessionError, clearSessionError, clearForkAttempts } from "./event.js"
import { buildSessionKey, getOrCreateSession } from "../session.js"
import { extractParts, type PromptPart } from "../feishu/content-extractor.js"
import type * as Lark from "@larksuiteoapi/node-sdk"

/** SSE 事件竞态等待窗口（ms），让 session.error 有机会在 HTTP 错误后到达 */
const SSE_RACE_WAIT_MS = 100

/** 每个会话的活跃自动提示循环，用于用户介入时中断 */
const activeAutoPrompts = new Map<string, AbortController>()

export interface ChatDeps {
  config: ResolvedConfig
  client: OpencodeClient
  feishuClient: InstanceType<typeof Lark.Client>
  log: LogFn
  directory: string
}

export async function handleChat(ctx: FeishuMessageContext, deps: ChatDeps): Promise<void> {
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
    log("info", "用户介入，自动提示已中断", { sessionKey })
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
    parts,
  })

  // 静默监听模式：消息发给 OpenCode 作为上下文，不触发 AI 回复
  if (!shouldReply) {
    try {
      await client.session.prompt({
        path: { id: session.id },
        query,
        body: { parts, noReply: true },
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
  const timer =
    thinkingDelay > 0
      ? setTimeout(async () => {
          if (done) return
          try {
            const res = await sender.sendTextMessage(feishuClient, chatId, "正在思考…")
            if (done) return // 重新检查，防止发送期间主流程已结束
            if (res.ok && res.messageId) {
              placeholderId = res.messageId
              registerPending(session.id, { chatId, placeholderId, feishuClient })
            }
          } catch (err) {
            log("warn", "发送占位消息失败", {
              chatId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }, thinkingDelay)
      : null

  try {
    await client.session.prompt({
      path: { id: session.id },
      query,
      body: { parts },
    })

    const finalText = await pollForResponse(client, session.id, { timeout, pollInterval, stablePolls, query })

    // prompt 成功：重置 fork 计数，避免一次性错误导致永久计数
    clearForkAttempts(sessionKey)

    await replyOrUpdate(feishuClient, chatId, placeholderId, finalText || "⚠️ 响应超时")

    // 自动提示循环：响应完成后自动发送"继续"推动 OpenCode 持续工作
    const { autoPrompt } = config
    if (autoPrompt.enabled && shouldReply) {
      const ac = new AbortController()
      activeAutoPrompts.set(sessionKey, ac)
      log("info", "启动自动提示循环", { sessionKey, maxIterations: autoPrompt.maxIterations })

      try {
        for (let i = 0; i < autoPrompt.maxIterations; i++) {
          await abortableSleep(autoPrompt.intervalSeconds * 1000, ac.signal)

          log("info", "发送自动提示", { sessionKey, iteration: i + 1 })

          await client.session.prompt({
            path: { id: session.id },
            query,
            body: { parts: [{ type: "text", text: autoPrompt.message }] },
          })

          const text = await pollForResponse(client, session.id, { timeout, pollInterval, stablePolls, query, signal: ac.signal })
          if (text) {
            await sender.sendTextMessage(feishuClient, chatId, text)
          }
        }

        log("info", "自动提示循环结束（达到最大次数）", { sessionKey })
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          log("info", "自动提示循环被中断", { sessionKey })
        } else {
          log("error", "自动提示循环异常", {
            sessionKey,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } finally {
        activeAutoPrompts.delete(sessionKey)
      }
    }
  } catch (err) {
    // 等待一个微小窗口，让可能在途的 session.error 事件有机会到达并被处理
    await new Promise(r => setTimeout(r, SSE_RACE_WAIT_MS))

    // 优先使用 session.error 事件中的实际错误信息（prompt() 常抛出无意义的 JSON 解析错误）
    const sessionError = getSessionError(session.id)
    clearSessionError(session.id)
    const thrownError = err instanceof Error ? err.message : String(err)
    const errorMessage = sessionError || thrownError

    log("error", "对话处理失败", {
      sessionId: session.id,
      sessionKey: sessionKey.replace(/-[^-]+$/, "-***"),
      chatType,
      error: thrownError,
      ...(sessionError ? { sessionError } : {}),
    })
    const msg = "❌ " + errorMessage
    await replyOrUpdate(feishuClient, chatId, placeholderId, msg)
  } finally {
    done = true
    if (timer) clearTimeout(timer)
    unregisterPending(session.id)
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
 * 轮询等待 AI 响应稳定，返回最终文本
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
