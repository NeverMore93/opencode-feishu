/**
 * 错误分类：typed discriminated union 替代递归 string 扫描。
 *
 * 所有错误经 `classify()` 转为 `PluginError`（5 kinds），
 * consumer 通过 `matchPluginError()` exhaustive handler 消费。
 *
 * @see spec: specs/027-typed-error-taxonomy/spec.md
 * @see plan: specs/027-typed-error-taxonomy/plan.md
 */

// ═══════════ 字段路径（literal union 防 drift） ═══════════

export type FieldPath =
  | "name"
  | "data.message"
  | "data.responseBody"
  | "data.providerID"
  | "data.modelId"
  | "data.isRetryable"
  | "data.statusCode"

// ═══════════ 规则名（literal union 防 drift） ═══════════

export type RuleName =
  | "auth/provider-auth-error"
  | "context/overflow-error"
  | "model/provider-not-found"
  | "model/unknown-error-with-pattern"
  | "poison/file-part-media-type"
  | "poison/localshell-schema"
  | "poison/zoderror-localshell"

// ═══════════ UnknownUpstream hint ═══════════

export type UnknownHint =
  | "non-error-throw"
  | "circular-ref"
  | "classifier-threw"
  | "unrecognized-shape"

// ═══════════ Evidence（4 种 probe via） ═══════════

export type Evidence =
  | { readonly via: "name";        readonly path: "name";          readonly value: string }
  | { readonly via: "field";       readonly path: FieldPath;       readonly value: string }
  | { readonly via: "pattern";     readonly path: FieldPath;       readonly pattern: string; readonly match: string }
  | { readonly via: "http-status"; readonly status: number }

// ═══════════ Base interface ═══════════

export interface PluginErrorBase {
  readonly evidence: readonly Evidence[]
  readonly original: string
  readonly raw: unknown
}

// ═══════════ 5 kinds discriminated union ═══════════

export type PluginError =
  | (PluginErrorBase & { readonly kind: "SessionPoisoned";  readonly rule: RuleName })
  | (PluginErrorBase & { readonly kind: "ModelUnavailable"; readonly providerID?: string; readonly modelId?: string })
  | (PluginErrorBase & { readonly kind: "ContextOverflow";  readonly providerID?: string })
  | (PluginErrorBase & { readonly kind: "Unauthorized";     readonly providerID?: string })
  | (PluginErrorBase & { readonly kind: "UnknownUpstream"; readonly hint?: UnknownHint })

// ═══════════ Probe function type ═══════════

export type Probe<K extends PluginError["kind"]> = (
  raw: unknown,
  collect: (evidence: Evidence) => void,
) => Extract<PluginError, { kind: K }> | null

// ═══════════ Utilities ═══════════

/**
 * 把任意抛出物转为 string，处理 Error / string / plain object / null /
 * undefined / 循环引用。
 */
export function stringify(raw: unknown): string {
  if (raw === null || raw === undefined) return String(raw)
  if (typeof raw === "string") return raw
  if (raw instanceof Error) {
    return raw.message || raw.name || String(raw)
  }
  try {
    return JSON.stringify(raw)
  } catch {
    return "[unserializable]"
  }
}

/** 截断到前 n 字，超出时追加 `...`。 */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s
}

// ═══════════ 内部工具 ═══════════

/** 安全读取 raw 对象的 name 字段（SDK error discriminant）。 */
function getErrorName(raw: unknown): string | undefined {
  if (raw && typeof raw === "object") {
    const name = (raw as Record<string, unknown>).name
    return typeof name === "string" ? name : undefined
  }
  return undefined
}

/** 安全读取 raw.data 嵌套字段。 */
function getDataField(raw: unknown, field: string): unknown {
  if (raw && typeof raw === "object") {
    const data = (raw as Record<string, unknown>).data
    if (data && typeof data === "object") {
      return (data as Record<string, unknown>)[field]
    }
  }
  return undefined
}

/** 安全读取 raw.data 中的 string 字段。 */
function getDataString(raw: unknown, field: string): string | undefined {
  const v = getDataField(raw, field)
  return typeof v === "string" ? v : undefined
}

// ═══════════ try* 规则（按优先级链排序） ═══════════

