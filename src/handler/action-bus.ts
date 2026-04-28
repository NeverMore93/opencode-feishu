/**
 * Action Bus：同一个 session 内部的轻量事件总线。
 *
 * 它的职责不是全局消息总线，而是把：
 * - SSE 事件处理
 * - 流式卡片渲染
 * - 权限/问答交互卡片
 * 这几个关注点松耦合地串起来。
 */
import type { DetailPhaseSnapshot, LogFn, PermissionRequest, QuestionRequest } from "../types.js"

/**
 * 仓库内部统一的“处理后事件”类型。
 *
 * 任何上游原始事件都应先被转换成这里的结构，再向下游广播。
 */
export type ProcessedAction =
  /** 文本内容更新；可能是 delta，也可能是整段快照。 */
  | { type: "text-updated"; sessionId: string; delta?: string; fullText?: string }
  /** 详细步骤阶段快照更新。 */
  | { type: "details-updated"; sessionId: string; phase: DetailPhaseSnapshot }
  /** 工具调用状态变化。 */
  | { type: "tool-state-changed"; sessionId: string; callID: string; tool: string; state: "running" | "completed" | "error" }
  /** OpenCode 发来权限请求。 */
  | { type: "permission-requested"; sessionId: string; request: PermissionRequest }
  /** OpenCode 发来问答请求。 */
  | { type: "question-requested"; sessionId: string; request: QuestionRequest }
  /** Session 进入 idle。 */
  | { type: "session-idle"; sessionId: string }
  /**
   * Assistant 消息元信息更新（model/cost/tokens/time）。
   * 来源：event.ts 监听 OpenCode v2 新增的 `message.updated` 事件（携带完整 AssistantMessage 元数据）。
   * 消费者：streaming-card 可据此在卡片中展示当前模型/费用/耗时，无需额外 HTTP 调用。
   */
  | {
    type: "assistant-meta-updated"
    sessionId: string
    providerID?: string
    modelID?: string
    cost?: number
    tokens?: Record<string, unknown>
    time?: { created?: number; completed?: number }
  }

/** 订阅回调可以同步也可以异步。 */
type ActionCallback = (action: ProcessedAction) => void | Promise<void>

/** sessionId → 订阅回调集合。 */
const subscribers = new Map<string, Set<ActionCallback>>()

/**
 * 注册某个 session 的事件订阅。
 *
 * @returns 取消订阅函数；幂等，多次调用安全
 */
export function subscribe(
  sessionId: string,
  cb: ActionCallback,
): () => void {
  let subs = subscribers.get(sessionId)
  if (!subs) {
    // 第一次订阅某个 session 时，初始化其订阅集合。
    subs = new Set()
    subscribers.set(sessionId, subs)
  }
  subs.add(cb)

  let removed = false
  return () => {
    if (removed) return
    removed = true
    // 重新从 Map 取最新集合，避免闭包里拿到过期引用。
    const current = subscribers.get(sessionId)
    if (current) {
      current.delete(cb)
      // 最后一个订阅者移除后，把空集合也顺手清掉。
      if (current.size === 0) {
        subscribers.delete(sessionId)
      }
    }
  }
}

/**
 * 向指定 session 的订阅者广播事件。
 *
 * 这里采用 fire-and-forget：
 * 单个订阅者抛错不会阻塞其他订阅者，也不会把主流程打断。
 */
export function emit(sessionId: string, action: ProcessedAction, log?: LogFn): void {
  const subs = subscribers.get(sessionId)
  if (!subs) return

  for (const cb of subs) {
    Promise.resolve()
      .then(() => cb(action))
      .catch((err) => {
        // 事件总线依然保持 fire-and-forget，但不再把订阅者异常静默吞掉。
        log?.("error", "action-bus 订阅回调执行失败", {
          sessionId,
          actionType: action.type,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }
}

