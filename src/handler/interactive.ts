/**
 * 交互式事件处理：权限审批/问答卡片发送 + 回调分发
 */
import type { PermissionRequest, QuestionRequest, LogFn } from "../types.js"
import { buildCardFromDSL, type ButtonInput, type SectionInput } from "../tools/send-card.js"
import * as sender from "../feishu/sender.js"
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { TtlMap } from "../utils/ttl-map.js"

export interface InteractiveDeps {
  feishuClient: InstanceType<typeof Lark.Client>
  log: LogFn
  v2Client?: OpencodeClient
}

/** 去重：同一 requestId 只发一张卡片（TTL 防止内存泄漏） */
const seenIds = new TtlMap<true>(10 * 60 * 1_000)

function markSeen(requestId: string): boolean {
  if (seenIds.has(requestId)) return false
  seenIds.set(requestId, true)
  return true
}

export function handlePermissionRequested(
  request: PermissionRequest,
  chatId: string,
  deps: InteractiveDeps,
  chatType: "p2p" | "group" = "p2p",
): void {
  if (!deps.v2Client) {
    deps.log("warn", "v2Client 未配置，跳过权限卡片发送", { requestId: String(request.id ?? "") })
    return
  }
  const requestId = String(request.id ?? "")
  if (!requestId || !markSeen(requestId)) return

  const card = buildPermissionCardDSL(request, chatId, chatType)
  sender.sendInteractiveCard(deps.feishuClient, chatId, card).catch((err) => {
    deps.log("warn", "发送权限卡片失败", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

export function handleQuestionRequested(
  request: QuestionRequest,
  chatId: string,
  deps: InteractiveDeps,
  chatType: "p2p" | "group" = "p2p",
): void {
  if (!deps.v2Client) {
    deps.log("warn", "v2Client 未配置，跳过问答卡片发送", { requestId: String(request.id ?? "") })
    return
  }
  const requestId = String(request.id ?? "")
  if (!requestId || !markSeen(requestId)) return

  const card = buildQuestionCardDSL(request, chatId, chatType)
  sender.sendInteractiveCard(deps.feishuClient, chatId, card).catch((err) => {
    deps.log("warn", "发送问答卡片失败", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

export interface CardActionData {
  actionValue: string | undefined
  actionTag: string | undefined
  messageId: string | undefined
  chatId: string | undefined
  operatorId: string | undefined
}

/**
 * 处理卡片按钮点击回调（异步，不阻塞回调返回）
 */
export async function handleCardAction(
  action: CardActionData,
  deps: InteractiveDeps,
): Promise<void> {
  if (!action.actionValue) return
  if (!deps.v2Client) {
    deps.log("warn", "v2Client 未配置，交互回调被忽略（按钮点击不会转发到 OpenCode）", {
      actionValue: action.actionValue,
    })
    return
  }

  type PermissionReplyValue = { action: "permission_reply"; requestId: string; reply: "once" | "always" | "reject" }
  type QuestionReplyValue = { action: "question_reply"; requestId: string; answers: string[][] }
  type ActionValue = PermissionReplyValue | QuestionReplyValue | { action?: string; requestId?: string }

  let value: ActionValue
  try {
    value = JSON.parse(action.actionValue)
  } catch {
    return
  }

  const requestId = value.requestId
  if (!requestId) return

  try {
    if (value.action === "permission_reply" && "reply" in value) {
      await deps.v2Client.permission.reply({
        requestID: requestId,
        reply: value.reply,
      })
    } else if (value.action === "question_reply" && "answers" in value) {
      await deps.v2Client.question.reply({
        requestID: requestId,
        answers: value.answers,
      })
    }
  } catch (err) {
    deps.log("error", "交互回调处理失败", {
      action: value.action,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * 构建即时回调响应（3 秒内返回 toast）
 */
export function buildCallbackResponse(action: CardActionData): object {
  if (!action.actionValue) return {}

  let value: { action?: string; reply?: string }
  try {
    value = JSON.parse(action.actionValue)
  } catch {
    return {}
  }

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

  if (value.action === "send_message") {
    return {
      toast: { type: "info", content: "📨 已发送" },
    }
  }

  return {}
}

/**
 * 使用统一 DSL 构建权限审批卡片
 */
function buildPermissionCardDSL(request: PermissionRequest, chatId: string, chatType: "p2p" | "group"): object {
  const permission = String(request.permission ?? "unknown")
  const patterns = Array.isArray(request.patterns) ? request.patterns.map(String) : []
  const requestId = String(request.id ?? "")

  const patternsText = patterns.length > 0
    ? patterns.map(p => `- \`${p}\``).join("\n")
    : "（无具体路径）"

  const buttons: ButtonInput[] = [
    {
      text: "✅ 允许一次", value: "", style: "primary",
      actionPayload: { action: "permission_reply", requestId, reply: "once" },
    },
    {
      text: "🔓 始终允许", value: "", style: "default",
      actionPayload: { action: "permission_reply", requestId, reply: "always" },
    },
    {
      text: "❌ 拒绝", value: "", style: "danger",
      actionPayload: { action: "permission_reply", requestId, reply: "reject" },
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
 * 使用统一 DSL 构建问答选择卡片
 */
function buildQuestionCardDSL(request: QuestionRequest, chatId: string, chatType: "p2p" | "group"): object {
  const questions = request.questions ?? []
  const requestId = String(request.id ?? "")

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
