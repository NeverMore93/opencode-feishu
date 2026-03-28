/**
 * 会话消息队列调度器：按 sessionKey FIFO 串行处理
 *
 * - P2P 和群聊统一使用 FIFO 队列，消息按顺序处理不互相中断
 * - 静默转发完全绕过队列
 */
import type { FeishuMessageContext } from "../types.js"
import { handleChat, type ChatDeps } from "./chat.js"
import { buildSessionKey } from "../session.js"

interface QueuedMessage {
  readonly ctx: FeishuMessageContext
  readonly deps: ChatDeps
}

interface QueueState {
  queue: QueuedMessage[]
  processing: boolean
}

/** 全局队列状态：sessionKey → QueueState */
const states = new Map<string, QueueState>()

function getOrCreateState(sessionKey: string): QueueState {
  const existing = states.get(sessionKey)
  if (existing) return existing
  const state: QueueState = { queue: [], processing: false }
  states.set(sessionKey, state)
  return state
}

function cleanupStateIfIdle(sessionKey: string, state: QueueState): void {
  if (!state.processing && state.queue.length === 0) {
    states.delete(sessionKey)
  }
}

/**
 * 消息入队：统一入口，根据 shouldReply 和 chatType 分发策略
 */
export async function enqueueMessage(ctx: FeishuMessageContext, deps: ChatDeps): Promise<void> {
  // 静默消息完全绕过队列
  if (!ctx.shouldReply) {
    await handleChat(ctx, deps)
    return
  }

  const sessionKey = buildSessionKey(
    ctx.chatType,
    ctx.chatType === "p2p" ? ctx.senderId : ctx.chatId,
  )

  await handleGroupMessage(sessionKey, ctx, deps)
}

/**
 * FIFO 串行队列：P2P 和群聊统一使用
 */
async function handleGroupMessage(
  sessionKey: string,
  ctx: FeishuMessageContext,
  deps: ChatDeps,
): Promise<void> {
  const state = getOrCreateState(sessionKey)
  state.queue.push({ ctx, deps })

  // 已有 drainLoop 运行中，消息已入队，等它处理
  if (state.processing) return

  await drainLoop(sessionKey, state)
}

/**
 * 串行消费队列中的所有消息
 */
async function drainLoop(sessionKey: string, state: QueueState): Promise<void> {
  state.processing = true

  try {
    while (state.queue.length > 0) {
      const item = state.queue.shift()!
      try {
        await handleChat(item.ctx, item.deps)
      } catch (err) {
        item.deps.log("error", "队列消息处理失败", {
          sessionKey,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } finally {
    state.processing = false
    cleanupStateIfIdle(sessionKey, state)
  }
}

export type { ChatDeps } from "./chat.js"
