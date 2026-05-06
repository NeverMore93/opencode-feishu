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

/**
 * form 容器子组件 name 命名规则（contract 02 / FR-007）。
 * 必须以字母开头，仅含字母数字下划线，长度 1-20。
 */
const FIELD_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,19}$/

/**
 * form 容器自身 formName 命名规则（contract 02）。
 * 与字段 name 同规则；form 提交按钮命名约定 `btn_submit_<formName>` 由此衍生。
 */
const FORM_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,19}$/

/**
 * 插件预埋字段名集合（FR-018 + T022 superRefine）。
 * agent 不允许在 submit.actionPayload 中重写这些 key，避免越权伪造插件信封字段。
 * 此外，`__plugin_*` 前缀也保留（在 superRefine 中通过 startsWith 检测）。
 */
const RESERVED_PAYLOAD_KEYS = ["formName", "callbackChatId"] as const

const FIELD_NAME_ERROR =
  "字段名与命名规则不一致：必须以字母开头，仅含字母数字下划线，长度 1-20"

const TextFieldSchema = z.object({
  type: z.literal("text"),
  name: z.string().regex(FIELD_NAME_PATTERN, FIELD_NAME_ERROR),
  inlineLabel: z.string().min(1, "inlineLabel 非空字符串"),
  placeholder: z.string().optional(),
  defaultValue: z.string().optional(),
  maxLength: z.number().int().min(1).max(10_000).optional(),
  required: z.boolean().optional(),
})

const SelectOptionSchema = z.object({
  label: z.string().min(1, "option.label 非空字符串"),
  value: z.string().min(1, "option.value 非空字符串"),
})

const SelectFieldSchema = z.object({
  type: z.literal("select"),
  name: z.string().regex(FIELD_NAME_PATTERN, FIELD_NAME_ERROR),
  inlineLabel: z.string().min(1, "inlineLabel 非空字符串"),
  placeholder: z.string().optional(),
  options: z
    .array(SelectOptionSchema)
    .min(1, "select 字段 options 非空数组")
    .max(20, "select 字段 options 上限 20 项"),
  required: z.boolean().optional(),
})

const MultiSelectFieldSchema = z.object({
  type: z.literal("multi_select"),
  name: z.string().regex(FIELD_NAME_PATTERN, FIELD_NAME_ERROR),
  inlineLabel: z.string().min(1, "inlineLabel 非空字符串"),
  placeholder: z.string().optional(),
  options: z
    .array(SelectOptionSchema)
    .min(1, "multi_select 字段 options 非空数组")
    .max(20, "multi_select 字段 options 上限 20 项"),
  required: z.boolean().optional(),
})

const DatePickerFieldSchema = z.object({
  type: z.literal("date_picker"),
  name: z.string().regex(FIELD_NAME_PATTERN, FIELD_NAME_ERROR),
  inlineLabel: z.string().min(1, "inlineLabel 非空字符串"),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
})

const CheckerFieldSchema = z.object({
  type: z.literal("checker"),
  name: z.string().regex(FIELD_NAME_PATTERN, FIELD_NAME_ERROR),
  text: z.string().min(1, "checker.text 非空字符串"),
  defaultChecked: z.boolean().default(false),
})

/**
 * form section 字段类型联合（FR-006 第 7 项 + FR-007）。
 *
 * z.discriminatedUnion 在编译期排除非法 type 组合，运行期为 agent 给出
 * "type 不匹配此分支字段集合"的精确错误信息（FR-017 陈述句风格）。
 */
const FormFieldSchema = z.discriminatedUnion("type", [
  TextFieldSchema,
  SelectFieldSchema,
  MultiSelectFieldSchema,
  DatePickerFieldSchema,
  CheckerFieldSchema,
])

/**
 * form section schema（contract 02）。
 *
 * - submit 必填（form 没有提交按钮就没意义）
 * - reset 可选；schema 不暴露 reset.actionPayload 即满足 FR-006 第 1 项
 *   （"reset 按钮禁止 behaviors"，飞书 200621 拒收的硬约束）
 * - inlineLabel 在每个字段单独声明，translateFormSection 展开为独立 markdown 元素
 *   绕过飞书 form 子组件不允许 label 字段的限制（FR-006 第 2 项）
 */
