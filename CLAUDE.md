# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 通用编码准则

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

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
- 通过插件 `event` 钩子接收 SSE 事件（message.part.updated、message.part.delta、message.updated、session.error、permission.asked、question.asked、session.idle）

## 项目约定（重要）

### 开发规范
- **当前项目不需要单测** - 专注功能实现和集成测试
- **所有文档包括 .specify 目录下尽量用中文编写**
- **任何变更先改版本号** - 推荐使用 `npm run release` 自动完成版本更新、commit、tag 和 push，然后通过 PR 合并到 main。

### Prompt/Skill 约定
- 插件尽量保持透传，只负责渠道事实、展示控制和交互承载，不主动塑形 agent 的内容性输入输出。
- `skills/<name>/prompt.md` 仅作为插件运行时 prompt 源文件，内容必须限制为最小事实、工具契约、渲染/回调约束和显式 non-goals。
- `skills/<name>/SKILL.md` 是正式技能文档，用于发现、维护、评审和演进，**不得**整份注入飞书会话的 system prompt。
- `prompt.md` **不得**写入"何时发卡""标题/摘要/结论如何组织""按钮如何措辞""发送前自检"这类输出策略指令。
- 当前 skills：`skills/feishu-card-interaction/`（含 `prompt.md` 运行时 system prompt 与 `SKILL.md` 技能文档）。

详细项目约定参见：`.specify/memory/constitution.md`

## Spec 驱动开发

项目使用 `.specify/` 方法学管理需求和设计：

- **`specs/<编号>-<名称>/`** — 每个 feature 的规格资产（spec.md、plan.md、tasks.md、checklists/）
- **`.specify/memory/constitution.md`** — 项目级治理规则（测试策略、文档语言、错误处理分层等）
- **`.specify/templates/`** — spec/plan/tasks 模板
- **工作流**: `/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.checklist` → 实现

## 目录级 CLAUDE.md

- 根目录 `CLAUDE.md` 负责仓库整体规则；子目录下的 `CLAUDE.md` 负责更细的目录职责边界。
- 发生冲突时，离文件更近的 `CLAUDE.md` 优先，但不得违背根目录规则和 `.specify/memory/constitution.md`。
- 缓存、产物、归档、临时 worktree 等目录不作为长期维护边界，不要求补齐目录级职责文档。

## 开发命令

### 构建和开发
```bash
npm install              # 安装依赖
npm run build            # 构建（tsup）
npm run dev              # 监听模式
npm run typecheck        # 仅类型检查
npm run typecheck && npm run build   # 提交前自检（项目无 lint/test）
```

### 发布
```bash
npm run release          # 交互式 bumpp：选版本 → commit → tag → push
npm publish              # 手动发布（prepublishOnly 自动跑 build+typecheck）
npm publish --dry-run    # 预览将发布文件
```

- 推送 `v*` tag 后 GitHub Actions 自动发布到 npm（需 `NPM_TOKEN` secret）

### 本地调试
```bash
FEISHU_DEBUG=1 opencode                               # 启用 stderr JSON 日志
FEISHU_DEBUG=1 opencode 2>&1 | grep '"level":"error"' # 过滤错误日志
FEISHU_DEBUG=1 opencode 2>feishu-debug.log            # 重定向到文件
```

- `FEISHU_DEBUG=1`：启用 console.error 结构化 JSON 输出（不影响 stdout 管道）
- `feishu.json` 中 `logLevel`：控制 Lark SDK 内部日志（`fatal`/`error`/`warn`/`info`/`debug`/`trace`）

### 安装到 OpenCode

1. `npm run build`
2. 在 `~/.config/opencode/opencode.json` 中声明插件（**使用项目绝对路径**，不用包名——Windows 上 Bun 安装有 EPERM 问题）：
   ```json
   { "plugin": ["D:/path/to/opencode-feishu"] }
   ```
