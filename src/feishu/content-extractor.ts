/**
 * 飞书消息内容提取层。
 *
 * 目标是把飞书侧丰富且异构的消息类型，
 * 统一翻译成 OpenCode 可消费的 `PromptPart[]`。
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"
import { downloadMessageResource, guessMimeByFilename, type DownloadResult } from "./resource.js"

/** OpenCode 侧当前真正会消费的 part 结构。 */
export type PromptPart =
  | { type: "text"; text: string; metadata?: Record<string, unknown> }
  | { type: "file"; mime: string; url: string; filename?: string }

type PostElement = { tag?: string; text?: string; href?: string; image_key?: string }
type PostContent = { title?: string; content?: Array<Array<PostElement>> }

/**
 * 将飞书消息转换为 OpenCode parts 数组。
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
    let parts: PromptPart[]

    // 先按消息类型分发到专用提取函数，再由各函数处理自己的细节。
    switch (messageType) {
      case "text":
        parts = extractText(rawContent)
        break
      case "image":
        parts = await extractImage(feishuClient, messageId, rawContent, log, maxResourceSize)
        break
      case "post":
        parts = await extractPost(feishuClient, messageId, rawContent, log, maxResourceSize)
        break
      case "file":
        parts = await extractFile(feishuClient, messageId, rawContent, log, maxResourceSize)
        break
      case "audio":
        parts = await extractAudio(feishuClient, messageId, rawContent, log, maxResourceSize)
        break
      case "media":
        parts = extractMediaFallback()
        break
      case "sticker":
        parts = [{ type: "text", text: "[表情包]" }]
        break
      case "interactive":
        parts = extractInteractive(rawContent, log)
        break
      case "share_chat":
        parts = extractShareChat(rawContent, log)
        break
      case "share_user":
        parts = [{ type: "text", text: "[分享了一个用户名片]" }]
        break
      case "merge_forward":
        parts = [{ type: "text", text: "[合并转发消息]" }]
        break
      default:
        parts = [{ type: "text", text: `[不支持的消息类型: ${messageType}]` }]
        break
    }

    return normalizeExtractedParts(parts, messageType)
  } catch (err) {
    // 内容提取失败不应让整条消息链路崩溃，统一降级为可读文本提示。
    log("error", "消息内容提取失败", {
      messageId,
      messageType,
      error: err instanceof Error ? err.message : String(err),
    })
    return [{ type: "text", text: `[消息内容提取失败: ${messageType}]` }]
  }
}

/**
 * 为“历史摄入”场景生成纯文本描述。
 *
 * 与 `extractParts()` 不同，这里不会下载资源，只返回简短说明，
 * 因为历史摄入的目标是上下文摘要而不是完整复现。
 */
