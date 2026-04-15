/**
 * 交互处理层：把 OpenCode 的权限/问答请求渲染成飞书卡片，
 * 再把用户点击结果回传给 OpenCode v2 接口。
 */
import type { PermissionRequest, QuestionRequest, LogFn } from "../types.js"
import { buildCardFromDSL, type ButtonInput, type SectionInput } from "../tools/send-card.js"
import * as sender from "../feishu/sender.js"
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { TtlMap } from "../utils/ttl-map.js"
import {
  confirmAbortForRun,
  getRunByRunId,
  isTerminalRunState,
  requestAbortForRun,
  resetAbortForRun,
} from "./reply-run-registry.js"
import { emit } from "./action-bus.js"

/** 交互模块需要的外部依赖。 */
export interface InteractiveDeps {
  /** 飞书 SDK client，用于实际发送卡片。 */
  feishuClient: InstanceType<typeof Lark.Client>
  /** 项目统一日志函数。 */
  log: LogFn
  /** OpenCode v2 client；缺失时无法进行权限/问答回传。 */
  v2Client?: OpencodeClient
}

/** 去重：同一 requestId 只发一张卡片（TTL 防止内存泄漏） */
const seenIds = new TtlMap<true>(10 * 60 * 1_000)

interface PermissionReplyActionValue {
  action: "permission_reply"
  requestId: string
  sessionId: string
  reply: "once" | "always" | "reject"
}

interface QuestionReplyActionValue {
  action: "question_reply"
  requestId: string
  sessionId: string
  answers: string[][]
}

interface AbortReplyActionValue {
  action: "abort_reply"
  runId: string
  sessionId: string
  source?: string
  cardVersion?: number
}

interface SendMessageActionValue {
  action: "send_message"
  text: string
  chatId: string
  /**
   * chatType 由发卡侧写入；老卡片或外部构造 payload 可能缺失。
   * 这里保留“缺失态”，交给 gateway 结合回调上下文做最终判定。
   */
  chatType?: "p2p" | "group"
}

export type ParsedCardActionValue =
  | PermissionReplyActionValue
  | QuestionReplyActionValue
  | AbortReplyActionValue
  | SendMessageActionValue

/**
 * 标记 requestId 是否首次出现。
 *
 * 返回 `true` 表示这次应该继续发送卡片，
 * 返回 `false` 表示此前已经处理过相同 requestId。
 */
function markSeen(requestId: string): boolean {
  if (seenIds.has(requestId)) return false
  seenIds.set(requestId, true)
  return true
}

/**
 * 发送失败时回滚已保留的 requestId，允许后续重试重新补发卡片。
 */
function unmarkSeen(requestId: string): void {
  seenIds.delete(requestId)
}

/**
 * 解析 card action payload，并只保留当前仓库真正处理的三类动作。
 *
 * 这样 `interactive.ts` 和 `gateway.ts` 不必各自手写一套 JSON.parse + 字段校验。
 */
