/**
 * OpenCode 飞书插件：通过飞书 WebSocket 长连接接入 OpenCode AI 对话
 */
import { readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs"
import { lookup } from "node:dns/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Plugin, Hooks } from "@opencode-ai/plugin"
import WebSocket from "ws"
import { ProxyAgent } from "proxy-agent"
import type { FeishuPluginConfig, ResolvedConfig, LogFn } from "./types.js"
import { startFeishuGateway, type FeishuGatewayResult } from "./feishu/gateway.js"
import { handleChat } from "./handler/chat.js"
import { handleEvent } from "./handler/event.js"
import { ingestGroupHistory } from "./feishu/history.js"

const SERVICE_NAME = "opencode-feishu"
const DEBUG_LOG = join(homedir(), "feishu-debug.log")

const DEFAULT_CONFIG: Omit<ResolvedConfig, "appId" | "appSecret"> = {
  timeout: 120_000,
  thinkingDelay: 2_500,
}

function dbg(msg: string) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch { /* ignore */ }
}

export const FeishuPlugin: Plugin = async (ctx) => {
  console.log("[opencode-feishu] plugin init start", new Date().toISOString())
  // 清空/创建 debug 日志文件
  try { writeFileSync(DEBUG_LOG, `[${new Date().toISOString()}] === FeishuPlugin init start ===\n`) } catch { /* ignore */ }

  dbg("FeishuPlugin called")

  const { client } = ctx
  let gateway: FeishuGatewayResult | null = null
  let resolvedConfig: ResolvedConfig | null = null

  const log: LogFn = (level, message, extra) => {
    dbg(`[LOG/${level}] ${message} ${extra ? JSON.stringify(extra) : ""}`)
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

  try {
    // ── 初始化：直接在插件函数体中执行（不依赖任何 hook） ──

    // 从 ~/.config/opencode/plugins/feishu.json 读取配置
    const configPath = join(homedir(), ".config", "opencode", "plugins", "feishu.json")
    dbg(`configPath=${configPath}, exists=${existsSync(configPath)}`)

    if (!existsSync(configPath)) {
      throw new Error(
        `缺少飞书配置文件：请创建 ${configPath}，内容为 {"appId":"cli_xxx","appSecret":"xxx"}`,
      )
    }

    let feishuRaw: FeishuPluginConfig
    try {
      feishuRaw = JSON.parse(readFileSync(configPath, "utf-8")) as FeishuPluginConfig
      dbg(`config parsed OK: appId=${feishuRaw.appId?.slice(0, 8)}...`)
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
    dbg(`resolvedConfig OK: timeout=${resolvedConfig.timeout}, thinkingDelay=${resolvedConfig.thinkingDelay}`)

    const wsUrl = await probeWsConfig(resolvedConfig, log)
    if (wsUrl) {
      await debugWsConnect(wsUrl, log)
    }

    // 获取 bot open_id（用于群聊 @提及检测）
    dbg("fetchBotOpenId start...")
    const botOpenId = await fetchBotOpenId(resolvedConfig.appId, resolvedConfig.appSecret, log)
    dbg(`fetchBotOpenId done: botOpenId=${botOpenId || "(empty)"}`)

    // 启动飞书 WebSocket 网关
    dbg("startFeishuGateway start...")
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
    dbg("startFeishuGateway done (gateway created)")

    log("info", "飞书插件已初始化", {
      appId: resolvedConfig.appId.slice(0, 8) + "...",
      botOpenId: botOpenId || "(fallback mode)",
    })

    // ── 返回 hooks（缓存到单例） ──
    const hooks: Hooks = {
      event: async ({ event }) => {
        if (!gateway) return
        await handleEvent(event, gateway.client, log)
      },
    }
    dbg("init complete, returning hooks")
    return hooks
  } catch (err) {
    const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
    dbg(`INIT ERROR: ${errMsg}`)
    throw err
  }
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

async function probeWsConfig(config: ResolvedConfig, log: LogFn): Promise<string | null> {
  const endpoint = "https://open.feishu.cn/callback/ws/endpoint"
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ AppID: config.appId, AppSecret: config.appSecret }),
    })
    const text = await res.text()
    let wsUrl: string | null = null
    try {
      const parsed = JSON.parse(text) as { data?: { URL?: string } }
      wsUrl = parsed?.data?.URL ?? null
    } catch {
      wsUrl = null
    }

    if (wsUrl) {
      const url = new URL(wsUrl)
      log("info", "WS config probe", {
        status: res.status,
        ok: res.ok,
        wsHost: url.host,
        wsPath: url.pathname,
        wsQueryKeys: Array.from(url.searchParams.keys()),
        wsUrlRedacted: redactWsUrl(wsUrl),
      })
    } else {
      log("info", "WS config probe", {
        status: res.status,
        ok: res.ok,
        bodyPreview: text.slice(0, 300),
      })
    }
    return wsUrl
  } catch (err) {
    log("error", "WS config probe failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

function redactWsUrl(wsUrl: string): string {
  try {
    const url = new URL(wsUrl)
    url.searchParams.forEach((_, key) => {
      url.searchParams.set(key, "***")
    })
    return url.toString()
  } catch {
    return "(invalid url)"
  }
}

async function debugWsConnect(wsUrl: string, log: LogFn): Promise<void> {
  let host = ""
  let path = ""
  try {
    const url = new URL(wsUrl)
    host = url.host
    path = url.pathname
  } catch (err) {
    log("error", "WS debug invalid url", {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  try {
    const addrs = await lookup(host, { all: true })
    log("info", "WS debug dns", { host, addrs })
  } catch (err) {
    log("error", "WS debug dns failed", {
      host,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const wsAgent = new ProxyAgent()
  const ws = new WebSocket(wsUrl, { agent: wsAgent, handshakeTimeout: 10_000 })
  const timeout = setTimeout(() => {
    log("error", "WS debug timeout", { host, path })
    try {
      ws.terminate()
    } catch {
      // ignore
    }
  }, 12_000)

  ws.on("open", () => {
    clearTimeout(timeout)
    log("info", "WS debug connected", { host, path })
    ws.close()
  })

  ws.on("error", (err: Error) => {
    clearTimeout(timeout)
    const anyErr = err as Error & { code?: string; errno?: string; syscall?: string }
    log("error", "WS debug error", {
      host,
      path,
      name: anyErr.name,
      message: anyErr.message,
      code: anyErr.code,
      errno: anyErr.errno,
      syscall: anyErr.syscall,
    })
  })

  ws.on("close", (code: number, reason: Buffer) => {
    clearTimeout(timeout)
    log("info", "WS debug close", {
      host,
      path,
      code,
      reason: reason.toString(),
    })
  })

  ws.on("unexpected-response", (_req: unknown, res: import("http").IncomingMessage) => {
    clearTimeout(timeout)
    const headers: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(res.headers)) {
      if (key.toLowerCase() === "set-cookie" || key.toLowerCase() === "authorization") continue
      headers[key] = value
    }
    log("warn", "WS debug unexpected response", {
      host,
      path,
      statusCode: res.statusCode,
      statusMessage: res.statusMessage,
      headers,
    })
  })
}
