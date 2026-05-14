import { z } from "zod"

/**
 * 飞书网关层整理出的“统一消息上下文”。
 *
 * 后续 `session-queue.ts`、`chat.ts` 等模块都只依赖这个稳定结构，
 * 不再直接接触飞书原始事件 payload。
 */
export interface FeishuMessageContext {
  /** 飞书 chat_id，用于发送和更新消息。 */
  chatId: string
  /** 当前消息自己的 message_id。 */
  messageId: string
  /** 飞书原始消息类型，例如 text / image / post / file。 */
  messageType: string
  /** 已提取的可读文本；非文本消息可能为空。 */
  content: string
  /** 飞书原始 JSON content 字符串，供资源解析器继续使用。 */
  rawContent: string
  /** 聊天类型：单聊或群聊。 */
  chatType: "p2p" | "group"
  /** 发送者 open_id。 */
  senderId: string
  /** 线程根消息 ID，可选。 */
  rootId?: string
  /** 被回复/引用的父消息 ID，可选。 */
  parentId?: string
  /** 飞书 create_time，通常为毫秒时间戳字符串。 */
  createTime?: string
  /**
   * 是否需要对用户可见地回复。
   * `false` 表示只把消息同步给 OpenCode 作为上下文，不在飞书侧发送消息。
   */
  shouldReply: boolean
}

/**
 * `session.idle` 兜底催促配置。
 *
 * 当模型以工具调用收尾却没有继续输出时，插件可按该配置再发一条 synthetic prompt。
 */
const NudgeSchema = z.object({
  /** 是否启用 idle 催促能力。 */
  enabled: z.boolean().default(false),
  /** 真正送入 OpenCode 的催促文本。 */
  // 默认文本来自 OpenCode compaction.ts:340 的 autocontinue prompt
  message: z.string().min(1).default("Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."),
  /** 两次催促之间的最小间隔（秒）。 */
  intervalSeconds: z.number().int().positive().max(300).default(30),
  /** 同一会话内最多催促多少次。 */
  maxIterations: z.number().int().positive().max(100).default(3),
})

/**
 * 飞书插件配置 schema。
 *
 * 这里同时承担：
 * 1. 运行时 JSON 校验
 * 2. 默认值补齐
 * 3. TypeScript 类型推导源
 */
export const FeishuConfigSchema = z.object({
  /** 飞书自建应用 appId。 */
  appId: z.string().min(1, "appId 不能为空"),
  /** 飞书自建应用 appSecret。 */
  appSecret: z.string().min(1, "appSecret 不能为空"),
  /** 对话轮询总超时。 */
  timeout: z.number().int().positive().optional(),
  /** 飞书 SDK 的内部日志等级。 */
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** 入群后最多摄入多少条历史消息。 */
  maxHistoryMessages: z.number().int().positive().max(500).default(200),
  /** 轮询 session messages 的间隔。 */
  pollInterval: z.number().int().positive().default(1_000),
  /** 连续多少次轮询无变化视为稳定。 */
  stablePolls: z.number().int().positive().default(3),
  /** 飞书消息去重窗口。 */
  dedupTtl: z.number().int().positive().default(10 * 60 * 1_000),
  /** 资源下载大小上限。 */
  maxResourceSize: z.number().int().positive().max(500 * 1024 * 1024).default(500 * 1024 * 1024),
  /** idle 催促子配置。 */
  nudge: NudgeSchema.default(() => NudgeSchema.parse({})),
  /** OpenCode 工作目录，可在启动阶段进一步展开。 */
  directory: z.string().optional(),
})

/**
 * `feishu.json` 的“输入态”类型。
 *
 * 适合描述外部配置文件，因为此时默认值还没被补齐。
 */
export type FeishuPluginConfig = z.input<typeof FeishuConfigSchema>

/**
 * 经过 Zod 补齐默认值后的“运行态”配置。
 */
export type ResolvedConfig = z.infer<typeof FeishuConfigSchema> & { directory: string }

/**
 * 项目内部统一日志函数签名。
 */
export type LogFn = (
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void

/**
 * 结构化结果卡里单个"详细步骤"阶段的状态。
 */
export type DetailPhaseStatus = "running" | "completed" | "error"

/**
 * 结构化结果卡里"详细步骤"区域的单个阶段快照。
 *
 * 跨 `handler/` 事件编排层和 `feishu/` 渲染层复用的稳定结构。
 */
export interface DetailPhaseSnapshot {
  phaseId: string
  label: string
  status: DetailPhaseStatus
  body: string
  toolSummary?: string[]
  updatedAt: string
}

/**
 * 权限请求事件里，本仓库真正用到的字段。
 *
 * 字段保持宽松是为了兼容上游事件结构的小变动。
 */
export interface PermissionRequest {
  /** 请求唯一 ID，用于按钮回传。 */
  id?: string | number
  /** 关联的 session。 */
  sessionID?: string
  /** 权限名称。 */
  permission?: string
  /** 路径模式列表。 */
  patterns?: string[]
  /** 若由工具调用触发，则会带上工具消息定位信息。 */
  tool?: {
    messageID?: string
    callID?: string
  }
}

/**
 * 问答请求事件里，本仓库真正用到的字段。
 */
export interface QuestionRequest {
  /** 请求唯一 ID。 */
  id?: string | number
  /** 关联的 session。 */
  sessionID?: string
  /** 问题数组；当前卡片实现只消费第一题。 */
  questions?: Array<{
    /** 问题正文。 */
    question?: string
    /** 卡片标题。 */
    header?: string
    /** 用户可选选项。 */
    options?: Array<{ label?: string; value?: string }>
  }>
  /** 若由工具调用触发，则会带上工具消息定位信息。 */
  tool?: {
    messageID?: string
    callID?: string
  }
}
