/**
 * 飞书 WebSocket 长连接：接收消息并回调
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuMessageContext } from "../types.js";
import { isDuplicate } from "./dedup.js";
import { isBotMentioned } from "./group-filter.js";
import type { Config } from "../types.js";

export interface FeishuGatewayOptions {
  config: Config;
  /** bot 自身的 open_id（启动时通过 bot info API 获取），用于群聊 @提及检测 */
  botOpenId?: string;
  onMessage: (ctx: FeishuMessageContext) => void | Promise<void>;
  /** bot 被拉入群聊时触发（用于摄入历史上下文） */
  onBotAdded?: (chatId: string) => void | Promise<void>;
  log: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;
}

export interface FeishuGatewayResult {
  client: InstanceType<typeof Lark.Client>;
  stop: () => void;
}

/**
 * 启动飞书 WebSocket 网关，返回 Client（供 sender 使用）和 stop 函数
 */
export function startFeishuGateway(options: FeishuGatewayOptions): FeishuGatewayResult {
  const { config, botOpenId = "", onMessage, onBotAdded, log } = options;
  const { appId, appSecret } = config.feishu;

  const sdkConfig = {
    appId,
    appSecret,
    domain: Lark.Domain.Feishu,
    appType: Lark.AppType.SelfBuild,
  };

  const client = new Lark.Client(sdkConfig);

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: Record<string, unknown>) => {
      try {
        const message = (data as { message?: Record<string, unknown> }).message;
        if (!message) return;

        const chatId = message.chat_id as string | undefined;
        if (!chatId) return;

        const messageId = message.message_id as string | undefined;
        if (isDuplicate(messageId)) return;

        const messageType = (message.message_type as string) ?? "text";
        if (messageType !== "text" || !message.content) return;

        let text: string;
        try {
          const parsed = JSON.parse(message.content as string) as { text?: string };
          text = (parsed.text ?? "").trim();
        } catch {
          return;
        }
        text = text.replace(/@_user_\d+\s*/g, "").trim();
        if (!text) return;

        const chatType = (message.chat_type as string) === "group" ? "group" : "p2p";

        // 群聊：仅在被 @ 时回复（静默监听）
        let shouldReply = true;
        if (chatType === "group") {
          const mentions = Array.isArray(message.mentions) ? message.mentions : [];
          shouldReply = isBotMentioned(
            mentions as Array<{ id?: { open_id?: string } }>,
            botOpenId
          );
        }

        const sender = (data as { sender?: { sender_id?: { open_id?: string } } }).sender;
        const senderId = sender?.sender_id?.open_id ?? "";
        const rootId = message.root_id as string | undefined;

        const ctx: FeishuMessageContext = {
          chatId: String(chatId),
          messageId: messageId ?? "",
          messageType,
          content: text,
          chatType,
          senderId,
          rootId,
          shouldReply,
        };

        await onMessage(ctx);
      } catch (err) {
        log("error", "Message handler error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    "im.chat.member.bot.added_v1": async (data: Record<string, unknown>) => {
      try {
        const chatId = data.chat_id as string | undefined;
        if (chatId && onBotAdded) {
          log("info", "Bot added to group chat", { chatId });
          await onBotAdded(chatId);
        }
      } catch (err) {
        log("error", "Bot-added handler error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  const wsClient = new Lark.WSClient({
    ...sdkConfig,
    loggerLevel: Lark.LoggerLevel.info,
  });

  wsClient.start({ eventDispatcher: dispatcher });
  log("info", "Feishu WebSocket gateway started", { appIdPrefix: appId.slice(0, 8) + "..." });

  const stop = () => {
    log("info", "Stopping Feishu WebSocket gateway");
    // Lark WSClient 无显式 stop，依赖进程退出或 GC
  };

  return { client, stop };
}
