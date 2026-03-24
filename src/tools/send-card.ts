/**
 * feishu_send_card Tool：agent 驱动的一次性结构化卡片
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { getChatIdBySession, getChatInfoBySession } from "../feishu/session-chat-map.js"
import { sendInteractiveCard } from "../feishu/sender.js"
import { truncateMarkdown } from "../feishu/markdown.js"
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { LogFn } from "../types.js"

const z = tool.schema

const TEMPLATE_COLORS = ["blue", "green", "orange", "red", "purple", "grey"] as const

interface SendCardDeps {
  feishuClient: InstanceType<typeof Lark.Client>
  log: LogFn
}

export function createSendCardTool(deps: SendCardDeps): ToolDefinition {
  return tool({
    description:
      "发送格式化卡片消息到当前飞书会话。支持 markdown 正文、分割线、备注和交互按钮。" +
      "按钮点击等同用户发送消息。卡片作为独立消息发送，不影响流式回复。",
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
              .enum(["markdown", "divider", "note", "actions"])
              .default("markdown")
              .describe("区块类型：markdown（正文）、divider（分割线）、note（备注）、actions（按钮组）"),
            content: z
              .string()
              .optional()
              .describe("区块内容（markdown 格式，divider/actions 类型无需此字段）"),
            buttons: z
              .array(
                z.object({
                  text: z.string().describe("按钮显示文本（2-6字）"),
                  value: z.string().describe("点击后作为用户消息发送的内容"),
                  style: z
                    .enum(["primary", "default", "danger"])
                    .default("default")
                    .describe("按钮样式"),
                }),
              )
              .optional()
              .describe("按钮列表（仅 actions 类型使用）"),
          }),
        )
        .min(1)
        .describe("卡片正文区块列表"),
    },
    async execute(args, context) {
      const chatId = getChatIdBySession(context.sessionID)
      if (!chatId) {
        deps.log("warn", "Agent 卡片发送跳过：sessionID 无飞书聊天映射", {
          sessionId: context.sessionID,
          title: args.title,
        })
        return "错误：当前会话不关联飞书聊天，无法发送卡片"
      }

      const chatInfo = getChatInfoBySession(context.sessionID)
      const card = buildCardFromDSL(args, chatId, chatInfo?.chatType ?? "p2p")
      const result = await sendInteractiveCard(deps.feishuClient, chatId, card)

      if (result.ok) {
        deps.log("info", "Agent 卡片已发送", {
          sessionId: context.sessionID,
          chatId,
          title: args.title,
          messageId: result.messageId,
        })
        return `卡片已发送：「${args.title}」`
      }

      deps.log("warn", "Agent 卡片发送失败", {
        sessionId: context.sessionID,
        chatId,
        title: args.title,
        error: result.error,
      })
      return `卡片发送失败：${result.error}`
    },
  })
}

export type ButtonInput = {
  text: string
  value: string
  style: "primary" | "default" | "danger"
  /** 内部字段：直接用作按钮 value（权限/问答场景），不暴露给 agent Zod schema */
  actionPayload?: object
}

export type SectionInput = {
  type: "markdown" | "divider" | "note" | "actions"
  content?: string
  buttons?: readonly ButtonInput[]
}

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
      elements: args.sections.map((s) => {
        switch (s.type) {
          case "divider":
            return { tag: "hr" }
          case "note":
            return {
              tag: "note",
              elements: [{ tag: "plain_text", content: s.content ?? "" }],
            }
          case "actions":
            if (!s.buttons?.length) return null
            return {
              tag: "action",
              actions: s.buttons.map((btn) => ({
                tag: "button",
                text: { tag: "plain_text", content: btn.text },
                type: btn.style,
                value: JSON.stringify(btn.actionPayload ?? {
                  action: "send_message",
                  chatId,
                  chatType,
                  text: btn.value,
                }),
              })),
            }
          case "markdown":
          default:
            return {
              tag: "markdown",
              content: truncateMarkdown(s.content ?? "", 28_000),
            }
        }
      }).filter(Boolean),
    },
  }
}
