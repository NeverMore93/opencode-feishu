/**
 * OpenCode 飞书插件：通过飞书 WebSocket 长连接接入 OpenCode AI 对话
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import * as Lark from "@larksuiteoapi/node-sdk"
import type { Plugin, Hooks } from "@opencode-ai/plugin"
import { z } from "zod"
import { FeishuConfigSchema, type ResolvedConfig, type LogFn } from "./types.js"
import { CardKitClient } from "./feishu/cardkit.js"
import { startFeishuGateway, type FeishuGatewayResult } from "./feishu/gateway.js"
import { enqueueMessage } from "./handler/session-queue.js"
import { handleEvent } from "./handler/event.js"
import { handleCardAction, type InteractiveDeps } from "./handler/interactive.js"
import { ingestGroupHistory } from "./feishu/history.js"
import { initDedup } from "./feishu/dedup.js"

const SERVICE_NAME = "opencode-feishu"
const LOG_PREFIX = "[feishu]"
const isDebug = !!process.env.FEISHU_DEBUG


export const FeishuPlugin: Plugin = async (ctx) => {
  const { client } = ctx
  let gateway: FeishuGatewayResult | null = null

  const log: LogFn = (level, message, extra) => {
    const prefixed = `${LOG_PREFIX} ${message}`
    if (isDebug) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), service: SERVICE_NAME, level, message: prefixed, ...extra }))
    }
    client.app.log({
      body: {
        service: SERVICE_NAME,
        level,
        message: prefixed,
        extra,
      },
    }).catch(() => {})
  }

  const configPath = join(homedir(), ".config", "opencode", "plugins", "feishu.json")
  let resolvedConfig: ResolvedConfig
  try {
    resolvedConfig = loadAndValidateConfig(configPath, ctx.directory ?? "")
  } catch (e) {
    if (e instanceof z.ZodError) {
      const details = e.issues.map(i => `  - ${i.path.join(".")}: ${i.message}`).join("\n")
      throw new Error(`${LOG_PREFIX} 配置验证失败:\n${details}`)
    }
    if (e instanceof SyntaxError) {
      throw new Error(`飞书配置文件格式错误：${configPath} 必须是合法的 JSON (${e.message})`)
    }
    throw e
  }

  // 初始化去重缓存
  initDedup(resolvedConfig.dedupTtl)

  // 创建 Lark Client（SDK 内置 token 管理 + HTTP 客户端）
  const larkClient = new Lark.Client({
    appId: resolvedConfig.appId,
    appSecret: resolvedConfig.appSecret,
    domain: Lark.Domain.Feishu,
    appType: Lark.AppType.SelfBuild,
  })
  const cardkit = new CardKitClient(larkClient, log)

  // 获取 bot open_id（用于群聊 @提及检测）
  const botOpenId = await fetchBotOpenId(larkClient, log)

  // TODO: Enable when @opencode-ai/sdk/v2 is available
  const v2Client = undefined

  // 启动飞书 WebSocket 网关（复用 larkClient）
  gateway = startFeishuGateway({
    config: resolvedConfig,
    larkClient,
    botOpenId,
    onMessage: async (msgCtx) => {
      if (!msgCtx.content.trim() || !gateway) return
      const interactiveDeps: InteractiveDeps = {
        feishuClient: larkClient,
        log,
        v2Client,
      }
      await enqueueMessage(msgCtx, {
        config: resolvedConfig,
        client,
        feishuClient: larkClient,
        log,
        directory: resolvedConfig.directory,
        cardkit,
        interactiveDeps,
      })
    },
    onBotAdded: (chatId) => {
      if (!gateway) return
      ingestGroupHistory(larkClient, client, chatId, {
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
    onCardAction: async (action) => {
      if (!gateway) return
      const interactiveDeps: InteractiveDeps = {
        feishuClient: larkClient,
        log,
        v2Client,
      }
      await handleCardAction(action, interactiveDeps)
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
      await handleEvent(event, { log, directory: resolvedConfig.directory })
    },
  }
  return hooks
}

/**
 * 从配置文件读取、解析环境变量占位符、Zod 验证、展开 directory 路径。
 * 抛出 ZodError / SyntaxError / Error（文件不存在）。
 */
function loadAndValidateConfig(configPath: string, ctxDirectory: string): ResolvedConfig {
  if (!existsSync(configPath)) {
    throw new Error(`缺少飞书配置文件：请创建 ${configPath}，内容为 {"appId":"cli_xxx","appSecret":"xxx"}`)
  }
  const raw = resolveEnvPlaceholders(JSON.parse(readFileSync(configPath, "utf-8")))
  const parsed = FeishuConfigSchema.parse(raw)
  return { ...parsed, directory: expandDirectoryPath(parsed.directory ?? ctxDirectory ?? "") }
}

/**
 * 展开 directory 路径中的环境变量和 ~ 前缀。
 * 支持 ${VAR} 和 ~ 两种语法。
 */
function expandDirectoryPath(dir: string): string {
  if (!dir) return dir
  // 展开 ~ 为用户主目录
  if (dir.startsWith("~")) {
    dir = join(homedir(), dir.slice(1))
  }
  // 展开 ${VAR} 环境变量（不支持 $VAR 无花括号语法，避免与路径中 $ 字符歧义）
  dir = dir.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    const val = process.env[name]
    if (val === undefined) {
      throw new Error(`环境变量 ${name} 未设置（directory 引用了 \${${name}}）`)
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
 * 获取 bot 自身的 open_id（用于群聊 @提及检测）
 * 使用 Lark SDK client.request() 自动处理认证
 * 失败时直接抛出错误，阻止插件启动
 */
async function fetchBotOpenId(
  larkClient: InstanceType<typeof Lark.Client>,
  log: LogFn,
): Promise<string> {
  // SDK 没有 /bot/v3/info 的语义方法，使用 client.request() 通用方法
  const res = await larkClient.request<{ bot?: { open_id?: string } }>({
    url: "https://open.feishu.cn/open-apis/bot/v3/info",
    method: "GET",
  })
  const openId = res?.bot?.open_id
  if (!openId) {
    throw new Error("Bot open_id 为空，无法启动群聊 @提及检测")
  }
  log("info", "Bot open_id 获取成功", { openId })
  return openId
}
