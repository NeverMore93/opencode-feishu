/**
 * `feishu_send_card` Tool：允许 agent 主动往当前飞书会话发送结构化卡片。
 *
 * 它和 StreamingCard 的定位不同：
 * - StreamingCard 用于“当前这次 AI 回复”的流式展示
 * - feishu_send_card 用于 agent 主动发一条独立卡片消息
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { getChatIdBySession, getChatInfoBySession } from "../feishu/session-chat-map.js"
import { sendInteractiveCard } from "../feishu/sender.js"

import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"

/** 复用插件工具系统自带的 schema 构造器。 */
const z = tool.schema

/** 飞书卡头支持的颜色模板。 */
const TEMPLATE_COLORS = ["blue", "green", "orange", "red", "purple", "grey"] as const

/** Tool 运行需要的最小依赖。 */
interface SendCardDeps {
  feishuClient: InstanceType<typeof Lark.Client>
  log: LogFn
}

/**
 * 创建 `feishu_send_card` 工具定义。
 *
 * 这个工具的本质是：
 * 1. 从当前 sessionID 找到对应飞书聊天
 * 2. 把 DSL 翻译成 Card 2.0 JSON
 * 3. 通过 sender 发一条 interactive 消息
 */
export function createSendCardTool(deps: SendCardDeps): ToolDefinition {
  return tool({
    description:
      "发送格式化卡片消息到当前飞书会话。支持 22 种 Card 2.0 组件：" +
      "markdown 正文、分割线、备注、交互按钮、图片、表格、折叠面板、" +
      "输入框、下拉选择、日期/时间选择器、复选框、人员选择等。" +
      "按钮点击等同用户发送消息。卡片作为独立消息发送，不影响流式回复。" +
      "本工具只负责将 agent 已决定的内容渲染为卡片，不补全主题、摘要或结论。",
    args: {
      title: z.string().describe("卡片标题"),
      template: z
        .enum(TEMPLATE_COLORS)
        .default("blue")
        .describe("标题颜色主题"),
      sections: z
        .array(
          z.object({
            type: z
              .enum([
                "markdown", "divider", "note", "actions",
                "image", "person", "person_list", "image_list",
                "chart", "table",
                "input", "select", "multi_select", "date_picker", "time_picker", "datetime_picker",
                "checker", "overflow", "person_picker", "multi_person_picker",
                "collapse", "image_picker",
              ])
              .default("markdown")
              .describe(
                "区块类型：markdown（正文）、divider（分割线）、note（备注）、actions（按钮组）、" +
                "image（图片）、person（人员）、person_list（人员列表）、image_list（多图组合）、" +
                "chart（图表）、table（表格）、" +
                "input（输入框）、select（单选）、multi_select（多选）、date_picker（日期）、" +
                "time_picker（时间）、datetime_picker（日期时间）、checker（复选框）、" +
                "overflow（更多菜单）、person_picker（人员选择）、multi_person_picker（多人选择）、" +
                "collapse（折叠面板）、image_picker（图片选择）。仅使用上列类型，其他值无效。"
              ),
            content: z
              .string()
              .optional()
              .describe("区块内容（markdown 格式，divider/actions 类型无需此字段）"),
            buttons: z
              .array(
                z.object({
                  text: z.string().describe("按钮显示文本（2-6字）"),
                  value: z.string().describe("按钮点击后作为用户消息发送的文本内容（纯文本，不含 JSON）。中断、权限审批、问答应答等控制语义由插件单独承载，此字段无法表达。"),
                  style: z
                    .enum(["primary", "default", "danger"])
                    .default("default")
                    .describe("按钮样式"),
                }),
              )
              .optional()
              .describe("按钮列表（仅 actions 类型使用）"),
            imageKey: z.string().optional().describe("图片 key（image/image_list 类型）"),
            alt: z.string().optional().describe("图片描述文字"),
            userId: z.string().optional().describe("用户 open_id（person 类型）"),
            userIds: z.array(z.string()).optional().describe("用户 open_id 列表（person_list 类型）"),
            imageKeys: z.array(z.string()).optional().describe("图片 key 列表（image_list 类型）"),
            layout: z.enum(["bisect", "trisect", "quadrisect"]).optional().describe("多图布局"),
            chartSpec: z.record(z.string(), z.unknown()).optional().describe("图表规格（ECharts 格式）"),
            columns: z
              .array(z.object({ name: z.string(), dataType: z.string().optional() }))
              .optional()
              .describe("表格列定义"),
            rows: z
              .array(z.record(z.string(), z.unknown()))
              .optional()
              .describe("表格行数据"),
            name: z.string().optional().describe("交互组件名称（用于回调标识）"),
            placeholder: z.string().optional().describe("输入框/选择器占位文本"),
            defaultValue: z.string().optional().describe("输入框默认值"),
            options: z
              .array(
                z.object({
                  label: z.string(),
                  value: z.string(),
                  imageKey: z.string().optional(),
                }),
              )
              .optional()
              .describe("选择器选项列表"),
            checked: z.boolean().optional().describe("复选框初始状态"),
            title: z.string().optional().describe("折叠面板标题"),
          }),
        )
        .min(1)
        .describe("卡片正文区块列表"),
    },
    async execute(args, context) {
      // Tool 执行发生在 OpenCode session 上下文里，需要先反查飞书 chatId。
      const chatId = getChatIdBySession(context.sessionID)
      if (!chatId) {
        deps.log("warn", "Agent 卡片发送跳过：sessionID 无飞书聊天映射", {
          sessionId: context.sessionID,
          title: args.title,
        })
        return "错误：当前会话不关联飞书聊天，无法发送卡片"
      }

      // 尽量保留聊天类型信息；DSL 里的按钮回调需要知道自己来自单聊还是群聊。
      const chatInfo = getChatInfoBySession(context.sessionID)
      const card = buildCardFromDSL(args, chatId, chatInfo?.chatType ?? "p2p")
      // Tool 主动发卡片也把 sender 层异常接到项目 error 日志，避免只有失败字符串没有日志上下文。
      const result = await sendInteractiveCard(deps.feishuClient, chatId, card, deps.log)

      if (result.ok) {
        deps.log("info", "Agent 卡片已发送", {
          sessionId: context.sessionID,
          chatId,
          title: args.title,
          messageId: result.messageId,
        })
        return `卡片已发送：「${args.title}」`
      }

      deps.log("error", "Agent 卡片发送失败", {
        sessionId: context.sessionID,
        chatId,
        title: args.title,
        error: result.error,
      })
      return `卡片发送失败：${result.error}`
    },
  })
}

