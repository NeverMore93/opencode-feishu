/**
 * OpenCode 飞书插件：通过飞书 WebSocket 长连接接入 OpenCode AI 对话
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { request as httpsRequest } from "node:https"
import { text } from "node:stream/consumers"
import { HttpsProxyAgent } from "https-proxy-agent"
import type { Plugin, Hooks } from "@opencode-ai/plugin"
import type { FeishuPluginConfig, ResolvedConfig, LogFn } from "./types.js"
import { startFeishuGateway, type FeishuGatewayResult } from "./feishu/gateway.js"
import { handleChat } from "./handler/chat.js"
import { handleEvent } from "./handler/event.js"
import { ingestGroupHistory } from "./feishu/history.js"
import { initDedup } from "./feishu/dedup.js"

const SERVICE_NAME = "opencode-feishu"
const isDebug = !!process.env.FEISHU_DEBUG

const DEFAULT_CONFIG: Omit<ResolvedConfig, "appId" | "appSecret"> = {
  timeout: 120_000,
  thinkingDelay: 2_500,
  logLevel: "info",
  maxHistoryMessages: 200,
  pollInterval: 1_000,
  stablePolls: 3,
  dedupTtl: 10 * 60 * 1_000,
  directory: "",
}

export const FeishuPlugin: Plugin = async (ctx) => {
  const { client } = ctx
  let gateway: FeishuGatewayResult | null = null

  const log: LogFn = (level, message, extra) => {
    if (isDebug) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), service: SERVICE_NAME, level, message, ...extra }))
    }
    client.app.log({
      body: {
        service: SERVICE_NAME,
        level,
        message,
        extra,
      },
    }).catch(() => {})
  }

  // 从 ~/.config/opencode/plugins/feishu.json 读取配置
  const configPath = join(homedir(), ".config", "opencode", "plugins", "feishu.json")

  if (!existsSync(configPath)) {
    throw new Error(
      `缺少飞书配置文件：请创建 ${configPath}，内容为 {"appId":"cli_xxx","appSecret":"xxx"}`,
    )
  }

  let feishuRaw: FeishuPluginConfig
  try {
    feishuRaw = resolveEnvPlaceholders(
      JSON.parse(readFileSync(configPath, "utf-8")),
    ) as FeishuPluginConfig
  } catch (parseErr) {
    throw new Error(`飞书配置文件格式错误：${configPath} 必须是合法的 JSON (${parseErr})`)
  }

  if (feishuRaw.directory !== undefined && typeof feishuRaw.directory !== "string") {
    log("warn", `飞书配置警告：${configPath} 中的 'directory' 必须是字符串，已忽略`, {
      actualType: typeof feishuRaw.directory,
    })
    feishuRaw.directory = undefined
  }

  if (!feishuRaw.appId || !feishuRaw.appSecret) {
    throw new Error(
      `飞书配置不完整：${configPath} 中必须包含 appId 和 appSecret`,
    )
  }

  const resolvedConfig: ResolvedConfig = {
    appId: feishuRaw.appId,
    appSecret: feishuRaw.appSecret,
    timeout: feishuRaw.timeout ?? DEFAULT_CONFIG.timeout,
    thinkingDelay: feishuRaw.thinkingDelay ?? DEFAULT_CONFIG.thinkingDelay,
    logLevel: feishuRaw.logLevel ?? DEFAULT_CONFIG.logLevel,
    maxHistoryMessages: feishuRaw.maxHistoryMessages ?? DEFAULT_CONFIG.maxHistoryMessages,
    pollInterval: feishuRaw.pollInterval ?? DEFAULT_CONFIG.pollInterval,
    stablePolls: feishuRaw.stablePolls ?? DEFAULT_CONFIG.stablePolls,
    dedupTtl: feishuRaw.dedupTtl ?? DEFAULT_CONFIG.dedupTtl,
    directory: expandDirectoryPath(feishuRaw.directory ?? ctx.directory ?? DEFAULT_CONFIG.directory),
  }

  // 初始化去重缓存
  initDedup(resolvedConfig.dedupTtl)

  // 获取 bot open_id（用于群聊 @提及检测）
  const botOpenId = await fetchBotOpenId(resolvedConfig.appId, resolvedConfig.appSecret, log)

  // 启动飞书 WebSocket 网关
  gateway = startFeishuGateway({
    config: resolvedConfig,
    botOpenId,
    onMessage: async (msgCtx) => {
      if (!msgCtx.content.trim() || !gateway) return
      await handleChat(msgCtx, {
        config: resolvedConfig,
        client,
        feishuClient: gateway.client,
        log,
        directory: resolvedConfig.directory,
      })
    },
    onBotAdded: (chatId) => {
      if (!gateway) return
      ingestGroupHistory(gateway.client, client, chatId, {
        maxMessages: resolvedConfig.maxHistoryMessages,
        log,
        directory: resolvedConfig.directory,
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
    botOpenId,
  })

  const hooks: Hooks = {
    event: async ({ event }) => {
      if (!gateway) return
      await handleEvent(event)
    },
  }
  return hooks
}

/**
 * 展开 directory 路径中的环境变量和 ~ 前缀。
 * 支持 $VAR、${VAR} 和 ~ 三种语法。
 */