export function parseCardActionValue(
  actionValue: string | undefined,
  log?: LogFn,
): ParsedCardActionValue | undefined {
  if (!actionValue) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(actionValue)
  } catch (err) {
    // 非法 actionValue 仍然按软失败处理，但会留下 error 日志便于排查卡片协议问题。
    log?.("error", "解析卡片 actionValue 失败", {
      actionValue,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }

  if (!parsed || typeof parsed !== "object") return undefined
  const value = parsed as Record<string, unknown>
  const requestId = typeof value.requestId === "string" ? value.requestId : ""

  switch (value.action) {
    case "permission_reply": {
      const reply = value.reply
      const sessionId = typeof value.sessionId === "string" ? value.sessionId : ""
      if (!requestId || !sessionId || (reply !== "once" && reply !== "always" && reply !== "reject")) {
        return undefined
      }
      return { action: "permission_reply", requestId, sessionId, reply }
    }
    case "question_reply": {
      const answers = value.answers
      const sessionId = typeof value.sessionId === "string" ? value.sessionId : ""
      if (
        !requestId || !sessionId ||
        !Array.isArray(answers) ||
        answers.some(
          (group) => !Array.isArray(group) || group.some((answer) => typeof answer !== "string"),
        )
      ) {
        return undefined
      }
      return { action: "question_reply", requestId, sessionId, answers }
    }
    case "abort_reply": {
      const runId = typeof value.runId === "string" ? value.runId : ""
      const sessionId = typeof value.sessionId === "string" ? value.sessionId : ""
      if (!runId || !sessionId) return undefined
      return {
        action: "abort_reply",
        runId,
        sessionId,
        source: typeof value.source === "string" ? value.source : undefined,
        cardVersion: typeof value.cardVersion === "number" ? value.cardVersion : undefined,
      }
    }
    case "send_message": {
      const text = typeof value.text === "string" ? value.text : ""
      const chatId = typeof value.chatId === "string" ? value.chatId : ""
      if (!text || !chatId) return undefined
      return {
        action: "send_message",
        text,
        chatId,
        chatType: value.chatType === "group" || value.chatType === "p2p"
          ? value.chatType
          : undefined,
      }
    }
    default:
      return undefined
  }
}

/**
 * 异步发送交互卡片，并补一层带 requestId/chatId 的业务日志。
 *
 * sender 层会把飞书 SDK 异常折叠成 `{ ok: false }`，
 * 这里负责检查结果并保留更完整的业务上下文。
 */
function sendRequestCard(params: {
  requestId: string
  chatId: string
  deps: InteractiveDeps
  card: object
  missingClientMessage: string
  sendFailureMessage: string
}): void {
  const { requestId, chatId, deps, card, missingClientMessage, sendFailureMessage } = params
  if (!deps.v2Client) {
    deps.log("warn", missingClientMessage, { requestId })
    return
  }
  // 先占住 requestId，避免同一条 SSE 在发送尚未完成时并发发出重复卡片。
  if (!requestId || !markSeen(requestId)) return

  void (async () => {
    const res = await sender.sendInteractiveCard(deps.feishuClient, chatId, card, deps.log)
    if (!res.ok) {
      // 发送失败要回滚占位，避免后续相同 requestId 永久失去重试机会。
      unmarkSeen(requestId)
      deps.log("error", sendFailureMessage, {
        requestId,
        chatId,
        error: res.error ?? "unknown",
      })
    }
  })().catch((err) => {
    // 交互卡片是增强能力，失败后不应让主链路崩溃。
    unmarkSeen(requestId)
    deps.log("error", sendFailureMessage, {
      requestId,
      chatId,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

/**
 * 发送权限审批卡片。
 *
 * 发送失败只记录日志，不阻断主对话流程。
 */
export function handlePermissionRequested(
  request: PermissionRequest,
  chatId: string,
  deps: InteractiveDeps,
  chatType: "p2p" | "group",
  sessionId: string,
): void {
  const requestId = String(request.id ?? "")
  sendRequestCard({
    requestId,
    chatId,
    deps,
    card: buildPermissionCardDSL(request, chatId, chatType, sessionId),
    missingClientMessage: "v2Client 未配置，跳过权限卡片发送",
    sendFailureMessage: "发送权限卡片失败",
  })
}

/**
 * 发送问答选择卡片。
 *
 * 当前实现只渲染第一题，适合“单问题、按钮式确认”的场景。
 */
export function handleQuestionRequested(
  request: QuestionRequest,
  chatId: string,
  deps: InteractiveDeps,
  chatType: "p2p" | "group",
  sessionId: string,
): void {
  const requestId = String(request.id ?? "")
  sendRequestCard({
    requestId,
    chatId,
    deps,
    card: buildQuestionCardDSL(request, chatId, chatType, sessionId),
    missingClientMessage: "v2Client 未配置，跳过问答卡片发送",
    sendFailureMessage: "发送问答卡片失败",
  })
}

/**
 * 飞书 `card.action.trigger` 回调里，本仓库真正关心的字段。
 *
 * 保持宽松结构是为了兼容飞书 SDK 事件体的版本差异。
 */
export interface CardActionData {
  actionValue: string | undefined
  actionTag: string | undefined
  messageId: string | undefined
  chatId: string | undefined
  operatorId: string | undefined
}

/**
 * 处理卡片点击后的异步回传。
 *
 * 这里只处理真正需要调用 OpenCode v2 API 的 payload；
 * 普通 `send_message` 按钮已经在 `gateway.ts` 中被转成合成消息事件。
 */
export async function handleCardAction(
  action: CardActionData,
  deps: InteractiveDeps,
): Promise<object | undefined> {
  const value = parseCardActionValue(action.actionValue, deps.log)
  if (!value || value.action === "send_message") {
    return buildCallbackResponse(action, deps.log)
  }

  if (value.action === "abort_reply") {
    const abortResult = requestAbortForRun({
      runId: value.runId,
      sessionId: value.sessionId,
      source: "card",
    })
    if (abortResult.outcome !== "accepted") {
      return buildToast(
        abortResult.outcome === "failed" ? "warning" : "info",
        abortResult.feedback,
      )
    }

    if (!deps.v2Client) {
      deps.log("warn", "v2Client 未配置，无法向 OpenCode 发起 abort", {
        runId: value.runId,
        sessionId: value.sessionId,
      })
      resetAbortForRun(value.runId)
      return buildToast("warning", "当前环境未启用中断能力")
    }

    // fire-and-forget 避免卡住飞书 3 秒回调窗口；requestAbortForRun 已把 run 置 aborting，toast 立即返回
    void deps.v2Client.session.abort({
      sessionID: value.sessionId,
    }).then(() => {
      const latestRun = getRunByRunId(value.runId)
      if (latestRun && !isTerminalRunState(latestRun.state)) {
        confirmAbortForRun(value.runId)
      }
    }).catch((err) => {
      resetAbortForRun(value.runId)
      deps.log("error", "abort_reply 后台 session.abort 失败", {
        runId: value.runId,
        sessionId: value.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    return buildToast("success", abortResult.feedback)
  }

  if (!deps.v2Client) {
    deps.log("warn", "v2Client 未配置，交互回调被忽略（按钮点击不会转发到 OpenCode）", {
      actionValue: action.actionValue,
    })
    return buildCallbackResponse(action, deps.log)
  }

  // 仅在 v2 API 确认成功后才把 detail phase 标记为 completed；失败时改为 error 避免误导用户以为已应答。
  const phaseId = value.action === "permission_reply" ? "permission" : "question"
  const label = value.action === "permission_reply" ? "等待授权" : "等待答复"
  const successBody = value.action === "permission_reply" ? "用户已回应权限请求。" : "用户已回答问题。"
  const failureBody = value.action === "permission_reply" ? "权限回调转发失败。" : "问答回调转发失败。"

  const emitPhase = (status: "completed" | "error", body: string): void => {
    emit(value.sessionId, {
      type: "details-updated",
      sessionId: value.sessionId,
      phase: {
        phaseId,
        label,
        status,
        body,
        updatedAt: new Date().toISOString(),
      },
    }, deps.log)
  }

  const onReplyFailed = (err: unknown): void => {
    deps.log("error", "交互回调处理失败", {
      action: value.action,
      requestId: value.requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    emitPhase("error", failureBody)
  }

  try {
    if (value.action === "permission_reply") {
      void deps.v2Client.permission.reply({
        requestID: value.requestId,
        reply: value.reply,
      }).then(() => emitPhase("completed", successBody)).catch(onReplyFailed)
    } else {
      void deps.v2Client.question.reply({
        requestID: value.requestId,
        answers: value.answers,
      }).then(() => emitPhase("completed", successBody)).catch(onReplyFailed)
    }
  } catch (err) {
    onReplyFailed(err)
  }

  return buildCallbackResponse(action, deps.log)
}

/**
 * 构建飞书要求的即时回调响应。
 *
 * 飞书要求 `card.action.trigger` 很快返回，因此这里只回 toast，
 * 真正的业务处理在后台异步完成。
 */
export function buildCallbackResponse(action: CardActionData, log?: LogFn): object {
  const value = parseCardActionValue(action.actionValue, log)
  if (!value) return {}

  if (value.action === "permission_reply") {
    const isReject = value.reply === "reject"
    return {
      toast: {
        type: isReject ? "warning" : "success",
        content: isReject ? "❌ 已拒绝" : "✅ 已允许",
      },
    }
  }

  if (value.action === "question_reply") {
    return {
      toast: { type: "success", content: "✅ 已回答" },
    }
  }

  if (value.action === "abort_reply") {
    return buildToast("success", "已接收中断请求，正在停止回答")
  }

  if (value.action === "send_message") {
    return {
      toast: { type: "info", content: "📨 已发送" },
    }
  }

  return {}
}

function buildToast(type: "success" | "warning" | "info", content: string): object {
  return { toast: { type, content } }
}

/**
 * 把权限请求翻译成统一的 card DSL。
 *
 * 这里的按钮通过 `actionPayload` 注入专用 JSON，
 * 不走普通 `send_message` 分支。
 */
function buildPermissionCardDSL(request: PermissionRequest, chatId: string, chatType: "p2p" | "group", sessionId: string): object {
  const permission = String(request.permission ?? "unknown")
  const patterns = Array.isArray(request.patterns) ? request.patterns.map(String) : []
  const requestId = String(request.id ?? "")

  const patternsText = patterns.length > 0
    ? patterns.map(p => `- \`${p}\``).join("\n")
    : "（无具体路径）"

  // 三个按钮对应 OpenCode permission.reply 支持的三种答复。
  const buttons: ButtonInput[] = [
    {
      text: "✅ 允许一次", value: "", style: "primary",
      actionPayload: { action: "permission_reply", requestId, sessionId, reply: "once" },
    },
    {
      text: "🔓 始终允许", value: "", style: "default",
      actionPayload: { action: "permission_reply", requestId, sessionId, reply: "always" },
    },
    {
      text: "❌ 拒绝", value: "", style: "danger",
      actionPayload: { action: "permission_reply", requestId, sessionId, reply: "reject" },
    },
  ]

  const sections: SectionInput[] = [
    { type: "markdown", content: `AI 请求以下权限:\n\n${patternsText}` },
    { type: "actions", buttons },
  ]

  const dsl = { title: `🔐 权限请求: ${permission}`, template: "orange", sections }
  return buildCardFromDSL(dsl, chatId, chatType)
}

/**
 * 把问答请求翻译成按钮卡片。
 *
 * 当前每个选项都会映射成一个按钮，点击后回传 `answers: [[value]]`。
 */
function buildQuestionCardDSL(request: QuestionRequest, chatId: string, chatType: "p2p" | "group", sessionId: string): object {
  const questions = request.questions ?? []
  const requestId = String(request.id ?? "")

  // 当前仅消费第一题；若未来支持多题，需要额外的表单状态设计。
  const q = questions[0]
  const header = String(q?.header ?? "AI 提问")
  const questionText = String(q?.question ?? "请选择")
  const options = Array.isArray(q?.options) ? q.options : []

  const buttons: ButtonInput[] = options.map((opt, idx) => ({
    text: String(opt.label ?? opt.value ?? `选项 ${idx + 1}`),
    value: "",
    style: idx === 0 ? "primary" as const : "default" as const,
    actionPayload: {
      action: "question_reply",
      requestId,
      sessionId,
      answers: [[String(opt.value ?? opt.label ?? "")]],
    },
  }))

  const sections: SectionInput[] = [
    { type: "markdown", content: questionText },
    ...(buttons.length > 0 ? [{ type: "actions" as const, buttons }] : []),
  ]

  const dsl = { title: header, template: "blue", sections }
  return buildCardFromDSL(dsl, chatId, chatType)
}
