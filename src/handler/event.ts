/**
 * OpenCode 事件处理层。
 *
 * 这个模块站在插件 `event` hook 和下游 UI 之间，负责三件事：
 * 1. 接收并归一化 OpenCode SSE 事件
 * 2. 维护若干与 session 绑定的短期状态缓存
 * 3. 把事件转成 action-bus 广播给流式卡片、交互卡片等消费者
 */
import type { Event as SdkEvent } from "@opencode-ai/sdk"

/**
 * 扩展的事件类型，覆盖 v2 SDK 新增的事件。
 *
 * v1 SDK 的 Event 联合类型不含 `message.part.delta`、`permission.asked`、
 * `question.asked` 等 v2 事件。插件 event hook 实际会收到这些事件，
 * 此处用本地类型补充，避免 `as any` 强制类型断言。
 */
type Event = SdkEvent | {
  type: "message.part.delta"
  properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string }
} | {
  type: "permission.asked"
  properties: Record<string, unknown>
} | {
  type: "question.asked"
  properties: Record<string, unknown>
} | {
  type: "message.updated"
  properties: { info: { role?: string; id?: string; sessionID?: string; providerID?: string; modelID?: string; cost?: number; tokens?: Record<string, unknown>; time?: { created?: number; completed?: number }; [key: string]: unknown } }
} | {
  type: "todo.updated"
  properties: { sessionID: string; todos: Array<{ id: string; content: string; status: string; priority: string }> }
} | {
  type: string
  properties?: Record<string, unknown>
}

import * as sender from "../feishu/sender.js"
import type { LogFn, PermissionRequest, QuestionRequest } from "../types.js"
import type * as Lark from "@larksuiteoapi/node-sdk"
import { emit } from "./action-bus.js"
import { TtlMap } from "../utils/ttl-map.js"

/**
 * 当前正在“流式回复”的飞书消息上下文。
 *
 * `chat.ts` 在创建占位消息或流式卡片后注册它，
 * `message.part.updated` 事件到来时就靠这份上下文去更新对应飞书消息。
 */
export interface PendingReplyPayload {
  placeholderId: string
  feishuClient: InstanceType<typeof Lark.Client>
  /** 是否需要把增量文本镜像到飞书文本消息。结构化卡模式下为 false。 */
  mirrorTextToMessage: boolean
  /** 累积下来的完整文本缓冲区。 */
  textBuffer: string
  /** 锁定的 assistant messageID，首个 SSE 事件设置，后续只接受匹配的事件 */
  expectedMessageId?: string
  /** 当前轮是否已经观测到与本次 assistant message 关联的活动。 */
  hasActivity: boolean
}

/** 事件处理层运行所需依赖。 */
export interface EventDeps {
  log: LogFn
  directory: string
  client: import("@opencode-ai/sdk").OpencodeClient
  /** idle 催促配置，从解析后的 feishu.json 透传而来。 */
  nudge: { enabled: boolean; message: string; intervalSeconds: number; maxIterations: number }
}

/** sessionId → 当前飞书占位消息上下文。 */
const pendingBySession = new Map<string, PendingReplyPayload>()

/** 缓存的会话错误信息 */
export interface CachedSessionError {
  message: string    // 用于展示的错误消息
  raw?: unknown      // 原始错误对象，供 classify() 使用
}

/** SSE 侧上报的会话错误，保留 30 秒供 chat.ts 轮询路径消费。 */
const sessionErrors = new TtlMap<CachedSessionError>(30_000)

/** 重试次数限制：防止模型不兼容时无限重试循环 */
/** sessionKey → 已尝试的自动恢复次数，TTL 1 小时。 */
const retryAttempts = new TtlMap<number>(3_600_000)
export const MAX_RETRY_ATTEMPTS = 2

/** 清空某个 sessionKey 的恢复次数统计。 */
export function clearRetryAttempts(sessionKey: string): void {
  retryAttempts.delete(sessionKey)
}

