/**
 * 飞书引用消息解析：获取被回复消息的内容
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"
import { describeMessageType } from "./content-extractor.js"

const MAX_QUOTE_LENGTH = 500

export async function fetchQuotedMessage(
  client: InstanceType<typeof Lark.Client>,
  parentId: string,
  log: LogFn,
): Promise<string | undefined> {
  try {
    const res = await client.im.message.get({
      path: { message_id: parentId },
    })
    const msg = res?.data?.items?.[0]
    if (!msg) return undefined

    const msgType = (msg.msg_type as string) ?? "text"
    const body = (msg.body as { content?: string })?.content ?? ""
    const text = describeMessageType(msgType, body)
    if (!text) return undefined

    return text.length > MAX_QUOTE_LENGTH ? text.slice(0, MAX_QUOTE_LENGTH) + "..." : text
  } catch (err) {
    log("warn", "引用消息获取失败", {
      parentId,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}
