/**
 * 飞书 WebSocket 长连接：接收消息并回调
 */
import * as Lark from "@larksuiteoapi/node-sdk"
import { HttpsProxyAgent } from "https-proxy-agent"
import type { Agent } from "node:https"
import type { FeishuMessageContext, ResolvedConfig, LogFn } from "../types.js"
import { type CardActionData, buildCallbackResponse } from "../handler/interactive.js"
import { isDuplicate } from "./dedup.js"
import { describeMessageType } from "./content-extractor.js"
import { isBotMentioned } from "./group-filter.js"

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
  onCardAction?: (action: CardActionData) => Promise<void>
  log: LogFn
}

export interface FeishuGatewayResult {
  client: InstanceType<typeof Lark.Client>
  stop: () => void
}

/**
 * 启动飞书 WebSocket 网关，返回 Client（供 sender 使用）和 stop 函数
 */
export function startFeishuGateway(options: FeishuGatewayOptions): FeishuGatewayResult {
  const { config, larkClient, botOpenId = "", onMessage, onBotAdded, onCardAction, log } = options
  const { appId, appSecret } = config
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    ""

  let wsAgent: Agent | undefined
  if (proxyUrl) {
    wsAgent = new HttpsProxyAgent(proxyUrl)
    log("info", "WS proxy enabled", { proxy: proxyUrl })
  }

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: Record<string, unknown>) => {
      try {
        log("info", "收到飞书事件", {
          keys: Object.keys(data || {}),
        })
        const message = (data as { message?: Record<string, unknown> }).message
        if (!message) return

        const chatId = message.chat_id as string | undefined
        if (!chatId) return

        const messageId = message.message_id as string | undefined
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
        let text = describeMessageType(messageType, rawContent)
        if (messageType === "text") {
          text = text.replace(/@_user_\d+\s*/g, "").trim()
        }
        if (!text) return

        const chatType = (message.chat_type as string) === "group" ? "group" : "p2p"

        // 群聊：仅在被 @ 时回复（静默监听）
        let shouldReply = true
        if (chatType === "group") {
          const mentions = Array.isArray(message.mentions) ? message.mentions : []
          shouldReply = isBotMentioned(
            mentions as Array<{ id?: { open_id?: string } }>,
            botOpenId,
          )
        }

        const sender = (data as { sender?: { sender_id?: { open_id?: string } } }).sender
        const senderId = sender?.sender_id?.open_id ?? ""
        const rootId = message.root_id as string | undefined
        const createTime = message.create_time as string | undefined

        const ctx: FeishuMessageContext = {
          chatId: String(chatId),
          messageId: messageId ?? "",
          messageType,
          content: text,
          rawContent,
          chatType,
          senderId,
          rootId,
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
      }
    },
    "im.chat.member.bot.added_v1": async (data: Record<string, unknown>) => {
      try {
        const chatId = data.chat_id as string | undefined
        if (chatId && onBotAdded) {
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
        // 类型化事件 payload（双路径兼容 SDK v1/v2 格式）
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

        // 检测 send_message 按钮：构造合成消息，走正常消息流程
        const sendMsg = parseSendMessageAction(action)
        if (sendMsg) {
          const syntheticCtx: FeishuMessageContext = {
            chatId: sendMsg.chatId,
            messageId: `btn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            messageType: "text",
            content: sendMsg.text,
            rawContent: JSON.stringify({ text: sendMsg.text }),
            chatType: sendMsg.chatType,
            senderId: action.operatorId ?? "",
            shouldReply: true,
          }
          void Promise.resolve(onMessage(syntheticCtx)).catch((err: unknown) => {
            log("error", "send_message 按钮处理失败", {
              error: err instanceof Error ? err.message : String(err),
            })
          })
          return buildCallbackResponse(action)
        }

        // fire-and-forget（必须 3s 内返回）
        if (onCardAction) {
          void onCardAction(action).catch((err) => {
            log("error", "card action 处理失败", {
              error: err instanceof Error ? err.message : String(err),
            })
          })
        }

        // 即时返回 toast
        return buildCallbackResponse(action)
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
    log("info", "飞书 WebSocket 网关停止中")
    wsClient.close()
    log("info", "飞书 WebSocket 网关已停止")
  }

  return { client: larkClient, stop }
}

interface SendMessagePayload {
  chatId: string
  chatType: "p2p" | "group"
  text: string
}

/**
 * 解析 send_message 类型的按钮回调 value
 */
function parseSendMessageAction(action: CardActionData): SendMessagePayload | undefined {
  if (!action.actionValue) return undefined
  try {
    const value = JSON.parse(action.actionValue) as Record<string, unknown>
    if (value.action !== "send_message") return undefined
    const text = typeof value.text === "string" ? value.text : ""
    const chatId = typeof value.chatId === "string" ? value.chatId : ""
    if (!text || !chatId) return undefined
    const chatType = value.chatType === "group" ? "group" as const : "p2p" as const
    return { chatId, chatType, text }
  } catch {
    return undefined
  }
}