/**
 * actions 区块里单个按钮的输入定义。
 *
 * `actionPayload` 是内部增强字段：
 * - agent 正常使用时不会看到它
 * - 权限/问答卡片会借它注入专用 JSON 回调值
 */
export type ButtonInput = {
  text: string
  value: string
  style: "primary" | "default" | "danger"
  /** 内部字段：直接用作按钮 value（权限/问答场景），不暴露给 agent Zod schema */
  actionPayload?: object
}

/**
 * 通用 section 输入定义。
 *
 * 一个 section 最终会被翻译成 1 个或多个 Card 2.0 元素。
 */
export type SectionInput = {
  type:
    | "markdown" | "divider" | "note" | "actions"
    | "image" | "person" | "person_list" | "image_list"
    | "chart" | "table"
    | "input" | "select" | "multi_select" | "date_picker" | "time_picker" | "datetime_picker"
    | "checker" | "overflow" | "person_picker" | "multi_person_picker"
    | "collapse" | "image_picker"
  content?: string
  buttons?: readonly ButtonInput[]
  // Display
  imageKey?: string
  alt?: string
  userId?: string
  userIds?: string[]
  imageKeys?: string[]
  layout?: string
  chartSpec?: Record<string, unknown>
  columns?: { name: string; dataType?: string }[]
  rows?: Record<string, unknown>[]
  // Interactive
  name?: string
  placeholder?: string
  defaultValue?: string
  options?: readonly { label: string; value: string; imageKey?: string }[]
  checked?: boolean
  // Container
  title?: string
}

/**
 * 把 DSL 翻译成 Card 2.0 JSON。
 *
 * 设计原则：
 * - 上层输入用统一 DSL，屏蔽 Card 2.0 的细碎字段差异
 * - 对飞书不存在的组件做“最相近组件”降级
 * - 缺必要数据时返回空数组，避免生成无效元素
 */
