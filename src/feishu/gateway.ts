/**
 * 飞书 WebSocket 长连接：接收消息并回调
 */
import * as Lark from "@larksuiteoapi/node-sdk"
import { ProxyAgent } from "proxy-agent"
import type { FeishuMessageContext, ResolvedConfig, LogFn } from "../types.js"
import { isDuplicate } from "./dedup.js"
import { isBotMentioned } from "./group-filter.js"

export interface FeishuGatewayOptions {
  config: ResolvedConfig
  /** bot 自身的 open_id（启动时通过 bot info API 获取），用于群聊 @提及检测 */
  botOpenId?: string
  onMessage: (ctx: FeishuMessageContext) => void | Promise<void>
  /** bot 被拉入群聊时触发（用于摄入历史上下文） */
  onBotAdded?: (chatId: string) => void | Promise<void>
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
  const { config, botOpenId = "", onMessage, onBotAdded, log } = options
  const { appId, appSecret } = config
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    ""

  const wsAgent = new ProxyAgent()
  if (proxyUrl) {
    log("info", "WS proxy enabled", { proxy: proxyUrl })
  }

  const sdkConfig = {
    appId,
    appSecret,
    domain: Lark.Domain.Feishu,
    appType: Lark.AppType.SelfBuild,
  }

  const client = new Lark.Client(sdkConfig)

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
        log("info", "飞书消息元信息", {
          chatId,
          messageId: messageId ?? "",
          messageType,
          hasContent: !!message.content,
        })
        if (messageType !== "text" || !message.content) return

        let text: string
        try {
          const parsed = JSON.parse(message.content as string) as { text?: string }
          text = (parsed.text ?? "").trim()
        } catch {
          return
        }
        text = text.replace(/@_user_\d+\s*/g, "").trim()
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

        const ctx: FeishuMessageContext = {
          chatId: String(chatId),
          messageId: messageId ?? "",
          messageType,
          content: text,
          chatType,
          senderId,
          rootId,
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
  })

  const wsClient = new Lark.WSClient({
    ...sdkConfig,
    agent: wsAgent,
    loggerLevel: Lark.LoggerLevel.info,
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

  return { client, stop }
}