/** 读取当前累计恢复次数；未记录时视为 0。 */
export function getRetryAttempts(sessionKey: string): number {
  return retryAttempts.get(sessionKey) ?? 0
}

/** 写入恢复次数并刷新 TTL。 */
export function setRetryAttempts(sessionKey: string, count: number): void {
  retryAttempts.set(sessionKey, count)
}

/** 读取 session.error 缓存。 */
export function getSessionError(sessionId: string): CachedSessionError | undefined {
  return sessionErrors.get(sessionId)
}

/** 清理 session.error 缓存，避免旧错误污染新一轮对话。 */
export function clearSessionError(sessionId: string): void {
  sessionErrors.delete(sessionId)
}

/**
 * 注册一个“待更新的飞书回复”。
 *
 * 调用方只需要提供基础字段；文本缓冲和 expectedMessageId 由本模块初始化。
 */
export function registerPending(
  sessionId: string,
  payload: Omit<PendingReplyPayload, "textBuffer" | "expectedMessageId" | "hasActivity">,
): void {
  pendingBySession.set(sessionId, {
    ...payload,
    textBuffer: "",
    expectedMessageId: undefined,
    hasActivity: false,
  })
}

export function unregisterPending(sessionId: string): void {
  pendingBySession.delete(sessionId)
}

/**
 * 事件主分发入口。
 *
 * 这里先按最关键的几个大类做路由：
 * - `message.part.updated`：流式输出增量
 * - `session.error`：错误缓存
 * - 其他事件：统一丢给 `handleV2Event()`
 */
export async function handleEvent(
  event: Event,
  deps: EventDeps,
): Promise<void> {
  switch (event.type) {
    case "message.part.delta": {
      const props = (event as any).properties as {
        sessionID?: string
        messageID?: string
        delta?: string
      }
      const { sessionID, messageID, delta } = props
      if (!sessionID || !delta) break
      const deltaPayload = pendingBySession.get(sessionID)
      if (!deltaPayload) break
      if (!matchOrLatchMessageId(deltaPayload, messageID)) return
      deltaPayload.hasActivity = true
      deltaPayload.textBuffer += delta

      if (deltaPayload.mirrorTextToMessage && deltaPayload.placeholderId && deltaPayload.textBuffer) {
        const res = await sender.updateMessage(
          deltaPayload.feishuClient,
          deltaPayload.placeholderId,
          deltaPayload.textBuffer || " ",
          deps.log,
        )
        if (!res.ok) {
          deps.log("error", "更新飞书占位消息失败（delta）", {
            sessionId: sessionID,
            placeholderId: deltaPayload.placeholderId,
            error: res.error ?? "unknown",
          })
        }
      }

      emit(sessionID, {
        type: "text-updated",
        sessionId: sessionID,
        delta,
        fullText: deltaPayload.textBuffer,
      }, deps.log)
      break
    }
    case "message.part.updated": {
      const part = (event as any).properties?.part as { sessionID?: string; messageID?: unknown; type?: string; text?: string; [key: string]: unknown } | undefined
      if (!part?.sessionID) break
      const payload = pendingBySession.get(part.sessionID)
      if (!payload) break
      await handleMessagePartUpdated(event, part, payload, deps.log)
      break
    }
    case "session.error":
      handleSessionErrorEvent(event, deps)
      break
    // message.updated：v2 SDK 新增事件，携带完整 AssistantMessage 元数据（model/cost/tokens/time）
    // 仅处理 role=assistant 的情况；同一 assistant message 可能触发多次（部分完成→完全完成），消费者需具备幂等性
    case "message.updated": {
      const info = (event.properties as any)?.info as { role?: string; sessionID?: string; providerID?: string; modelID?: string; cost?: number; tokens?: Record<string, unknown>; time?: { created?: number; completed?: number } } | undefined
      if (info?.role === "assistant" && info.sessionID) {
        const payload = pendingBySession.get(info.sessionID)
        if (payload) {
          payload.hasActivity = true
          // 通过 action-bus 广播 assistant-meta-updated；消费者（streaming-card）据此展示模型/费用/耗时
          emit(info.sessionID, {
            type: "assistant-meta-updated",
            sessionId: info.sessionID,
            providerID: info.providerID,
            modelID: info.modelID,
            cost: info.cost,
            tokens: info.tokens,
            time: info.time,
          }, deps.log)
        }
      }
      break
    }
    default:
      handleV2Event(event, deps)
      break
  }
}

