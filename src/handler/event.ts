/**
 * OpenCode 事件处理：通过插件 event 钩子接收事件，更新飞书占位消息
 */
import type { Event } from "@opencode-ai/sdk"
import type { LogFn } from "../types.js"
import * as sender from "../feishu/sender.js"
import type * as Lark from "@larksuiteoapi/node-sdk"

export interface PendingReplyPayload {
  chatId: string
  placeholderId: string
  feishuClient: InstanceType<typeof Lark.Client>
  textBuffer: string
}

const pendingBySession = new Map<string, PendingReplyPayload>()

export function registerPending(
  sessionId: string,
  payload: Omit<PendingReplyPayload, "textBuffer">,
): void {
  pendingBySession.set(sessionId, { ...payload, textBuffer: "" })
}

export function unregisterPending(sessionId: string): void {
  pendingBySession.delete(sessionId)
}

/**
 * 处理 OpenCode 事件（由插件 event 钩子调用）
 */
export async function handleEvent(
  event: Event,
  _feishuClient: InstanceType<typeof Lark.Client>,
  log: LogFn,
): Promise<void> {
  switch (event.type) {
    case "message.part.updated": {
      const part = event.properties.part
      if (!part) break

      const sessionId = part.sessionID
      if (!sessionId) break

      const payload = pendingBySession.get(sessionId)
      if (!payload) break

      const added = extractPartText(part)
      if (added) {
        payload.textBuffer += added
        try {
          await sender.updateMessage(payload.feishuClient, payload.placeholderId, payload.textBuffer.trim())
        } catch {
          // best-effort
        }
      }
      break
    }
    case "session.error": {
      const props = event.properties as Record<string, unknown>
      const sessionId = props.sessionID as string | undefined
      if (!sessionId) break

      const payload = pendingBySession.get(sessionId)
      if (!payload) break

      const errMsg = (props.error as Record<string, unknown>)?.message ?? String(props.error)
      try {
        await sender.updateMessage(payload.feishuClient, payload.placeholderId, `❌ 会话错误: ${errMsg}`)
      } catch {
        try {
          await sender.sendTextMessage(payload.feishuClient, payload.chatId, `❌ 会话错误: ${errMsg}`)
        } catch {
          log("error", "发送错误消息失败", { sessionId, error: String(errMsg) })
        }
      }
      break
    }
    default:
      break
  }
}

function extractPartText(part: { type?: string; text?: string; [key: string]: unknown }): string {
  if (part.type === "text") return part.text ?? ""
  if (part.type === "reasoning" && part.text) return `🤔 思考: ${part.text}\n\n`
  return ""
}
