/**
 * OpenCode 飞书插件入口模块
 *
 * 本文件是 opencode-feishu 插件的主入口，负责：
 * 1. 加载和验证飞书配置（feishu.json + Zod schema）
 * 2. 初始化 Lark SDK 客户端（token 管理、HTTP 调用）
 * 3. 获取 bot 自身 open_id（用于群聊 @提及检测）
 * 4. 启动飞书 WebSocket 长连接网关
 * 5. 注册 OpenCode 事件钩子（SSE 事件处理、tool 注册、system prompt 注入）
 * 6. 导出 FeishuPlugin 供 OpenCode 加载
 *
 * 插件不是独立服务——由 OpenCode 管理其生命周期。
 */

// ────────────────── Node.js 内置模块 ──────────────────
import { readFileSync, existsSync } from "node:fs"  // 文件读取和存在性检查（同步版，仅启动阶段使用）
import { join } from "node:path"                     // 跨平台路径拼接
import { fileURLToPath } from "node:url"             // 将 import.meta.url 转为文件系统路径（用于定位 skills/ 目录）
import { homedir } from "node:os"                    // 获取用户主目录（~/.config/opencode/plugins/feishu.json）

// ────────────────── 飞书 SDK ──────────────────
import * as Lark from "@larksuiteoapi/node-sdk"      // Lark/飞书 SDK：Client（HTTP + token 管理）、WSClient（WebSocket 长连接）

// ────────────────── OpenCode 插件接口 ──────────────────
import type { Plugin, Hooks } from "@opencode-ai/plugin" // Plugin 工厂函数类型 + Hooks 生命周期钩子类型

// ────────────────── Zod 配置校验 ──────────────────
import { z } from "zod"                              // 运行时 schema 验证，启动时捕获配置拼写/类型错误

// ────────────────── 内部模块 ──────────────────
import { FeishuConfigSchema, type ResolvedConfig, type LogFn } from "./types.js"  // 配置 Zod schema + 解析后的配置类型 + 日志函数签名
import { CardKitClient } from "./feishu/cardkit.js"                               // CardKit 2.0 SDK 薄封装（创建/更新/关闭流式卡片）
import { startFeishuGateway, type FeishuGatewayResult } from "./feishu/gateway.js" // 飞书 WebSocket 网关（消息接收、卡片回调、bot 入群事件）
import { enqueueMessage } from "./handler/session-queue.js"                        // 消息队列调度器入口（per-session 并发控制）
import { handleEvent } from "./handler/event.js"                                   // SSE 事件处理器（message.part.updated / permission / question / idle / error）
import { handleCardAction, type InteractiveDeps } from "./handler/interactive.js"  // 交互卡片按钮回调处理（权限审批 / 问答回复）
import { ingestGroupHistory } from "./feishu/history.js"                           // Bot 入群时批量摄入群聊历史消息
import { initDedup } from "./feishu/dedup.js"                                      // 消息去重缓存初始化（默认 10 分钟窗口）
import { createSendCardTool } from "./tools/send-card.js"                          // Agent 可调用的 feishu_send_card tool 工厂
import { getChatIdBySession } from "./feishu/session-chat-map.js"                  // 会话 → 聊天 ID 映射查询（判断是否飞书会话）
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"                  // OpenCode v2 REST 客户端（用于权限/问答交互回复）

/** 日志服务标识，所有 client.app.log() 调用都携带此名称 */
const SERVICE_NAME = "opencode-feishu"

/** 日志消息前缀，便于在 OpenCode 日志中快速筛选飞书插件输出 */
const LOG_PREFIX = "[feishu]"

/** 调试模式开关：设置 FEISHU_DEBUG=1 时同时输出结构化 JSON 到 stderr */
const isDebug = !!process.env.FEISHU_DEBUG

/**
 * 从 skills/ 目录加载飞书交互决策指南（system prompt 片段）
 *
 * 该文件是 markdown 格式的 agent 指南，告知 AI 当前对话渠道为飞书，
 * 并提供 feishu_send_card 工具的使用说明。
 * 内容在插件启动时读取一次，修改后重启即生效（无需重新构建）。
 *
 * @returns 飞书 system prompt 字符串；skill 文件缺失时返回最小化 fallback 提示
 */
