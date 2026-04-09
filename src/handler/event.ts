/**
 * OpenCode 事件处理层。
 *
 * 这个模块站在插件 `event` hook 和下游 UI 之间，负责三件事：
 * 1. 接收并归一化 OpenCode SSE 事件
 * 2. 维护若干与 session 绑定的短期状态缓存
 * 3. 把事件转成 action-bus 广播给流式卡片、交互卡片等消费者
 */
import type { Event } from "@opencode-ai/sdk"

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
  /** 累积下来的完整文本缓冲区。 */
  textBuffer: string
  /** 锁定的 assistant messageID，首个 SSE 事件设置，后续只接受匹配的事件 */
  expectedMessageId?: string
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
  fields: string[]   // 所有提取的错误文本字段（用于模式匹配）
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
  payload: Omit<PendingReplyPayload, "textBuffer" | "expectedMessageId">,
): void {
  pendingBySession.set(sessionId, { ...payload, textBuffer: "", expectedMessageId: undefined })
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
    else if (Array.isArray(v)) { for (const item of v) collectStrings(item, out, maxDepth - 1) }
    else if (v && typeof v === "object") collectStrings(v, out, maxDepth - 1)
  }
}

/**
 * 检测错误字段是否包含模型不兼容错误。
 *
 * 双层匹配策略防止再犯：
 * 1. 精确子串：覆盖已知的错误码和格式化字符串
 * 2. 关键词组合：检测 "model" + 否定/不可用语义词，覆盖未知的自然语言变体
 */
/** 检测 session 历史数据中毒（每次 LLM 调用都会重复触发的错误） */
/**
 * session 历史中毒的高危关键词。
 *
 * 这类错误通常意味着历史消息里存在当前模型无法接受的 part/schema，
 * 单纯重试不会好，必须让上层主动丢弃旧 session。
 */
const SESSION_POISON_PATTERNS = [
  "file part media type",
  "tool choice type",
]

/**
 * 检测错误字段是否指向“session 历史已经中毒”。
 *
 * 一旦命中，上层会直接 `invalidateSession()` 而不是再尝试模型恢复。
 */
export function isSessionPoisoned(fields: string[]): boolean {
  return fields.some(f => {
    const l = f.toLowerCase()
    if (SESSION_POISON_PATTERNS.some(p => l.includes(p))) return true
    return /localshell.*schema|zoderror.*local.?shell/.test(l)
  })
}

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
    case "message.part.updated": {
      const part = event.properties.part
      if (!part?.sessionID) break
      const payload = pendingBySession.get(part.sessionID)
      if (!payload) break
      await handleMessagePartUpdated(event, part, payload, deps.log)
      break
    }
    case "session.error":
      handleSessionErrorEvent(event, deps)
      break
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
  event: Event,
  part: { sessionID?: string; messageID?: unknown; type?: string; text?: string; [key: string]: unknown },
  payload: PendingReplyPayload,
  log: LogFn,
): Promise<void> {
  // messageID 过滤：首个事件锁定 messageID，后续只接受匹配的事件
  const messageId = part.messageID as string | undefined
  if (messageId) {
    if (!payload.expectedMessageId) {
      // 首个事件到来时锁定 messageID，后续只接受同一 assistant message 的更新。
      payload.expectedMessageId = messageId
    } else if (payload.expectedMessageId !== messageId) {
      // 串行队列虽能大幅降低串扰，但这里仍做 messageID 守卫，确保只吃当前回复的事件。
      return
    }
  } else if (payload.expectedMessageId) {
    // 一旦已经锁定 messageID，就不再接受没有 messageID 的模糊事件。
    return
  }

  const partSessionId = part.sessionID as string

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

  // delta 是增量文本，part.text 是全量文本
  const delta = (event.properties as { delta?: string }).delta
  if (delta) {
    // 增量事件：直接把 delta 追加进已有 buffer。
    payload.textBuffer += delta
  } else {
    const fullText = extractPartText(part)
    if (fullText) {
      // 快照事件：整段替换 buffer，避免重复拼接。
      payload.textBuffer = fullText
    }
  }

  if (payload.textBuffer) {
    // 传统占位消息路径会实时把 buffer 写回飞书消息。
    const res = await sender.updateMessage(
      payload.feishuClient,
      payload.placeholderId,
      payload.textBuffer.trim(),
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

  // Emit text-updated action to action-bus
  if (partSessionId) {
    emit(partSessionId, {
      type: "text-updated",
      sessionId: partSessionId,
      delta: delta ?? undefined,
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

  const fields = extractErrorFields(error)

  deps.log("warn", "收到 session.error 事件", { sessionId, errMsg })

  sessionErrors.set(sessionId, { message: errMsg, fields })

  // 不在此处做 fork 恢复或向用户发送错误——统一由 chat.ts catch 块处理
}

/**
 * 处理 v2 新增事件：permission.asked / question.asked / session.idle。
 */
function handleV2Event(event: Event, deps: EventDeps): void {
  const evtType = (event as { type: string }).type
  const evtProps = (event as { properties?: Record<string, unknown> }).properties ?? {}
  const evtSessionId = evtProps.sessionID as string | undefined

  if (evtType === "permission.asked" && evtSessionId) {
    emit(evtSessionId, {
      type: "permission-requested",
      sessionId: evtSessionId,
      request: evtProps as PermissionRequest,
    }, deps.log)
    deps.log("info", "permission.asked 事件已分发", { sessionId: evtSessionId })
  } else if (evtType === "question.asked" && evtSessionId) {
    emit(evtSessionId, {
      type: "question-requested",
      sessionId: evtSessionId,
      request: evtProps as QuestionRequest,
    }, deps.log)
    deps.log("info", "question.asked 事件已分发", { sessionId: evtSessionId })
  } else if (evtType === "session.idle" && evtSessionId) {
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

/** 用户发新消息时清空该 session 的催促计数。 */
export function clearNudge(sessionId: string): void {
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

  const state = nudgeState.get(sessionId) ?? { count: 0, lastTime: 0 }
  if (state.count >= deps.nudge.maxIterations) return
  if (Date.now() - state.lastTime < deps.nudge.intervalSeconds * 1000) return

  const { client, log, directory } = deps
  const query = directory ? { directory } : undefined

  try {
    const resp = await client.session.messages({ path: { id: sessionId }, query })
    const messages = resp?.data
    if (!Array.isArray(messages) || messages.length === 0) return

    // 找最后一条 assistant 消息
    const lastAssistant = [...messages].reverse().find(m => m.info?.role === "assistant")
    if (!lastAssistant?.parts?.length) return

    // 检查最后一个 part 是否是 tool 类型
    const lastPart = lastAssistant.parts[lastAssistant.parts.length - 1]
    if (lastPart.type !== "tool") return

    // AI 以工具调用结尾后 idle — 催促继续
    nudgeState.set(sessionId, { count: state.count + 1, lastTime: Date.now() })
    log("info", "session.idle 检测到工具调用后停止，发送催促", {
      sessionId, iteration: state.count + 1, maxIterations: deps.nudge.maxIterations,
    })

    await client.session.promptAsync({
      path: { id: sessionId },
      query,
      // `synthetic: true` 用来告诉 OpenCode：这是插件的内部催促，不是用户显式输入。
      body: { parts: [{ type: "text", text: deps.nudge.message, synthetic: true } as const] },
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