export function buildCardFromDSL(
  args: { title: string; template: string; sections: readonly SectionInput[] },
  chatId: string,
  chatType: "p2p" | "group",
): object {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: args.title },
      template: args.template,
    },
    body: {
      elements: args.sections.flatMap((s) => {
        // 每个 section 根据 type 翻译为对应的 Card 2.0 element。
        switch (s.type) {
          case "divider":
            return { tag: "hr" }
          case "note":
            // Card 2.0 无独立 note 组件，用 div + plain_text 近似替代。
            return { tag: "div", text: { tag: "plain_text", content: s.content ?? "" } }
          case "actions":
            if (!s.buttons?.length) return []
            // Card 2.0 无 action 容器，用 column_set 横排按钮。
            return {
              tag: "column_set",
              flex_mode: "none",
              background_style: "default",
              columns: s.buttons.map((btn) => ({
                tag: "column",
                width: "weighted",
                weight: 1,
                elements: [{
                  tag: "button",
                  text: { tag: "plain_text", content: btn.text },
                  type: btn.style,
                  // 未注入 actionPayload 时，默认把按钮点击转成一条 send_message 合成消息。
                  value: btn.actionPayload ?? {
                    action: "send_message",
                    chatId,
                    chatType,
                    text: btn.value,
                  },
                }],
              })),
            }
          case "image":
            if (!s.imageKey) return []
            return { tag: "img", img_key: s.imageKey, alt: { tag: "plain_text", content: s.alt ?? "" } }
          case "person":
            if (!s.userId) return []
            return { tag: "person", user_id: s.userId }
          case "person_list":
            if (!s.userIds?.length) return []
            return { tag: "person_list", persons: s.userIds.map(id => ({ id })), size: "small" }
          case "image_list":
            if (!s.imageKeys?.length) return []
            return {
              tag: "img_combination",
              combination_mode: s.layout ?? "bisect",
              img_list: s.imageKeys.map(k => ({ img_key: k })),
            }
          case "chart":
            return { tag: "chart", chart_spec: s.chartSpec ?? {} }
          case "table": {
            if (!s.columns?.length) return []
            return {
              tag: "table",
              // 目前固定每页 10 条，避免超大表格在飞书里一次性展开过长。
              page_size: 10,
              columns: s.columns.map(c => ({ name: c.name, data_type: c.dataType ?? "text" })),
              rows: s.rows ?? [],
            }
          }
          case "input":
            return {
              tag: "input",
              name: s.name ?? "input",
              ...(s.placeholder ? { placeholder: { tag: "plain_text", content: s.placeholder } } : {}),
              ...(s.defaultValue ? { default_value: s.defaultValue } : {}),
            }
          case "select":
            return {
              tag: "select_static",
              name: s.name ?? "select",
              ...(s.placeholder ? { placeholder: { tag: "plain_text", content: s.placeholder } } : {}),
              options: (s.options ?? []).map(o => ({ text: { tag: "plain_text", content: o.label }, value: o.value })),
            }
          case "multi_select":
            return {
              tag: "multi_select_static",
              name: s.name ?? "multi_select",
              ...(s.placeholder ? { placeholder: { tag: "plain_text", content: s.placeholder } } : {}),
              options: (s.options ?? []).map(o => ({ text: { tag: "plain_text", content: o.label }, value: o.value })),
            }
          case "date_picker":
            return {
              tag: "date_picker",
              name: s.name ?? "date",
              ...(s.placeholder ? { placeholder: { tag: "plain_text", content: s.placeholder } } : {}),
            }
          case "time_picker":
            return {
              tag: "picker_time",
              name: s.name ?? "time",
              ...(s.placeholder ? { placeholder: { tag: "plain_text", content: s.placeholder } } : {}),
            }
          case "datetime_picker":
            return {
              tag: "picker_datetime",
              name: s.name ?? "datetime",
              ...(s.placeholder ? { placeholder: { tag: "plain_text", content: s.placeholder } } : {}),
            }
          case "checker":
            return {
              tag: "checker",
              name: s.name ?? "checker",
              checked: s.checked ?? false,
              text: { tag: "plain_text", content: s.content ?? "" },
            }
          case "overflow":
            if (!s.options?.length) return []
            return {
              tag: "overflow",
              options: s.options.map(o => ({ text: { tag: "plain_text", content: o.label }, value: o.value })),
            }
          case "person_picker":
            return {
              tag: "select_person",
              name: s.name ?? "person",
              ...(s.placeholder ? { placeholder: { tag: "plain_text", content: s.placeholder } } : {}),
            }
          case "multi_person_picker":
            return {
              tag: "multi_select_person",
              name: s.name ?? "persons",
              ...(s.placeholder ? { placeholder: { tag: "plain_text", content: s.placeholder } } : {}),
            }
          case "collapse":
            return {
              tag: "collapsible_panel",
              // 默认折叠，避免卡片过长影响首屏可读性。
              expanded: false,
              header: { title: { tag: "plain_text", content: s.title ?? "" } },
              elements: [{ tag: "markdown", content: s.content ?? "" }],
            }
          case "image_picker": {
            const imgOpts = (s.options ?? []).filter(o => o.imageKey)
            if (!imgOpts.length) return []
            return {
              tag: "select_img",
              name: s.name ?? "img",
              options: imgOpts.map(o => ({ img_key: o.imageKey!, value: o.value })),
            }
          }
          case "markdown":
          default:
            return { tag: "markdown", content: s.content ?? "" }
        }
      }).filter(Boolean),
    },
  }
}
