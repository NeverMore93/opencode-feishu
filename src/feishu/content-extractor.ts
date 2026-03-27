/**
 * 飞书消息内容提取：将不同类型的飞书消息转换为 OpenCode SDK 的 parts 数组
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"
import { downloadMessageResource, guessMimeByFilename, type DownloadResult } from "./resource.js"

/** OpenCode SDK 兼容的 part 输入类型 */
export type PromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; url: string; filename?: string }

/**
 * 将飞书消息转换为 OpenCode parts 数组
 *
 * @param feishuClient 飞书 SDK 客户端
 * @param messageId 飞书消息 ID
 * @param messageType 消息类型（text, image, post, file, audio, media, etc.）
 * @param rawContent 原始 JSON content 字符串
 * @param log 日志函数
 * @returns parts 数组，至少包含一个元素
 */
export async function extractParts(
  feishuClient: InstanceType<typeof Lark.Client>,
  messageId: string,
  messageType: string,
  rawContent: string,
  log: LogFn,
  maxResourceSize: number,
): Promise<PromptPart[]> {
  try {
    switch (messageType) {
      case "text":
        return extractText(rawContent)
      case "image":
        return await extractImage(feishuClient, messageId, rawContent, log, maxResourceSize)
      case "post":
        return await extractPost(feishuClient, messageId, rawContent, log, maxResourceSize)
      case "file":
        return await extractFile(feishuClient, messageId, rawContent, log, maxResourceSize)
      case "audio":
        return await extractAudio(feishuClient, messageId, rawContent, log, maxResourceSize)
      case "media":
        return extractMediaFallback()
      case "sticker":
        return [{ type: "text", text: "[表情包]" }]
      case "interactive":
        return extractInteractive(rawContent)
      case "share_chat":
        return extractShareChat(rawContent)
      case "share_user":
        return [{ type: "text", text: "[分享了一个用户名片]" }]
      case "merge_forward":
        return [{ type: "text", text: "[合并转发消息]" }]
      default:
        return [{ type: "text", text: `[不支持的消息类型: ${messageType}]` }]
    }
  } catch (err) {
    log("warn", "消息内容提取失败", {
      messageId,
      messageType,
      error: err instanceof Error ? err.message : String(err),
    })
    return [{ type: "text", text: `[消息内容提取失败: ${messageType}]` }]
  }
}

/**
 * 为历史摄入生成文本描述（不下载资源）
 */
export function describeMessageType(messageType: string, rawContent: string): string {
  switch (messageType) {
    case "text": {
      try {
        const parsed = JSON.parse(rawContent) as { text?: string }
        return (parsed.text ?? "").trim()
      } catch {
        return ""
      }
    }
    case "image":
      return "[图片]"
    case "post":
      return extractPostText(rawContent)
    case "file": {
      try {
        const parsed = JSON.parse(rawContent) as { file_name?: string }
        return `[文件: ${parsed.file_name ?? "未知文件"}]`
      } catch {
        return "[文件]"
      }
    }
    case "audio":
      return "[语音消息]"
    case "media":
      return "[视频消息]"
    case "sticker":
      return "[表情包]"
    case "interactive":
      return "[卡片消息]"
    case "share_chat":
      return "[群分享]"
    case "share_user":
      return "[用户名片]"
    case "merge_forward":
      return "[合并转发]"
    default:
      return `[${messageType}]`
  }
}

// ── 各类型提取逻辑 ──

function extractText(rawContent: string): PromptPart[] {
  const parsed = JSON.parse(rawContent) as { text?: string }
  const text = (parsed.text ?? "").trim()
  if (!text) return []
  return [{ type: "text", text }]
}

async function extractImage(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  rawContent: string,
  log: LogFn,
  maxResourceSize: number,
): Promise<PromptPart[]> {
  const parsed = JSON.parse(rawContent) as { image_key?: string }
  const imageKey = parsed.image_key
  if (!imageKey) return [{ type: "text", text: "[图片: 无法获取]" }]

  const result = await downloadMessageResource(client, messageId, imageKey, "image", log, maxResourceSize)
  if (!result.resource) {
    return [{ type: "text", text: formatDownloadFailure("图片", result, maxResourceSize) }]
  }

  return [{ type: "file", mime: result.resource.mime, url: result.resource.dataUrl }]
}

