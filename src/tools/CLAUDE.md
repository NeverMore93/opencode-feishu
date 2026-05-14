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
- `SectionInput` — 支持 23 种区块类型：markdown/divider/note/actions（基础）、image/person/chart/table（展示）、input/select/date_picker/collapse 等（交互）、**form**（spec 031 新增：含 fields + submit + reset，`translateFormSection` 翻译为飞书 form 容器 schema）。
- `FormFieldSchema` — 5 种字段类型的 discriminatedUnion（text/select/multi_select/date_picker/checker），含 superRefine 校验（FR-006/007）。

### request-form.ts

- `createRequestFormTool(deps)` — 注册 `feishu_request_form` 阻塞型工具定义，execute 函数三路 race（用户提交 / abort signal / timeout）。
- 三路 race 实现：register-before-send 模式消除竞态窗口；`settled` flag + `settle()` 闭包确保 exactly-once resolution；`clearTimeout` + `removeEventListener` 在 settle 时清理资源。
- 复用 P1 的 `buildCardFromDSL` 构造 form 卡片，复用 `sendInteractiveCard` 发送。
- 返回值：用户提交成功 → `{ output, metadata: { formValue, operatorId, timezone } }`；超时/中断/发送失败 → 错误字符串。
