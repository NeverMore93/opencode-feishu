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
- 通过插件 `event` 钩子接收 `message.part.updated` 事件实时更新占位消息

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
    ├── config 钩子 → 读取 opencode.json 中的 feishu 配置
    │   ├── fetchBotOpenId() → 获取 bot open_id
    │   └── startFeishuGateway() → 启动 WebSocket 长连接
    │       ├── im.message.receive_v1 → handleChat()
    │       │   ├── 静默监听: client.session.prompt({ noReply: true })
    │       │   └── 主动回复: client.session.prompt() → 轮询 → sender
    │       └── im.chat.member.bot.added_v1 → ingestGroupHistory()
    └── event 钩子 → handleEvent()
        ├── message.part.updated → 实时更新飞书占位消息
        └── session.error → 缓存错误 + 模型不兼容时自动恢复会话
```

### 核心模块

**插件入口 (`src/index.ts`):**
- 导出 `FeishuPlugin: Plugin`（命名导出）
- `config` 钩子：从 `opencode.json` 的 `feishu` 字段读取配置，初始化飞书网关
- `event` 钩子：接收 OpenCode 事件，处理 `message.part.updated` 和 `session.error`
- 使用 `client.app.log()` 记录结构化日志

**飞书网关 (`src/feishu/gateway.ts`):**
- 使用 `@larksuiteoapi/node-sdk` 建立 WebSocket 连接
- 处理 `im.message.receive_v1` 事件
- 消息去重（10 分钟窗口，通过 `dedup.ts`）
- 群消息 @提及过滤（通过 `group-filter.ts`）
- 处理 `im.chat.member.bot.added_v1` 用于历史摄入

**对话处理器 (`src/handler/chat.ts`):**
- 直接使用 `client.session.list()/create()/prompt()/messages()` 管理会话
- 会话键格式：`feishu-p2p-<userId>` 或 `feishu-group-<chatId>`
- 会话标题格式：`Feishu-<sessionKey>-<timestamp>`
- 静默监听模式：`noReply: true`
- 主动回复模式：占位消息 → 轮询 → 最终回复
- 自动提示模式：响应完成后循环发送"继续" → 轮询 → 回复，直到 maxIterations 或用户中断

**事件处理器 (`src/handler/event.ts`):**
- 处理 `message.part.updated` 实时更新占位消息
- 处理 `session.error`：提取错误消息、缓存到 `sessionErrors` Map
- 管理 `pendingBySession` 映射（sessionId → 飞书占位消息）
- 管理 `retryAttempts` 计数器（防止无限重试循环，上限 2 次）
- 管理 `sessionErrors` 映射（30s TTL，供 chat.ts 消费真实错误）

**历史摄入 (`src/feishu/history.ts`):**
- 通过飞书 API 获取最近 50 条群消息
- 以 `noReply: true` 发送到 OpenCode（仅上下文）

**消息发送器 (`src/feishu/sender.ts`):**
- 通过飞书 API 发送、更新和删除消息

**辅助模块：**
- `src/feishu/dedup.ts` - 10 分钟消息去重窗口
- `src/feishu/group-filter.ts` - @提及检测
- `src/types.ts` - 类型定义（FeishuMessageContext, ResolvedConfig, LogFn）

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
自动提示：`autoPrompt` 对象 — `enabled`（默认 false）、`intervalSeconds`（默认 30）、`maxIterations`（默认 10）、`message`（默认 "请同步当前进度，如需帮助请说明"）

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
| 自动提示循环 | 是（"继续"） | 否 | 是（每次响应） |

## TypeScript 配置

- **目标**: ES2022
- **模块**: ESNext + Bundler 解析
- **构建工具**: tsup（ESM 输出，Node 20 目标）
- **严格模式**: 启用
- **输出**: `dist/` 目录，包含声明文件和源映射
- **入口**: 库模式（无 shebang），导出 `FeishuPlugin`

## 依赖项

**运行时:**
- `@larksuiteoapi/node-sdk`: 飞书 WebSocket 网关和 API 客户端

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
- 提取优先级：`e.message` → `data.message` → `e.type` → `e.name` → 兜底文案
- SDK `UnknownError` 类型的 `data.message` 是 required 字段，存放原始错误名

**L2 模型不兼容自动恢复**（chat.ts）：检测 `ModelNotFound`/`ProviderModelNotFound` 错误时在同一 session 上重试
- `resolveLatestModel()`：从错误消息提取失败的 `providerID/modelID`，遍历所有已连接 provider（`data.connected`），排除失败模型，返回可用模型或 undefined
- 恢复策略：在同一 session 上用 per-request model override 重试 prompt（session 未损坏，model 是 per-request），不 fork、不创建新 session
- 重试计数器：每 sessionKey 最多重试 2 次，防止无限循环；成功后重置计数
- 当无任何已连接 provider 有可用模型时，直接向用户显示错误，不重试

**L3 竞态协调**（chat.ts）：prompt() HTTP 响应和 SSE session.error 并行到达
- catch 块等待 100ms（`SSE_RACE_WAIT_MS`）让 SSE 事件先到达
- 优先使用 `getSessionError()` 缓存的真实错误，而非 prompt() 抛出的 JSON 解析错误
- 错误消息统一由 chat.ts catch 块发送给用户（event.ts 不发送，避免双重发送）

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
