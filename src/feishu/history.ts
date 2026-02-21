/**
 * 群聊历史上下文摄入：bot 被拉入群聊时，读取历史消息并发送给 OpenCode 作为上下文
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { OpencodeClient } from "@opencode-ai/sdk"
import type { LogFn } from "../types.js"
import { buildSessionKey, getOrCreateSession } from "../session.js"

interface HistoryMessage {
  senderType: string
  senderId: string
  content: string
  createTime: string
}

const DEFAULT_MAX_MESSAGES = 50
const DEFAULT_PAGE_SIZE = 50

/**
 * 拉取群聊历史消息并注入 OpenCode 会话作为背景上下文
 */
export async function ingestGroupHistory(
  feishuClient: InstanceType<typeof Lark.Client>,
  opencodeClient: OpencodeClient,
  chatId: string,
  options: {
    maxMessages?: number
    log: LogFn
  },
): Promise<void> {
  const { maxMessages = DEFAULT_MAX_MESSAGES, log } = options

  log("info", "开始摄入群聊历史上下文", { chatId, maxMessages })

  // 1. 拉取历史消息
  const messages = await fetchRecentMessages(feishuClient, chatId, maxMessages, log)
  if (!messages.length) {
    log("info", "群聊无历史消息，跳过摄入", { chatId })
    return
  }

  // 2. 获取/创建 OpenCode 会话
  const sessionKey = buildSessionKey("group", chatId)
  const session = await getOrCreateSession(opencodeClient, sessionKey)

  // 3. 格式化为上下文文本
  const contextText = formatHistoryAsContext(messages)

  // 4. 发送到 OpenCode（noReply: true，仅记录上下文，不触发 AI 回复）
  await opencodeClient.session.prompt({
    path: { id: session.id },
    body: {
      parts: [{ type: "text", text: contextText }],
      noReply: true,
    },
  })

  log("info", "群聊历史上下文摄入完成", { chatId, messageCount: messages.length, sessionId: session.id })
}

/**
 * 通过飞书 API 拉取群聊最近的文本消息
 */
async function fetchRecentMessages(
  client: InstanceType<typeof Lark.Client>,
  chatId: string,
  maxMessages: number,
  log: LogFn,
): Promise<HistoryMessage[]> {
  const result: HistoryMessage[] = []
  let pageToken: string | undefined

  try {
    while (result.length < maxMessages) {
      const res = await client.im.message.list({
        params: {
          container_id_type: "chat",
          container_id: chatId,
          sort_type: "ByCreateTimeDesc",
          page_size: Math.min(DEFAULT_PAGE_SIZE, maxMessages - result.length),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      })

      const items = res?.data?.items
      if (!items || items.length === 0) break

      for (const item of items) {
        if (item.deleted) continue
        if (item.msg_type !== "text" || !item.body?.content) continue

        let text: string
        try {
          const parsed = JSON.parse(item.body.content) as { text?: string }
          text = (parsed.text ?? "").trim()
        } catch {
          continue
        }
        if (!text) continue

        result.push({
          senderType: item.sender?.sender_type ?? "unknown",
          senderId: item.sender?.id ?? "",
          content: text,
          createTime: item.create_time ?? "",
        })

        if (result.length >= maxMessages) break
      }

      if (!res?.data?.has_more) break
      pageToken = res.data.page_token ?? undefined
    }
  } catch (err) {
    log("warn", "拉取群聊历史消息失败", {
      chatId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // API 返回倒序（最新在前），翻转为正序（最早在前）
  result.reverse()
  return result
}

/**
 * 将历史消息格式化为上下文文本
 */
function formatHistoryAsContext(messages: HistoryMessage[]): string {
  const header = [
    "[群聊历史上下文 - 以下是 bot 加入前的群聊记录，仅作为背景信息，无需回复]",
    `消息数量: ${messages.length}`,
    "---",
  ].join("\n")

  const body = messages
    .map((m) => {
      const time = m.createTime
        ? new Date(Number(m.createTime)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
        : "unknown"
      const senderLabel = m.senderType === "app" ? "[Bot]" : `[${m.senderId}]`
      return `[${time}] ${senderLabel}: ${m.content}`
    })
    .join("\n")

  return `${header}\n${body}`
}
