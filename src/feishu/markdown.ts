/**
 * 飞书卡片 Markdown 清理工具
 *
 * 飞书 CardKit 2.0 支持的 Markdown 子集有限，不兼容标准 HTML 标签。
 * 本模块负责：
 * 1. 清理 AI 输出中的 HTML 标签（保护代码块中的泛型语法如 Map<string, number>）
 * 2. 确保代码块正确闭合（流式输出可能在代码块中间截断）
 * 3. 截断超长内容以符合飞书卡片大小限制（~30KB）
 */

/**
 * 飞书卡片内容最大字节数
 * 飞书实际上限约 30KB，这里预留 2KB 余量（28KB = 28,672 字节）
 * 用于容纳截断后缀和代码块闭合标记
 */
const MAX_CARD_BYTES = 28 * 1024 // 留 2KB 余量（飞书上限 ~30KB）

/** 内容截断时追加的提示后缀 */
const TRUNCATION_SUFFIX = "\n\n*内容过长，已截断*"

/** 截断后缀的 UTF-8 字节长度（预计算，避免每次截断时重复编码） */
const TRUNCATION_SUFFIX_BYTES = new TextEncoder().encode(TRUNCATION_SUFFIX).length

/** 代码块闭合标记 "\n```" 的字节长度，截断时需要预留此空间 */
const CODE_FENCE_BYTES = 4 // "\n```".length

/**
 * HTML 标签正则表达式
 * 只匹配明确的 HTML 标签（带属性或已知标签名），
 * 设计为不误匹配代码中的泛型语法如 Map<string, number>
 * 例如：<div>、<br/>、</p>、<span class="x"> 会被匹配
 * 而：Map<string, number> 不会被匹配（因为 string, number 不是有效的标签属性格式）
 */
const HTML_TAG_RE = /<\/?\w+(?:\s[^>]*)?\/?>/g

/**
 * 清理 markdown 使其兼容飞书卡片渲染
 *
 * 处理流程：
 * 1. 将 <br> 标签转换为换行符
 * 2. 提取代码块内容（保护其不被 HTML 清理影响）
 * 3. 对非代码段移除 HTML 标签
 * 4. 还原代码块
 * 5. 确保代码块正确闭合
 *
 * @param text 原始 markdown 文本（可能包含 HTML 标签）
 * @returns 清理后的纯 markdown 文本
 */
export function cleanMarkdown(text: string): string {
  // 第一步：将 <br> / <br/> 转换为换行符（飞书不支持 <br> 标签）
  let result = text.replace(/<br\s*\/?>/gi, "\n")
  // 第二步：先补全未闭合代码块，避免半截代码块被当成普通文本做 HTML 清洗。
  result = closeCodeBlocks(result)

  // 第三步：提取代码块，用 NUL 字符占位，避免代码块中的泛型语法被误删
  const { segments, codeBlocks } = extractCodeBlocks(result)
  // 只对非代码段执行 HTML 标签清理
  result = segments.map(seg => seg.replace(HTML_TAG_RE, "")).join("\0")
  // 第四步：将 NUL 占位符替换回原始代码块内容
  let idx = 0
  result = result.replace(/\0/g, () => codeBlocks[idx++] ?? "")

  // 第五步：兜底再检查一次，兼容清洗过程中新插入换行后的代码块状态。
  result = closeCodeBlocks(result)
  return result
}

/**
 * 截断超长内容，确保不超过飞书卡片大小限制
 *
 * 截断策略：
 * 1. 计算有效截断点（预留后缀和代码块闭合的字节数）
 * 2. 按字节截断（使用 TextEncoder/TextDecoder 处理 UTF-8 多字节字符）
 * 3. 尽量在最后一个完整行处截断（避免截断在行中间）
 * 4. 确保截断后的代码块正确闭合
 * 5. 追加截断提示后缀
 *
 * @param text 待截断的 markdown 文本
 * @param limit 最大允许字节数，默认 MAX_CARD_BYTES（28KB）
 * @returns 截断后的文本（未超限则原样返回）
 */
export function truncateMarkdown(text: string, limit = MAX_CARD_BYTES): string {
  const bytes = new TextEncoder().encode(text)
  // 未超限，直接返回原文
  if (bytes.length <= limit) return text

  // 计算有效截断上限：总限制 - 截断后缀 - 可能的代码块闭合标记
  const effectiveLimit = limit - TRUNCATION_SUFFIX_BYTES - CODE_FENCE_BYTES
  // 极端情况：如果有效限制为零或负数，只返回后缀
  if (effectiveLimit <= 0) return TRUNCATION_SUFFIX

  // 按字节截断（TextDecoder 自动处理截断的 UTF-8 多字节字符，避免产生乱码）
  const truncated = new TextDecoder().decode(bytes.slice(0, effectiveLimit))
  // 尽量在最后一个换行符处截断，避免在行中间切断
  // 只在换行符位置超过有效限制 80% 时才使用，否则截断太多内容
  const lastNewline = truncated.lastIndexOf("\n")
  const cutPoint = lastNewline > effectiveLimit * 0.8 ? lastNewline : truncated.length
  let result = truncated.slice(0, cutPoint)
  // 确保截断后的代码块闭合
  result = closeCodeBlocks(result)
  return result + TRUNCATION_SUFFIX
}

/**
 * 将文本分割为"非代码段"和"代码块"两个数组
 *
 * 用于在清理 HTML 标签时保护代码块中的内容（如泛型语法 Map<string, number>）。
 * segments 数组比 codeBlocks 多一个元素（segments[i] 和 segments[i+1] 之间夹着 codeBlocks[i]）。
 *
 * @param text 原始文本
 * @returns segments（非代码段数组）和 codeBlocks（代码块数组）
 */
function extractCodeBlocks(text: string): { segments: string[]; codeBlocks: string[] } {
  const segments: string[] = []
  const codeBlocks: string[] = []
  // 匹配完整的代码块（``` ... ```），非贪婪模式
  const re = /```[\s\S]*?```/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  // 遍历所有代码块，收集代码块和非代码段
  while ((match = re.exec(text)) !== null) {
    // 代码块之前的文本作为非代码段
    segments.push(text.slice(lastIndex, match.index))
    // 代码块本身
    codeBlocks.push(match[0])
    lastIndex = match.index + match[0].length
  }
  // 最后一个代码块之后的文本（或没有代码块时的全部文本）
  segments.push(text.slice(lastIndex))
  return { segments, codeBlocks }
}

/**
 * 确保 markdown 中的代码块正确闭合
 *
 * 流式输出场景下，AI 可能在代码块中间被截断，
 * 导致 ``` 标记数量为奇数（未闭合）。
 * 此函数检测并追加缺少的闭合标记。
 *
 * @param text markdown 文本
 * @returns 代码块已闭合的文本
 */
function closeCodeBlocks(text: string): string {
  // 只统计真正作为 fence 起始的代码块分隔行，忽略正文中的行内反引号。
  const matches = text.match(/^`{3,}.*$/gm)
  // 奇数个 fence 行表示有未闭合的代码块，追加闭合标记。
  if (matches && matches.length % 2 !== 0) {
    return text + "\n```"
  }
  return text
}
