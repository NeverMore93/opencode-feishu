/**
 * 飞书卡片 Markdown 清理工具
 */

const MAX_CARD_BYTES = 28 * 1024 // 留 2KB 余量（飞书上限 ~30KB）
const TRUNCATION_SUFFIX = "\n\n*内容过长，已截断*"
const TRUNCATION_SUFFIX_BYTES = new TextEncoder().encode(TRUNCATION_SUFFIX).length
const CODE_FENCE_BYTES = 4 // "\n```".length

/** 只匹配明确的 HTML 标签（带属性或已知标签名），保护代码中的泛型如 Map<string, number> */
const HTML_TAG_RE = /<\/?\w+(?:\s[^>]*)?\/?>/g

/**
 * 清理 markdown 使其兼容飞书卡片渲染
 * - 移除 HTML 标签（保护代码中的泛型角括号）
 * - 确保代码块正确闭合
 */
export function cleanMarkdown(text: string): string {
  // <br> → 换行
  let result = text.replace(/<br\s*\/?>/gi, "\n")

  // 保护代码块中的内容不被 HTML 清理
  const { segments, codeBlocks } = extractCodeBlocks(result)
  result = segments.map(seg => seg.replace(HTML_TAG_RE, "")).join("\0")
  // 还原代码块
  let idx = 0
  result = result.replace(/\0/g, () => codeBlocks[idx++] ?? "")

  result = closeCodeBlocks(result)
  return result
}

/**
 * 截断超长内容，确保不超过飞书卡片大小限制
 */
export function truncateMarkdown(text: string, limit = MAX_CARD_BYTES): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= limit) return text

  // 预留后缀 + 可能的代码块闭合占用的字节数
  const effectiveLimit = limit - TRUNCATION_SUFFIX_BYTES - CODE_FENCE_BYTES
  if (effectiveLimit <= 0) return TRUNCATION_SUFFIX

  // 按字节截断，确保不截断 UTF-8 多字节字符
  const truncated = new TextDecoder().decode(bytes.slice(0, effectiveLimit))
  // 找最后一个完整行
  const lastNewline = truncated.lastIndexOf("\n")
  const cutPoint = lastNewline > effectiveLimit * 0.8 ? lastNewline : truncated.length
  let result = truncated.slice(0, cutPoint)
  result = closeCodeBlocks(result)
  return result + TRUNCATION_SUFFIX
}

/** 将文本分割为非代码段和代码块，便于只对非代码段做 HTML 清理 */
function extractCodeBlocks(text: string): { segments: string[]; codeBlocks: string[] } {
  const segments: string[] = []
  const codeBlocks: string[] = []
  const re = /```[\s\S]*?```/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    segments.push(text.slice(lastIndex, match.index))
    codeBlocks.push(match[0])
    lastIndex = match.index + match[0].length
  }
  segments.push(text.slice(lastIndex))
  return { segments, codeBlocks }
}

function closeCodeBlocks(text: string): string {
  const matches = text.match(/```/g)
  if (matches && matches.length % 2 !== 0) {
    return text + "\n```"
  }
  return text
}
