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
  onCardAction?: (action: CardActionData) => Promise<void>
  log: LogFn
}

export interface FeishuGatewayResult {
  /** 复用的飞书 SDK client，供发送模块继续使用。 */
  client: InstanceType<typeof Lark.Client>
  /** 主动关闭 WebSocket 连接的函数。 */
  stop: () => void
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
    log("info", "WS proxy enabled", { proxy: proxyUrl })
  }

  // EventDispatcher 是飞书 SDK 的事件分发核心；这里只注册我们真正关心的几类事件。
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
          const syntheticCtx: FeishuMessageContext = {
            chatId: targetChatId,
            messageId: `btn-${randomUUID()}`,
            messageType: "text",
            content: parsedAction.text,
            rawContent: JSON.stringify({ text: parsedAction.text }),
            chatType: parsedAction.chatType,
            senderId: action.operatorId ?? "",
            shouldReply: true,
          }
          void Promise.resolve(onMessage(syntheticCtx)).catch((err: unknown) => {
            log("error", "send_message 按钮处理失败", {
              error: err instanceof Error ? err.message : String(err),
            })
          })
          // 即使后台还没处理完，也要马上给飞书回一个 toast。
          return buildCallbackResponse(action, log)
        }

        // 其他交互统一走 onCardAction，后台异步处理，避免卡住飞书 3 秒响应窗口。
        if (onCardAction) {
          void onCardAction(action).catch((err) => {
            log("error", "card action 处理失败", {
              error: err instanceof Error ? err.message : String(err),
            })
          })
        }

        // 即时返回 toast
        return buildCallbackResponse(action, log)
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