function loadFeishuSkill(): string {
  // 基于当前模块路径回溯到项目根目录下的 skills/ 文件夹
  const skillPath = join(fileURLToPath(import.meta.url), "../../skills/feishu-card-interaction.md")
  if (existsSync(skillPath)) {
    return readFileSync(skillPath, "utf-8")
  }
  // fallback：skill 文件缺失时使用最小提示，确保 agent 至少知道飞书渠道和可用工具
  return "当前用户通过飞书（Feishu/Lark）与你对话。你可以使用 feishu_send_card 工具发送格式化卡片消息（支持按钮交互）。"
}

/** 缓存的飞书 system prompt，在模块加载时一次性读取 */
const feishuSystemPrompt = loadFeishuSkill()

/**
 * OpenCode 插件入口导出。
 *
 * OpenCode 在加载插件时会调用这个工厂函数，
 * 它完成初始化后返回本插件注册的 hooks 集合。
 */
export const FeishuPlugin: Plugin = async (ctx) => {
  const { client } = ctx
  // `gateway` 用于在各个 hook 闭包里判断网关是否已经成功初始化。
  let gateway: FeishuGatewayResult | null = null

  // 统一日志桥接：始终写入 OpenCode 日志；调试模式额外输出 stderr JSON。
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
    // 启动期一次性完成配置读取、环境变量展开和 schema 校验。
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

  // v2 client 主要用于权限审批/问答交互回调。
  const v2Client = createOpencodeClient({ directory: resolvedConfig.directory || undefined })
  const interactiveDeps: InteractiveDeps = { feishuClient: larkClient, log, v2Client }

  // 启动飞书 WebSocket 网关（复用 larkClient）
  gateway = startFeishuGateway({
    config: resolvedConfig,
    larkClient,
    botOpenId,
    onMessage: async (msgCtx) => {
      // 网关未完成初始化或消息为空时，不进入主处理链路。
      if (!msgCtx.content.trim() || !gateway) return
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
      // Bot 刚入群时异步补录历史消息，帮助模型建立初始上下文。
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
      // 交互按钮统一交给 interactive 层处理。
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
      // 只有网关可用时才消费 OpenCode SSE 事件。
      if (!gateway) return
      await handleEvent(event, { log, directory: resolvedConfig.directory, client, nudge: resolvedConfig.nudge })
    },
    tool: {
      feishu_send_card: createSendCardTool({ feishuClient: larkClient, log }),
    },
    "experimental.chat.system.transform": async (input, output) => {
      // 仅在飞书会话中注入提示，非飞书会话不干扰 agent
      if (!input.sessionID || !getChatIdBySession(input.sessionID)) return
      output.system.push(feishuSystemPrompt)

      // 注入运行时上下文（工作目录 + 当前模型）
      const runtimeLines = [`当前工作目录: ${resolvedConfig.directory || ctx.directory || "未设置"}`]
      try {
        const cfg = await client.config.get({ query: { directory: resolvedConfig.directory || undefined } })
        if (cfg?.data?.model) runtimeLines.push(`当前模型: ${cfg.data.model}`)
      } catch (err) {
        log("warn", "获取 config 失败", { error: err instanceof Error ? err.message : String(err) })
      }
      // 作为独立 system 段落注入，避免和 skill 文本粘连。
      output.system.push(runtimeLines.join("\n"))
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
  // 先 JSON.parse，再递归展开字符串里的环境变量占位符。
  const raw = resolveEnvPlaceholders(JSON.parse(readFileSync(configPath, "utf-8")))
  const parsed = FeishuConfigSchema.parse(raw)
  // directory 在这里统一展开成最终运行时路径。
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
    // 数组元素递归替换，占位符规则与对象字段一致。
    return obj.map(resolveEnvPlaceholders)
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      // 对象值逐个递归替换，键名保持原样。
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
  // SDK 没有 /bot/v3/info 的语义方法，因此走通用 request()。
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
