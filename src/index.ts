/**
 * OpenCode 飞书插件：通过飞书 WebSocket 长连接接入 OpenCode AI 对话
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Plugin, Hooks } from "@opencode-ai/plugin"
import type { FeishuPluginConfig, ResolvedConfig, LogFn } from "./types.js"
import { startFeishuGateway, type FeishuGatewayResult } from "./feishu/gateway.js"
import { handleChat } from "./handler/chat.js"
import { handleEvent } from "./handler/event.js"
import { ingestGroupHistory } from "./feishu/history.js"

const SERVICE_NAME = "opencode-feishu"

const DEFAULT_CONFIG: Omit<ResolvedConfig, "appId" | "appSecret"> = {
  timeout: 120_000,
  thinkingDelay: 2_500,
}

export const FeishuPlugin: Plugin = async (ctx) => {
  const { client } = ctx
  let gateway: FeishuGatewayResult | null = null
  let resolvedConfig: ResolvedConfig | null = null

  const log: LogFn = (level, message, extra) => {
    client.app.log({
      body: {
        service: SERVICE_NAME,
        level,
        message,
        extra,
      },
    }).catch(() => {
      // fallback: 如果 OpenCode 日志系统不可用，使用 console
      const payload = JSON.stringify({ service: SERVICE_NAME, level, message, ...extra, time: new Date().toISOString() })
      if (level === "error") console.error(payload)
      else console.log(payload)
    })
  }

  // ── 初始化：直接在插件函数体中执行（不依赖任何 hook） ──

  // 从 ~/.config/opencode/plugins/feishu.json 读取配置
  const configPath = join(homedir(), ".config", "opencode", "plugins", "feishu.json")

  if (!existsSync(configPath)) {
    throw new Error(
      `缺少飞书配置文件：请创建 ${configPath}，内容为 {"appId":"cli_xxx","appSecret":"xxx"}`,
    )
  }

  let feishuRaw: FeishuPluginConfig
  try {
    feishuRaw = JSON.parse(readFileSync(configPath, "utf-8")) as FeishuPluginConfig
  } catch (parseErr) {
    throw new Error(`飞书配置文件格式错误：${configPath} 必须是合法的 JSON (${parseErr})`)
  }

  if (!feishuRaw.appId || !feishuRaw.appSecret) {
    throw new Error(
      `飞书配置不完整：${configPath} 中必须包含 appId 和 appSecret`,
    )
  }

  resolvedConfig = {
    appId: feishuRaw.appId,
    appSecret: feishuRaw.appSecret,
    timeout: feishuRaw.timeout ?? DEFAULT_CONFIG.timeout,
    thinkingDelay: feishuRaw.thinkingDelay ?? DEFAULT_CONFIG.thinkingDelay,
  }

  // 获取 bot open_id（用于群聊 @提及检测）
  const botOpenId = await fetchBotOpenId(resolvedConfig.appId, resolvedConfig.appSecret, log)

  // 启动飞书 WebSocket 网关
  gateway = startFeishuGateway({
    config: resolvedConfig,
    botOpenId,
    onMessage: async (msgCtx) => {
      if (!msgCtx.content.trim() || !gateway || !resolvedConfig) return
      await handleChat(msgCtx, {
        config: resolvedConfig,
        client,
        feishuClient: gateway.client,
        log,
        directory: ctx.directory,
      })
    },
    onBotAdded: (chatId) => {
      if (!gateway) return
      ingestGroupHistory(gateway.client, client, chatId, {
        maxMessages: 50,
        log,
      }).catch((err) => {
        log("error", "群聊历史摄入失败", {
          chatId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    },
    log,
  })

  log("info", "飞书插件已初始化", {
    appId: resolvedConfig.appId.slice(0, 8) + "...",
    botOpenId: botOpenId || "(fallback mode)",
  })

  // ── 返回 hooks ──
  const hooks: Hooks = {
    event: async ({ event }) => {
      if (!gateway) return
      await handleEvent(event, log)
    },
  }
  return hooks
}

/**
 * 获取 bot 自身的 open_id（用于群聊 @提及检测）
 */
async function fetchBotOpenId(appId: string, appSecret: string, log: LogFn): Promise<string> {
  try {
    const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const tokenData = await tokenRes.json() as { tenant_access_token?: string }
    const token = tokenData?.tenant_access_token
    if (!token) {
      log("warn", "获取 tenant_access_token 失败，群聊 @提及检测将使用 fallback 模式")
      return ""
    }

    const botRes = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
    const botData = await botRes.json() as { bot?: { open_id?: string } }
    const openId = botData?.bot?.open_id
    if (openId) {
      log("info", "Bot open_id 获取成功", { openId })
      return openId
    }
    log("warn", "Bot open_id 为空，群聊 @提及检测将使用 fallback 模式")
    return ""
  } catch (err) {
    log("warn", "获取 bot open_id 失败，群聊 @提及检测将使用 fallback 模式", {
      error: err instanceof Error ? err.message : String(err),
    })
    return ""
  }
}