/** 条件 A 白名单：Poison 规则允许的 error.name 集合。 */
const POISON_NAME_WHITELIST = new Set([
  "StructuredOutputError",
  "UnknownError",
  "APIError",
])

/** 条件 B 子串模式。 */
const POISON_SUBSTRING_PATTERNS: ReadonlyArray<{ pattern: string; rule: RuleName }> = [
  { pattern: "file part media type", rule: "poison/file-part-media-type" },
]

/** 条件 B 正则模式。 */
const POISON_REGEX_PATTERNS: ReadonlyArray<{ pattern: RegExp; rule: RuleName }> = [
  { pattern: /localshell.*schema/i,       rule: "poison/localshell-schema" },
  { pattern: /zoderror.*local.?shell/i,   rule: "poison/zoderror-localshell" },
]

/** 模型不可用的 pattern 匹配（用于 UnknownError 降级路径）。 */
const MODEL_PATTERNS = [
  /model\s+not\s+found/i,
  /model\b.*\bnot\s+(found|supported|available)/i,
  /model\s+is\s+not\s+(available|supported)/i,
  /modelnotfound/i,
  /model_not_found/i,
  /tool\s+choice\s+type/i,
]

const tryUnauthorized: Probe<"Unauthorized"> = (raw, collect) => {
  if (getErrorName(raw) !== "ProviderAuthError") return null
  collect({ via: "name", path: "name", value: "ProviderAuthError" })
  return {
    kind: "Unauthorized",
    providerID: getDataString(raw, "providerID"),
    evidence: [],
    original: truncate(stringify(raw), 500),
    raw,
  } as Extract<PluginError, { kind: "Unauthorized" }>
}

const tryContextOverflow: Probe<"ContextOverflow"> = (raw, collect) => {
  if (getErrorName(raw) !== "ContextOverflowError") return null
  collect({ via: "name", path: "name", value: "ContextOverflowError" })
  return {
    kind: "ContextOverflow",
    providerID: getDataString(raw, "providerID"),
    evidence: [],
    original: truncate(stringify(raw), 500),
    raw,
  } as Extract<PluginError, { kind: "ContextOverflow" }>
}

const tryModelUnavailable: Probe<"ModelUnavailable"> = (raw, collect) => {
  const name = getErrorName(raw)

  // 路径 1：精确 name 匹配
  if (name === "ProviderModelNotFoundError") {
    collect({ via: "name", path: "name", value: "ProviderModelNotFoundError" })
    return {
      kind: "ModelUnavailable",
      providerID: getDataString(raw, "providerID"),
      modelId: getDataString(raw, "modelId"),
      evidence: [],
      original: truncate(stringify(raw), 500),
      raw,
    } as Extract<PluginError, { kind: "ModelUnavailable" }>
  }

  // 路径 2：UnknownError + data.message pattern
  if (name === "UnknownError") {
    const msg = getDataString(raw, "message") ?? ""
    for (const pat of MODEL_PATTERNS) {
      const m = msg.match(pat)
      if (m) {
        collect({ via: "pattern", path: "data.message", pattern: pat.source, match: m[0] })
        return {
          kind: "ModelUnavailable",
          providerID: getDataString(raw, "providerID"),
          modelId: getDataString(raw, "modelId"),
          evidence: [],
          original: truncate(stringify(raw), 500),
          raw,
        } as Extract<PluginError, { kind: "ModelUnavailable" }>
      }
    }
  }

  return null
}

const trySessionPoisoned: Probe<"SessionPoisoned"> = (raw, collect) => {
  // 条件 A：error.name 白名单
  const name = getErrorName(raw)
  if (!name || !POISON_NAME_WHITELIST.has(name)) return null

  // 条件 B：data.message 匹配 poison pattern
  const msg = getDataString(raw, "message") ?? ""

  // 子串模式
  for (const entry of POISON_SUBSTRING_PATTERNS) {
    if (msg.toLowerCase().includes(entry.pattern)) {
      collect({ via: "pattern", path: "data.message", pattern: entry.pattern, match: msg.slice(0, 200) })
      // 再收集 name evidence
      collect({ via: "name", path: "name", value: name })
      return {
        kind: "SessionPoisoned",
        rule: entry.rule,
        evidence: [],
        original: truncate(stringify(raw), 500),
        raw,
      } as Extract<PluginError, { kind: "SessionPoisoned" }>
    }
  }

  // 正则模式
  for (const entry of POISON_REGEX_PATTERNS) {
    const m = msg.match(entry.pattern)
    if (m) {
      collect({ via: "pattern", path: "data.message", pattern: entry.pattern.source, match: m[0] })
      collect({ via: "name", path: "name", value: name })
      return {
        kind: "SessionPoisoned",
        rule: entry.rule,
        evidence: [],
        original: truncate(stringify(raw), 500),
        raw,
      } as Extract<PluginError, { kind: "SessionPoisoned" }>
    }
  }

  return null
}