/**
 * 处理 `message.part.updated`：
 * - 更新飞书占位消息/流式卡片文本
 * - 广播 action-bus 事件给其他消费者
 */
async function handleMessagePartUpdated(
  _event: Event,
  part: { sessionID?: string; messageID?: unknown; type?: string; text?: string; [key: string]: unknown },
  payload: PendingReplyPayload,
  log: LogFn,
): Promise<void> {
  if (!matchOrLatchMessageId(payload, part.messageID)) {
    // 串行队列虽能大幅降低串扰，但这里仍做 messageID 守卫，确保只吃当前回复的事件。
    return
  }

  const partSessionId = part.sessionID as string
  payload.hasActivity = true

  // Emit tool-state-changed for tool parts (skip text-updated — tool parts have no text content)
  if (part.type === "tool") {
    const p = part as Record<string, unknown>
    const toolName = String(p.tool ?? "unknown")
    const callID = String(p.callID ?? "")
    const stateObj = p.state as { status?: string } | undefined
    const rawStatus = stateObj?.status ?? (p.error != null ? "error" : "running")
    const toolState: "running" | "completed" | "error" = (rawStatus === "completed" || rawStatus === "error") ? rawStatus : "running"

    if (partSessionId) {
      emit(partSessionId, {
        type: "tool-state-changed",
        sessionId: partSessionId,
        callID,
        tool: toolName,
        state: toolState,
      }, log)
    }
    return
  }

  if (part.type === "reasoning") {
    const reasoningText = (part.text ?? "").trim()
    if (reasoningText && partSessionId) {
      emit(partSessionId, {
        type: "details-updated",
        sessionId: partSessionId,
        phase: {
          phaseId: "reasoning",
          label: "中间思路",
          status: "running",
          body: reasoningText,
          updatedAt: new Date().toISOString(),
        },
      }, log)
    }
    return
  }

  // message.part.updated 只处理 text 类型的全量快照（delta 已由 message.part.delta 处理）
  if (part.type !== "text") return

  const fullText = extractPartText(part)
  if (fullText) {
    // 快照事件：整段替换 buffer，避免重复拼接。
    payload.textBuffer = fullText
  }

  if (payload.mirrorTextToMessage && payload.placeholderId && payload.textBuffer) {
    // 传统占位消息路径会实时把 buffer 写回飞书消息。
    const res = await sender.updateMessage(
      payload.feishuClient,
      payload.placeholderId,
      payload.textBuffer || " ",
      log,
    )
    if (!res.ok) {
      log("error", "更新飞书占位消息失败", {
        sessionId: partSessionId,
        placeholderId: payload.placeholderId,
        error: res.error ?? "unknown",
      })
    }
  }

  // Emit text-updated action to action-bus (snapshot only, no delta)
  if (partSessionId && payload.textBuffer) {
    emit(partSessionId, {
      type: "text-updated",
      sessionId: partSessionId,
      delta: undefined,
      fullText: payload.textBuffer,
    }, log)
  }
}

/**
 * 处理 `session.error`：提取可展示错误并写入短期缓存。
 *
 * 注意这里故意不直接向用户发错，也不直接做恢复，
 * 统一由 `chat.ts` 的 catch 路径消费这些信息，避免双重发送。
 */
