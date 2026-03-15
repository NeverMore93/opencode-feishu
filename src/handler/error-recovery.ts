/**
 * 模型错误恢复：检测模型不兼容错误，使用全局默认模型重试
 */
import type { OpencodeClient } from "@opencode-ai/sdk"
import type { LogFn } from "../types.js"
import type { PromptPart } from "../feishu/content-extractor.js"
import {
  getRetryAttempts, setRetryAttempts, MAX_RETRY_ATTEMPTS, clearRetryAttempts,
  getSessionError, clearSessionError, isModelError,
  type CachedSessionError,
} from "./event.js"

/** pollForResponse 检测到 SSE 错误时抛出的异常 */
export class SessionErrorDetected extends Error {
  constructor(public readonly sessionError: CachedSessionError) {
    super(sessionError.message)
    this.name = "SessionErrorDetected"
  }
}

export interface RecoveryResult {
  readonly recovered: boolean
  readonly text?: string
  readonly sessionError?: CachedSessionError
}

/**
 * 从全局配置读取默认模型（Config.model 字段），解析为 { providerID, modelID }。
 * 不在失败 provider 内搜索替代 — 只用用户明确配置的默认模型。
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
 * 从捕获的异常中提取会话错误信息。
 * 检查 SessionErrorDetected 和 SSE 缓存两个来源。
 */
export function extractSessionError(err: unknown, sessionId: string): CachedSessionError | undefined {
  const result = err instanceof SessionErrorDetected
    ? err.sessionError
    : getSessionError(sessionId)
  clearSessionError(sessionId)
  return result
}

type PollFn = (
  client: OpencodeClient,
  sessionId: string,
  opts: {
    timeout: number
    pollInterval: number
    stablePolls: number
    query?: { directory: string }
    signal?: AbortSignal
  },
) => Promise<string>

/**
 * 尝试模型错误恢复：检测模型不兼容错误，使用全局默认模型重试。
 * AbortError 会被重新抛出，由调用方处理中断清理。
 */
export async function tryModelRecovery(params: {
  readonly sessionError: CachedSessionError
  readonly sessionId: string
  readonly sessionKey: string
  readonly client: OpencodeClient
  readonly directory?: string
  readonly parts: readonly PromptPart[]
  readonly timeout: number
  readonly pollInterval: number
  readonly stablePolls: number
  readonly query?: { directory: string }
  readonly signal?: AbortSignal
  readonly log: LogFn
  readonly poll: PollFn
}): Promise<RecoveryResult> {
  const {
    sessionError, sessionId, sessionKey, client, directory,
    parts, timeout, pollInterval, stablePolls, query, signal,
    log, poll,
  } = params

  log("info", "错误字段检查", {
    sessionKey,
    fields: sessionError.fields,
    isModel: isModelError(sessionError.fields),
  })

  if (!isModelError(sessionError.fields)) {
    return { recovered: false, sessionError }
  }

  const attempts = getRetryAttempts(sessionKey)
  if (attempts >= MAX_RETRY_ATTEMPTS) {
    log("warn", "已达重试上限，放弃恢复", { sessionKey, attempts })
    return { recovered: false, sessionError }
  }

  try {
    let modelOverride: { providerID: string; modelID: string } | undefined
    try {
      modelOverride = await getGlobalDefaultModel(client, directory)
    } catch (configErr) {
      log("warn", "读取全局模型配置失败", {
        sessionKey,
        error: configErr instanceof Error ? configErr.message : String(configErr),
      })
    }

    if (!modelOverride) {
      log("warn", "全局默认模型未配置，放弃恢复", { sessionKey })
      return { recovered: false, sessionError }
    }

    setRetryAttempts(sessionKey, attempts + 1)
    log("info", "使用全局默认模型恢复", {
      sessionKey,
      providerID: modelOverride.providerID,
      modelID: modelOverride.modelID,
    })

    clearSessionError(sessionId)
    await client.session.promptAsync({
      path: { id: sessionId },
      query,
      body: { parts: [...parts], model: modelOverride },
    })

    const finalText = await poll(client, sessionId, {
      timeout, pollInterval, stablePolls, query, signal,
    })

    log("info", "模型恢复后响应完成", {
      sessionKey, sessionId, output: finalText || "(empty)",
    })

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
    let updatedError: CachedSessionError
    if (recoveryErr instanceof SessionErrorDetected) {
      updatedError = recoveryErr.sessionError
      clearSessionError(sessionId)
    } else {
      const sseError = getSessionError(sessionId)
      if (sseError) {
        updatedError = sseError
        clearSessionError(sessionId)
      } else {
        updatedError = { message: errMsg, fields: [] }
      }
    }

    log("error", "模型恢复失败", { sessionId, sessionKey, error: errMsg })

    return { recovered: false, sessionError: updatedError }
  }
}
