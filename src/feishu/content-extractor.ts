/**
 * 飞书消息内容提取：将不同类型的飞书消息转换为 OpenCode SDK 的 parts 数组
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"
import { downloadMessageResource, guessMimeByFilename } from "./resource.js"

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
): Promise<PromptPart[]> {
  try {
    switch (messageType) {
      case "text":
        return extractText(rawContent)
      case "image":
        return await extractImage(feishuClient, messageId, rawContent, log)
      case "post":
        return extractPost(rawContent)
      case "file":
        return await extractFile(feishuClient, messageId, rawContent, log)
      case "audio":
        return await extractAudio(feishuClient, messageId, rawContent, log)
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
): Promise<PromptPart[]> {
  const parsed = JSON.parse(rawContent) as { image_key?: string }
  const imageKey = parsed.image_key
  if (!imageKey) return [{ type: "text", text: "[图片: 无法获取]" }]

  const resource = await downloadMessageResource(client, messageId, imageKey, "image", log)
  if (!resource) return [{ type: "text", text: "[图片: 下载失败]" }]

  return [{ type: "file", mime: resource.mime, url: resource.dataUrl }]
}

function extractPost(rawContent: string): PromptPart[] {
  const text = extractPostText(rawContent)
  if (!text) return []
  return [{ type: "text", text }]
}

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
          if (element.tag === "text" && element.text) {
            segments.push(element.text)
          } else if (element.tag === "a" && element.text) {
            segments.push(element.href ? `${element.text}(${element.href})` : element.text)
          } else if (element.tag === "at" && element.text) {
            // @提及，保留文本
          } else if (element.tag === "img") {
            segments.push("[图片]")
          }
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
): Promise<PromptPart[]> {
  const parsed = JSON.parse(rawContent) as { file_key?: string; file_name?: string }
  const fileKey = parsed.file_key
  const fileName = parsed.file_name ?? "未知文件"

  if (!fileKey) return [{ type: "text", text: `[文件: ${fileName}]` }]

  const mime = guessMimeByFilename(fileName)
  const resource = await downloadMessageResource(client, messageId, fileKey, "file", log)
  if (!resource) return [{ type: "text", text: `[文件下载失败: ${fileName}]` }]

  return [{ type: "file", mime: resource.mime || mime, url: resource.dataUrl, filename: fileName }]
}

async function extractAudio(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  rawContent: string,
  log: LogFn,
): Promise<PromptPart[]> {
  const parsed = JSON.parse(rawContent) as { file_key?: string }
  const fileKey = parsed.file_key

  if (!fileKey) return [{ type: "text", text: "[语音: 无法获取]" }]

  const resource = await downloadMessageResource(client, messageId, fileKey, "file", log)
  if (!resource) return [{ type: "text", text: "[语音: 下载失败]" }]

  return [{ type: "file", mime: resource.mime || "audio/opus", url: resource.dataUrl }]
}

function extractMediaFallback(): PromptPart[] {
  // 视频通常较大，默认不下载，仅文本描述
  return [{ type: "text", text: "[视频消息]" }]
}

function extractInteractive(rawContent: string): PromptPart[] {
  try {
    const parsed = JSON.parse(rawContent) as {
      elements?: Array<{ tag?: string; content?: string; text?: { content?: string } }>
      header?: { title?: { content?: string } }
    }
    const texts: string[] = []
    if (parsed.header?.title?.content) texts.push(parsed.header.title.content)
    if (Array.isArray(parsed.elements)) {
      for (const el of parsed.elements) {
        if (el.tag === "div" && el.text?.content) texts.push(el.text.content)
        else if (el.tag === "markdown" && el.content) texts.push(el.content)
      }
    }
    const text = texts.join("\n").trim()
    return text ? [{ type: "text", text: `[卡片消息]\n${text}` }] : [{ type: "text", text: "[卡片消息]" }]
  } catch {
    return [{ type: "text", text: "[卡片消息]" }]
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
