/**
 * 飞书 WebSocket 网关。
 *
 * 它负责把飞书事件世界翻译成仓库内部可消费的三个入口：
 * - `onMessage`：收到一条可处理消息
 * - `onBotAdded`：bot 被拉入群
 * - `onCardAction`：用户点击卡片按钮
 */
import * as Lark from "@larksuiteoapi/node-sdk"
import type { Agent } from "node:https"
import { randomUUID } from "node:crypto"
import * as httpsProxyAgent from "https-proxy-agent"
import type { FeishuMessageContext, ResolvedConfig, LogFn } from "../types.js"
import { type CardActionData, buildCallbackResponse, parseCardActionValue } from "../handler/interactive.js"
import { isDuplicate } from "./dedup.js"
import { describeMessageType } from "./content-extractor.js"
import { isBotMentioned } from "./group-filter.js"

// 兼容 Bun 和 Node.js 的 CJS/ESM interop。
const { HttpsProxyAgent } = httpsProxyAgent

/** 启动飞书网关所需的外部依赖。 */
export interface FeishuGatewayOptions {
  config: ResolvedConfig
  /** 外部创建的 Lark Client（复用 token 管理和 HTTP 客户端） */
  larkClient: InstanceType<typeof Lark.Client>
  /** bot 自身的 open_id（启动时通过 bot info API 获取），用于群聊 @提及检测 */
  botOpenId?: string
  onMessage: (ctx: FeishuMessageContext) => void | Promise<void>
  /** bot 被拉入群聊时触发（用于摄入历史上下文） */
  onBotAdded?: (chatId: string) => void | Promise<void>
  /** 卡片按钮点击回调 */
  onCardAction?: (action: CardActionData) => Promise<object | undefined>
  log: LogFn
}

export interface FeishuGatewayResult {
  /** 复用的飞书 SDK client，供发送模块继续使用。 */
  client: InstanceType<typeof Lark.Client>
  /** 主动关闭 WebSocket 连接的函数。 */
  stop: () => void
}

/**
 * 将飞书会话类型压缩成仓库内部统一使用的 `"group" | "p2p"`。
 *
 * 飞书 REST `chat.get` 返回的 `chat_mode` / `chat_type` 可能出现不同字面量，
 * 这里只做最小必要映射；无法识别时返回 `undefined`，交由上层决定是否拒绝。
 */
function normalizeResolvedChatType(rawValue: string | undefined): "group" | "p2p" | undefined {
  const normalized = rawValue?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized.includes("p2p")) return "p2p"
  if (normalized.includes("group") || normalized.includes("topic")) return "group"
  return undefined
}

/**
 * 为卡片 `send_message` 回调确定最终 chatType。
 *
 * 普通新卡片会自带 `chatType`；只有旧卡片缺字段，或 payload/chat 回调上下文不一致时，
 * 才额外查询飞书会话信息做权威兜底，避免把群聊误路由到 p2p session。
 */