export function describeMessageType(messageType: string, rawContent: string, log?: LogFn): string {
  switch (messageType) {
    case "text": {
      try {
        const parsed = JSON.parse(rawContent) as { text?: string }
        return (parsed.text ?? "").trim()
      } catch (err) {
        log?.("error", "解析 text 消息内容失败", {
          messageType,
          error: err instanceof Error ? err.message : String(err),
        })
        return ""
      }
    }
    case "image":
      return "[图片]"
    case "post":
      return extractPostText(rawContent, log)
    case "file": {
      try {
        const parsed = JSON.parse(rawContent) as { file_name?: string }
        return `[文件: ${parsed.file_name ?? "未知文件"}]`
      } catch (err) {
        log?.("error", "解析 file 消息内容失败", {
          messageType,
          error: err instanceof Error ? err.message : String(err),
        })
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
      return firstTextPart(extractInteractive(rawContent, log), "[卡片消息]")
    case "share_chat":
      return firstTextPart(extractShareChat(rawContent, log), "[群分享]")
    case "share_user":
      return "[用户名片]"
    case "merge_forward":
      return "[合并转发]"
    default:
      return `[${messageType}]`
  }
}

/**
 * 兜底保证 extractor 的输出永远非空，避免调用方把消息静默丢弃。
 */
function normalizeExtractedParts(parts: PromptPart[], messageType: string): PromptPart[] {
  if (parts.length > 0) return parts
  return [{ type: "text", text: `[消息内容为空或解析失败: ${messageType}]` }]
}

/**
 * 从 part 数组里提取首个文本 part，用于历史摄入/预览这类“只要一句概览”的场景。
 */
function firstTextPart(parts: PromptPart[], fallback: string): string {
  const first = parts[0]
  return first?.type === "text" ? first.text : fallback
}

/**
 * 判断 MIME 是否可视为文本类型。
 *
 * OpenCode 对文本文件通常会内联读取，因此这里把常见源码/配置格式也归入文本类。
 */
function isTextualMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true
  return ["application/json", "application/xml", "application/yaml",
          "application/javascript", "application/typescript"].includes(mime)
}

/**
 * 解析富文本 post 的原始 JSON。
 *
 * 这个 JSON 结构会被“实时提取”和“历史摘要”两条路径复用，
 * 因此把解析与 error 日志收敛到同一个 helper。
 */
function parsePostContent(rawContent: string, log?: LogFn): PostContent | undefined {
  try {
    return JSON.parse(rawContent) as PostContent
  } catch (err) {
    log?.("error", "解析 post 消息内容失败", {
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

/**
 * 把单个 post 元素转成可内联的文本片段。
 *
 * 图片元素不在这里处理，因为下载资源和文字占位由上层决定。
 */
function formatPostInlineText(element: PostElement): string | undefined {
  if ((element.tag === "text" || element.tag === "at") && element.text) {
    return element.text
  }
  if (element.tag === "a" && element.text) {
    return element.href ? `${element.text}(${element.href})` : element.text
  }
  return undefined
}

// ── 各类型提取逻辑 ──

function extractText(rawContent: string): PromptPart[] {
  const parsed = JSON.parse(rawContent) as { text?: string }
  const text = (parsed.text ?? "").trim()
  if (!text) return []
  return [{ type: "text", text }]
}

/**
 * 解析图片消息。
 *
 * 成功时下载原图并作为 `file` part 交给 OpenCode；
 * 失败时降级成一条文本说明。
 */
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

/**
 * 解析富文本 `post` 消息。
 *
 * 该类型最复杂，因为一条 post 里可能同时混有：
 * - 文字
 * - 超链接
 * - @人
 * - 内嵌图片
 *
 * 因此这里会把文本和图片拆成多个 prompt parts。
 */
async function extractPost(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  rawContent: string,
  log: LogFn,
  maxResourceSize: number,
): Promise<PromptPart[]> {
  const parsed = parsePostContent(rawContent, log)
  if (!parsed) {
    // post 结构解析失败时返回空，交由上层统一兜底。
    return []
  }

  const parts: PromptPart[] = []
  const textLines: string[] = []

  if (parsed.title) textLines.push(parsed.title)

  if (Array.isArray(parsed.content)) {
    for (const paragraph of parsed.content) {
      if (!Array.isArray(paragraph)) continue
      const segments: string[] = []
      for (const element of paragraph) {
        const inlineText = formatPostInlineText(element)
        if (inlineText) {
          segments.push(inlineText)
          continue
        }
        if (element.tag === "img" && element.image_key) {
          // 先把当前段落已经积累的文本刷出去，避免文本和图片顺序错乱。
          if (segments.length) {
            textLines.push(segments.join(""))
            segments.length = 0
          }
          if (textLines.length) {
            parts.push({ type: "text", text: textLines.join("\n") })
            textLines.length = 0
          }
          // 再单独下载并输出内嵌图片。
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
}

/**
 * 从 post 中提取纯文本描述。
 *
 * 用于历史摄入和日志预览，不涉及资源下载。
 */
function extractPostText(rawContent: string, log?: LogFn): string {
  const parsed = parsePostContent(rawContent, log)
  if (!parsed) {
    return ""
  }

  const lines: string[] = []
  if (parsed.title) lines.push(parsed.title)
  if (Array.isArray(parsed.content)) {
    for (const paragraph of parsed.content) {
      if (!Array.isArray(paragraph)) continue
      const segments: string[] = []
      for (const element of paragraph) {
        const inlineText = formatPostInlineText(element)
        if (inlineText) segments.push(inlineText)
        else if (element.tag === "img") segments.push("[图片]")
      }
      if (segments.length) lines.push(segments.join(""))
    }
  }
  return lines.join("\n").trim()
}

/**
 * 解析文件消息。
 *
 * 根据 MIME 做三段式策略：
 * - 文本类文件：作为 `text/plain` file part 内联
 * - 图片类文件：保留原始图片 MIME
 * - 其他二进制文件：降级成文本描述
 */
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

  const detectedMime = result.resource.mime === "application/octet-stream" ? mime : (result.resource.mime || mime)

  // 文本类文件 → text/plain（OpenCode 会倾向于内联处理）。
  if (isTextualMime(detectedMime)) {
    const semi = result.resource.dataUrl.indexOf(";")
    const url = "data:text/plain" + result.resource.dataUrl.slice(semi)
    return [{ type: "file", mime: "text/plain", url, filename: fileName }]
  }

  // 图片 → 保持原始 MIME（AI SDK 支持 image/*）。
  if (detectedMime.startsWith("image/")) {
    return [{ type: "file", mime: detectedMime, url: result.resource.dataUrl, filename: fileName }]
  }

  // 其他二进制文件（PDF/DOCX/XLSX/ZIP 等）→ 当前不直接喂给 SDK，降级为文本描述。
  // data URL 的前缀不是文件内容本身，估算体积时只统计逗号后的 base64 payload。
  const commaIndex = result.resource.dataUrl.indexOf(",")
  const base64Data = commaIndex >= 0 ? result.resource.dataUrl.slice(commaIndex + 1) : ""
  const sizeMB = (base64Data.length * 0.75 / (1024 * 1024)).toFixed(1)
  return [{ type: "text", text: `[文件: ${fileName}, ${sizeMB}MB]` }]
}

/**
 * 解析语音消息。
 *
 * 飞书侧通常把语音也走 file 下载通道，因此这里直接复用资源下载逻辑。
 */
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

/**
 * 视频消息的保守降级方案。
 *
 * 视频通常体积较大，当前默认不下载，只保留文字说明。
 */
function extractMediaFallback(): PromptPart[] {
  return [{ type: "text", text: "[视频消息]" }]
}

/**
 * 根据下载结果拼一个对用户/模型更友好的失败说明。
 */
function formatDownloadFailure(label: string, result: DownloadResult, maxSize: number): string {
  if (result.reason === "too_large" && result.totalSize) {
    const sizeMB = (result.totalSize / (1024 * 1024)).toFixed(1)
    const limitMB = (maxSize / (1024 * 1024)).toFixed(0)
    return `[文件过大: ${label}, 已下载 ${sizeMB}MB 时超出 ${limitMB}MB 限制]`
  }
  return `[下载失败: ${label}]`
}

/**
 * 解析飞书卡片消息。
 *
 * 这里不尝试完整还原卡片结构，只递归提取“对模型理解有帮助的文本信息”。
 */
function extractInteractive(rawContent: string, log?: LogFn): PromptPart[] {
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>
    const texts: string[] = []

    // 先收集 header 标题。
    const header = parsed.header as { title?: { content?: string } } | undefined
    if (header?.title?.content) texts.push(header.title.content)

    // Card 2.0 在 body.elements；老格式可能直接挂在顶层 elements。
    const body = parsed.body as { elements?: unknown[] } | undefined
    const elements = (body?.elements ?? parsed.elements) as Array<Record<string, unknown>> | undefined
    if (Array.isArray(elements)) {
      collectTexts(elements, texts)
    }

    const text = texts.join("\n").trim()
    return text ? [{ type: "text", text: `[卡片消息]\n${text}` }] : [{ type: "text", text: "[卡片消息]" }]
  } catch (err) {
    log?.("error", "解析卡片消息内容失败", {
      error: err instanceof Error ? err.message : String(err),
    })
    return [{ type: "text", text: "[卡片消息]" }]
  }
}

/**
 * 递归提取卡片元素中的可读文本。
 *
 * 只挑“对语义理解有帮助”的字段，不追求 1:1 还原视觉结构。
 */
function collectTexts(elements: Array<Record<string, unknown>>, out: string[]): void {
  for (const el of elements) {
    const tag = el.tag as string | undefined
    if (!tag) continue

    // markdown / plain_text：直接收集 content。
    if ((tag === "markdown" || tag === "plain_text") && typeof el.content === "string") {
      out.push(el.content)
    }
    // div：收集其 text.content。
    else if (tag === "div") {
      const text = el.text as { content?: string } | undefined
      if (text?.content) out.push(text.content)
    }
    // note：递归其内部元素。
    else if (tag === "note" && Array.isArray(el.elements)) {
      collectTexts(el.elements as Array<Record<string, unknown>>, out)
    }
    // table：提取表头和行数据，转成 markdown 表格样式文本。
    else if (tag === "table") {
      extractTable(el, out)
    }
    // column_set / column：递归子元素。
    else if ((tag === "column_set" || tag === "column") && Array.isArray(el.columns ?? el.elements)) {
      collectTexts((el.columns ?? el.elements) as Array<Record<string, unknown>>, out)
    }
    // action 按钮组：把按钮文本收集成提示性字符串。
    else if (tag === "action" && Array.isArray(el.actions)) {
      for (const btn of el.actions as Array<Record<string, unknown>>) {
        const btnText = btn.text as { content?: string } | undefined
        if (btnText?.content) out.push(`[按钮: ${btnText.content}]`)
      }
    }
  }
}

/**
 * 把 table 元素提取成 markdown 表格文本。
 */
function extractTable(el: Record<string, unknown>, out: string[]): void {
  const columns = el.columns as Array<{ name?: string; data_type?: string }> | undefined
  const rows = el.rows as Array<Record<string, unknown>> | undefined
  if (!columns?.length) return

  // 表头。
  const headers = columns.map(c => c.name ?? "")
  out.push("| " + headers.join(" | ") + " |")
  out.push("| " + headers.map(() => "---").join(" | ") + " |")

  // 行数据。
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

/**
 * 解析群分享消息。
 */
function extractShareChat(rawContent: string, log?: LogFn): PromptPart[] {
  try {
    const parsed = JSON.parse(rawContent) as { chat_id?: string }
    return [{ type: "text", text: `[分享了一个群聊${parsed.chat_id ? `: ${parsed.chat_id}` : ""}]` }]
  } catch (err) {
    log?.("error", "解析 share_chat 消息内容失败", {
      error: err instanceof Error ? err.message : String(err),
    })
    return [{ type: "text", text: "[群分享]" }]
  }
}
