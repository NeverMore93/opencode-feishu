/**
 * 模型错误恢复层。
 *
 * 当会话因模型不兼容、模型不存在、provider 不支持等原因失败时，
 * 这里负责判断是否值得自动重试，并尝试切回全局默认模型。
 */
import type { OpencodeClient } from "@opencode-ai/sdk"
import type { LogFn } from "../types.js"
import type { PromptPart } from "../feishu/content-extractor.js"
import {
  getRetryAttempts, setRetryAttempts, MAX_RETRY_ATTEMPTS, clearRetryAttempts,
  getSessionError, clearSessionError,
  type CachedSessionError,
} from "./event.js"
import type { PluginError } from "./errors.js"

/**
 * `pollForResponse()` 在轮询期间发现 SSE 错误时抛出的专用异常。
 *
 * 这样调用方能区分“普通异常”和“session 已经明确报错”两类失败。
 */
export class SessionErrorDetected extends Error {
  constructor(public readonly sessionError: CachedSessionError) {
    super(sessionError.message)
    this.name = "SessionErrorDetected"
  }
}

/** 恢复流程的统一返回值。 */
export interface RecoveryResult {
  /** 是否已经成功恢复并拿到了有效输出。 */
  readonly recovered: boolean
  /** 恢复成功时的最终文本。 */
  readonly text?: string
}

/**
 * 从全局配置读取默认模型，并拆成 OpenCode 需要的结构。
 *
 * 注意这里故意不在失败 provider 内做候选搜索，
 * 只信任用户显式配置的默认模型。
 */
async function getGlobalDefaultModel(
  client: OpencodeClient,
  directory?: string,
): Promise<{ providerID: string; modelID: string } | undefined> {
  const query = directory ? { directory } : undefined
  const { data: config } = await client.config.get({ query })
  const model = config?.model
  if (!model || !model.includes("/")) return undefined
  const slash = model.indexOf("/")
  const providerID = model.slice(0, slash).trim()
  const modelID = model.slice(slash + 1).trim()
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

/**
 * 从异常对象中提取当前会话真正的错误信息。
 *
 * 错误来源有两类：
 * 1. `SessionErrorDetected` 直接携带的结构化错误
 * 2. `event.ts` 提前缓存到 sessionErrors 里的 SSE 错误
 *
 * 取到错误后会立即清理缓存，避免旧错误污染下一轮调用。
 */
export function extractSessionError(err: unknown, sessionId: string): CachedSessionError | undefined {
  const result = err instanceof SessionErrorDetected
    ? err.sessionError
    : getSessionError(sessionId)
  clearSessionError(sessionId)
  return result
}

/** 由 chat.ts 注入的轮询函数签名，恢复逻辑复用同一套等待机制。 */
type PollFn = (
  client: OpencodeClient,
  sessionId: string,
  opts: {
    timeout?: number
    pollInterval: number
    stablePolls: number
    query?: { directory: string }
    signal?: AbortSignal
  },
) => Promise<string>

/**
 * 尝试做一次模型错误恢复。
 *
 * 调用方已通过 classify() 确认 kind === "ModelUnavailable"，
 * 这里不再做错误识别，直接尝试切回全局默认模型重试。
 *
 * 真正会进入重试的前提：
 * - 尚未超过重试上限
 * - 能读到有效的全局默认模型
 *
 * AbortError 不属于恢复失败，而是上层主动中断，因此必须继续向外抛。
 */
export async function tryModelRecovery(params: {
  readonly pluginError: PluginError & { kind: "ModelUnavailable" }
  readonly sessionId: string
  readonly sessionKey: string
  readonly client: OpencodeClient
  readonly directory?: string
  readonly requestMessageId: string
  readonly parts: readonly PromptPart[]
  readonly timeout?: number
  readonly pollInterval: number
  readonly stablePolls: number
  readonly query?: { directory: string }
  readonly signal?: AbortSignal
  readonly log: LogFn
  readonly poll: PollFn
}): Promise<RecoveryResult> {
  const {
    pluginError, sessionId, sessionKey, client, directory,
    requestMessageId,
    parts, timeout, pollInterval, stablePolls, query, signal,
    log, poll,
  } = params

  log("info", "recovery.model.attempted", {
    sessionKey,
    kind: pluginError.kind,
    providerID: pluginError.providerID,
    evidenceCount: pluginError.evidence.length,
  })

  const attempts = getRetryAttempts(sessionKey)
  if (attempts >= MAX_RETRY_ATTEMPTS) {
    log("warn", "已达重试上限，放弃恢复", { sessionKey, attempts })
    return { recovered: false }
  }

  try {
    // 单独保护读取配置这一步，避免配置查询失败把整个恢复逻辑直接打断。
    let modelOverride: { providerID: string; modelID: string } | undefined
    try {
      modelOverride = await getGlobalDefaultModel(client, directory)
    } catch (configErr) {
      log("error", "读取全局模型配置失败", {
        sessionKey,
        error: configErr instanceof Error ? configErr.message : String(configErr),
      })
    }

    if (!modelOverride) {
      log("warn", "全局默认模型未配置，放弃恢复", { sessionKey })
      return { recovered: false }
    }

    // 先记一次尝试次数，防止异常路径漏记。
    setRetryAttempts(sessionKey, attempts + 1)
    log("info", "使用全局默认模型恢复", {
      sessionKey,
      providerID: modelOverride.providerID,
      modelID: modelOverride.modelID,
    })

    // 清掉上一次调用残留的 SSE 错误，避免新一轮轮询读到旧状态。
    clearSessionError(sessionId)
    await client.session.promptAsync({
      path: { id: sessionId },
      query,
      // 恢复尝试也显式绑定一个 user messageID，便于上层只读取这次尝试的实际模型。
      body: { parts: [...parts], model: modelOverride, messageID: requestMessageId },
    })

    const finalText = await poll(client, sessionId, {
      timeout, pollInterval, stablePolls, query, signal,
    })

    log("info", "模型恢复后响应完成", {
      sessionKey, sessionId, output: finalText || "(empty)",
    })

    // 只要恢复成功，就把累计重试次数清零。
    clearRetryAttempts(sessionKey)

    log("info", "模型不兼容恢复成功", {
      sessionId, sessionKey,
      model: `${modelOverride.providerID}/${modelOverride.modelID}`,
      attempt: attempts + 1,
    })

    return { recovered: true, text: finalText }
  } catch (recoveryErr) {
    if (recoveryErr instanceof Error && recoveryErr.name === "AbortError") {
      throw recoveryErr
    }

    const errMsg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)

    // 清理可能残留的 SSE 错误缓存。
    clearSessionError(sessionId)

    log("error", "模型恢复失败", { sessionId, sessionKey, error: errMsg })

    return { recovered: false }
  }
}
