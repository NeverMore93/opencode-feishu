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
  /** 默认工作目录（覆盖 OpenCode 插件上下文的 directory） */
  directory?: string
}

/**
 * 合并默认值后的完整配置
 */
export interface ResolvedConfig {
  appId: string
  appSecret: string
  timeout: number
  thinkingDelay: number
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace"
  maxHistoryMessages: number
  pollInterval: number
  stablePolls: number
  dedupTtl: number
  directory: string
}

/**
 * 插件日志函数签名
 */
export type LogFn = (
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void