const FormSectionSchemaBase = z.object({
  type: z.literal("form"),
  formName: z.string().regex(FORM_NAME_PATTERN, "formName 与命名规则不一致：必须以字母开头，仅含字母数字下划线，长度 1-20"),
  fields: z
    .array(FormFieldSchema)
    .min(1, "form section fields 非空数组")
    .max(10, "form section fields 上限 10 项"),
  submit: z.object({
    text: z.string().min(1, "submit.text 非空字符串"),
    actionPayload: z.record(z.string(), z.unknown()).optional(),
  }),
  reset: z
    .object({
      text: z.string().min(1, "reset.text 非空字符串"),
    })
    .optional(),
})

const FormSectionSchema = FormSectionSchemaBase.superRefine((data, ctx) => {
  // T019 / FR-006 第 3 项：form 内 field name 唯一性
  const seen = new Set<string>()
  for (let i = 0; i < data.fields.length; i++) {
    const fieldName = data.fields[i].name
    if (seen.has(fieldName)) {
      ctx.addIssue({
        code: "custom",
        path: ["fields", i, "name"],
        message: `form '${data.formName}' 含 2 个名为 '${fieldName}' 的字段，name 在同一 form 内唯一`,
      })
    }
    seen.add(fieldName)
  }
})

/**
 * form 字段输入类型（与 FormFieldSchema 等价，手写以解耦 zod 类型推导限制）。
 *
 * 5 种字段类型与 contract 02 一一对齐：
 * - text：单行文本输入（input）
 * - select：单选下拉
 * - multi_select：多选下拉
 * - date_picker：日期选择
 * - checker：复选框（boolean）
 */
type FormFieldInput =
  | {
      type: "text"
      name: string
      inlineLabel: string
      placeholder?: string
      defaultValue?: string
      maxLength?: number
      required?: boolean
    }
  | {
      type: "select"
      name: string
      inlineLabel: string
      placeholder?: string
      options: ReadonlyArray<{ label: string; value: string }>
      required?: boolean
    }
  | {
      type: "multi_select"
      name: string
      inlineLabel: string
      placeholder?: string
      options: ReadonlyArray<{ label: string; value: string }>
      required?: boolean
    }
  | {
      type: "date_picker"
      name: string
      inlineLabel: string
      placeholder?: string
      required?: boolean
    }
  | {
      type: "checker"
      name: string
      text: string
      defaultChecked?: boolean
    }

/**
 * form section 输入类型（与 FormSectionSchema 等价）。
 *
 * - submit 必填（form 没有提交按钮即无意义）
 * - reset 可选；reset 在 schema 内仅暴露 text，满足 FR-006 第 1 项硬约束（reset 按钮禁止 behaviors）
 */
type FormSectionInput = {
  type: "form"
  formName: string
  fields: ReadonlyArray<FormFieldInput>
  submit: { text: string; actionPayload?: Record<string, unknown> }
  reset?: { text: string }
}

/**
 * 22 种基础 section 的 schema（spec 031 之前的 sections 完整集合）。
 *
 * 作为 z.union 的一个分支与 FormSectionSchema 并列；agent 通过 type 字段隐式选择。
 * 抽出为模块级常量是 spec 031 引入 form section 时的直接派生，不改变任何字段语义。
 */
