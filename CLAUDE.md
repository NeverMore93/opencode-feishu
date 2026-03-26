# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此代码仓库中工作时提供指导。

## 项目概述

**opencode-feishu** 是 OpenCode 的飞书插件（不是独立服务），通过飞书 WebSocket 长连接接入本地 OpenCode Server。它支持流式响应和实时更新的 AI 对话。插件作为**消息中继**：所有消息（包括以 `/` 开头的命令）原样转发给 OpenCode，不解析命令、不选择模型。

**核心能力：**
- 飞书 WebSocket 长连接接收消息（无需 webhook）
- 作为 OpenCode 插件运行（导出 `FeishuPlugin`，符合 `@opencode-ai/plugin` 接口）
- 通过 OpenCode SDK `client` 管理会话和消息
- 群聊静默监听（转发所有消息作为上下文，仅在被 @提及时回复）
- 入群自动摄入历史消息
- CardKit 2.0 流式卡片：AI 回复实时显示文本（markdown 渲染）和工具调用进度
- 交互式卡片：权限审批和问答通过按钮完成（card.action.trigger WebSocket 回调）
- 事件总线（action-bus）：per-session 事件订阅/发布，驱动流式卡片和交互卡片
- Zod 配置验证：启动时结构化验证 feishu.json，拼写/类型错误立即报出
- 通过插件 `event` 钩子接收 SSE 事件（message.part.updated、permission.asked、question.asked、session.idle）

## 项目约定（重要）

### 项目定位
- **opencode-feishu 是 OpenCode 的插件，不是独立服务**
- 作为 OpenCode 生态的一部分，由 OpenCode 加载和管理生命周期
- 依赖 OpenCode Server 提供核心 AI 能力

### 开发规范
- **当前项目不需要单测** - 专注功能实现和集成测试
- **所有文档包括 .specify 目录下尽量用中文编写**
- **任何变更先改版本号** - 推荐使用 `npm run release` 自动完成版本更新、commit、tag 和 push，然后通过 PR 合并到 main。

详细项目约定参见：`.specify/memory/constitution.md`

## 开发命令

### 构建和开发
```bash
# 安装依赖
npm install

# 构建（使用 tsup）
npm run build

# 开发模式（监听 + 重新构建）
npm run dev

# 仅类型检查
npm run typecheck
```

### 发布
```bash
# 一键版本发布（交互式选择 patch/minor/major，自动 commit + tag + push）
npm run release

# 手动发布（prepublishOnly 自动执行构建+类型检查）
npm publish

# 干运行：查看将要发布的文件（不实际发布）
npm publish --dry-run
```

- `prepublishOnly` 脚本确保每次 `npm publish` 前自动运行 `build` 和 `typecheck`
- `npm run release` 使用 bumpp 交互式选择版本，自动更新 package.json、创建 git commit 和 tag、推送到远程
- 推送 `v*` tag 后 GitHub Actions 自动发布到 npm（需在 GitHub Secrets 中配置 `NPM_TOKEN`）

### 本地调试
```bash
# 启用调试模式（日志输出到 stderr）
FEISHU_DEBUG=1 opencode

# 配合 Lark SDK 详细日志（feishu.json 中设置 "logLevel": "debug"）
FEISHU_DEBUG=1 opencode

# 过滤错误日志
FEISHU_DEBUG=1 opencode 2>&1 | grep '"level":"error"'

# 重定向到文件
FEISHU_DEBUG=1 opencode 2>feishu-debug.log
```

- `FEISHU_DEBUG=1`：启用 console.error 结构化 JSON 输出（不影响 stdout 管道）
- `feishu.json` 中 `logLevel`：控制 Lark SDK 内部日志详细程度（`fatal`/`error`/`warn`/`info`/`debug`/`trace`）
- 不设 `FEISHU_DEBUG` 时行为与之前完全一致（无 console 输出）

### 安装到 OpenCode

**1. 构建插件：**
```bash
npm run build
```

**2. 在 `opencode.json` 中声明插件（使用项目绝对路径）：**
```json
{ "plugin": ["D:/path/to/opencode-feishu"] }
```

> OpenCode 插件系统会将路径转换为 `file:///` 协议直接加载 `dist/index.js`。
> 不要使用包名（如 `"opencode-feishu"`），Windows 上 Bun 安装存在 EPERM 权限问题。

**3. 创建飞书配置文件** `~/.config/opencode/plugins/feishu.json`：
```json
{ "appId": "cli_xxxxxxxxxxxx", "appSecret": "your_secret" }
```

## 架构设计

