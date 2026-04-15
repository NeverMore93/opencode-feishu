import type { CardKitSchema } from "./cardkit.js"
import type { PromptPart } from "./content-extractor.js"
import type { ReplyRunState, ReplyTerminalState } from "../handler/reply-run-registry.js"
import type { DetailPhaseSnapshot, DetailPhaseStatus } from "../types.js"
import { cleanMarkdown, truncateMarkdown } from "./markdown.js"

// Re-export 保持其他 feishu 模块（streaming-card）的 import 路径不变。
export type { DetailPhaseSnapshot, DetailPhaseStatus }

export const TITLE_ELEMENT_ID = "reply_title"
export const STATUS_ELEMENT_ID = "reply_status"
export const CONCLUSION_ELEMENT_ID = "reply_conclusion"
export const DETAILS_ELEMENT_ID = "reply_details"
export const DETAILS_CONTENT_ELEMENT_ID = "reply_details_content"
export const ACTIONS_ELEMENT_ID = "reply_actions"

const DEFAULT_TITLE = "AI 回复"
const DEFAULT_CONCLUSION = "正在整理结果..."
const MAX_TITLE_LENGTH = 72

type HeaderTemplate = "blue" | "green" | "orange" | "red" | "purple" | "grey"

export interface AbortActionValue {
  action: "abort_reply"
  runId: string
  sessionId: string
  source?: string
  cardVersion?: number
}

export interface ReplyCardAction {
  kind: "abort"
  text: string
  style: "primary" | "default" | "danger"
  disabled?: boolean
  value: AbortActionValue
}

export interface ReplyCardView {
  runId: string
  title: string
  compactStatus: string
  conclusion: string
  detailsCollapsed: boolean
  detailsMarkdown?: string
  terminalState?: ReplyTerminalState
  actions: ReplyCardAction[]
  fallbackMode: "structured" | "simple"
  headerTemplate: HeaderTemplate
}

export function normalizeReplyTitle(input: string, fallback = DEFAULT_TITLE): string {
  const normalized = input
    .replace(/\r/g, "\n")
    .replace(/\n+/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/\s+/g, " ")
    .replace(/[`*_#>\[\]]/g, "")
    .trim()

  if (!normalized) return fallback
  if (normalized.length <= MAX_TITLE_LENGTH) return normalized
  return normalized.slice(0, MAX_TITLE_LENGTH - 1).trimEnd() + "…"
}

export function deriveReplyTitleFromParts(parts: readonly PromptPart[]): string {
  const text = parts
    .filter((part): part is Extract<PromptPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")

  const withoutQuotePrefix = text.replace(/^\[回复消息\]:[\s\S]*?---\s*/u, "")
  const withoutSpeakerPrefix = withoutQuotePrefix.replace(/^\[[^\]]+\]:\s*/u, "")
  return normalizeReplyTitle(withoutSpeakerPrefix)
}

export function buildCompactStatus(state: ReplyRunState): string {
  switch (state) {
    case "starting":
      return "⏳ 正在建立结果卡"
    case "running":
      return "⏳ 正在生成结论"
    case "completing":
      return "✅ 正在收尾"
    case "aborting":
      return "🛑 正在中断"
    case "completed":
      return "✅ 已完成"
    case "aborted":
      return "⛔ 已中断"
    case "failed":
      return "❌ 已失败"
    case "timed_out":
      return "⚠️ 已超时"
    default:
      return "⏳ 处理中"
  }
}

export function resolveHeaderTemplate(
  state: ReplyRunState,
  terminalState?: ReplyTerminalState,
): HeaderTemplate {
  const terminal = terminalState ?? toTerminalState(state)
  switch (terminal) {
    case "completed":
      return "green"
    case "failed":
      return "red"
    case "timed_out":
    case "aborted":
      return "orange"
    default:
      return "blue"
  }
}

export function toTerminalState(state: ReplyRunState): ReplyTerminalState | undefined {
  switch (state) {
    case "completed":
      return "completed"
    case "failed":
      return "failed"
    case "timed_out":
      return "timed_out"
    case "aborted":
      return "aborted"
    default:
      return undefined
  }
}

export function buildAbortAction(runId: string, sessionId: string, cardVersion = 1): ReplyCardAction {
  return {
    kind: "abort",
    text: "中断回答",
    style: "danger",
    value: {
      action: "abort_reply",
      runId,
      sessionId,
      source: "reply-card",
      cardVersion,
    },
  }
}

export function buildDetailsMarkdown(phases: Iterable<DetailPhaseSnapshot>): string | undefined {
  const sections: string[] = []

  for (const phase of phases) {
    const body = normalizeBlockMarkdown(phase.body)
    const toolSummary = Array.isArray(phase.toolSummary) && phase.toolSummary.length > 0
      ? phase.toolSummary.map((item) => `- ${item}`).join("\n")
      : ""

    if (!body && !toolSummary) continue

    const phaseSections = [
      `### ${formatPhaseIcon(phase.status)} ${phase.label}`,
      body,
      toolSummary ? `**工具进度**\n${toolSummary}` : "",
    ].filter(Boolean)

    sections.push(phaseSections.join("\n\n"))
  }

  if (sections.length === 0) return undefined
  return truncateMarkdown(sections.join("\n\n---\n\n"))
}

