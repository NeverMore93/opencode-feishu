/**
 * 交互式事件处理：权限审批/问答卡片发送 + 回调分发
 */
import type { PermissionRequest, QuestionRequest, LogFn } from "../types.js"
import { buildPermissionCard, buildQuestionCard } from "../feishu/card-builder.js"
import * as sender from "../feishu/sender.js"
import type * as Lark from "@larksuiteoapi/node-sdk"
import { TtlMap } from "../utils/ttl-map.js"

export interface InteractiveDeps {
  feishuClient: InstanceType<typeof Lark.Client>
  log: LogFn
  v2Client?: {
    permission: { reply: (opts: { path: { requestID: string }; body: { reply: string; message?: string } }) => Promise<unknown> }
    question: {
      reply: (opts: { path: { requestID: string }; body: { answers: string[][] } }) => Promise<unknown>
      reject: (opts: { path: { requestID: string } }) => Promise<unknown>
    }
  }
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
): void {
  if (!deps.v2Client) {
    deps.log("warn", "v2Client 未配置，跳过权限卡片发送", { requestId: String(request.id ?? "") })
    return
  }
  const requestId = String(request.id ?? "")
  if (!requestId || !markSeen(requestId)) return

  const card = buildPermissionCard(request)
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
): void {
  if (!deps.v2Client) {
    deps.log("warn", "v2Client 未配置，跳过问答卡片发送", { requestId: String(request.id ?? "") })
    return
  }
  const requestId = String(request.id ?? "")
  if (!requestId || !markSeen(requestId)) return

  const card = buildQuestionCard(request)
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

  type PermissionReplyValue = { action: "permission_reply"; requestId: string; reply: string }
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
        path: { requestID: requestId },
        body: { reply: value.reply },
      })
    } else if (value.action === "question_reply" && "answers" in value) {
      await deps.v2Client.question.reply({
        path: { requestID: requestId },
        body: { answers: value.answers },
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

  return {}
}