### 插件架构
```
OpenCode 加载插件 → src/index.ts (FeishuPlugin)
    ├── Zod 配置验证 → FeishuConfigSchema.parse(feishu.json)
    ├── Lark Client → SDK 内置 token 管理 + HTTP 客户端（中央创建，传递给 gateway/cardkit）
    ├── CardKitClient → SDK thin wrapper（委托 client.cardkit.v1.*）
    ├── fetchBotOpenId(larkClient) → client.request() 获取 bot open_id
    └── startFeishuGateway(larkClient) → 启动 WebSocket 长连接（复用 Client）
        ├── im.message.receive_v1 → enqueueMessage() [session-queue]
        │   ├── shouldReply=false → handleChat() 静默转发（绕过队列）
        │   ├── P2P + shouldReply=true → 可中断策略（abort + 立即处理新消息）
        │   │   └── handleChat() → 返回 AutoPromptContext
        │   │       └── runP2PAutoPrompt(signal) → abortableSleep + 单次迭代 + 空闲检测
        │   └── Group + shouldReply=true → 串行排队（FIFO 顺序依次处理）
        │       └── drainLoop: Phase 1 用户消息 → Phase 2 空闲 auto-prompt
        │           ├── handleChat(ctx, deps, signal) → 返回 AutoPromptContext
        │           │   ├── StreamingCard.start() → 流式卡片（fallback 纯文本占位）
        │           │   ├── subscribe(action-bus) → text/tool/permission/question 更新卡片
        │           │   └── promptAsync() → 轮询（session.idle 提前退出）→ card.close()
        │           └── 队列空 → sleep(1s 粒度检查队列) → runOneAutoPromptIteration → 空闲检测
        ├── im.chat.member.bot.added_v1 → ingestGroupHistory()
        └── card.action.trigger → handleCardAction() → v2Client.permission/question.reply()
    event 钩子 → handleEvent()
        ├── message.part.updated → 更新占位消息 + emit text-updated/tool-state-changed
        ├── permission.asked → emit permission-requested（→ 交互卡片）
        ├── question.asked → emit question-requested（→ 交互卡片）
        ├── session.idle → emit session-idle（→ 轮询提前退出）
        └── session.error → 缓存错误 + 模型不兼容时自动恢复会话
```

### 核心模块

**插件入口 (`src/index.ts`):**
- 导出 `FeishuPlugin: Plugin`（命名导出）
- Zod 配置验证：`FeishuConfigSchema.parse()` 替代手动 `??` 合并，启动时报出清晰错误
- 创建 `Lark.Client`（SDK 内置 token 管理），传递给 `CardKitClient` 和 `startFeishuGateway`
- `fetchBotOpenId()` 使用 `larkClient.request()` 自动认证（无手动 token 管理）
- `event` 钩子：接收 OpenCode 事件，处理 6+ 事件类型并通过 action-bus 分发
- 使用 `client.app.log()` 记录结构化日志

**飞书网关 (`src/feishu/gateway.ts`):**
- 接收外部创建的 `Lark.Client`（复用 token 管理和 HTTP 客户端）
- 创建 `WSClient`（WebSocket 长连接，独立代理配置）
- 处理 `im.message.receive_v1` 事件
- 处理 `card.action.trigger` 卡片回调（权限/问答按钮，3 秒内返回 toast）
- 消息去重（10 分钟窗口，通过 `dedup.ts`）
- 群消息 @提及过滤（通过 `group-filter.ts`）
- 处理 `im.chat.member.bot.added_v1` 用于历史摄入

**消息队列调度器 (`src/handler/session-queue.ts`):**
- per-sessionKey 并发控制，防止占位消息竞态覆盖
- P2P 可中断策略：`AbortController.abort()` + `session.abort()` 中断当前处理 + auto-prompt 后续阶段
- 群聊串行排队策略：FIFO 顺序依次处理，所有 @bot 消息都得到回复
- 群聊 auto-prompt：`drainLoop` 队列耗尽后进入空闲 auto-prompt 阶段，每秒检查队列实现用户消息优先
- P2P auto-prompt：`runP2PAutoPrompt` 使用 `abortableSleep` 可被新消息 abort 中断
- 静默消息（shouldReply=false）完全绕过队列
- 暴露 `enqueueMessage()` 作为唯一入口