function handleSessionErrorEvent(event: Event, deps: EventDeps): void {
  const props = event.properties as Record<string, unknown>
  const sessionId = props.sessionID as string | undefined
  if (!sessionId) return

  const error = props.error
  let errMsg: string
  if (typeof error === "string") {
    errMsg = error
  } else if (error && typeof error === "object") {
    const e = error as Record<string, unknown>
    const asStr = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim().length > 0 ? v : undefined
    const rawDataMsg = (e.data && typeof e.data === "object" && "message" in e.data)
      ? (e.data as { message?: unknown }).message
      : undefined
    errMsg = asStr(e.message) ?? asStr(rawDataMsg) ?? asStr(e.type) ?? asStr(e.name) ?? "An unexpected error occurred"
  } else {
    errMsg = String(error)
  }

  deps.log("warn", "收到 session.error 事件", { sessionId, errMsg })

  // Phase 0 临时采样日志：记录完整 error 形状，为主 PR 的回归 fixtures 提供真实样本。
  // 此日志在 027 主 PR 合入后删除（T035）。
  const e = error as Record<string, unknown> | undefined
  deps.log("warn", "session.error.raw-shape", {
    errorName: (e as { name?: string })?.name,
    errorKeys: e && typeof e === "object" ? Object.keys(e) : [],
    dataKeys: (e as { data?: Record<string, unknown> })?.data && typeof (e as { data?: Record<string, unknown> }).data === "object"
      ? Object.keys((e as { data: Record<string, unknown> }).data)
      : [],
    dataMessage: ((e as { data?: { message?: string } })?.data?.message ?? "").slice(0, 500),
    sessionId,
  })

  sessionErrors.set(sessionId, { message: errMsg, raw: error })

  // 不在此处做 fork 恢复或向用户发送错误——统一由 chat.ts catch 块处理
}

/**
 * 处理 v2 新增事件：permission.asked / question.asked / session.idle。
 */
