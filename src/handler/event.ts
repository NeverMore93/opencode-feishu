/**
 * OpenCode 事件处理：通过插件 event 钩子接收事件，更新飞书占位消息
 */
import type { Event } from "@opencode-ai/sdk"

import * as sender from "../feishu/sender.js"
import type { LogFn } from "../types.js"
import type * as Lark from "@larksuiteoapi/node-sdk"

export interface PendingReplyPayload {
  chatId: string
  placeholderId: string
  feishuClient: InstanceType<typeof Lark.Client>
  textBuffer: string
}

export interface EventDeps {
  log: LogFn
  directory: string
}

const pendingBySession = new Map<string, PendingReplyPayload>()

/** 缓存的会话错误信息 */
export interface CachedSessionError {
  message: string    // 用于展示的错误消息
  fields: string[]   // 所有提取的错误文本字段（用于模式匹配）
}

const sessionErrors = new Map<string, CachedSessionError>()
const sessionErrorTimeouts = new Map<string, NodeJS.Timeout>()
const SESSION_ERROR_TTL_MS = 30_000

/** 重试次数限制：防止模型不兼容时无限重试循环 */
const retryAttempts = new Map<string, number>()
const retryAttemptTimeouts = new Map<string, NodeJS.Timeout>()
export const MAX_RETRY_ATTEMPTS = 2
const RETRY_ATTEMPTS_TTL_MS = 3_600_000

/**
 * 重置指定 sessionKey 的重试计数（成功 prompt 后调用）
 */
export function clearRetryAttempts(sessionKey: string): void {
  retryAttempts.delete(sessionKey)
  const timer = retryAttemptTimeouts.get(sessionKey)
  if (timer) {
    clearTimeout(timer)
    retryAttemptTimeouts.delete(sessionKey)
  }
}

export function getRetryAttempts(sessionKey: string): number {
  return retryAttempts.get(sessionKey) ?? 0
}

export function setRetryAttempts(sessionKey: string, count: number): void {
  retryAttempts.set(sessionKey, count)
  const existing = retryAttemptTimeouts.get(sessionKey)
  if (existing) clearTimeout(existing)
  const timeoutId = setTimeout(() => {
    retryAttempts.delete(sessionKey)
    retryAttemptTimeouts.delete(sessionKey)
  }, RETRY_ATTEMPTS_TTL_MS)
  retryAttemptTimeouts.set(sessionKey, timeoutId)
}

export function getSessionError(sessionId: string): CachedSessionError | undefined {
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

function setSessionError(sessionId: string, message: string, fields: string[]): void {
  const existing = sessionErrorTimeouts.get(sessionId)
  if (existing) {
    clearTimeout(existing)
  }
  sessionErrors.set(sessionId, { message, fields })
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
 * 从 error 对象提取所有可用于模式匹配的文本字段。
 *
 * 策略：显式提取 message/type/name（可能是不可枚举属性）+
 * Object.values 提取所有可枚举 string 值 + data.message 嵌套字段。
 * 原生 Error 的 message/name 是不可枚举的，Object.values 无法获取，
 * 因此必须显式提取。最终用 Set 去重。
 */
export function extractErrorFields(error: unknown): string[] {
  if (typeof error === "string") return [error]
  if (error && typeof error === "object") {
    const fields: string[] = []
    collectStrings(error, fields, 3)
    return [...new Set(fields)]
  }
  return [String(error)]
}

/**
 * 递归提取对象中所有 string 值（最大深度限制防止循环引用）。
 * 同时显式提取 message/type/name（可能不可枚举）。
 */
function collectStrings(obj: unknown, out: string[], maxDepth: number): void {
  if (maxDepth <= 0 || !obj || typeof obj !== "object") return
  const e = obj as Record<string, unknown>
  // 显式提取可能不可枚举的标准 Error 属性
  for (const key of ["message", "type", "name"]) {
    const v = e[key]
    if (typeof v === "string" && v.length > 0) out.push(v)
  }
  // 提取所有可枚举值：string 直接收集，object 递归下探
  for (const v of Object.values(e)) {
    if (typeof v === "string" && v.length > 0) out.push(v)
    else if (v && typeof v === "object" && !Array.isArray(v)) collectStrings(v, out, maxDepth - 1)
  }
}

/**
 * 检测错误字段是否包含模型不兼容错误。
 *
 * 双层匹配策略防止再犯：
 * 1. 精确子串：覆盖已知的错误码和格式化字符串
 * 2. 关键词组合：检测 "model" + 否定/不可用语义词，覆盖未知的自然语言变体
 */
export function isModelError(fields: string[]): boolean {
  const exactPatterns = [
    "model not found", "modelnotfound", "model_not_found",
    "model not supported", "model_not_supported", "model is not supported",
  ]
  const negativeWords = ["not", "unsupported", "invalid", "unavailable", "unknown", "does not", "doesn't", "cannot", "不支持", "不存在", "无效"]
  return fields.some(f => {
    const l = f.toLowerCase()
    // 层 1：精确子串匹配（已知模式）
    if (exactPatterns.some(p => l.includes(p))) return true
    // 层 2：关键词组合匹配（"model" + 否定词 = 模型不可用）
    if (l.includes("model") && negativeWords.some(w => l.includes(w))) return true
    return false
  })
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

      const fields = extractErrorFields(error)

      deps.log("warn", "收到 session.error 事件", { sessionId, errMsg })

      setSessionError(sessionId, errMsg, fields)

      // 不在此处做 fork 恢复或向用户发送错误——统一由 chat.ts catch 块处理
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
