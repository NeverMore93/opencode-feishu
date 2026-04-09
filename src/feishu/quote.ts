/**
 * 飞书引用消息解析模块
 *
 * 当用户在飞书中回复（引用）某条消息时，消息事件会携带 parent_id 字段。
 * 本模块通过飞书 API 获取被引用消息的原始内容，
 * 截断到安全长度后返回，供 chat.ts 拼接到发送给 OpenCode 的上下文中。
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"
import { describeMessageType } from "./content-extractor.js"

/**
 * 引用消息内容的最大字符数
 * 防止超长引用消息撑爆上下文，500 字符足以提供必要背景
 */
const MAX_QUOTE_LENGTH = 500

/**
 * 获取被引用（回复）消息的文本内容
 *
 * 通过飞书 im.message.get API 读取 parent_id 对应的消息，
 * 解析其消息类型和内容，返回人类可读的文本描述。
 * 超过 MAX_QUOTE_LENGTH 的内容会被截断并追加省略号。
 *
 * @param client 飞书 SDK Client 实例（自动处理 token 认证）
 * @param parentId 被引用消息的 message_id
 * @param log 日志函数，用于记录获取失败的 error 日志
 * @returns 引用消息的文本内容，获取失败或消息不存在时返回 undefined
 */
export async function fetchQuotedMessage(
  client: InstanceType<typeof Lark.Client>,
  parentId: string,
  log: LogFn,
): Promise<string | undefined> {
  try {
    // 通过飞书 API 获取指定 message_id 的消息详情
    const res = await client.im.message.get({
      path: { message_id: parentId },
    })
    // API 返回的 items 数组中取第一条（get 接口只返回一条）
    const msg = res?.data?.items?.[0]
    if (!msg) return undefined

    // 提取消息类型和正文内容
    const msgType = (msg.msg_type as string) ?? "text"
    const body = (msg.body as { content?: string })?.content ?? ""
    // 将消息类型+内容转换为人类可读的文本描述
    const text = describeMessageType(msgType, body, log)
    if (!text) return undefined

    // 超长内容截断，防止引用内容过大
    return text.length > MAX_QUOTE_LENGTH ? text.slice(0, MAX_QUOTE_LENGTH) + "..." : text
  } catch (err) {
    // 获取失败时记录 error 日志，但不阻断主流程（引用消息是可选上下文）
    log("error", "引用消息获取失败", {
      parentId,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}