async function extractPost(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  rawContent: string,
  log: LogFn,
  maxResourceSize: number,
): Promise<PromptPart[]> {
  try {
    const parsed = JSON.parse(rawContent) as {
      title?: string
      content?: Array<Array<{ tag?: string; text?: string; href?: string; image_key?: string }>>
    }
    const parts: PromptPart[] = []
    const textLines: string[] = []

    if (parsed.title) textLines.push(parsed.title)

    if (Array.isArray(parsed.content)) {
      for (const paragraph of parsed.content) {
        if (!Array.isArray(paragraph)) continue
        const segments: string[] = []
        for (const element of paragraph) {
          if (element.tag === "text" && element.text) {
            segments.push(element.text)
          } else if (element.tag === "a" && element.text) {
            segments.push(element.href ? `${element.text}(${element.href})` : element.text)
          } else if (element.tag === "at" && element.text) {
            segments.push(element.text)
          } else if (element.tag === "img" && element.image_key) {
            // 先把之前积累的文本作为一个 text part
            if (segments.length) {
              textLines.push(segments.join(""))
              segments.length = 0
            }
            if (textLines.length) {
              parts.push({ type: "text", text: textLines.join("\n") })
              textLines.length = 0
            }
            // 下载内嵌图片
            const result = await downloadMessageResource(client, messageId, element.image_key, "image", log, maxResourceSize)
            if (result.resource) {
              parts.push({ type: "file", mime: result.resource.mime, url: result.resource.dataUrl })
            } else {
              parts.push({ type: "text", text: formatDownloadFailure("富文本图片", result, maxResourceSize) })
            }
          } else if (element.tag === "img") {
            segments.push("[图片]")
          }
        }
        if (segments.length) textLines.push(segments.join(""))
      }
    }

    // 剩余文本
    if (textLines.length) {
      parts.push({ type: "text", text: textLines.join("\n").trim() })
    }

    return parts.length ? parts : []
  } catch {
    return []
  }
}

/** 纯文本提取（用于 describeMessageType 和 history） */
function extractPostText(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as {
      title?: string
      content?: Array<Array<{ tag?: string; text?: string; href?: string }>>
    }
    const lines: string[] = []
    if (parsed.title) lines.push(parsed.title)
    if (Array.isArray(parsed.content)) {
      for (const paragraph of parsed.content) {
        if (!Array.isArray(paragraph)) continue
        const segments: string[] = []
        for (const element of paragraph) {
          if (element.tag === "text" && element.text) segments.push(element.text)
          else if (element.tag === "a" && element.text) segments.push(element.href ? `${element.text}(${element.href})` : element.text)
          else if (element.tag === "at" && element.text) segments.push(element.text)
          else if (element.tag === "img") segments.push("[图片]")
        }
        if (segments.length) lines.push(segments.join(""))
      }
    }
    return lines.join("\n").trim()
  } catch {
    return ""
  }
}

async function extractFile(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  rawContent: string,
  log: LogFn,
  maxResourceSize: number,
): Promise<PromptPart[]> {
  const parsed = JSON.parse(rawContent) as { file_key?: string; file_name?: string }
  const fileKey = parsed.file_key
  const fileName = parsed.file_name ?? "未知文件"

  if (!fileKey) return [{ type: "text", text: `[文件: ${fileName}]` }]

  const mime = guessMimeByFilename(fileName)
  const result = await downloadMessageResource(client, messageId, fileKey, "file", log, maxResourceSize)
  if (!result.resource) {
    return [{ type: "text", text: formatDownloadFailure(fileName, result, maxResourceSize) }]
  }

  return [{ type: "file", mime: result.resource.mime || mime, url: result.resource.dataUrl, filename: fileName }]
}

async function extractAudio(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  rawContent: string,
  log: LogFn,
  maxResourceSize: number,
): Promise<PromptPart[]> {
  const parsed = JSON.parse(rawContent) as { file_key?: string }
  const fileKey = parsed.file_key

  if (!fileKey) return [{ type: "text", text: "[语音: 无法获取]" }]

  const result = await downloadMessageResource(client, messageId, fileKey, "file", log, maxResourceSize)
  if (!result.resource) {
    return [{ type: "text", text: formatDownloadFailure("语音", result, maxResourceSize) }]
  }

  return [{ type: "file", mime: result.resource.mime || "audio/opus", url: result.resource.dataUrl }]
}