3. 创建 `~/.config/opencode/plugins/feishu.json`（完整字段见下方"配置"）

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
        │   └── shouldReply=true → 按 sessionKey 进入统一 FIFO 串行队列
        │       └── handleChat(ctx, deps, signal?)
        │           ├── StreamingCard.start() → 流式卡片（fallback 纯文本占位）
        │           ├── subscribe(action-bus) → text/tool/permission/question 更新卡片
        │           └── promptAsync() → 轮询（session.idle 提前退出）→ card.close()
        ├── im.chat.member.bot.added_v1 → ingestGroupHistory()
        └── card.action.trigger → handleCardAction() → v2Client.permission/question.reply()
                                                        (v2Client = OpenCode v2 SDK client)
    event 钩子 → handleEvent()
        ├── message.part.updated → 全量快照：更新占位消息 + emit text-updated/tool-state-changed
        ├── message.part.delta → 增量 delta：拼接文本增量到 pendingBySession
        ├── message.updated → emit assistant-meta-updated（模型/费用/耗时）
        ├── permission.asked → emit permission-requested（→ 交互卡片）
        ├── question.asked → emit question-requested（→ 交互卡片）
        ├── session.idle → emit session-idle（→ 轮询提前退出）
        └── session.error → 缓存错误 + 模型不兼容时自动恢复会话
```

### 源码结构

```
src/
  index.ts              # 插件入口：配置验证、Lark Client 创建、事件钩子注册
  session.ts            # 飞书聊天 → OpenCode session 的稳定映射 + 缓存
  types.ts              # Zod config schema + 共享类型
  handler/              # 会话编排层（不碰飞书 SDK 细节）
    chat.ts             # 核心对话处理：promptAsync → 流式卡片 → 轮询 + classify 唯一调用点
    errors.ts           # 错误分类：PluginError 5 kinds + classify + matchPluginError
    event.ts            # SSE 事件分发 + 错误缓存 + pendingBySession
    error-recovery.ts   # 模型错误自动恢复（消费已分类的 PluginError）
    session-queue.ts    # per-sessionKey FIFO 串行队列
    action-bus.ts       # per-session 事件订阅/发布
    interactive.ts      # 权限/问答交互卡片 + 按钮回调路由
    reply-run-registry.ts # run 生命周期状态机 + abort 支持
  feishu/               # 飞书渠道适配层（不碰会话编排逻辑）
    gateway.ts cardkit.ts streaming-card.ts result-card-view.ts sender.ts
    content-extractor.ts resource.ts quote.ts user-name.ts markdown.ts
    history.ts session-chat-map.ts dedup.ts group-filter.ts
  tools/
    send-card.ts        # feishu_send_card tool + 统一 DSL→CardKit JSON 翻译
  utils/
    ttl-map.ts          # 带 TTL 自动清理的 Map
skills/
  feishu-card-interaction/
    prompt.md SKILL.md