**对话处理器 (`src/handler/chat.ts`):**
- 使用 `client.session.promptAsync()` 异步发送消息（不阻塞）
- 接受可选 `signal?: AbortSignal` 参数，支持被队列中断
- 返回 `AutoPromptContext | undefined`：供 session-queue 驱动 auto-prompt 后续阶段
- 会话键格式：`feishu-p2p-<userId>` 或 `feishu-group-<chatId>`
- 会话标题格式：`Feishu-<sessionKey>-<timestamp>`
- 静默监听模式：`promptAsync({ noReply: true })`
- 主动回复模式：`StreamingCard.start()` → action-bus 订阅 → 轮询（session.idle 提前退出）→ `card.close()`
- `runOneAutoPromptIteration()`：单次 auto-prompt 迭代（发送提示 → poll → 空闲检测 → 发送有效响应）
- `isIdleResponse()`：双重条件空闲检测（长度 < idleMaxLength AND 关键词匹配）
- action-bus 订阅：text-updated → 卡片文本更新、tool-state-changed → 工具进度、permission/question → 交互卡片
- StreamingCard 回退：CardKit 创建失败时自动降级为纯文本占位消息
- AbortError 处理：被中断时调用 `card.destroy()` 删除消息，静默退出

**事件处理器 (`src/handler/event.ts`):**
- 处理 `message.part.updated`：实时更新占位消息 + emit `text-updated`/`tool-state-changed` 到 action-bus
- 处理 `permission.asked`/`question.asked`：emit 到 action-bus（→ 交互卡片）
- 处理 `session.idle`：emit 到 action-bus（→ 轮询提前退出）
- 处理 `session.error`：提取错误消息、缓存到 `sessionErrors` Map、检测模型不兼容错误
- `isModelError()`：双层匹配策略 — 层1 精确子串（已知错误码），层2 关键词组合（"model" + 否定词，覆盖未知变体）
- 管理 `pendingBySession` 映射（sessionId → 飞书占位消息）
- 管理 `retryAttempts` 计数器（防止无限重试循环，上限 2 次）
- 管理 `sessionErrors` 映射（30s TTL，供 chat.ts pollForResponse 和 catch 块消费）

**事件总线 (`src/handler/action-bus.ts`):**
- per-session 事件订阅/发布：`subscribe(sessionId, cb)` 返回 unsubscribe 函数
- `emit(sessionId, action)` fire-and-forget 分发，错误不阻塞
- `unsubscribeAll(sessionId)` 清理所有订阅
- `ProcessedAction` 联合类型：7 种事件（text-updated、tool-state-changed、subtask-discovered、permission-requested、question-requested、session-idle、session-error）

**交互处理器 (`src/handler/interactive.ts`):**
- `handlePermissionRequested`/`handleQuestionRequested`：使用 `buildCardFromDSL` 构建交互卡片并发送到飞书
- `handleCardAction`：解析按钮回调 value → 路由到 v2Client permission/question reply
- `seenRequestIds` 防止重复发送交互卡片
- `buildCallbackResponse`：返回 toast 即时反馈（3 秒约束）
- 权限/问答卡片通过 `actionPayload` 字段注入按钮回调数据，复用统一 DSL 构建路径

**CardKit 客户端 (`src/feishu/cardkit.ts`):**
- `CardKitClient` 类：SDK thin wrapper，委托 `client.cardkit.v1.*` 方法
- `createCard(schema)` → `client.cardkit.v1.card.create()`
- `updateElement(cardId, elementId, content, sequence)` → `client.cardkit.v1.cardElement.content()`
- `closeStreaming(cardId, sequence)` → `client.cardkit.v1.card.settings()`
- Token 管理由 SDK Client 内置处理，无需自定义 TokenManager

**流式卡片 (`src/feishu/streaming-card.ts`):**
- `StreamingCard` 类：管理单个 AI 回复的流式卡片生命周期
- `start()` → 创建卡片 + 发送 interactive 消息
- `updateText(delta)` / `setToolStatus(callID, tool, state)` → 队列串行化更新
- `close(finalMarkdown?)` → 清理 markdown + 截断 + 关闭流式模式
- `destroy()` → 删除消息（abort 场景）

**Markdown 工具 (`src/feishu/markdown.ts`):**
- `cleanMarkdown(text)`：移除 HTML 标签、确保代码块闭合
- `truncateMarkdown(text, limit)`：截断到 28KB 并添加提示后缀

**历史摄入 (`src/feishu/history.ts`):**
- 通过飞书 API 获取最近 50 条群消息
- 以 `noReply: true` 发送到 OpenCode（仅上下文）

**消息发送器 (`src/feishu/sender.ts`):**
- 通过飞书 API 发送、更新和删除消息
- `sendCardMessage(client, chatId, cardId)` — 发送 CardKit 流式卡片
- `sendInteractiveCard(client, chatId, card)` — 发送交互式卡片（权限/问答）