function handleV2Event(event: Event, deps: EventDeps): void {
  const evtType = (event as { type: string }).type
  const evtProps = (event as { properties?: Record<string, unknown> }).properties ?? {}
  const evtSessionId = evtProps.sessionID as string | undefined
  const pending = evtSessionId ? pendingBySession.get(evtSessionId) : undefined

  if (evtType === "permission.asked" && evtSessionId && pending) {
    const request = evtProps as PermissionRequest
    const toolMessageId = request.tool?.messageID
    if (!matchOrLatchMessageId(pending, toolMessageId)) return
    pending.hasActivity = true
    emit(evtSessionId, {
      type: "permission-requested",
      sessionId: evtSessionId,
      request,
    }, deps.log)
    deps.log("info", "permission.asked 事件已分发", { sessionId: evtSessionId })
  } else if (evtType === "question.asked" && evtSessionId && pending) {
    const request = evtProps as QuestionRequest
    const toolMessageId = request.tool?.messageID
    if (!matchOrLatchMessageId(pending, toolMessageId)) return
    pending.hasActivity = true
    emit(evtSessionId, {
      type: "question-requested",
      sessionId: evtSessionId,
      request,
    }, deps.log)
    deps.log("info", "question.asked 事件已分发", { sessionId: evtSessionId })
  } else if (evtType === "session.idle" && evtSessionId && pending?.hasActivity) {
    emit(evtSessionId, {
      type: "session-idle",
      sessionId: evtSessionId,
    }, deps.log)
    // 按需催促：检查最后一条 AI 消息是否以工具调用结尾（AI 可能卡住了）。
    nudgeIfToolIdle(evtSessionId, deps).catch((err) => {
      deps.log("error", "session.idle 催促任务异常退出", {
        sessionId: evtSessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
}

/** 催促计数器：sessionId → { count, lastTime }（用户新消息时清理） */
const nudgeState = new Map<string, { count: number; lastTime: number }>()

/**
 * 催促代数：每次用户新消息都会递增，用来让旧的 in-flight nudge 任务自我失效。
 *
 * 这样即使 `session.messages()` 已经发出，请求返回后也能知道：
 * “这还是不是同一轮 idle 状态下允许发送的催促”。
 */
const nudgeGeneration = new Map<string, number>()

/** 用户发新消息时清空该 session 的催促计数。 */
export function clearNudge(sessionId: string): void {
  nudgeGeneration.set(sessionId, (nudgeGeneration.get(sessionId) ?? 0) + 1)
  nudgeState.delete(sessionId)
}

/**
 * session.idle 时检查最后一条 assistant 消息：
 * 如果它以工具调用结尾，则按配置发送一条 synthetic prompt 催促继续。
 *
 * 受两层限制：
 * - `maxIterations`：总次数上限
 * - `intervalSeconds`：两次催促之间的最小间隔
 */
async function nudgeIfToolIdle(sessionId: string, deps: EventDeps): Promise<void> {
  if (!deps.nudge.enabled) return

  const generation = nudgeGeneration.get(sessionId) ?? 0
  const state = nudgeState.get(sessionId) ?? { count: 0, lastTime: 0 }
  if (state.count >= deps.nudge.maxIterations) return
  if (Date.now() - state.lastTime < deps.nudge.intervalSeconds * 1000) return

  const { client, log, directory } = deps
  const query = directory ? { directory } : undefined

  try {
    const resp = await client.session.messages({ path: { id: sessionId }, query })
    if ((nudgeGeneration.get(sessionId) ?? 0) !== generation) return

    const messages = resp?.data
    if (!Array.isArray(messages) || messages.length === 0) return

    // 找最后一条 assistant 消息
    const lastAssistant = [...messages].reverse().find(m => m.info?.role === "assistant")
    if (!lastAssistant?.parts?.length) return

    // 检查最后一个 part 是否是 tool 类型
    const lastPart = lastAssistant.parts[lastAssistant.parts.length - 1]
    if (lastPart.type !== "tool") return

    // 重新确认这一轮 idle 没有被新的用户消息打断。
    if ((nudgeGeneration.get(sessionId) ?? 0) !== generation) return

    // AI 以工具调用结尾后 idle — 催促继续
    nudgeState.set(sessionId, { count: state.count + 1, lastTime: Date.now() })
    log("info", "session.idle 检测到工具调用后停止，发送催促", {
      sessionId, iteration: state.count + 1, maxIterations: deps.nudge.maxIterations,
    })

    if ((nudgeGeneration.get(sessionId) ?? 0) !== generation) return

    await client.session.promptAsync({
      path: { id: sessionId },
      query,
      // `synthetic: true` 用来告诉 OpenCode：这是插件的内部催促，不是用户显式输入。
      body: { parts: [{ type: "text", text: deps.nudge.message, synthetic: true, metadata: { compaction_continue: true } } as const] },
    })
  } catch (err) {
    log("error", "session.idle 催促失败", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * 从 SSE part 中提取可展示文本。
 *
 * - 普通 text part 直接返回文本
 * - reasoning part 加一个前缀，避免用户看不出它是“思考内容”
 * - 其他类型目前不转换成文本
 */
function extractPartText(part: { type?: string; text?: string; [key: string]: unknown }): string {
  if (part.type === "text") return part.text ?? ""
  if (part.type === "reasoning" && part.text) return `🤔 思考: ${part.text}\n\n`
  return ""
}

function matchOrLatchMessageId(payload: PendingReplyPayload, messageId: unknown): boolean {
  const normalized = typeof messageId === "string" ? messageId.trim() : ""
  if (!normalized) {
    // 一旦已经锁定 assistant messageID，就不再接受无法关联的模糊事件。
    return !payload.expectedMessageId
  }

  if (!payload.expectedMessageId) {
    payload.expectedMessageId = normalized
    return true
  }

  return payload.expectedMessageId === normalized
}
