import { randomUUID } from "node:crypto"
import { TtlMap } from "../utils/ttl-map.js"

const RUN_CACHE_TTL = 10 * 60 * 1_000

export type ReplyRunState =
  | "starting"
  | "running"
  | "completing"
  | "completed"
  | "aborting"
  | "aborted"
  | "failed"
  | "timed_out"

export type ReplyTerminalState = "completed" | "failed" | "timed_out" | "aborted"

export interface ActiveReplyRun {
  runId: string
  sessionId: string
  sessionKey: string
  chatId: string
  chatType: "p2p" | "group"
  state: ReplyRunState
  startedAt: string
  endedAt?: string
  cardMessageId?: string
  cardId?: string
  requestMessageIds: string[]
  abortRequestedAt?: string
  abortSource?: "card" | "message" | "system"
  terminalState?: ReplyTerminalState
  controller: AbortController
}

export interface AbortRequestResult {
  outcome: "accepted" | "duplicate" | "stale" | "failed"
  feedback: string
  run?: ActiveReplyRun
}

// activeBySessionKey 正常流程在 archiveRun / createReplyRun 中显式清理；
// 但 run 异常未到 terminal state 时会残留条目，TtlMap 作为兜底防止长期累积。
const ACTIVE_KEY_TTL = 2 * 60 * 60 * 1_000
const activeBySessionKey = new TtlMap<ActiveReplyRun>(ACTIVE_KEY_TTL)
const runsByRunId = new TtlMap<ActiveReplyRun>(RUN_CACHE_TTL)
const runsBySessionId = new TtlMap<ActiveReplyRun>(RUN_CACHE_TTL)

const TERMINAL_STATES = new Set<ReplyRunState>(["completed", "aborted", "failed", "timed_out"])

export function createReplyRun(params: {
  sessionId: string
  sessionKey: string
  chatId: string
  chatType: "p2p" | "group"
}): ActiveReplyRun {
  const existing = activeBySessionKey.get(params.sessionKey)
  if (existing && !isTerminalRunState(existing.state)) {
    archiveRun(existing, existing.state === "aborting" ? "aborted" : "failed")
  }

  const run: ActiveReplyRun = {
    runId: randomUUID(),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    chatId: params.chatId,
    chatType: params.chatType,
    state: "starting",
    startedAt: new Date().toISOString(),
    requestMessageIds: [],
    controller: new AbortController(),
  }

  activeBySessionKey.set(params.sessionKey, run)
  cacheRun(run)
  return run
}

export function attachRunCard(runId: string, card: { cardId?: string; cardMessageId?: string }): ActiveReplyRun | undefined {
  const run = getRunByRunId(runId)
  if (!run) return undefined
  if (card.cardId) run.cardId = card.cardId
  if (card.cardMessageId) run.cardMessageId = card.cardMessageId
  cacheRun(run)
  return run
}

export function addRunRequestMessageId(runId: string, messageId: string): ActiveReplyRun | undefined {
  const run = getRunByRunId(runId)
  if (!run) return undefined
  if (messageId && !run.requestMessageIds.includes(messageId)) {
    run.requestMessageIds.push(messageId)
    cacheRun(run)
  }
  return run
}

export function markRunState(runId: string, state: ReplyRunState): ActiveReplyRun | undefined {
  const run = getRunByRunId(runId)
  if (!run) return undefined
  if (isTerminalRunState(run.state)) return run
  run.state = state
  cacheRun(run)
  return run
}

export function completeReplyRun(runId: string, terminalState: ReplyTerminalState): ActiveReplyRun | undefined {
  const run = getRunByRunId(runId)
  if (!run) return undefined
  archiveRun(run, terminalState)
  return run
}

export function requestAbortForRun(params: {
  runId: string
  sessionId: string
  source: "card" | "message" | "system"
}): AbortRequestResult {
  const run = getRunByRunId(params.runId)
  if (!run || run.sessionId !== params.sessionId) {
    return { outcome: "stale", feedback: "当前任务已失效，无法中断" }
  }

  if (isTerminalRunState(run.state)) {
    return { outcome: "duplicate", feedback: "当前回答已结束，无需重复中断", run }
  }

  if (run.state === "aborting") {
    return { outcome: "duplicate", feedback: "已收到中断请求，正在停止回答", run }
  }

  try {
    run.abortRequestedAt = new Date().toISOString()
    run.abortSource = params.source
    run.state = "aborting"
    cacheRun(run)
    return { outcome: "accepted", feedback: "已接收中断请求，正在停止回答", run }
  } catch {
    return { outcome: "failed", feedback: "中断请求发送失败，请稍后重试", run }
  }
}

export function confirmAbortForRun(runId: string): ActiveReplyRun | undefined {
  const run = getRunByRunId(runId)
  if (!run) return undefined
  if (isTerminalRunState(run.state)) return run
  run.controller.abort()
  cacheRun(run)
  return run
}

export function resetAbortForRun(runId: string): ActiveReplyRun | undefined {
  const run = getRunByRunId(runId)
  if (!run) return undefined
  if (run.state !== "aborting") return run
  run.abortRequestedAt = undefined
  run.abortSource = undefined
  run.state = "running"
  cacheRun(run)
  return run
}

export function getRunAbortSignal(runId: string): AbortSignal | undefined {
  return getRunByRunId(runId)?.controller.signal
}

export function isRunAbortRequested(runId: string): boolean {
  const run = getRunByRunId(runId)
  return !!run?.abortRequestedAt
}

export function getRunByRunId(runId: string): ActiveReplyRun | undefined {
  return runsByRunId.get(runId)
}

export function getRunBySessionId(sessionId: string): ActiveReplyRun | undefined {
  return runsBySessionId.get(sessionId)
}

export function getActiveRunBySessionKey(sessionKey: string): ActiveReplyRun | undefined {
  return activeBySessionKey.get(sessionKey)
}

export function isTerminalRunState(state: ReplyRunState): state is ReplyTerminalState {
  return TERMINAL_STATES.has(state)
}

function archiveRun(run: ActiveReplyRun, terminalState: ReplyTerminalState): void {
  run.terminalState = terminalState
  run.state = terminalState
  run.endedAt = new Date().toISOString()
  activeBySessionKey.delete(run.sessionKey)
  cacheRun(run)
}

function cacheRun(run: ActiveReplyRun): void {
  runsByRunId.set(run.runId, run)
  runsBySessionId.set(run.sessionId, run)
  if (!isTerminalRunState(run.state)) {
    activeBySessionKey.set(run.sessionKey, run)
  }
}
