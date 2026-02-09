/**
 * 应用配置
 */
export interface Config {
  feishu: FeishuConfig;
  opencode: OpenCodeConfig;
  bot: BotConfig;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export interface OpenCodeConfig {
  baseUrl: string;
  directory?: string;
  model?: string;
  /** 默认使用的 OpenCode Agent（如 build、plan、general） */
  agent?: string;
  timeout: number;
}

export interface BotConfig {
  thinkingDelay: number;
  enableStreaming: boolean;
  streamInterval: number;
  groupFilter: boolean;
}

/**
 * 飞书消息上下文（接收）
 */
export interface FeishuMessageContext {
  chatId: string;
  messageId: string;
  messageType: string;
  content: string;
  chatType: "p2p" | "group";
  senderId: string;
  rootId?: string;
}

/**
 * 飞书会话键（用于映射 OpenCode 会话）
 */
export type FeishuSessionKey = string;

/**
 * 会话状态（飞书用户 <-> OpenCode 会话）
 */
export interface SessionState {
  sessionId: string;
  feishuChatId: string;
  feishuUserId: string;
  chatType: "p2p" | "group";
  createdAt: number;
  lastActivity: number;
  model?: string;
}

/**
 * 配置来源（用于诊断）
 */
export type ConfigSource =
  | { type: "file"; detail: string }
  | { type: "env"; detail: string };

export interface LoadConfigResult {
  config: Config;
  sources: ConfigSource[];
}