**Agent 卡片 Tool (`src/tools/send-card.ts`):**
- `createSendCardTool(deps)` — 注册 `feishu_send_card` tool，agent 可自主发送结构化卡片
- `buildCardFromDSL(args, chatId, chatType)` — 统一 DSL → CardKit 2.0 JSON 翻译（同时被 agent tool 和权限/问答卡片复用）
- `ButtonInput.actionPayload` — 内部字段，有此字段时直接用作按钮 value（权限/问答场景），无时构造 send_message action
- `SectionInput` — 支持 markdown/divider/note/actions 四种区块类型

**会话-聊天映射 (`src/feishu/session-chat-map.ts`):**
- `registerSessionChat(sessionId, chatId, chatType)` — 注册 sessionId → chatId 映射
- `getChatIdBySession(sessionId)` — 查询映射
- 供 feishu_send_card tool 和 system prompt 注入使用

**辅助模块：**
- `src/feishu/dedup.ts` - 10 分钟消息去重窗口
- `src/feishu/group-filter.ts` - @提及检测
- `src/types.ts` - 类型定义（FeishuMessageContext, ResolvedConfig, LogFn, ProcessedAction）

## 配置

### 配置文件

**1. OpenCode 插件声明**（`~/.config/opencode/opencode.json`）：
```json
{ "plugin": ["opencode-feishu"] }
```

**2. 飞书配置**（`~/.config/opencode/plugins/feishu.json`）：
```json
{
  "appId": "cli_xxxxxxxxxxxx",
  "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "timeout": 120000,
  "thinkingDelay": 2500
}
```

必需字段：`appId`, `appSecret`
可选字段：`timeout`（默认 120000ms）、`thinkingDelay`（默认 2500ms）、`logLevel`（默认 `"info"`，控制 Lark SDK 日志级别）
自动提示：`autoPrompt` 对象 — `enabled`（默认 false）、`intervalSeconds`（默认 30）、`maxIterations`（默认 10）、`message`（默认 "请同步当前进度，如需帮助请说明"）、`idleThreshold`（连续空闲次数阈值，默认 2）、`idleMaxLength`（空闲判定文本长度上限，默认 50）

## 群聊行为

### 静默监听
- 所有群消息都转发到 OpenCode 作为上下文（`noReply: true`）
- Bot 仅在被直接 @提及时回复
- 静默转发：不消耗 AI token，无可见的 bot 活动

### @提及检测
- 需要 bot 的 `open_id`（通过 `/open-apis/bot/v3/info` 获取）
- 获取失败时直接抛出错误，阻止插件启动（严格模式）
- 检测逻辑在 `src/feishu/group-filter.ts`

### 入群历史摄入
- 由 `im.chat.member.bot.added_v1` 事件触发
- 获取群聊最近 50 条消息
- 以 `noReply: true` 发送所有消息到 OpenCode（仅上下文）

## 消息流程变体

| 场景 | 发送到 OpenCode | noReply | 飞书回复 |
|------|:---------------:|:-------:|:--------:|
| 单聊 (P2P) | 是 | 否 | 是 |
| 群聊 + 被 @提及 | 是 | 否 | 是 |
| 群聊 + 未被 @提及 | 是 | **是** | **否** |
| Bot 加入群（历史） | 是 | **是** | **否** |
| 自动提示循环 | 是（"继续"） | 否 | 是（有效响应）/ 否（空闲响应） |

## TypeScript 配置

- **目标**: ES2022
- **模块**: ESNext + Bundler 解析
- **构建工具**: tsup（ESM 输出，Node 20 目标）
- **严格模式**: 启用
- **输出**: `dist/` 目录，包含声明文件和源映射
- **入口**: 库模式（无 shebang），导出 `FeishuPlugin`

## 依赖项

**运行时:**
- `@larksuiteoapi/node-sdk`: 飞书 WebSocket 网关、REST API 客户端、内置 token 管理、CardKit 2.0 API
- `zod`: 配置文件结构化验证
- `https-proxy-agent`: WSClient 代理环境支持

**Peer:**
- `@opencode-ai/plugin`: OpenCode 插件接口（由 OpenCode 提供）

**开发:**
- `@opencode-ai/plugin`: 插件类型定义
- `typescript`: 类型检查
- `tsup`: 构建工具（基于 esbuild）
- `@types/node`: Node.js 类型定义

## 错误处理