const BaseSectionSchema = z.object({
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
    .describe("区块内容（飞书 markdown 子集：粗体、斜体、链接、代码块、行内代码、列表、标题 h1-h6。HTML 标签会被自动移除。divider/actions 类型无需此字段）"),
  buttons: z
    .array(
      z.object({
        text: z.string().describe("按钮显示文本（2-6字）"),
        value: z.string().describe("按钮点击后作为用户消息发送的文本内容（纯文本，不含 JSON）。中断、权限审批、问答应答等控制语义由插件单独承载，此字段无法表达。"),
        style: z
          .enum(["primary", "default", "danger"])
          .default("default")
          .describe("按钮样式：primary=高亮推荐, default=普通, danger=危险操作红色"),
      }),
    )
    .max(5)
    .optional()
    .describe("按钮列表（仅 actions 类型使用，最多 5 个）"),
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
})

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
      "仅使用工具 schema 明确支持的 section 类型和字段。" +
      "卡片作为独立消息发送，不影响流式回复。" +
      "本工具只负责将 agent 已决定的内容渲染为卡片，不补全主题、摘要或结论。" +
      "普通按钮点击触发用户消息回复，agent 继续当前运行；仅专门的 abort 按钮会中断当前运行。" +
      "单张卡片内容不超过 30KB（飞书限制）。markdown 支持粗体、斜体、链接、代码块、列表、标题；HTML 标签会被自动移除。actions section 用于呈现一组互斥的下一步动作选项，每个 actions 区块最多 5 个按钮，button.value 直接成为下一轮 user prompt 文本。form section 用于一次性收集多字段结构化输入，用户填写中间状态不触发回调，仅 submit 按钮触发一次 form_value 回传，form_value 字典键来自子组件 name 字段。" +
      "适合交互性输出（确认、选择、输入）使用按钮或输入组件；结构化或较长内容适合用分区和折叠面板展示。",
    args: {
      title: z.string().describe("卡片标题"),
      template: z
        .enum(TEMPLATE_COLORS)
        .default("blue")
        .describe("标题颜色主题：blue=信息/中性, green=成功/完成, orange=警告/注意, red=错误/严重, purple=特殊/创意, grey=次要/辅助"),
      sections: z
        .array(z.union([FormSectionSchema, BaseSectionSchema]))
        .min(1)
        .describe("卡片正文区块列表（支持 22 种基础组件 + 1 种 form 容器）")
        .superRefine((sections, ctx) => {
          // T021 / FR-006 第 5 项：同卡片 formName 唯一性
          // T022 / FR-018：submit.actionPayload 不允许 agent 写入插件保留 key
          const seenFormNames = new Set<string>()
          for (let i = 0; i < sections.length; i++) {
            const s = sections[i]
            if (s.type !== "form") continue

            if (seenFormNames.has(s.formName)) {
              ctx.addIssue({
                code: "custom",
                path: [i, "formName"],
                message: `sections 含 2 个 formName='${s.formName}' 的 form section，formName 在同一卡片内唯一`,
              })
            }
            seenFormNames.add(s.formName)

            const payload = s.submit.actionPayload
            if (payload && typeof payload === "object") {
              for (const reservedKey of RESERVED_PAYLOAD_KEYS) {
                if (reservedKey in payload) {
                  ctx.addIssue({
                    code: "custom",
                    path: [i, "submit", "actionPayload", reservedKey],
                    message: `submit.actionPayload 不允许包含 '${reservedKey}' 键，此键由插件自动注入`,
                  })
                }
              }
              for (const key of Object.keys(payload)) {
                if (key.startsWith("__plugin_")) {
                  ctx.addIssue({
                    code: "custom",
                    path: [i, "submit", "actionPayload", key],
                    message: `submit.actionPayload 不允许 '__plugin_*' 前缀键，此前缀由插件保留`,
                  })
                }
              }
            }
          }
        }),
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
 * 22 种基础 section 输入定义（spec 031 之前的 SectionInput 完整集合）。
 *
 * 一个 section 最终会被翻译成 1 个或多个 Card 2.0 元素。
 * spec 031 引入 form section 后，外部消费者继续用 SectionInput（包含 form），
 * BaseSectionInput 保留为内部展开用（buildCardFromDSL switch 内的 case 22 类型）。
 */
export type BaseSectionInput = {
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
 * Section 输入联合类型（spec 031 form section 接入后的对外契约）。
 *
 * - BaseSectionInput：22 种基础组件
 * - FormSectionInput：form 容器（一次性收集多字段结构化输入）
 *
 * agent 通过 type 字段选择分支；buildCardFromDSL switch 据此分发到对应翻译路径。
 */
export type SectionInput = BaseSectionInput | FormSectionInput

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
          case "form":
            // spec 031 contract 02：form 容器统一翻译。chatId 透传作为 customValue.callbackChatId 注入。
            return translateFormSection(s, chatId)
          case "markdown":
          default:
            return { tag: "markdown", content: s.content ?? "" }
        }
      }).filter(Boolean),
    },
  }
}

