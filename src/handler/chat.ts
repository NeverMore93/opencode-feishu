/**
 * 对话处理：会话管理、占位消息、prompt 发送、轮询等待、最终回复
 */
import type { FeishuMessageContext, ResolvedConfig, LogFn } from "../types.js"
import type { OpencodeClient } from "@opencode-ai/sdk"
import * as sender from "../feishu/sender.js"
import {
  registerPending, unregisterPending,
  getSessionError, clearSessionError,
  clearForkAttempts, getForkAttempts, setForkAttempts, MAX_FORK_ATTEMPTS,
  isModelError, extractErrorFields,
} from "./event.js"
import { buildSessionKey, getOrCreateSession, invalidateCachedSession, setCachedSession, forkOrCreateSession } from "../session.js"
import { extractParts, type PromptPart } from "../feishu/content-extractor.js"
import type * as Lark from "@larksuiteoapi/node-sdk"

/** SSE 事件竞态等待窗口（ms），让 session.error 有机会在 HTTP 错误后到达 */
const SSE_RACE_WAIT_MS = 100

/** 每个会话的活跃自动提示循环，用于用户介入时中断 */
const activeAutoPrompts = new Map<string, AbortController>()

export interface ChatDeps {
  config: ResolvedConfig
  client: OpencodeClient
  feishuClient: InstanceType<typeof Lark.Client>
  log: LogFn
  directory: string
}