async function resolveCardActionChatType(params: {
  chatId: string
  payloadChatType?: "p2p" | "group"
  requireAuthoritativeLookup: boolean
  larkClient: InstanceType<typeof Lark.Client>
  log: LogFn
}): Promise<"p2p" | "group" | undefined> {
  const { chatId, payloadChatType, requireAuthoritativeLookup, larkClient, log } = params
  if (!requireAuthoritativeLookup && payloadChatType) {
    return payloadChatType
  }

  try {
    const response = await larkClient.im.chat.get({
      path: { chat_id: chatId },
    })
    const resolvedFromResponse =
      normalizeResolvedChatType(response.data?.chat_mode) ??
      normalizeResolvedChatType(response.data?.chat_type)

    if (resolvedFromResponse) {
      if (payloadChatType && payloadChatType !== resolvedFromResponse) {
        log("warn", "send_message 按钮 chatType 与飞书会话信息不一致，使用飞书会话类型", {
          chatId,
          payloadChatType,
          resolvedChatType: resolvedFromResponse,
          chatMode: response.data?.chat_mode ?? "",
          rawChatType: response.data?.chat_type ?? "",
        })
      }
      return resolvedFromResponse
    }

    log("error", "无法从飞书会话信息推断 send_message 按钮 chatType", {
      chatId,
      payloadChatType: payloadChatType ?? "",
      chatMode: response.data?.chat_mode ?? "",
      rawChatType: response.data?.chat_type ?? "",
      code: response.code ?? 0,
      msg: response.msg ?? "",
    })
  } catch (err) {
    log("error", "查询 send_message 按钮会话信息失败", {
      chatId,
      payloadChatType: payloadChatType ?? "",
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return requireAuthoritativeLookup ? undefined : payloadChatType
}

/**
 * 启动飞书 WebSocket 网关，返回 Client（供 sender 使用）和 stop 函数
 */
export function startFeishuGateway(options: FeishuGatewayOptions): FeishuGatewayResult {
  const { config, larkClient, botOpenId = "", onMessage, onBotAdded, onCardAction, log } = options
  const { appId, appSecret } = config
  // 优先读取常见代理环境变量，让 WebSocket 也能跟随企业网络设置。
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    ""

  let wsAgent: Agent | undefined
  if (proxyUrl) {
    wsAgent = new HttpsProxyAgent(proxyUrl)
    // 代理地址可能带账号密码；日志里只保留脱敏后的可定位信息，避免敏感凭据落盘。
    log("info", "WS proxy enabled", { proxy: redactProxyUrlForLog(proxyUrl) })
  }

  // EventDispatcher 是飞书 SDK 的事件分发核心；这里只注册我们真正关心的几类事件。
  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: Record<string, unknown>) => {
      // catch 块需要这两个值来发送兜底消息，提前声明。
      let fallbackChatId: string | undefined
      let fallbackShouldReply = false
      try {
        log("info", "收到飞书事件", {
          keys: Object.keys(data || {}),
        })
        const message = (data as { message?: Record<string, unknown> }).message
        if (!message) return

        const chatId = message.chat_id as string | undefined
        if (!chatId) return
        fallbackChatId = chatId

        const messageId = message.message_id as string | undefined
        // 去重必须尽早做，避免后面一整条消息链路重复执行。
        if (isDuplicate(messageId)) return

        const messageType = (message.message_type as string) ?? "text"
        const rawContent = (message.content as string) ?? ""
        log("info", "飞书消息元信息", {
          chatId,
          messageId: messageId ?? "",
          messageType,
          hasContent: !!rawContent,
        })
        if (!rawContent) return

        // 提取文本内容（用于 @提及清理和空消息过滤）
        let text = describeMessageType(messageType, rawContent, log)
        if (messageType === "text") {
          // text 消息里的 @mention token 在决定 shouldReply 后就没有必要再传给模型。
          text = text.replace(/@_user_\d+\s*/g, "").trim()
        }
        if (!text) return

        const chatType = (message.chat_type as string) === "group" ? "group" : "p2p"

        // 群聊默认静默监听；只有真的 @到 bot 才转入“需要回复”的链路。
        let shouldReply = true
        if (chatType === "group") {
          const mentions = Array.isArray(message.mentions) ? message.mentions : []
          shouldReply = isBotMentioned(
            mentions as Array<{ id?: { open_id?: string } }>,
            botOpenId,
          )
        }
        fallbackShouldReply = shouldReply

        const sender = (data as { sender?: { sender_id?: { open_id?: string } } }).sender
        const senderId = sender?.sender_id?.open_id ?? ""
        const rootId = message.root_id as string | undefined
        const parentId = message.parent_id as string | undefined
        const createTime = message.create_time as string | undefined

        // 把飞书原始事件折叠成仓库内部统一消息上下文。
        const ctx: FeishuMessageContext = {
          chatId: String(chatId),
          messageId: messageId ?? "",
          messageType,
          content: text,
          rawContent,
          chatType,
          senderId,
          rootId,
          parentId,
          createTime,
          shouldReply,
        }

        log("info", "收到飞书消息", {
          chatId: String(chatId),
          messageId: messageId ?? "",
          chatType,
          shouldReply,
          textPreview: text.slice(0, 80),
        })

        await onMessage(ctx)
      } catch (err) {
        log("error", "消息处理错误", {
          error: err instanceof Error ? err.message : String(err),
        })
        if (fallbackShouldReply && fallbackChatId) {
          larkClient.im.message.create({
            data: {
              receive_id: fallbackChatId,
              msg_type: "text",
              content: JSON.stringify({ text: "⚠️ 消息处理异常，请重试" }),
            },
            params: { receive_id_type: "chat_id" },
          }).catch(() => {})
        }
      }
    },
    "im.chat.member.bot.added_v1": async (data: Record<string, unknown>) => {
      try {
        const chatId = data.chat_id as string | undefined
        if (chatId && onBotAdded) {
          // Bot 刚被拉入群时，异步触发历史消息摄入。
          log("info", "Bot 被添加到群聊", { chatId })
          await onBotAdded(chatId)
        }
      } catch (err) {
        log("error", "Bot入群处理错误", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    "card.action.trigger": async (data: Record<string, unknown>) => {
      try {
        // 类型化事件 payload（双路径兼容 SDK v1/v2 格式）。
        const evt = data as {
          action?: { value?: unknown; tag?: string }
          context?: { open_message_id?: string; open_chat_id?: string }
          open_message_id?: string
          open_chat_id?: string
          operator?: { open_id?: string }
        }
        const action: CardActionData = {
          actionValue: (typeof evt.action?.value === "object" && evt.action.value !== null)
            ? JSON.stringify(evt.action.value)
            : String(evt.action?.value ?? ""),
          actionTag: String(evt.action?.tag ?? ""),
          messageId: String(evt.context?.open_message_id ?? evt.open_message_id ?? ""),
          chatId: String(evt.context?.open_chat_id ?? evt.open_chat_id ?? ""),
          operatorId: String(evt.operator?.open_id ?? ""),
        }

        // 特判 send_message 按钮：把按钮点击伪装成一条新的用户文本消息，复用正常消息链路。
        const parsedAction = parseCardActionValue(action.actionValue, log)
        if (parsedAction?.action === "send_message") {
          // 飞书回调上下文里的 chatId 才是本次点击发生位置的权威来源，按钮 payload 只做冗余校验。
          const callbackChatId = action.chatId?.trim() ?? ""
          if (callbackChatId && callbackChatId !== parsedAction.chatId) {
            log("warn", "send_message 按钮 chatId 与回调上下文不一致，使用回调 chatId", {
              callbackChatId,
              payloadChatId: parsedAction.chatId,
            })
          }
          const targetChatId = callbackChatId || parsedAction.chatId
          const chatIdMismatch = !!callbackChatId && callbackChatId !== parsedAction.chatId
          void (async () => {
            const resolvedChatType = await resolveCardActionChatType({
              chatId: targetChatId,
              payloadChatType: parsedAction.chatType,
              // 旧卡片缺 chatType 或 payload chatId 已明显过期时，必须查飞书权威会话信息再继续。
              requireAuthoritativeLookup: !parsedAction.chatType || chatIdMismatch,
              larkClient,
              log,
            })
            if (!resolvedChatType) {
              log("error", "send_message 按钮 chatType 无法确定，已拒绝处理", {
                callbackChatId,
                payloadChatId: parsedAction.chatId,
                payloadChatType: parsedAction.chatType ?? "",
                targetChatId,
                operatorId: action.operatorId,
              })
              // toast 已在 IIFE 外返回"已发送"，这里尽力补一条错误消息告知用户。
              await larkClient.im.message.create({
                data: {
                  receive_id: targetChatId,
                  msg_type: "text",
                  content: JSON.stringify({ text: "⚠️ 消息发送失败：无法确定目标会话类型" }),
                },
                params: { receive_id_type: "chat_id" },
              }).catch(() => {})
              return
            }
            if (!parsedAction.chatType) {
              log("warn", "send_message 按钮缺少 chatType，已按飞书会话信息兼容推断", {
                callbackChatId,
                payloadChatId: parsedAction.chatId,
                targetChatId,
                resolvedChatType,
              })
            }
            const syntheticCtx: FeishuMessageContext = {
              chatId: targetChatId,
              messageId: `btn-${randomUUID()}`,
              messageType: "text",
              content: parsedAction.text,
              rawContent: JSON.stringify({ text: parsedAction.text }),
              chatType: resolvedChatType,
              senderId: action.operatorId ?? "",
              shouldReply: true,
            }
            await onMessage(syntheticCtx)
          })().catch((err: unknown) => {
            log("error", "send_message 按钮处理失败", {
              error: err instanceof Error ? err.message : String(err),
            })
            // toast 已返回"已发送"，尽力补一条错误消息。
            larkClient.im.message.create({
              data: {
                receive_id: targetChatId,
                msg_type: "text",
                content: JSON.stringify({ text: "⚠️ 消息发送失败，请重试" }),
              },
              params: { receive_id_type: "chat_id" },
            }).catch(() => {})
          })
          // 即使后台还没处理完，也要马上给飞书回一个 toast。
          return buildCallbackResponse(action, log)
        }

        // 其他交互统一走 onCardAction；由上层决定是否同步返回更精确的 toast。
        if (onCardAction) {
          const callbackResponse = await onCardAction(action)
          const response = callbackResponse ?? buildCallbackResponse(action, log)
          if (Object.keys(response).length === 0) {
            log("warn", "card.action.trigger 收到未识别 action，返回 fallback toast", {
              actionValue: action.actionValue?.slice(0, 200),
              actionTag: action.actionTag,
              chatId: action.chatId,
              operatorId: action.operatorId,
            })
            return { toast: { type: "info", content: "该按钮未配置对应行为，请联系会话发起者" } }
          }
          return response
        }

        // 即时返回 toast；未识别的 action 返回 fallback toast。
        const fallbackCheck = buildCallbackResponse(action, log)
        if (Object.keys(fallbackCheck).length === 0) {
          log("warn", "card.action.trigger 收到未识别 action，返回 fallback toast", {
            actionValue: action.actionValue?.slice(0, 200),
            actionTag: action.actionTag,
            chatId: action.chatId,
            operatorId: action.operatorId,
          })
          return { toast: { type: "info", content: "该按钮未配置对应行为，请联系会话发起者" } }
        }
        return fallbackCheck
      } catch (err) {
        log("error", "card.action.trigger 处理异常", {
          error: err instanceof Error ? err.message : String(err),
        })
        return {}
      }
    },
  })

  const logLevelMap: Record<string, Lark.LoggerLevel> = {
    fatal: Lark.LoggerLevel.fatal,
    error: Lark.LoggerLevel.error,
    warn: Lark.LoggerLevel.warn,
    info: Lark.LoggerLevel.info,
    debug: Lark.LoggerLevel.debug,
    trace: Lark.LoggerLevel.trace,
  }

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    domain: Lark.Domain.Feishu,
    ...(wsAgent ? { agent: wsAgent } : {}),
    loggerLevel: logLevelMap[config.logLevel] ?? Lark.LoggerLevel.info,
    logger: {
      // 飞书 SDK 的不同级别统一桥接到项目日志系统。
      error: (...msg: unknown[]) => log("error", "[lark.ws]", { msg }),
      warn: (...msg: unknown[]) => log("warn", "[lark.ws]", { msg }),
      info: (...msg: unknown[]) => log("info", "[lark.ws]", { msg }),
      debug: (...msg: unknown[]) => log("info", "[lark.ws]", { msg }),
      trace: (...msg: unknown[]) => log("info", "[lark.ws]", { msg }),
    },
  })

  wsClient.start({ eventDispatcher: dispatcher })
  log("info", "飞书 WebSocket 网关已启动", { appIdPrefix: appId.slice(0, 8) + "..." })

  const stop = () => {
    // 停止时只需要关闭 WSClient；飞书 SDK 自身会处理底层连接资源。
    log("info", "飞书 WebSocket 网关停止中")
    wsClient.close()
    log("info", "飞书 WebSocket 网关已停止")
  }

  return { client: larkClient, stop }
}

/**
 * 代理 URL 可能带有 `user:pass@host` 形式的凭据。
 * 日志里统一脱敏，既保留排障所需的地址信息，也避免明文暴露敏感字段。
 */
function redactProxyUrlForLog(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl)
    if (parsed.username || parsed.password) {
      parsed.username = "***"
      parsed.password = "***"
    }
    return parsed.toString()
  } catch {
    return "[invalid-proxy-url]"
  }
}
