/**
 * 飞书消息资源下载：将图片、文件、音频等资源转换为 data URL
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"

export interface DownloadedResource {
  /** data:<mime>;base64,<data> */
  dataUrl: string
  mime: string
  filename?: string
}

const MAX_RESOURCE_SIZE = 10 * 1024 * 1024 // 10MB

/**
 * 下载飞书消息中的资源文件，返回 data URL
 *
 * 使用 im.messageResource.get API，支持图片、文件、音频、视频
 * 返回 null 表示下载失败或资源过大
 */
export async function downloadMessageResource(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  fileKey: string,
  type: "image" | "file",
  log: LogFn,
): Promise<DownloadedResource | null> {
  try {
    const res = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    })

    // res 可能包含 data（stream）和 headers
    const streamData = res as unknown as { data?: NodeJS.ReadableStream; headers?: Record<string, string> }
    if (!streamData.data) {
      log("warn", "资源下载返回空数据", { messageId, fileKey, type })
      return null
    }

    const chunks: Buffer[] = []
    let totalSize = 0

    for await (const chunk of streamData.data) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array)
      totalSize += buf.length
      if (totalSize > MAX_RESOURCE_SIZE) {
        log("warn", "资源过大，跳过下载", { messageId, fileKey, totalSize })
        return null
      }
      chunks.push(buf)
    }

    const buffer = Buffer.concat(chunks)
    const contentType = streamData.headers?.["content-type"] ?? guessMimeByType(type)
    const base64 = buffer.toString("base64")
    const dataUrl = `data:${contentType};base64,${base64}`

    return { dataUrl, mime: contentType }
  } catch (err) {
    log("warn", "资源下载失败", {
      messageId,
      fileKey,
      type,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

function guessMimeByType(type: "image" | "file"): string {
  return type === "image" ? "image/png" : "application/octet-stream"
}

/**
 * 根据文件名推断 MIME 类型
 */
export function guessMimeByFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
    zip: "application/zip",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    opus: "audio/opus",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
  }
  return map[ext] ?? "application/octet-stream"
}
