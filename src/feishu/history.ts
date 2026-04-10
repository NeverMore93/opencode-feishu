/**
 * 群聊历史上下文摄入。
 *
 * 当 bot 被新拉入群聊时，这个模块会补录一段历史消息给 OpenCode，
 * 让后续对话一开始就拥有最基本的背景信息。
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { OpencodeClient } from "@opencode-ai/sdk"
import type { LogFn } from "../types.js"
import { buildSessionKey, getOrCreateSession } from "../session.js"
import { describeMessageType } from "./content-extractor.js"

/** 历史消息的轻量归一化结构。 */
interface HistoryMessage {
  senderType: string
  senderId: string
  content: string
  createTime: string
}

/** 单次调用飞书 list 接口时的页面大小上限。 */
const DEFAULT_PAGE_SIZE = 50

/**
 * 拉取群聊历史消息并注入 OpenCode 会话。
 *
 * 整个过程不会触发 AI 回复，只会把内容作为 `noReply` 上下文同步进去。
 */
export async function ingestGroupHistory(
  feishuClient: InstanceType<typeof Lark.Client>,
  opencodeClient: OpencodeClient,
  chatId: string,
  options: {
    maxMessages: number
    log: LogFn
    directory?: string
  },
): Promise<void> {
  const { maxMessages, log, directory } = options
  const query = directory ? { directory } : undefined

  log("info", "开始摄入群聊历史上下文", { chatId, maxMessages })

  // 1. 先从飞书侧拉取最近历史消息。
  const messages = await fetchRecentMessages(feishuClient, chatId, maxMessages, log)
  if (!messages.length) {
    log("info", "群聊无历史消息，跳过摄入", { chatId })
    return
  }

  // 2. 复用该群聊对应的 OpenCode 会话。
  const sessionKey = buildSessionKey("group", chatId)
  const session = await getOrCreateSession(opencodeClient, sessionKey, directory)

  // 3. 把历史消息格式化成一段连续的上下文文本。
  const contextText = formatHistoryAsContext(messages)

  // 4. 以 noReply 方式送入 OpenCode，只记上下文，不要求模型立即回应。
  await opencodeClient.session.promptAsync({
    path: { id: session.id },
    query,
    body: {
      parts: [{ type: "text", text: contextText }],
      noReply: true,
    },
  })

  log("info", "群聊历史上下文摄入完成", { chatId, messageCount: messages.length, sessionId: session.id })
}

/**
 * 通过飞书 API 分页拉取群聊最近消息。
 *
 * 返回值已经做过：
 * - 删除消息过滤
 * - 空内容过滤
 * - 消息类型转文本描述
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
        // 已删除或无正文的消息没有摄入价值。
        if (item.deleted) continue
        if (!item.body?.content) continue

        const msgType = item.msg_type ?? "text"
        const rawContent = item.body.content
        const text = describeMessageType(msgType, rawContent, log)
        if (!text) continue

        result.push({
          senderType: item.sender?.sender_type ?? "unknown",
          senderId: item.sender?.id ?? "",
          content: text,
          createTime: item.create_time ?? "",
        })

        if (result.length >= maxMessages) break
      }

      // 飞书服务端已无更多页时结束。
      if (!res?.data?.has_more) break
      pageToken = res.data.page_token ?? undefined
    }
  } catch (err) {
    log("error", "拉取群聊历史消息失败", {
      chatId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // API 返回倒序（最新在前），翻转为正序（最早在前），更适合模型顺序阅读。
  result.reverse()
  return result
}

/**
 * 将历史消息格式化为适合 prompt 注入的文本。
 */
function formatHistoryAsContext(messages: HistoryMessage[]): string {
  const header = [
    "[群聊历史上下文 - 以下是 bot 加入前的群聊记录，仅作为背景信息，无需回复]",
    `消息数量: ${messages.length}`,
    "---",
  ].join("\n")

  const body = messages
    .map((m) => {
      // 时间统一转成中文可读格式，帮助模型理解先后关系。
      const time = m.createTime
        ? new Date(Number(m.createTime)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
        : "unknown"
      // app 发送者通常是机器人或系统实体，单独标记。
      const senderLabel = m.senderType === "app" ? "[Bot]" : `[${m.senderId}]`
      return `[${time}] ${senderLabel}: ${m.content}`
    })
    .join("\n")

  return `${header}\n${body}`
}
