/**
 * OpenCode 飞书插件入口
 * 独立服务：飞书 WebSocket 长连接 + OpenCode SDK，实现双向对话
 */
import "dotenv/config";
import { loadConfigWithSource } from "./config.js";
import { startFeishuGateway } from "./feishu/gateway.js";
import { createOpenCodeClient } from "./opencode/client.js";
import { createSessionManager } from "./session/manager.js";
import { route } from "./handler/router.js";
import { runCommand, sessionKeyFromContext } from "./handler/commands.js";
import { handleChat } from "./handler/chat.js";
import { startEventStream, registerPending, unregisterPending } from "./opencode/events.js";
import { ingestGroupHistory } from "./feishu/history.js";
import type { FeishuMessageContext } from "./types.js";

const SERVICE_NAME = "opencode-feishu";

function log(level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
  const payload = JSON.stringify({
    service: SERVICE_NAME,
    level,
    message,
    ...extra,
    time: new Date().toISOString(),
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.log(payload);
  }
}

/**
 * 获取 bot 自身的 open_id（用于群聊 @提及检测）
 * 通过飞书 API /open-apis/bot/v3/info 获取
 */
async function fetchBotOpenId(appId: string, appSecret: string): Promise<string> {
  try {
    // 1. 获取 tenant_access_token
    const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const tokenData = await tokenRes.json() as { tenant_access_token?: string };
    const token = tokenData?.tenant_access_token;
    if (!token) {
      log("warn", "获取 tenant_access_token 失败，群聊 @提及检测将使用 fallback 模式");
      return "";
    }

    // 2. 获取 bot 信息
    const botRes = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const botData = await botRes.json() as { bot?: { open_id?: string } };
    const openId = botData?.bot?.open_id;
    if (openId) {
      log("info", "Bot open_id 获取成功", { openId });
      return openId;
    }
    log("warn", "Bot open_id 为空，群聊 @提及检测将使用 fallback 模式");
    return "";
  } catch (err) {
    log("warn", "获取 bot open_id 失败，群聊 @提及检测将使用 fallback 模式", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

async function main(): Promise<void> {
  let config;
  try {
    const result = loadConfigWithSource({ directory: process.cwd() });
    config = result.config;
    log("info", "配置加载成功", {
      sources: result.sources.map((s) => s.type),
      opencodeBaseUrl: config.opencode.baseUrl,
    });
  } catch (err) {
    log("error", "配置加载失败", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // 获取 bot 自身 open_id（用于群聊 @提及检测）
  const botOpenId = await fetchBotOpenId(config.feishu.appId, config.feishu.appSecret);

  // 阶段3: OpenCode 客户端
  const opencodeClient = createOpenCodeClient(config.opencode);
  const opencodeHealthy = await opencodeClient.health();
  log(opencodeHealthy ? "info" : "warn", "OpenCode 连接状态", {
    healthy: opencodeHealthy,
    baseUrl: config.opencode.baseUrl,
  });

  // 阶段6: SSE 事件流（流式更新占位消息）
  const stopEventStream = startEventStream(opencodeClient, {
    showReasoning: true,
    log,
  });

  // 阶段4: 会话管理 + 模型覆盖
  const sessionManager = createSessionManager({
    client: opencodeClient,
    directory: config.opencode.directory,
  });
  const modelOverrides = new Map<string, string>();
  const agentOverrides = new Map<string, string>();

  // 阶段2 + 阶段5: 飞书网关与消息处理
  const { client: feishuClient, stop: stopFeishu } = startFeishuGateway({
    config,
    botOpenId,
    onMessage: async (ctx) => {
      const r = route(ctx);
      if (r.type === "command") {
        // 群聊静默模式下命令也不回复（仅 @提及时回复命令）
        if (!ctx.shouldReply) return;
        const commandDeps = {
          config,
          opencodeClient,
          sessionManager,
          getModel: (c: FeishuMessageContext) => modelOverrides.get(sessionKeyFromContext(c)),
          setModel: (c: FeishuMessageContext, m: string) => modelOverrides.set(sessionKeyFromContext(c), m),
          getAgent: (c: FeishuMessageContext) => agentOverrides.get(sessionKeyFromContext(c)),
          setAgent: (c: FeishuMessageContext, a: string) => agentOverrides.set(sessionKeyFromContext(c), a),
        };
        const reply = await runCommand(r, ctx, commandDeps);
        if (reply) {
          const { sendTextMessage } = await import("./feishu/sender.js");
          await sendTextMessage(feishuClient, ctx.chatId, reply);
        }
        return;
      }
      if (r.type === "chat" && r.content) {
        const chatDeps = {
          config,
          opencodeClient,
          sessionManager,
          feishuClient,
          getModel: (c: FeishuMessageContext) => modelOverrides.get(sessionKeyFromContext(c)),
          getAgent: (c: FeishuMessageContext) => agentOverrides.get(sessionKeyFromContext(c)),
          log,
          registerPending,
          unregisterPending,
        };
        await handleChat({ ...ctx, content: r.content }, chatDeps);
      }
    },
    onBotAdded: (chatId: string) => {
      // 异步摄入群聊历史上下文，不阻塞事件处理
      ingestGroupHistory(feishuClient, opencodeClient, sessionManager, chatId, {
        maxMessages: 50,
        log,
      }).catch((err) => {
        log("error", "群聊历史摄入失败", {
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    log,
  });

  void feishuClient;
  void opencodeClient;

  log("info", "服务就绪：飞书网关已连接", {
    feishuAppIdPrefix: config.feishu.appId.slice(0, 8) + "...",
    botOpenId: botOpenId || "(fallback mode)",
  });

  const shutdown = () => {
    stopFeishu();
    stopEventStream.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (reason, promise) => {
    log("error", "未处理的 Promise 拒绝", { reason: String(reason) });
  });
}

main().catch((err) => {
  log("error", "启动失败", { error: String(err) });
  process.exit(1);
});
