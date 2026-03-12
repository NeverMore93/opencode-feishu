/**
 * 交互式卡片构建器：权限审批/问答选择
 */
import type { PermissionRequest, QuestionRequest } from "../types.js"

/** 问题信息结构（从 QuestionRequest.questions 数组中提取） */
type QuestionInfo = {
  question?: string
  header?: string
  options?: Array<{ label?: string; value?: string }>
}

/**
 * 构建权限审批卡片
 */
export function buildPermissionCard(request: PermissionRequest): object {
  const permission = String(request.permission ?? "unknown")
  const patterns = Array.isArray(request.patterns) ? request.patterns.map(String) : []
  const requestId = String(request.id ?? "")

  const patternsText = patterns.length > 0
    ? patterns.map(p => `- ${p}`).join("\n")
    : "（无具体路径）"

  return {
    type: "card_kit",
    data: {
      schema: "2.0",
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: `🔐 权限请求: ${permission}` },
        template: "orange",
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: `AI 请求以下权限:\n\n${patternsText}`,
          },
          {
            tag: "action",
            actions: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "✅ 允许一次" },
                type: "primary",
                value: JSON.stringify({ action: "permission_reply", requestId, reply: "once" }),
              },
              {
                tag: "button",
                text: { tag: "plain_text", content: "🔓 始终允许" },
                type: "default",
                value: JSON.stringify({ action: "permission_reply", requestId, reply: "always" }),
              },
              {
                tag: "button",
                text: { tag: "plain_text", content: "❌ 拒绝" },
                type: "danger",
                value: JSON.stringify({ action: "permission_reply", requestId, reply: "reject" }),
              },
            ],
          },
        ],
      },
    },
  }
}

/**
 * 构建问答选择卡片
 */
export function buildQuestionCard(request: QuestionRequest): object {
  const questions = Array.isArray(request.questions) ? request.questions : []
  const requestId = String(request.id ?? "")

  // 取第一个问题（通常只有一个）
  const q = questions[0] as QuestionInfo | undefined
  const header = String(q?.header ?? "AI 提问")
  const questionText = String(q?.question ?? "请选择")
  const options = Array.isArray(q?.options) ? q.options : []

  const buttons = options.map((opt, idx) => ({
    tag: "button",
    text: { tag: "plain_text", content: String(opt.label ?? opt.value ?? `选项 ${idx + 1}`) },
    type: idx === 0 ? "primary" : "default",
    value: JSON.stringify({
      action: "question_reply",
      requestId,
      answers: [[String(opt.label ?? opt.value ?? "")]],
    }),
  }))

  return {
    type: "card_kit",
    data: {
      schema: "2.0",
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: header },
        template: "blue",
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: questionText,
          },
          ...(buttons.length > 0
            ? [{ tag: "action", actions: buttons }]
            : []),
        ],
      },
    },
  }
}
