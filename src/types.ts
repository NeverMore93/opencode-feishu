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
  proxy?: string
}

/**
 * 合并默认值后的完整配置
 */
export interface ResolvedConfig {
  appId: string
  appSecret: string
  timeout: number
  thinkingDelay: number
}

/**
 * 插件日志函数签名
 */
export type LogFn = (
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void
