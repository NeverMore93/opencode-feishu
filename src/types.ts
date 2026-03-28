import { z } from "zod"

/**
 * 飞书消息上下文（网关提取后传递给处理器）
 */
export interface FeishuMessageContext {
  chatId: string
  messageId: string
  messageType: string
  /** 提取后的文本内容（text/post 类型），非文本类型可能为空 */
  content: string
  /** 原始 JSON content 字符串（用于资源下载和内容提取） */
  rawContent: string
  chatType: "p2p" | "group"
  senderId: string
  rootId?: string
  parentId?: string
  /** 消息创建时间（毫秒时间戳字符串，来自飞书 create_time 字段） */
  createTime?: string
  /** false = 静默监听：消息转发给 OpenCode 但不在飞书回复（群聊未被 @提及时） */
  shouldReply: boolean
}

/**
 * 插件配置（从 ~/.config/opencode/plugins/feishu.json 读取）
 */
export interface FeishuPluginConfig {
  appId: string
  appSecret: string
  timeout?: number
  thinkingDelay?: number
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace"
  /** 入群时拉取历史消息的最大条数（默认 50） */
  maxHistoryMessages?: number
  /** 轮询 AI 响应的间隔毫秒数（默认 1500） */
  pollInterval?: number
  /** 连续几次轮询内容不变视为回复完成（默认 2） */
  stablePolls?: number
  /** 消息去重缓存过期毫秒数（默认 600000 即 10 分钟） */
  dedupTtl?: number
  /** 单个资源最大下载大小（字节，默认 500MB） */
  maxResourceSize?: number
  /** session.idle 后检测工具调用停止时自动催促一次（默认 false） */
  nudgeOnIdle?: boolean
  /** 默认工作目录（覆盖 OpenCode 插件上下文的 directory） */
  directory?: string
}

export const FeishuConfigSchema = z.object({
  appId: z.string().min(1, "appId 不能为空"),
  appSecret: z.string().min(1, "appSecret 不能为空"),
  timeout: z.number().int().positive().max(600_000).default(120_000),
  thinkingDelay: z.number().int().nonnegative().default(2_500),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  maxHistoryMessages: z.number().int().positive().max(500).default(200),
  pollInterval: z.number().int().positive().default(1_000),
  stablePolls: z.number().int().positive().default(3),
  dedupTtl: z.number().int().positive().default(10 * 60 * 1_000),
  maxResourceSize: z.number().int().positive().max(500 * 1024 * 1024).default(500 * 1024 * 1024),
  nudgeOnIdle: z.boolean().default(false),
  directory: z.string().optional(),
})

/**
 * 合并默认值后的完整配置（由 FeishuConfigSchema 推导）
 */
export type ResolvedConfig = z.infer<typeof FeishuConfigSchema> & { directory: string }

/**
 * 插件日志函数签名
 */
export type LogFn = (
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void

export interface PermissionRequest {
  id?: string | number
  permission?: string
  patterns?: string[]
}

export interface QuestionRequest {
  id?: string | number
  questions?: Array<{
    question?: string
    header?: string
    options?: Array<{ label?: string; value?: string }>
  }>
}
