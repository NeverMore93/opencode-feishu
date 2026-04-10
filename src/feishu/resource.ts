/**
 * 飞书资源下载层：把消息里的文件/图片/音频拉下来并转成 data URL。
 *
 * 之所以统一转成 data URL，是为了后续能直接塞进 OpenCode file parts，
 * 不依赖临时文件或额外公网地址。
 */
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"

/** 下载成功后的标准资源结构。 */
export interface DownloadedResource {
  /** data:<mime>;base64,<data> */
  dataUrl: string
  mime: string
  filename?: string
}

/** 下载流程的统一结果。 */
export interface DownloadResult {
  /** 下载成功时的资源；失败则为 null。 */
  resource: DownloadedResource | null
  /** 失败原因枚举，便于上层生成更友好的提示。 */
  reason: "ok" | "too_large" | "error"
  /** 下载超限时记录当时累计字节数。 */
  totalSize?: number
}

/**
 * 下载飞书消息中的资源并返回 data URL。
 *
 * 核心策略：
 * - 使用流式读取，边下边统计大小
 * - 一旦超过 `maxSize` 立刻中断，避免把大文件完整拉进内存
 * - 不把错误向上抛，而是统一折叠成 `DownloadResult`
 */
export async function downloadMessageResource(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  fileKey: string,
  type: "image" | "file",
  log: LogFn,
  maxSize: number,
): Promise<DownloadResult> {
  try {
    const res = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    })

    if (!res) {
      log("error", "资源下载返回空数据", { messageId, fileKey, type })
      return { resource: null, reason: "error" }
    }

    const stream = res.getReadableStream()
    const chunks: Buffer[] = []
    let totalSize = 0

    for await (const chunk of stream) {
      // 兼容 Buffer 和 Uint8Array 两种 chunk 形态。
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array)
      totalSize += buf.length
      if (totalSize > maxSize) {
        log("error", "资源过大，跳过下载", { messageId, fileKey, totalSize, maxSize })
        // 主动销毁流，尽快释放网络和内存占用。
        stream.destroy()
        return { resource: null, reason: "too_large", totalSize }
      }
      chunks.push(buf)
    }

    const buffer = Buffer.concat(chunks)
    const headers = res.headers as Record<string, string> | undefined
    const contentType = headers?.["content-type"] ?? guessMimeByType(type)
    const base64 = buffer.toString("base64")
    const dataUrl = `data:${contentType};base64,${base64}`

    return { resource: { dataUrl, mime: contentType }, reason: "ok" }
  } catch (err) {
    log("error", "资源下载失败", {
      messageId,
      fileKey,
      type,
      error: err instanceof Error ? err.message : String(err),
    })
    return { resource: null, reason: "error" }
  }
}

/**
 * 响应头缺失时，根据资源类别给一个保守 MIME 默认值。
 */
function guessMimeByType(type: "image" | "file"): string {
  return type === "image" ? "image/png" : "application/octet-stream"
}

/**
 * 根据文件名扩展名推断 MIME 类型。
 *
 * 这份映射主要用于“服务端只返回 octet-stream”时给上层二次判断，
 * 例如决定是否把文件按文本内联给 OpenCode。
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
    yaml: "text/plain",
    yml: "text/plain",
    md: "text/plain",
    ts: "text/plain",
    tsx: "text/plain",
    js: "text/plain",
    jsx: "text/plain",
    py: "text/plain",
    go: "text/plain",
    rs: "text/plain",
    java: "text/plain",
    kt: "text/plain",
    rb: "text/plain",
    sh: "text/plain",
    bash: "text/plain",
    zsh: "text/plain",
    toml: "text/plain",
    ini: "text/plain",
    cfg: "text/plain",
    conf: "text/plain",
    log: "text/plain",
    sql: "text/plain",
    graphql: "text/plain",
    proto: "text/plain",
    dockerfile: "text/plain",
    makefile: "text/plain",
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
