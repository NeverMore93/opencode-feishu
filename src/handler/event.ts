/**
 * OpenCode 事件处理：通过插件 event 钩子接收事件，更新飞书占位消息
 */
import type { Event } from "@opencode-ai/sdk"
import type { OpencodeClient } from "@opencode-ai/sdk"

import * as sender from "../feishu/sender.js"
import { invalidateCachedSession, setCachedSession, forkOrCreateSession } from "../session.js"
import type { LogFn } from "../types.js"
import type * as Lark from "@larksuiteoapi/node-sdk"

export interface PendingReplyPayload {
  chatId: string
  placeholderId: string
  feishuClient: InstanceType<typeof Lark.Client>
  textBuffer: string
}

export interface EventDeps {
  client: OpencodeClient
  log: LogFn
  directory: string
}

const pendingBySession = new Map<string, PendingReplyPayload>()
const sessionErrors = new Map<string, string>()
const sessionErrorTimeouts = new Map<string, NodeJS.Timeout>()
const SESSION_ERROR_TTL_MS = 30_000

/** Fork 次数限制：防止模型不兼容时无限 fork 循环 */
const forkAttempts = new Map<string, number>()
const MAX_FORK_ATTEMPTS = 2

/**
 * 重置指定 sessionKey 的 fork 计数（成功 prompt 后调用）
 */
export function clearForkAttempts(sessionKey: string): void {
  forkAttempts.delete(sessionKey)
}

export function getSessionError(sessionId: string): string | undefined {
  return sessionErrors.get(sessionId)
}

export function clearSessionError(sessionId: string): void {
  const timer = sessionErrorTimeouts.get(sessionId)
  if (timer) {
    clearTimeout(timer)
    sessionErrorTimeouts.delete(sessionId)
  }
  sessionErrors.delete(sessionId)
}

function setSessionError(sessionId: string, errMsg: string): void {
  const existing = sessionErrorTimeouts.get(sessionId)
  if (existing) {
    clearTimeout(existing)
  }
  sessionErrors.set(sessionId, errMsg)
  const timeoutId = setTimeout(() => {
    sessionErrors.delete(sessionId)
    sessionErrorTimeouts.delete(sessionId)
  }, SESSION_ERROR_TTL_MS)
  sessionErrorTimeouts.set(sessionId, timeoutId)
}

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
 * 迁移 pending 占位消息到新 session（fork 后旧 sessionId → 新 sessionId）
 */
function migratePending(oldSessionId: string, newSessionId: string): void {
  const payload = pendingBySession.get(oldSessionId)
  if (payload) {
    pendingBySession.delete(oldSessionId)
    pendingBySession.set(newSessionId, payload)
  }
}

/**
 * 检测错误消息是否为模型不兼容错误
 */
function isModelError(errMsg: string, rawError?: unknown): boolean {
  if (errMsg.includes("ModelNotFound") || errMsg.includes("ProviderModelNotFound")) {
    return true
  }
  if (rawError && typeof rawError === "object") {
    const e = rawError as Record<string, unknown>
    const fields = [e.type, e.name, e.message].filter(Boolean).map(String)
    // 也检查 data.message（SDK 错误类型的嵌套结构）
    if (e.data && typeof e.data === "object" && "message" in e.data) {
      const dataMsg = e.data.message
      if (dataMsg) fields.push(String(dataMsg))
    }
    return fields.some(f => f.includes("ModelNotFound") || f.includes("ProviderModelNotFound"))
  }
  return false
}

/**
 * 处理 OpenCode 事件（由插件 event 钩子调用）
 */
export async function handleEvent(
  event: Event,
  deps: EventDeps,
): Promise<void> {
  switch (event.type) {
    case "message.part.updated": {
      const part = event.properties.part
      if (!part) break

      const sessionId = part.sessionID
      if (!sessionId) break

      const payload = pendingBySession.get(sessionId)
      if (!payload) break

      // delta 是增量文本，part.text 是全量文本
      const delta = (event.properties as { delta?: string }).delta
      if (delta) {
        payload.textBuffer += delta
      } else {
        // 无 delta 时用全量文本替换（而非追加，避免文本重复）
        const fullText = extractPartText(part)
        if (fullText) {
          payload.textBuffer = fullText
        }
      }

      if (payload.textBuffer) {
        const res = await sender.updateMessage(payload.feishuClient, payload.placeholderId, payload.textBuffer.trim())
        if (!res.ok) {
          // best-effort: 更新失败不阻塞
        }
      }
      break
    }
    case "session.error": {
      const props = event.properties as Record<string, unknown>
      const sessionId = props.sessionID as string | undefined
      if (!sessionId) break

      const error = props.error
      let errMsg: string
      if (typeof error === "string") {
        errMsg = error
      } else if (error && typeof error === "object") {
        const e = error as Record<string, unknown>
        const rawDataMsg = (e.data && typeof e.data === "object" && "message" in e.data)
          ? (e.data as { message?: unknown }).message
          : undefined
        const dataMsg = rawDataMsg != null ? String(rawDataMsg) : undefined
        errMsg = String(e.message ?? dataMsg ?? e.type ?? e.name ?? "An unexpected error occurred")
      } else {
        errMsg = String(error)
      }

      const safeErrorFields = error && typeof error === "object"
        ? {
            type: (error as Record<string, unknown>).type,
            name: (error as Record<string, unknown>).name,
            dataMessage: ((error as Record<string, unknown>).data as Record<string, unknown> | undefined)?.message,
          }
        : { raw: String(error) }
      deps.log("warn", "收到 session.error 事件", {
        sessionId,
        error: safeErrorFields,
        extractedMsg: errMsg,
      })

      setSessionError(sessionId, errMsg)

      // 模型不兼容错误：主动 fork 会话，更新缓存（有次数限制）
      if (isModelError(errMsg, props.error)) {
        const sessionKey = invalidateCachedSession(sessionId)
        if (sessionKey) {
          const attempts = forkAttempts.get(sessionKey) ?? 0
          if (attempts >= MAX_FORK_ATTEMPTS) {
            deps.log("warn", "已达 fork 上限，放弃恢复", { sessionKey, attempts })
          } else {
            forkAttempts.set(sessionKey, attempts + 1)
            try {
              const newSession = await forkOrCreateSession(deps.client, sessionId, sessionKey, deps.directory)
              setCachedSession(sessionKey, newSession)
              deps.log("warn", "模型不兼容，已恢复会话", {
                oldSessionId: sessionId,
                newSessionId: newSession.id,
                sessionKey,
                forkAttempt: attempts + 1,
              })

              // 迁移 pending（如果有占位消息在旧 session 上）
              migratePending(sessionId, newSession.id)
            } catch (recoverErr) {
              deps.log("error", "会话恢复失败", {
                sessionId,
                sessionKey,
                error: recoverErr instanceof Error ? recoverErr.message : String(recoverErr),
              })
            }
          }
        }
      }

      // 不在此处向用户发送错误消息——由 chat.ts catch 块统一处理
      // 避免 event.ts 和 chat.ts 双重发送错误消息
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