export function createReplyCardView(params: {
  runId: string
  title: string
  state: ReplyRunState
  conclusion?: string
  detailsMarkdown?: string
  actions?: ReplyCardAction[]
  fallbackMode?: "structured" | "simple"
  terminalState?: ReplyTerminalState
}): ReplyCardView {
  const title = normalizeReplyTitle(params.title)
  const conclusion = normalizeBlockMarkdown(params.conclusion ?? "") || DEFAULT_CONCLUSION
  const terminalState = params.terminalState ?? toTerminalState(params.state)
  return {
    runId: params.runId,
    title,
    compactStatus: buildCompactStatus(params.state),
    conclusion,
    detailsCollapsed: true,
    detailsMarkdown: params.detailsMarkdown,
    terminalState,
    actions: params.actions ?? [],
    fallbackMode: params.fallbackMode ?? "structured",
    headerTemplate: resolveHeaderTemplate(params.state, terminalState),
  }
}

export function buildReplyCardSchema(view: ReplyCardView): CardKitSchema {
  const elements: Array<Record<string, unknown>> = [
    buildMarkdownElement(TITLE_ELEMENT_ID, buildTitleMarkdown(view.title)),
    buildMarkdownElement(STATUS_ELEMENT_ID, buildStatusMarkdown(view.compactStatus)),
    buildMarkdownElement(CONCLUSION_ELEMENT_ID, buildConclusionMarkdown(view.conclusion)),
  ]

  const detailsElement = buildDetailsElement(view.detailsMarkdown)
  if (detailsElement) elements.push(detailsElement)

  const actionsElement = buildActionsElement(view.actions)
  if (actionsElement) elements.push(actionsElement)

  return {
    data: {
      schema: "2.0",
      config: {
        streaming_mode: true,
        wide_screen_mode: true,
      },
      header: {
        title: { tag: "plain_text", content: "AI 回复" },
        template: view.headerTemplate,
      },
      body: {
        elements,
      },
    },
  }
}

export function buildTitleMarkdown(title: string): string {
  return `**主题**\n${normalizeReplyTitle(title)}`
}

export function buildStatusMarkdown(status: string): string {
  return `**状态**\n${status.trim()}`
}

export function buildConclusionMarkdown(conclusion: string): string {
  return `**结论**\n${normalizeBlockMarkdown(conclusion) || DEFAULT_CONCLUSION}`
}

export function buildDetailsElement(detailsMarkdown: string | undefined): Record<string, unknown> | undefined {
  const content = normalizeBlockMarkdown(detailsMarkdown ?? "")
  if (!content) return undefined

  return {
    tag: "collapsible_panel",
    element_id: DETAILS_ELEMENT_ID,
    expanded: false,
    header: {
      title: {
        tag: "plain_text",
        content: "详细步骤",
      },
    },
    elements: [
      buildMarkdownElement(DETAILS_CONTENT_ELEMENT_ID, content),
    ],
  }
}

export function buildActionsElement(actions: readonly ReplyCardAction[]): Record<string, unknown> | undefined {
  if (actions.length === 0) return undefined

  return {
    tag: "column_set",
    element_id: ACTIONS_ELEMENT_ID,
    flex_mode: "none",
    background_style: "default",
    columns: actions.map((action) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [{
        tag: "button",
        text: { tag: "plain_text", content: action.text },
        type: action.style,
        value: action.value,
        ...(action.disabled ? { disabled: true } : {}),
      }],
    })),
  }
}

export function buildSimpleFallbackText(view: ReplyCardView): string {
  const sections = [
    `【${view.title || DEFAULT_TITLE}】`,
    `状态：${view.compactStatus}`,
    `结论：\n${normalizeBlockMarkdown(view.conclusion) || DEFAULT_CONCLUSION}`,
  ]

  const details = normalizeBlockMarkdown(view.detailsMarkdown ?? "")
  if (details) {
    sections.push(`详细步骤：\n${details}`)
  }

  if (view.terminalState) {
    // 用本地化的 compactStatus 文案，避免把 enum 原值（completed/failed/aborted/…）泄露到用户可读面。
    sections.push(`终态：${buildCompactStatus(view.terminalState)}`)
  }

  return truncateMarkdown(cleanMarkdown(sections.join("\n\n")))
}

function buildMarkdownElement(elementId: string, content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    element_id: elementId,
    content,
  }
}

function normalizeBlockMarkdown(content: string): string {
  const cleaned = cleanMarkdown(content)
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return cleaned ? truncateMarkdown(cleaned) : ""
}

function formatPhaseIcon(status: DetailPhaseStatus): string {
  switch (status) {
    case "completed":
      return "✅"
    case "error":
      return "❌"
    default:
      return "🔄"
  }
}
