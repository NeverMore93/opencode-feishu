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
- **所有变更都在当前分支上进行，不要切新分支**
- **当前项目不需要单测** - 专注功能实现和集成测试
- **所有文档包括 .specify 目录下尽量用中文编写**

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

### 安装到 OpenCode（Windows）
```powershell
# 构建
npm run build

# 创建目录链接（junction，不需要管理员权限）
$source = Get-Location
$target = "$env:USERPROFILE\.config\opencode\plugins\opencode-feishu"
New-Item -ItemType Junction -Path $target -Target $source

# 在 opencode.json 中配置
# {
#   "plugin": ["opencode-feishu"],
#   "feishu": {
#     "appId": "cli_xxxxxxxxxxxx",
#     "appSecret": "your_secret"
#   }
# }
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
        └── message.part.updated → 实时更新飞书占位消息
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

**事件处理器 (`src/handler/event.ts`):**
- 处理 `message.part.updated` 实时更新占位消息
- 处理 `session.error` 向用户发送错误消息
- 管理 `pendingBySession` 映射（sessionId → 飞书占位消息）

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

### 在 OpenCode 配置文件中配置
```json
// ~/.config/opencode/opencode.json
{
  "plugin": ["opencode-feishu"],
  "feishu": {
    "appId": "cli_xxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "timeout": 120000,
    "thinkingDelay": 2500,
    "enableStreaming": true,
    "reconnectDelay": 5000,
    "dedupWindow": 600000
  }
}
```

必需字段：`feishu.appId`, `feishu.appSecret`
可选字段均有默认值（见上）。

## 群聊行为

### 静默监听
- 所有群消息都转发到 OpenCode 作为上下文（`noReply: true`）
- Bot 仅在被直接 @提及时回复
- 静默转发：不消耗 AI token，无可见的 bot 活动

### @提及检测
- 需要 bot 的 `open_id`（通过 `/open-apis/bot/v3/info` 获取）
- 获取失败时使用回退模式：任何 @提及都触发回复
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

- `open_id` 获取失败：回退到宽松的 @提及检测（记录警告）
- 提示超时：`timeout` 后返回"⚠️ 响应超时"
- 消息去重：10 分钟窗口防止重复处理
- 飞书消息发送失败：尽力更新占位消息，回退到发送新消息
- 会话错误：通过 `session.error` 事件向飞书发送错误消息
- 所有错误向飞书用户发送友好消息（不静默失败）

## 日志记录

- 通过 `client.app.log()` 输出到 OpenCode 日志系统
- 服务标识："opencode-feishu"
- 级别：info、warn、error
- fallback：OpenCode 日志不可用时降级到 console

## 常见开发场景

### 添加新的消息事件处理器
1. 修改 `src/feishu/gateway.ts` 注册新事件类型
2. 在 `src/handler/` 中添加处理逻辑
3. 在 `src/index.ts` 中连接处理器

### 修改轮询行为
- `src/handler/chat.ts` 中的常量：`POLL_INTERVAL_MS`、`STABLE_POLLS`
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