/**
 * 把 form section DSL 翻译为飞书 form 容器 schema（contract 02）。
 *
 * 关键约束：
 * - 每个非 checker 字段先 push 一条独立 `**inlineLabel**` markdown 元素（FR-004），
 *   绕过飞书 form 子组件不支持 label 字段的限制（FR-006 第 2 项硬约束）
 * - submit 按钮自动注入 `formName` + `callbackChatId` 到 customValue，agent 不可手写覆盖（T022 superRefine 守卫）
 * - reset 按钮（如有）不附 behaviors（FR-006 第 1 项硬约束 + 飞书 200621 拒收）
 */
function translateFormSection(s: FormSectionInput, chatId: string): object {
  const elements: object[] = []

  for (const field of s.fields) {
    // FR-004：inlineLabel 展开为独立 markdown 元素；checker 字段无 inlineLabel（用 text 字段表达），跳过。
    if (field.type !== "checker") {
      elements.push({ tag: "markdown", content: `**${field.inlineLabel}**` })
    }
    elements.push(translateFormField(field))
  }

  // FR-005 / T025：submit button 命名约定 + 强制 form_action_type="submit" + 自动注入 envelope 字段
  const submitCustomValue: Record<string, unknown> = {
    ...(s.submit.actionPayload ?? {}),
    formName: s.formName,
    callbackChatId: chatId,
  }
  elements.push({
    tag: "button",
    name: `btn_submit_${s.formName}`,
    text: { tag: "plain_text", content: s.submit.text },
    type: "primary",
    form_action_type: "submit",
    behaviors: [{ type: "callback", value: submitCustomValue }],
  })

  // FR-005 / T026：reset 命名约定 + form_action_type="reset"；不写 behaviors 数组（飞书 200621 拒收）
  if (s.reset) {
    elements.push({
      tag: "button",
      name: `btn_reset_${s.formName}`,
      text: { tag: "plain_text", content: s.reset.text },
      type: "default",
      form_action_type: "reset",
      // 故意不附 behaviors —— form 容器内 reset 按钮添加 behaviors 会被飞书 200621 拒收
    })
  }

  return {
    tag: "form",
    name: s.formName,
    direction: "vertical",
    elements,
  }
}

/**
 * 把单个 form 字段翻译为飞书 form 容器子组件 schema（contract 02 字段类型映射）。
 */
function translateFormField(field: FormFieldInput): object {
  switch (field.type) {
    case "text":
      return {
        tag: "input",
        name: field.name,
        ...(field.placeholder ? { placeholder: { tag: "plain_text", content: field.placeholder } } : {}),
        ...(field.defaultValue ? { default_value: field.defaultValue } : {}),
        ...(field.maxLength ? { max_length: field.maxLength } : {}),
        ...(field.required ? { required: true } : {}),
      }
    case "select":
      return {
        tag: "select_static",
        name: field.name,
        ...(field.placeholder ? { placeholder: { tag: "plain_text", content: field.placeholder } } : {}),
        options: field.options.map((o) => ({
          text: { tag: "plain_text", content: o.label },
          value: o.value,
        })),
        ...(field.required ? { required: true } : {}),
      }
    case "multi_select":
      return {
        tag: "multi_select_static",
        name: field.name,
        ...(field.placeholder ? { placeholder: { tag: "plain_text", content: field.placeholder } } : {}),
        options: field.options.map((o) => ({
          text: { tag: "plain_text", content: o.label },
          value: o.value,
        })),
        ...(field.required ? { required: true } : {}),
      }
    case "date_picker":
      return {
        tag: "date_picker",
        name: field.name,
        ...(field.placeholder ? { placeholder: { tag: "plain_text", content: field.placeholder } } : {}),
        ...(field.required ? { required: true } : {}),
      }
    case "checker":
      return {
        tag: "checker",
        name: field.name,
        checked: field.defaultChecked ?? false,
        text: { tag: "plain_text", content: field.text },
      }
  }
}
