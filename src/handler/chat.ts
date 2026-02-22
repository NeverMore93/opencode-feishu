/**
 * 对话处理：会话管理、占位消息、prompt 发送、轮询等待、最终回复
 */
import type { FeishuMessageContext, ResolvedConfig, LogFn } from "../types.js"
import type { OpencodeClient } from "@opencode-ai/sdk"
import * as sender from "../feishu/sender.js"
import { registerPending, unregisterPending } from "./event.js"
import { buildSessionKey, getOrCreateSession } from "../session.js"
import type * as Lark from "@larksuiteoapi/node-sdk"

const POLL_INTERVAL_MS = 1500
const STABLE_POLLS = 2

/** 每个会话的并发锁，防止同一会话多条消息同时处理 */
const sessionLocks = new Map<string, Promise<void>>()

export interface ChatDeps {
  config: ResolvedConfig
  client: OpencodeClient
  feishuClient: InstanceType<typeof Lark.Client>
  log: LogFn
  directory: string
}

export async function handleChat(ctx: FeishuMessageContext, deps: ChatDeps): Promise<void> {
  const { content, chatId, chatType, senderId, shouldReply } = ctx
  if (!content.trim()) return

  const { config, client, feishuClient, log, directory } = deps
  const query = directory ? { directory } : undefined

  const sessionKey = buildSessionKey(chatType, chatType === "p2p" ? senderId : chatId)
  const session = await getOrCreateSession(client, sessionKey, directory)

  // 群聊消息添加发送者身份前缀
  let promptContent = content
  if (chatType === "group" && senderId) {
    promptContent = `[${senderId}]: ${content}`
  }

  // 静默监听模式：消息发给 OpenCode 作为上下文，不触发 AI 回复
  if (!shouldReply) {
    try {
      await client.session.prompt({
        path: { id: session.id },
        query,
        body: {
          parts: [{ type: "text", text: promptContent }],
          noReply: true,
        },
      })
    } catch (err) {
      log("warn", "静默转发失败", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return
  }

  // 并发锁：同一会话的消息排队处理
  const prev = sessionLocks.get(session.id) ?? Promise.resolve()
  const current = prev.then(() => handleReply(ctx, deps, session, query)).catch(() => {})
  sessionLocks.set(session.id, current)
  await current
  // 如果当前是最后一个排队的任务，清理锁
  if (sessionLocks.get(session.id) === current) {
    sessionLocks.delete(session.id)
  }
}

async function handleReply(
  ctx: FeishuMessageContext,
  deps: ChatDeps,
  session: { id: string; title?: string },
  query: { directory: string } | undefined,
): Promise<void> {
  const { content, chatId, chatType, senderId } = ctx
  const { config, client, feishuClient, log } = deps

  let promptContent = content
  if (chatType === "group" && senderId) {
    promptContent = `[${senderId}]: ${content}`
  }

  const timeout = config.timeout
  const thinkingDelay = config.thinkingDelay

  let placeholderId = ""
  let placeholderReady = false

  // 使用 Promise 确保占位消息创建完成后才能使用
  let resolvePlaceholder: () => void
  const placeholderDone = new Promise<void>((r) => { resolvePlaceholder = r })

  const timer =
    thinkingDelay > 0
      ? setTimeout(async () => {
          const res = await sender.sendTextMessage(feishuClient, chatId, "正在思考…")
          if (res.ok && res.messageId) {
            placeholderId = res.messageId
            placeholderReady = true
            registerPending(session.id, { chatId, placeholderId, feishuClient })
          }
          resolvePlaceholder!()
        }, thinkingDelay)
      : null

  // 如果 thinkingDelay 为 0，直接 resolve
  if (!timer) resolvePlaceholder!()

  try {
    await client.session.prompt({
      path: { id: session.id },
      query,
      body: {
        parts: [{ type: "text", text: promptContent }],
      },
    })

    const start = Date.now()
    let lastText = ""
    let sameCount = 0

    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const { data: messages } = await client.session.messages({ path: { id: session.id }, query })
      const text = extractLastAssistantText(messages ?? [])

      if (text && text !== lastText) {
        lastText = text
        sameCount = 0
        // 轮询不再更新占位消息，交给 event 流式更新
      } else if (text && text.length > 0) {
        sameCount++
        if (sameCount >= STABLE_POLLS) break
      }
    }

    // 等待占位消息创建完成（如果 timer 还在跑）
    clearTimeout(timer!)
    await placeholderDone

    const { data: finalMessages } = await client.session.messages({ path: { id: session.id }, query })
    const finalText =
      extractLastAssistantText(finalMessages ?? []) ||
      lastText ||
      (Date.now() - start >= timeout ? "⚠️ 响应超时" : "[无回复]")

    if (placeholderReady && placeholderId) {
      const res = await sender.updateMessage(feishuClient, placeholderId, finalText)
      if (!res.ok) {
        // 更新失败（如消息被删除），fallback 到发新消息
        await sender.sendTextMessage(feishuClient, chatId, finalText)
      }
    } else {
      await sender.sendTextMessage(feishuClient, chatId, finalText)
    }
  } catch (err) {
    log("error", "对话处理失败", {
      error: err instanceof Error ? err.message : String(err),
    })

    // 等待占位消息创建完成
    clearTimeout(timer!)
    await placeholderDone

    const msg = "❌ " + (err instanceof Error ? err.message : String(err))
    if (placeholderReady && placeholderId) {
      const res = await sender.updateMessage(feishuClient, placeholderId, msg)
      if (!res.ok) {
        await sender.sendTextMessage(feishuClient, chatId, msg)
      }
    } else {
      await sender.sendTextMessage(feishuClient, chatId, msg)
    }
  } finally {
    unregisterPending(session.id)
  }
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