- `open_id` 获取失败：直接抛出错误，阻止插件启动
- 提示超时：`timeout` 后返回"⚠️ 响应超时"
- 消息去重：10 分钟窗口防止重复处理
- 飞书消息发送失败：尽力更新占位消息，回退到发送新消息
- 所有错误向飞书用户发送友好消息（不静默失败）

### 会话错误处理（三层架构）

**L1 错误提取**（event.ts）：从 `session.error` SSE 事件提取有意义的错误消息
- `errMsg` 提取优先级：`e.message` → `data.message` → `e.type` → `e.name` → 兜底文案
- `extractErrorFields()`：递归提取错误对象所有 string 值（最大深度 3），自动覆盖任何嵌套结构（data.message、data.error.code 等），无需手动维护字段名或层级
- SDK `UnknownError` 类型的 `data.message` 是 required 字段，存放原始错误名

**L2 轮询期间 SSE 错误检测**（chat.ts pollForResponse）：每次 poll 周期检查 `getSessionError()`
- `pollForResponse()` 在 sleep 后、API 调用前检查 SSE 缓存的 session error
- 检测到错误时抛出 `SessionErrorDetected` 异常（携带 sessionError 信息），立即终止轮询
- 使模型异步失败（prompt 成功但模型报错）在 ~1 秒内被检测，而非等待 120 秒超时

**L3 模型不兼容自动恢复**（chat.ts）：检测模型错误时用全局默认模型重试
- `getGlobalDefaultModel()`：通过 `client.config.get()` 读取 `Config.model` 字段（如 `"aigw/claude-opus-4-6-v1"`），解析为 `{ providerID, modelID }`
- 恢复策略：只用全局配置的默认模型，不在失败 provider 内搜索替代
- 重试计数器：每 sessionKey 最多重试 2 次，防止无限循环；成功后重置计数
- 全局默认模型未配置时，直接向用户显示错误，不重试

**L4 并发控制**（session-queue.ts）：per-sessionKey 消息队列防止竞态
- 私聊可中断：`AbortController.abort()` + `session.abort()` 中断当前处理，立即处理新消息
- 群聊串行排队：FIFO 顺序依次处理，所有 @bot 消息都得到回复
- 静默消息绕过队列：`shouldReply=false` 直接转发，不受队列影响
- `AbortError` 处理：被中断时静默退出，不向用户发送错误
- 使用 `promptAsync()` 异步发送（不再有 prompt() HTTP 错误与 SSE 的竞态问题）
- 错误消息统一由 chat.ts catch 块发送给用户（event.ts 不发送，避免双重发送）

**L5 SSE 事件过滤**（event.ts）：messageID 防止事件串扰
- `PendingReplyPayload.expectedMessageId`：首个 SSE 事件锁定 messageID，后续只接受匹配的事件
- 串行队列保证首个事件属于当前请求

## 日志记录

- 通过 `client.app.log()` 输出到 OpenCode 日志系统（主日志通道）
- 设置 `FEISHU_DEBUG=1` 环境变量时同时输出结构化 JSON 到 stderr（调试用）
- 服务标识："opencode-feishu"
- 级别：info、warn、error
- 日志调用使用 `.catch(() => {})` 静默处理失败（防止 Unhandled Promise Rejection）

## 常见开发场景

### 添加新的消息事件处理器
1. 修改 `src/feishu/gateway.ts` 注册新事件类型
2. 在 `src/handler/` 中添加处理逻辑
3. 在 `src/index.ts` 中连接处理器

### 修改轮询行为
- `feishu.json` 中配置 `pollInterval` 和 `stablePolls`
- 调整以实现更快/更慢的响应检测

### 调试事件流
- 事件通过插件 `event` 钩子接收，逻辑在 `src/handler/event.ts`
- 检查 `pendingBySession` 映射是否正确注册/注销

### 测试静默监听
- 发送群消息但不 @提及 bot
- 检查日志中的"静默转发"条目
- 验证无飞书回复但消息出现在 OpenCode 会话中

## 重要约束

- **不解析命令**：Bot 将所有消息（包括 `/commands`）原样转发给 OpenCode
- **不选择模型/代理**：OpenCode 决定模型和代理路由
- **不使用公网 webhook**：仅使用飞书 WebSocket 长连接
- **单一 OpenCode 实例**：作为插件运行在 OpenCode 进程内
- **会话恢复**：依赖标题前缀匹配（修改标题的会话可能无法恢复）
- **消息去重**：仅 10 分钟窗口
- **插件生命周期**：由 OpenCode 管理，无独立进程