```

每个子目录的 `CLAUDE.md` 包含该目录下每个文件的关键行为描述。

### 关键跨文件契约（修改任一侧必须同步另一侧）

**`buildCardFromDSL`**（tools/send-card.ts ↔ handler/interactive.ts）——唯一真跨目录契约：
- 同时被 agent tool 和权限/问答交互卡片复用
- `ButtonInput.actionPayload` 有值时直接用作按钮 value（权限/问答），无值时构造 send_message action

handler 内部契约（`mirrorTextToMessage`、`expectedMessageId` 首条锁）详见 `src/handler/CLAUDE.md`。

## 配置

**1. OpenCode 插件声明**（`~/.config/opencode/opencode.json`）：
```json
{ "plugin": ["D:/path/to/opencode-feishu"] }
```

**2. 飞书配置**（`~/.config/opencode/plugins/feishu.json`）：
```json
{
  "appId": "cli_xxxxxxxxxxxx",
  "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

必需字段：`appId`, `appSecret`
可选字段（**source of truth: `src/types.ts` 的 `FeishuConfigSchema`**）：
- `timeout`：对话轮询总超时（毫秒）；默认不设置固定超时。仅在显式配置时，超时后返回 `⚠️ 响应超时`
- `thinkingDelay`：默认 `2500ms`
- `logLevel`：默认 `"info"`，控制 Lark SDK 日志级别
- `maxHistoryMessages`：默认 `200`，最大 `500`；飞书接口按每页 `50` 条分页拉取
- `pollInterval`：默认 `1000ms`
- `stablePolls`：默认 `3`
- `dedupTtl`：默认 `600000ms`
- `maxResourceSize`：默认 `500MB`，最大 `500MB`
- `directory`：默认使用 OpenCode 当前工作目录（`ctx.directory`）；若 OpenCode 未提供则为空字符串；支持 `~` 和 `${ENV_VAR}` 展开
- `nudge.enabled`：默认 `false`
- `nudge.message`：默认"上一步操作已完成。请继续执行下一步，同步当前进度。如果全部完成，给出完整结果和结论。"
- `nudge.intervalSeconds`：默认 `30`
- `nudge.maxIterations`：默认 `3`
- `nudge` 真实行为：仅在 `session.idle` 且最后一条 assistant message 以 `tool` part 结尾时，向 OpenCode 发送 `synthetic prompt`；不会直接向飞书用户新增一条可见消息

## 消息流程变体

| 场景 | 发送到 OpenCode | noReply | 飞书回复 |
|------|:---------------:|:-------:|:--------:|
| 单聊 (P2P) | 是 | 否 | 是 |
| 群聊 + 被 @提及 | 是 | 否 | 是 |
| 群聊 + 未被 @提及 | 是 | **是** | **否** |
| Bot 加入群（历史摄入） | 是 | **是** | **否** |
| session.idle 催促 | 是（synthetic prompt） | 否 | 否（仅驱动 OpenCode 继续执行） |

**群聊行为关键点**（实现细节见 `src/feishu/CLAUDE.md`）：
- @提及检测依赖 bot 的 `open_id`（启动时通过 `/open-apis/bot/v3/info` 获取，失败直接阻止插件启动）
- 历史摄入由 `im.chat.member.bot.added_v1` 入群事件触发，按 `maxHistoryMessages` 分页拉取
- 群聊未被 @提及时仍全量转发给 OpenCode 作为上下文（`noReply: true`），不消耗 AI token

## 错误处理

- `open_id` 获取失败：直接抛出错误，阻止插件启动
- 提示超时：仅在显式配置 `timeout` 时，超时后返回"⚠️ 响应超时"
- 消息去重：按 `dedupTtl` 窗口防止重复处理（默认 10 分钟）
- 飞书消息发送失败：尽力更新占位消息，回退到发送新消息
- 所有错误向飞书用户发送友好消息（不静默失败）

### 会话错误处理（五层架构）

| 层 | 位置 | 职责 |
|----|------|------|
| L1 | event.ts | 从 `session.error` 提取错误消息 + raw error，缓存到 sessionErrors（30s TTL） |
| L2 | chat.ts pollForResponse | 每次轮询检查 SSE 缓存的错误，检测到立即终止 |
| L3 | error-recovery.ts | `classify()` 判定 `ModelUnavailable` 时用全局默认模型重试（每 sessionKey 上限 2 次） |
| L4 | session-queue.ts | per-sessionKey FIFO 防止消息竞态 |
| L5 | event.ts | `expectedMessageId` 首条锁防止事件串扰 |

各层实现细节参见 `src/handler/CLAUDE.md`。

## 重要约束

- **不解析命令**：Bot 将所有消息（包括 `/commands`）原样转发给 OpenCode
- **不选择模型/代理**：OpenCode 决定模型和代理路由
- **不使用公网 webhook**：仅使用飞书 WebSocket 长连接
- **单一 OpenCode 实例**：作为插件运行在 OpenCode 进程内
- **会话恢复**：依赖标题前缀匹配（修改标题的会话可能无法恢复）
- **消息去重**：按 `dedupTtl` 窗口处理，默认 10 分钟
- **插件生命周期**：由 OpenCode 管理，无独立进程
- **会话中毒恢复**：检测到结构性错误（如不兼容的 file part、tool schema）时调用 `client.session.create()` 开一条**全新空白** session（**不是 fork**，**不保留历史对话**）；旧 session 在 OpenCode server 上仍存在但插件不再引用。用户需重新发送消息，上下文丢失是此策略的有意代价——fork 会复制中毒历史导致死循环。
