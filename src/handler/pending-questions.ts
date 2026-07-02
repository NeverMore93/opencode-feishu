import type { QuestionRequest, LogFn } from "../types.js"
import * as sender from "../feishu/sender.js"
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { TtlMap } from "../utils/ttl-map.js"
import { emit } from "./action-bus.js"

const PENDING_QUESTION_TTL_MS = 10 * 60 * 1_000

interface PendingQuestion {
  requestId: string
  sessionId: string
  chatId: string
  request: QuestionRequest
}

export interface PendingQuestionDeps {
  feishuClient: InstanceType<typeof Lark.Client>
  log: LogFn
  v2Client?: OpencodeClient
}

export interface ParsedPendingQuestionReply {
  answers: string[][]
  displayText: string
}

const pendingByChatId = new TtlMap<PendingQuestion>(PENDING_QUESTION_TTL_MS)
const chatIdByRequestId = new TtlMap<string>(PENDING_QUESTION_TTL_MS)

export function registerPendingQuestion(params: {
  request: QuestionRequest
  chatId: string
  sessionId: string
}): void {
  const requestId = String(params.request.id ?? "")
  if (!requestId) return

  pendingByChatId.set(params.chatId, {
    requestId,
    sessionId: params.sessionId,
    chatId: params.chatId,
    request: params.request,
  })
  chatIdByRequestId.set(requestId, params.chatId)
}

export function clearPendingQuestionByRequestId(requestId: string): void {
  const chatId = chatIdByRequestId.get(requestId)
  if (chatId) pendingByChatId.delete(chatId)
  chatIdByRequestId.delete(requestId)
}

export function buildQuestionFallbackText(request: QuestionRequest): string {
  const question = getFirstQuestion(request)
  const header = String(question?.header ?? "AI 提问")
  const questionText = String(question?.question ?? "请选择")
  const options = normalizeOptions(request)

  const lines = [`${header}`, "", questionText]
  if (options.length > 0) {
    lines.push("", "可选回复：")
    options.forEach((option, idx) => {
      lines.push(`${idx + 1}. ${option.label}`)
    })
  }
  lines.push("", "你可以直接回复 1/2，或回复“继续”“取消”。")
  return lines.join("\n")
}

export function parsePendingQuestionReply(
  content: string,
  request: QuestionRequest,
): ParsedPendingQuestionReply | undefined {
  const text = content.trim()
  if (!text) return undefined

  const options = normalizeOptions(request)
  const lower = text.toLowerCase()

  if (/^[1-9]\d*$/.test(text)) {
    const idx = Number(text) - 1
    if (options.length === 0) return { answers: [[text]], displayText: text }
    if (idx >= 0 && idx < options.length) {
      const selected = options[idx]
      return { answers: [[selected.value]], displayText: selected.label }
    }
    return undefined
  }

  if (isContinueText(lower, text)) {
    const selected = findOption(options, ["继续", "continue", "proceed", "yes", "allow", "approve"]) ?? options[0]
    return {
      answers: [[selected?.value ?? text]],
      displayText: selected?.label ?? text,
    }
  }

  if (isCancelText(lower, text)) {
    const selected = findOption(options, ["取消", "cancel", "stop", "reject", "deny", "no"])
    return {
      answers: [[selected?.value ?? text]],
      displayText: selected?.label ?? text,
    }
  }

  return undefined
}

export async function tryResolvePendingQuestionText(params: {
  chatId: string
  content: string
  deps: PendingQuestionDeps
}): Promise<boolean> {
  const pending = pendingByChatId.get(params.chatId)
  if (!pending) return false

  const parsed = parsePendingQuestionReply(params.content, pending.request)
  if (!parsed) return false

  if (!params.deps.v2Client) {
    params.deps.log("warn", "OpenCode client 未配置，无法处理纯文本问答回复", {
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      chatId: params.chatId,
    })
    await sender.sendTextMessage(params.deps.feishuClient, params.chatId, "当前环境无法提交这个回答，请稍后重试。", params.deps.log)
    return true
  }

  try {
    await params.deps.v2Client.question.reply({
      requestID: pending.requestId,
      answers: parsed.answers,
    })
    clearPendingQuestionByRequestId(pending.requestId)
    emitQuestionPhase(pending.sessionId, "completed", "用户已通过纯文本回答问题。", params.deps.log)
    await sender.sendTextMessage(params.deps.feishuClient, params.chatId, `已收到选择：${parsed.displayText}`, params.deps.log)
  } catch (err) {
    params.deps.log("error", "纯文本问答回复提交失败", {
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      chatId: params.chatId,
      error: err instanceof Error ? err.message : String(err),
    })
    emitQuestionPhase(pending.sessionId, "error", "问答回调转发失败。", params.deps.log)
    await sender.sendTextMessage(params.deps.feishuClient, params.chatId, "提交回答失败，请稍后重试。", params.deps.log)
  }

  return true
}

function emitQuestionPhase(
  sessionId: string,
  status: "completed" | "error",
  body: string,
  log: LogFn,
): void {
  emit(sessionId, {
    type: "details-updated",
    sessionId,
    phase: {
      phaseId: "question",
      label: "等待答复",
      status,
      body,
      updatedAt: new Date().toISOString(),
    },
  }, log)
}

function getFirstQuestion(request: QuestionRequest): NonNullable<QuestionRequest["questions"]>[number] | undefined {
  return request.questions?.[0]
}

function normalizeOptions(request: QuestionRequest): Array<{ label: string; value: string }> {
  const rawOptions = getFirstQuestion(request)?.options
  if (!Array.isArray(rawOptions)) return []
  return rawOptions
    .map((option, idx) => ({
      label: String(option.label ?? option.value ?? `选项 ${idx + 1}`),
      value: String(option.value ?? option.label ?? ""),
    }))
    .filter((option) => option.value.trim().length > 0 || option.label.trim().length > 0)
}

function findOption(
  options: Array<{ label: string; value: string }>,
  needles: string[],
): { label: string; value: string } | undefined {
  return options.find((option) => {
    const haystack = `${option.label}\n${option.value}`.toLowerCase()
    return needles.some((needle) => haystack.includes(needle.toLowerCase()))
  })
}

function isContinueText(lower: string, raw: string): boolean {
  return lower === "continue" || lower === "go on" || raw === "继续" || raw === "继续执行"
}

function isCancelText(lower: string, raw: string): boolean {
  return lower === "cancel" || lower === "stop" || raw === "取消" || raw === "停止"
}
