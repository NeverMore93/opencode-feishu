/**
 * 会话消息队列：保证同一个逻辑聊天里的消息顺序稳定。
 *
 * 当前实现统一采用 FIFO 串行模型，这样最容易确保：
 * - 同一 session 的上下文顺序正确
 * - 占位消息/流式卡片不会被并发覆盖
 * - 群聊中多个 @bot 请求不会互相踩状态
 *
 * 说明：
 * - 单聊不再做“新消息打断旧消息”的 CLI 式中断，避免 IM 场景里出现残留撤回或丢回复
 * - `session.idle` 之后的继续催促已经转移到 `event.ts` 的 nudge 流程，不再由队列维护第二阶段循环
 */
import type { FeishuMessageContext } from "../types.js"
import { handleChat, type ChatDeps } from "./chat.js"
import { buildSessionKey } from "../session.js"

/** 单条待处理消息及其运行依赖。 */
interface QueuedMessage {
  readonly ctx: FeishuMessageContext
  readonly deps: ChatDeps
}

/** 某个 sessionKey 当前的队列运行状态。 */
interface QueueState {
  /** FIFO 消息数组。 */
  queue: QueuedMessage[]
  /** 是否已经有 drainLoop 在消费。 */
  processing: boolean
}

/** 全局队列状态：sessionKey → QueueState */
const states = new Map<string, QueueState>()

/**
 * 读取或初始化指定 sessionKey 的状态对象。
 */
function getOrCreateState(sessionKey: string): QueueState {
  const existing = states.get(sessionKey)
  if (existing) return existing
  const state: QueueState = { queue: [], processing: false }
  states.set(sessionKey, state)
  return state
}

/**
 * 队列彻底空闲时回收状态对象，避免长时间运行后空壳条目积累。
 */
function cleanupStateIfIdle(sessionKey: string, state: QueueState): void {
  if (!state.processing && state.queue.length === 0) {
    states.delete(sessionKey)
  }
}

/**
 * 统一入队入口。
 *
 * 特殊规则：
 * - `shouldReply=false` 的静默消息直接透传，不占用队列
 * - 需要回复的消息则按 sessionKey 归并到串行队列
 */
export async function enqueueMessage(ctx: FeishuMessageContext, deps: ChatDeps): Promise<void> {
  // 静默消息只做上下文同步，不需要排队等待 UI 回复链路。
  if (!ctx.shouldReply) {
    await handleChat(ctx, deps)
    return
  }

  const sessionKey = buildSessionKey(
    ctx.chatType,
    ctx.chatType === "p2p" ? ctx.senderId : ctx.chatId,
  )

  await handleQueuedMessage(sessionKey, ctx, deps)
}

/**
 * 把消息压入指定 session 的 FIFO 队列。
 *
 * 如果当前已有消费者在跑，本次调用只负责入队；
 * 如果当前没人消费，则由本次调用负责拉起 drainLoop。
 */
async function handleQueuedMessage(
  sessionKey: string,
  ctx: FeishuMessageContext,
  deps: ChatDeps,
): Promise<void> {
  const state = getOrCreateState(sessionKey)
  state.queue.push({ ctx, deps })

  // 已有消费者运行中时，不重复启动第二个 drainLoop。
  if (state.processing) return

  await drainLoop(sessionKey, state)
}

/**
 * 串行消费同一 session 的所有待处理消息。
 *
 * 这里故意在单条消息失败时继续往后处理，
 * 避免一次异常把整个聊天队列永久堵死。
 */
async function drainLoop(sessionKey: string, state: QueueState): Promise<void> {
  state.processing = true

  try {
    while (state.queue.length > 0) {
      // while 条件已经保证数组非空，因此这里的非空断言是安全的。
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

/** 复导出，方便其他模块直接从队列层拿依赖类型。 */
export type { ChatDeps } from "./chat.js"