function expandDirectoryPath(dir: string): string {
  if (!dir) return dir
  // 展开 ~ 为用户主目录
  if (dir.startsWith("~")) {
    dir = join(homedir(), dir.slice(1))
  }
  // 展开 $VAR（无花括号）— ${VAR} 已由 resolveEnvPlaceholders 处理
  dir = dir.replace(/\$(\w+)/g, (_match, name: string) => {
    const val = process.env[name]
    if (val === undefined) {
      throw new Error(`环境变量 ${name} 未设置（directory 引用了 $${name}）`)
    }
    return val
  })
  return dir
}

/**
 * 递归替换对象中字符串值里的 ${ENV_VAR} 占位符。
 * 明文值原样保留，仅替换包含 ${...} 的字符串。
 * 环境变量未设置时抛出错误，防止静默使用空值。
 */
function resolveEnvPlaceholders(obj: unknown): unknown {
  if (typeof obj === "string") {
    if (!obj.includes("${")) return obj
    return obj.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
      const val = process.env[name]
      if (val === undefined) {
        throw new Error(`环境变量 ${name} 未设置（配置值引用了 \${${name}}）`)
      }
      return val
    })
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvPlaceholders)
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveEnvPlaceholders(value)
    }
    return result
  }
  return obj
}

/**
 * Proxy-aware fetch. Bun's native fetch may ignore HTTPS_PROXY, so when a
 * proxy is configured we fall back to node:https + HttpsProxyAgent.
 * Signature mirrors global fetch — callers don't need to care about proxy.
 */
function proxyFetch(url: string, init?: RequestInit): Promise<Response> {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    ""
  if (!proxyUrl) return fetch(url, init)

  const parsed = new URL(url)
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string>,
        agent: new HttpsProxyAgent(proxyUrl),
      },
      (res) => {
        text(res).then((body) =>
          resolve(new Response(body, { status: res.statusCode ?? 0 })),
        ).catch(reject)
      },
    )
    req.on("error", reject)
    if (init?.body) req.write(init.body)
    req.end()
  })
}

/**
 * 获取 bot 自身的 open_id（用于群聊 @提及检测）
 * 失败时直接抛出错误，阻止插件启动
 */
async function fetchBotOpenId(appId: string, appSecret: string, log: LogFn): Promise<string> {
  const tokenRes = await proxyFetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const tokenData = await tokenRes.json() as { tenant_access_token?: string }
  const token = tokenData?.tenant_access_token
  if (!token) {
    throw new Error("获取 tenant_access_token 失败，无法启动群聊 @提及检测")
  }

  const botRes = await proxyFetch("https://open.feishu.cn/open-apis/bot/v3/info", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  })
  const botData = await botRes.json() as { bot?: { open_id?: string } }
  const openId = botData?.bot?.open_id
  if (!openId) {
    throw new Error("Bot open_id 为空，无法启动群聊 @提及检测")
  }
  log("info", "Bot open_id 获取成功", { openId })
  return openId
}