export async function handleChat(ctx: FeishuMessageContext, deps: ChatDeps): Promise<void> {
  const { content, chatId, chatType, senderId, shouldReply, messageType, rawContent, messageId } = ctx
  if (!content.trim() && messageType === "text") return

  const { config, client, feishuClient, log, directory } = deps
  const query = directory ? { directory } : undefined

  const sessionKey = buildSessionKey(chatType, chatType === "p2p" ? senderId : chatId)

  // 用户发新消息时中断该会话的自动提示循环
  const existing = activeAutoPrompts.get(sessionKey)
  if (existing) {
    existing.abort()
    activeAutoPrompts.delete(sessionKey)
    log("info", "用户介入，自动提示已中断", { sessionKey: sessionKey })
  }

  const session = await getOrCreateSession(client, sessionKey, directory)

  // 提取消息内容为 OpenCode parts
  const parts = await buildPromptParts(feishuClient, messageId, messageType, rawContent, content, chatType, senderId, log)
  if (!parts.length) return

  log("info", "收到用户消息", {
    sessionKey,
    sessionId: session.id,
    chatType,
    senderId,
    messageType,
    shouldReply,
    content,
    parts,
  })

  const baseBody = { parts }

  // 静默监听模式：消息发给 OpenCode 作为上下文，不触发 AI 回复
  if (!shouldReply) {
    try {
      await client.session.prompt({
        path: { id: session.id },
        query,
        body: { ...baseBody, noReply: true },
      })
    } catch (err) {
      log("warn", "静默转发失败", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return
  }

  const timeout = config.timeout
  const thinkingDelay = config.thinkingDelay
  const pollInterval = config.pollInterval
  const stablePolls = config.stablePolls

  let placeholderId = ""
  let done = false
  let activeSessionId = session.id
  const timer =
    thinkingDelay > 0
      ? setTimeout(async () => {
          if (done) return
          try {
            const res = await sender.sendTextMessage(feishuClient, chatId, "正在思考…")
            if (done) return // 重新检查，防止发送期间主流程已结束
            if (res.ok && res.messageId) {
              placeholderId = res.messageId
              registerPending(activeSessionId, { chatId, placeholderId, feishuClient })
            }
          } catch (err) {
            log("warn", "发送占位消息失败", {
              chatId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }, thinkingDelay)
      : null

  /** 自动提示循环：响应完成后自动发送"继续"推动 OpenCode 持续工作 */
  async function runAutoPromptLoop(activeId: string): Promise<void> {
    const { autoPrompt } = config
    if (!autoPrompt.enabled || !shouldReply) return

    const ac = new AbortController()
    activeAutoPrompts.set(sessionKey, ac)
    log("info", "启动自动提示循环", { sessionKey, maxIterations: autoPrompt.maxIterations })

    try {
      for (let i = 0; i < autoPrompt.maxIterations; i++) {
        await abortableSleep(autoPrompt.intervalSeconds * 1000, ac.signal)

        log("info", "发送自动提示", { sessionKey, iteration: i + 1 })

        await client.session.prompt({
          path: { id: activeId },
          query,
          body: { parts: [{ type: "text", text: autoPrompt.message }] },
        })

        const text = await pollForResponse(client, activeId, { timeout, pollInterval, stablePolls, query, signal: ac.signal })
        if (text) {
          log("info", "自动提示响应", {
            sessionKey,
            iteration: i + 1,
            output: text,
          })
          await sender.sendTextMessage(feishuClient, chatId, text)
        }
      }

      log("info", "自动提示循环结束（达到最大次数）", { sessionKey: sessionKey })
    } catch (loopErr) {
      if ((loopErr as Error).name === "AbortError") {
        log("info", "自动提示循环被中断", { sessionKey: sessionKey })
      } else {
        log("error", "自动提示循环异常", {
          sessionKey,
          error: loopErr instanceof Error ? loopErr.message : String(loopErr),
        })
      }
    } finally {
      activeAutoPrompts.delete(sessionKey)
    }
  }

  try {
    await client.session.prompt({
      path: { id: session.id },
      query,
      body: baseBody,
    })

    const finalText = await pollForResponse(client, session.id, { timeout, pollInterval, stablePolls, query })

    log("info", "模型响应完成", {
      sessionKey,
      sessionId: session.id,
      output: finalText || "(empty)",
    })

    // prompt 成功：重置 fork 计数
    clearForkAttempts(sessionKey)

    await replyOrUpdate(feishuClient, chatId, placeholderId, finalText || "⚠️ 响应超时")

    await runAutoPromptLoop(session.id)
  } catch (err) {
    // 等待一个微小窗口，让可能在途的 session.error 事件有机会到达并被处理
    await new Promise(r => setTimeout(r, SSE_RACE_WAIT_MS))

    let sessionError = getSessionError(session.id)
    clearSessionError(session.id)

    // SSE 缓存未命中时，尝试从 prompt() 抛出的错误中提取模型错误信息
    if (!sessionError) {
      const thrownFields = extractErrorFields(err)
      if (isModelError(thrownFields)) {
        const thrownMsg = err instanceof Error ? err.message : String(err)
        sessionError = { message: thrownMsg, fields: thrownFields }
      }
    }

    // 模型不兼容错误：在 catch 块内完成整个恢复流程（fork → 解析模型 → 重试）
    if (sessionError && isModelError(sessionError.fields)) {
      const attempts = getForkAttempts(sessionKey)
      if (attempts < MAX_FORK_ATTEMPTS) {
        setForkAttempts(sessionKey, attempts + 1)
        try {
          invalidateCachedSession(session.id)
          const newSession = await forkOrCreateSession(client, session.id, sessionKey, directory, log)
          setCachedSession(sessionKey, newSession)
          activeSessionId = newSession.id

          // 解析降级模型
          let modelOverride: { providerID: string; modelID: string } | undefined
          try {
            modelOverride = await resolveLatestModel(client, sessionError.fields, directory)
            if (modelOverride) {
              log("info", "已解析降级模型", {
                sessionKey,
                providerID: modelOverride.providerID,
                modelID: modelOverride.modelID,
              })
            }
          } catch (modelErr) {
            log("warn", "解析降级模型失败，将使用默认模型", {
              sessionKey,
              error: modelErr instanceof Error ? modelErr.message : String(modelErr),
            })
          }

          // 迁移占位消息到新 session
          unregisterPending(session.id)
          if (placeholderId) {
            registerPending(newSession.id, { chatId, placeholderId, feishuClient })
          }

          // 用新 session + 降级模型重试 prompt
          const retryBody = { ...baseBody, ...(modelOverride ? { model: modelOverride } : {}) }
          await client.session.prompt({
            path: { id: newSession.id },
            query,
            body: retryBody,
          })

          const finalText = await pollForResponse(client, newSession.id, { timeout, pollInterval, stablePolls, query })

          log("info", "恢复后模型响应完成", {
            sessionKey,
            newSessionId: newSession.id,
            output: finalText || "(empty)",
          })

          clearForkAttempts(sessionKey)
          await replyOrUpdate(feishuClient, chatId, placeholderId, finalText || "⚠️ 响应超时")

          log("info", "模型不兼容恢复成功", {
            oldSessionId: session.id,
            newSessionId: newSession.id,
            sessionKey,
            forkAttempt: attempts + 1,
          })

          await runAutoPromptLoop(newSession.id)
          return
        } catch (recoveryErr) {
          const recoveryErrMsg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)
          // 检查恢复过程中新 session 是否也产生了 SSE 错误
          const newSessionError = activeSessionId !== session.id ? getSessionError(activeSessionId) : undefined
          if (newSessionError) clearSessionError(activeSessionId)
          // 用恢复阶段的实际错误覆盖原始的 model-not-found 错误
          sessionError = newSessionError ?? { message: recoveryErrMsg, fields: [] }
          log("error", "模型恢复失败", {
            sessionId: session.id,
            sessionKey,
            error: recoveryErrMsg,
          })
          // fall through 到正常错误处理
        }
      } else {
        log("warn", "已达 fork 上限，放弃恢复", {
          sessionKey,
          attempts,
        })
      }
    }

    // 正常错误处理：优先使用 session.error 事件中的实际错误信息
    const thrownError = err instanceof Error ? err.message : String(err)
    const errorMessage = sessionError?.message || thrownError

    log("error", "对话处理失败", {
      sessionId: session.id,
      sessionKey,
      chatType,
      error: thrownError,
      ...(sessionError
        ? { sessionError: sessionError.message }
        : { sseRaceMiss: true }),
    })
    const msg = "❌ " + errorMessage
    await replyOrUpdate(feishuClient, chatId, placeholderId, msg)
  } finally {
    done = true
    if (timer) clearTimeout(timer)
    unregisterPending(activeSessionId)
  }
}

/**
 * 从错误字段中提取 providerID，查询可用模型列表，返回最新可用模型
 */
async function resolveLatestModel(
  client: OpencodeClient,
  errorFields: string[],
  directory?: string,
): Promise<{ providerID: string; modelID: string } | undefined> {
  const pattern = /model not found:?\s*(\w[\w-]*)\//i
  const rawProviderID = errorFields.map(f => pattern.exec(f)?.[1]).find(Boolean)
  if (!rawProviderID) return undefined
  // provider API 的 id 是小写的，错误消息可能是 "OpenAI/..." 等混合大小写
  const providerID = rawProviderID.toLowerCase()

  const query = directory ? { directory } : undefined
  const { data } = await client.provider.list({ query })
  if (!data) return undefined

  // 优先使用该 provider 的默认模型
  const defaultModelID = data.default?.[providerID]
  if (defaultModelID) {
    return { providerID, modelID: defaultModelID }
  }

  // Fallback：从 provider 的模型列表中选最新模型（优先 tool_call，其次任意非 deprecated）
  const provider = data.all?.find(p => p.id === providerID)
  if (!provider?.models) return undefined

  const sortedModels = Object.values(provider.models)
    .filter(m => m.status !== "deprecated")
    .sort((a, b) => b.release_date.localeCompare(a.release_date))

  if (sortedModels.length === 0) return undefined
  const best = sortedModels.find(m => m.tool_call) ?? sortedModels[0]
  return { providerID, modelID: best.id }
}

/**
 * 将飞书消息转换为 OpenCode prompt parts
 * 文本类型添加群聊发送者前缀；其他类型通过 content-extractor 提取
 */
async function buildPromptParts(
  feishuClient: InstanceType<typeof Lark.Client>,
  messageId: string,
  messageType: string,
  rawContent: string,
  textContent: string,
  chatType: "p2p" | "group",
  senderId: string,
  log: LogFn,
): Promise<PromptPart[]> {
  if (messageType === "text") {
    // 文本消息：沿用原有逻辑，群聊添加发送者前缀
    let promptText = textContent
    if (chatType === "group" && senderId) {
      promptText = `[${senderId}]: ${textContent}`
    }
    return [{ type: "text", text: promptText }]
  }

  // 非文本消息：通过 content-extractor 提取
  const parts = await extractParts(feishuClient, messageId, messageType, rawContent, log)

  // 群聊非文本消息：在 parts 前添加发送者前缀
  if (chatType === "group" && senderId && parts.length > 0) {
    return [{ type: "text", text: `[${senderId}]:` }, ...parts]
  }

  return parts
}

/**
 * 轮询等待 AI 响应稳定，返回最终文本
 */
async function pollForResponse(
  client: OpencodeClient,
  sessionId: string,
  opts: {
    timeout: number
    pollInterval: number
    stablePolls: number
    query?: { directory: string }
    signal?: AbortSignal
  },
): Promise<string> {
  const { timeout, pollInterval, stablePolls, query, signal } = opts
  const start = Date.now()
  let lastText = ""
  let sameCount = 0

  while (Date.now() - start < timeout) {
    if (signal) {
      await abortableSleep(pollInterval, signal)
    } else {
      await new Promise((r) => setTimeout(r, pollInterval))
    }
    const { data: messages } = await client.session.messages({ path: { id: sessionId }, query })
    const text = extractLastAssistantText(messages ?? [])

    if (text && text !== lastText) {
      lastText = text
      sameCount = 0
    } else if (text && text.length > 0) {
      sameCount++
      if (sameCount >= stablePolls) break
    }
  }

  const { data: finalMessages } = await client.session.messages({ path: { id: sessionId }, query })
  return extractLastAssistantText(finalMessages ?? []) || lastText
}

async function replyOrUpdate(
  feishuClient: InstanceType<typeof Lark.Client>,
  chatId: string,
  placeholderId: string,
  text: string,
): Promise<void> {
  if (placeholderId) {
    const res = await sender.updateMessage(feishuClient, placeholderId, text)
    if (!res.ok) {
      await sender.sendTextMessage(feishuClient, chatId, text)
    }
  } else {
    await sender.sendTextMessage(feishuClient, chatId, text)
  }
}

/**
 * 可被 AbortSignal 中断的 sleep
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const onDone = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      onDone()
      reject(new DOMException("Aborted", "AbortError"))
    }
    const timer = setTimeout(() => {
      onDone()
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function extractLastAssistantText(
  messages: Array<{
    info: { role?: string; [key: string]: unknown }
    parts: Array<{ type?: string; text?: string; [key: string]: unknown }>
  }>,
): string {
  const assistant = messages.filter((m) => m.info?.role === "assistant").pop()
  const parts = assistant?.parts ?? []
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim()
}