// ═══════════ classify（规则优先级链） ═══════════

/**
 * 把任意抛出物转为 PluginError。
 * 优先级：Auth → Context → Model → Poison → fallback。
 * 内层 try/catch 兜底，classify 永不 throw（FR-009）。
 */
export function classify(raw: unknown): PluginError {
  try {
    const original = truncate(stringify(raw), 500)
    const evidence: Evidence[] = []

    const collect = (e: Evidence) => { evidence.push(e) }

    // 优先级 1：Auth（强证据，精确 name 匹配）
    const auth = tryUnauthorized(raw, collect)
    if (auth) return { ...auth, evidence, original }

    // 优先级 2：ContextOverflow（强证据）
    const ctx = tryContextOverflow(raw, collect)
    if (ctx) return { ...ctx, evidence, original }

    // 优先级 3：Model（中等证据）
    const model = tryModelUnavailable(raw, collect)
    if (model) return { ...model, evidence, original }

    // 优先级 4：Poison（弱证据，two-factor，放最后）
    const poison = trySessionPoisoned(raw, collect)
    if (poison) return { ...poison, evidence, original }

    // fallback
    return {
      kind: "UnknownUpstream",
      hint: "unrecognized-shape",
      evidence: [],
      original,
      raw,
    }
  } catch {
    // classify 自身不应 throw（FR-009）
    return {
      kind: "UnknownUpstream",
      hint: "classifier-threw",
      evidence: [],
      original: "[classify threw]",
      raw,
    }
  }
}

// ═══════════ matchPluginError（exhaustive matcher） ═══════════

/**
 * 替代 switch(err.kind)，强制消费者覆盖所有 PluginError kind。
 * 漏任何 kind 的 handler → TypeScript 编译报错。
 */
export function matchPluginError<R>(
  err: PluginError,
  handlers: { [K in PluginError["kind"]]: (e: Extract<PluginError, { kind: K }>) => R },
): R {
  return handlers[err.kind](err as Extract<PluginError, typeof err.kind>)
}

// ═══════════ toLog（安全日志 payload） ═══════════

/**
 * 从 PluginError 生成安全的 log payload。
 * 不暴露 raw（防 secrets 泄漏）。
 */
export function toLog(err: PluginError): Record<string, unknown> {
  const base: Record<string, unknown> = {
    kind: err.kind,
    evidenceCount: err.evidence.length,
    evidencePrimary: err.evidence[0]
      ? { via: err.evidence[0].via, path: "path" in err.evidence[0] ? err.evidence[0].path : undefined }
      : undefined,
  }

  if (err.kind === "SessionPoisoned") {
    base.rule = err.rule
  }
  if (err.kind === "ModelUnavailable" || err.kind === "ContextOverflow" || err.kind === "Unauthorized") {
    if (err.providerID) base.providerID = err.providerID
  }
  if (err.kind === "ModelUnavailable" && err.modelId) {
    base.modelId = err.modelId
  }
  if (err.kind === "UnknownUpstream" && err.hint) {
    base.hint = err.hint
  }

  return base
}

// ═══════════ PluginErrorThrown（nominal wrapper） ═══════════

/**
 * 仅在需要跨 throw/catch 边界传播 PluginError identity 时使用。
 * 一般场景用 union + matchPluginError 即可。
 */
export class PluginErrorThrown extends Error {
  readonly inner: PluginError

  constructor(inner: PluginError) {
    super(`[${inner.kind}] ${truncate(inner.original, 200)}`)
    this.inner = inner
    this.name = "PluginErrorThrown"
  }
}
