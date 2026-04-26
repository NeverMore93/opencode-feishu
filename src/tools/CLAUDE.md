# CLAUDE.md

## 目录职责

- 本目录存放暴露给 agent 的工具实现。
- 工具职责是提供能力边界清晰、参数稳定的桥接接口。

## 可以在这里放

- tool schema、参数校验、调用适配和最小必要的工具级说明。

## 不要在这里放

- 会话编排逻辑。
- 与工具无关的 UI 渲染或通用业务流程。

## 修改约束

- 工具要保持幂等或可预期，不用隐藏副作用。
- 参数含义必须与实际行为严格对应，不能靠 prompt 猜。

## 文件职责

### send-card.ts

- `createSendCardTool(deps)` — 注册 `feishu_send_card` 工具定义，包含 22 种 Card 2.0 组件的 Zod schema 和调用适配。
- `buildCardFromDSL(args, chatId, chatType)` — 统一 DSL → CardKit 2.0 JSON 翻译，同时被 agent tool 和权限/问答交互卡片复用。
- `ButtonInput.actionPayload` — 内部字段，有此字段时直接用作按钮 value（权限/问答场景），无时构造 send_message action；不暴露给 agent Zod schema。
- `SectionInput` — 支持 22 种区块类型：markdown/divider/note/actions（基础）、image/person/chart/table（展示）、input/select/date_picker/collapse 等（交互）。