function extractMediaFallback(): PromptPart[] {
  // 视频通常较大，默认不下载，仅文本描述
  return [{ type: "text", text: "[视频消息]" }]
}

function formatDownloadFailure(label: string, result: DownloadResult, maxSize: number): string {
  if (result.reason === "too_large" && result.totalSize) {
    const sizeMB = (result.totalSize / (1024 * 1024)).toFixed(1)
    const limitMB = (maxSize / (1024 * 1024)).toFixed(0)
    return `[文件过大: ${label}, 已下载 ${sizeMB}MB 时超出 ${limitMB}MB 限制]`
  }
  return `[下载失败: ${label}]`
}

function extractInteractive(rawContent: string): PromptPart[] {
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>
    const texts: string[] = []

    // header title
    const header = parsed.header as { title?: { content?: string } } | undefined
    if (header?.title?.content) texts.push(header.title.content)

    // Card 2.0: body.elements; Card 1.0: top-level elements
    const body = parsed.body as { elements?: unknown[] } | undefined
    const elements = (body?.elements ?? parsed.elements) as Array<Record<string, unknown>> | undefined
    if (Array.isArray(elements)) {
      collectTexts(elements, texts)
    }

    const text = texts.join("\n").trim()
    return text ? [{ type: "text", text: `[卡片消息]\n${text}` }] : [{ type: "text", text: "[卡片消息]" }]
  } catch {
    return [{ type: "text", text: "[卡片消息]" }]
  }
}

/** 递归提取卡片元素中的文本内容 */
function collectTexts(elements: Array<Record<string, unknown>>, out: string[]): void {
  for (const el of elements) {
    const tag = el.tag as string | undefined
    if (!tag) continue

    // markdown / plain_text 直接取 content
    if ((tag === "markdown" || tag === "plain_text") && typeof el.content === "string") {
      out.push(el.content)
    }
    // div 取 text.content
    else if (tag === "div") {
      const text = el.text as { content?: string } | undefined
      if (text?.content) out.push(text.content)
    }
    // note 递归 elements
    else if (tag === "note" && Array.isArray(el.elements)) {
      collectTexts(el.elements as Array<Record<string, unknown>>, out)
    }
    // table: 提取表头和行数据为 markdown 表格
    else if (tag === "table") {
      extractTable(el, out)
    }
    // column_set / column: 递归子元素
    else if ((tag === "column_set" || tag === "column") && Array.isArray(el.columns ?? el.elements)) {
      collectTexts((el.columns ?? el.elements) as Array<Record<string, unknown>>, out)
    }
    // action 按钮组: 提取按钮文本
    else if (tag === "action" && Array.isArray(el.actions)) {
      for (const btn of el.actions as Array<Record<string, unknown>>) {
        const btnText = btn.text as { content?: string } | undefined
        if (btnText?.content) out.push(`[按钮: ${btnText.content}]`)
      }
    }
  }
}

/** 提取 table 元素为 markdown 表格格式 */
function extractTable(el: Record<string, unknown>, out: string[]): void {
  const columns = el.columns as Array<{ name?: string; data_type?: string }> | undefined
  const rows = el.rows as Array<Record<string, unknown>> | undefined
  if (!columns?.length) return

  // 表头
  const headers = columns.map(c => c.name ?? "")
  out.push("| " + headers.join(" | ") + " |")
  out.push("| " + headers.map(() => "---").join(" | ") + " |")

  // 行数据
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const cells = headers.map(h => {
        const val = row[h]
        return val != null ? String(val) : ""
      })
      out.push("| " + cells.join(" | ") + " |")
    }
  }
}

function extractShareChat(rawContent: string): PromptPart[] {
  try {
    const parsed = JSON.parse(rawContent) as { chat_id?: string }
    return [{ type: "text", text: `[分享了一个群聊${parsed.chat_id ? `: ${parsed.chat_id}` : ""}]` }]
  } catch {
    return [{ type: "text", text: "[群分享]" }]
  }
}
