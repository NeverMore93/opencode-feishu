/**
 * Action Bus: per-session 事件订阅/发布
 */
import type { PermissionRequest, QuestionRequest } from "../types.js"

/**
 * 事件总线标准化 Action 类型
 */
export type ProcessedAction =
  | { type: "text-updated"; sessionId: string; messageId?: string; delta?: string; fullText?: string }
  | { type: "tool-state-changed"; sessionId: string; callID: string; tool: string; state: "running" | "completed" | "error"; title?: string }
  | { type: "subtask-discovered"; sessionId: string; description: string; agent?: string }
  | { type: "permission-requested"; sessionId: string; request: PermissionRequest }
  | { type: "question-requested"; sessionId: string; request: QuestionRequest }
  | { type: "session-idle"; sessionId: string }
  | { type: "session-error"; sessionId: string; error: string; fields: string[] }

type ActionCallback = (action: ProcessedAction) => void | Promise<void>

const subscribers = new Map<string, Set<ActionCallback>>()

/**
 * 注册 per-session 事件订阅
 * @returns unsubscribe 函数（幂等，多次调用安全）
 */
export function subscribe(
  sessionId: string,
  cb: ActionCallback,
): () => void {
  let subs = subscribers.get(sessionId)
  if (!subs) {
    subs = new Set()
    subscribers.set(sessionId, subs)
  }
  subs.add(cb)

  let removed = false
  return () => {
    if (removed) return
    removed = true
    // 从当前 sessionId 的订阅集合中移除，使用 subscribers.get() 获取最新引用
    // 避免闭包捕获的旧 Set 引用与新 Set 不一致
    const current = subscribers.get(sessionId)
    if (current) {
      current.delete(cb)
      if (current.size === 0) {
        subscribers.delete(sessionId)
      }
    }
  }
}

/**
 * 向指定 session 的所有订阅者发布 action（fire-and-forget）
 */
export function emit(sessionId: string, action: ProcessedAction): void {
  const subs = subscribers.get(sessionId)
  if (!subs) return

  for (const cb of subs) {
    Promise.resolve()
      .then(() => cb(action))
      .catch(() => {})
  }
}

/**
 * 清理指定 session 的所有订阅
 */
export function unsubscribeAll(sessionId: string): void {
  subscribers.delete(sessionId)
}
