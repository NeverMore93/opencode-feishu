# AGENTS.md

## Project-Specific Guidelines

opencode-feishu 是 **OpenCode 的飞书插件**（不是独立服务）。它通过飞书 WebSocket 长连接接收消息，原样转发给 OpenCode，并用 CardKit 2.0 流式卡片展示 AI 回复。插件**不解析命令、不选择模型**——只做消息中继和渠道适配。

## 关键约定

- **不需要写单测**——专注功能实现
- **文档用中文**（包括 .specify 目录）
- **任何变更先改版本号**——用 `npm run release`（bumpp 交互式选版本 + commit + tag + push）
- **插件保持透传**——不主动塑形 agent 的内容性输入输出；`prompt.md` 只写最小事实和工具契约，不写输出策略指令
- 详细约定见 `.specify/memory/constitution.md`

## 开发命令

```bash
npm run build        # tsup 构建（ESM，Node 20 target）
npm run dev          # tsup --watch
npm run typecheck    # tsc --noEmit（无 lint 步骤）
npm run release      # bumpp：选版本 → commit → tag → push
```

验证变更：`npm run build && npm run typecheck`（项目无 lint/test 命令）。

推送 `v*` tag 后 GitHub Actions 自动 `npm publish`（需 `NPM_TOKEN` secret）。

## 本地调试

```bash
FEISHU_DEBUG=1 opencode              # stderr 输出结构化 JSON
FEISHU_DEBUG=1 opencode 2>debug.log  # 重定向到文件
```

## 安装到 OpenCode

1. `npm run build`
2. `opencode.json` 中声明插件用**项目绝对路径**（不要用包名，Windows 上 Bun 安装有 EPERM 问题）：
   ```json
   { "plugin": ["D:/path/to/opencode-feishu"] }
   ```
3. 飞书配置 `~/.config/opencode/plugins/feishu.json`：`appId` + `appSecret`（必需）

## 构建配置要点

- **tsup**：ESM only，`splitting: false`，`treeshake: true`
- **external**: `@opencode-ai/plugin`, `@opencode-ai/sdk`, `ws`
- **noExternal**（打入 bundle）: `@larksuiteoapi/node-sdk`, `zod`
- **peer deps**: `@opencode-ai/plugin >=1.1.0`, `@opencode-ai/sdk >=1.0.0`
- 入口 `src/index.ts` 导出命名 `FeishuPlugin: Plugin`

## 源码结构

```
src/
  index.ts              # 插件入口：配置验证、Lark Client 创建、事件钩子注册
  session.ts            # 飞书聊天 → OpenCode session 的稳定映射 + 缓存
  types.ts              # Zod config schema + 共享类型
  handler/              # 会话编排层（不碰飞书 SDK 细节）
    chat.ts             # 核心对话处理：promptAsync → 流式卡片 → 轮询 + classify 唯一调用点
    errors.ts           # 错误分类：PluginError 5 kinds + classify + matchPluginError
    event.ts            # SSE 事件分发 + 错误缓存 + pendingBySession 管理
    error-recovery.ts   # 模型错误自动恢复（消费已分类的 PluginError，上限 2 次）
    session-queue.ts    # per-sessionKey FIFO 串行队列
    action-bus.ts       # per-session 事件订阅/发布
    interactive.ts      # 权限/问答交互卡片 + 按钮回调路由
    reply-run-registry.ts # run 生命周期状态机 + abort 支持
  feishu/               # 飞书渠道适配层（不碰会话编排逻辑）
    gateway.ts          # WebSocket 网关：消息/卡片回调/bot入群事件
    cardkit.ts          # CardKit 2.0 SDK 薄封装
    streaming-card.ts   # 流式卡片生命周期管理
    result-card-view.ts # 结果卡 JSON 模板构建
    sender.ts           # 消息发送/更新/删除
    content-extractor.ts # 飞书消息 → OpenCode PromptPart[] 翻译
    resource.ts         # 文件/图片/音频下载 → data URL
    quote.ts            # 引用消息内容获取
    user-name.ts        # open_id → 用户名（24h TTL 缓存）
    markdown.ts         # HTML 清理 + 28KB 截断
    history.ts          # bot 入群历史摄入
    session-chat-map.ts # sessionId → chatId 映射
    dedup.ts            # 消息去重（默认 10 分钟窗口）
    group-filter.ts     # @提及检测
  tools/
    send-card.ts        # feishu_send_card tool + 统一 DSL→CardKit JSON 翻译
  utils/
    ttl-map.ts          # 带 TTL 自动清理的 Map
prompts/
  feishu-card-interaction/
    prompt.md           # 运行时 prompt（注入飞书会话 system prompt）
```

## 关键跨文件契约（修改任一侧必须同步另一侧）

**`mirrorTextToMessage` flag**（chat.ts ↔ event.ts）：
- CardKit 不可用时 chat.ts 发纯文本占位，注册 `mirrorTextToMessage: true`
- event.ts 根据此 flag 决定走文本更新还是卡片更新路径

**`expectedMessageId` 首条锁**（event.ts 内部）：
- 首个 SSE 事件锁定 messageID，后续不匹配的事件静默丢弃
- 依赖 session-queue 的 FIFO 串行保证首个事件属于当前 run

**`buildCardFromDSL`**（tools/send-card.ts）：
- 同时被 agent tool 和权限/问答交互卡片复用
- `ButtonInput.actionPayload` 有值时直接用作按钮 value（权限/问答），无值时构造 send_message action

## 错误处理分层

| 层 | 位置 | 职责 |
|----|------|------|
| L1 | event.ts | 从 `session.error` 提取错误消息，缓存到 sessionErrors（30s TTL） |
| L2 | chat.ts pollForResponse | 每次轮询检查 SSE 缓存的错误，检测到立即终止 |
| L3 | error-recovery.ts | `classify()` 判定 `ModelUnavailable` 时用全局默认模型重试（每 sessionKey 上限 2 次） |
| L4 | session-queue.ts | per-sessionKey FIFO 防止消息竞态 |
| L5 | event.ts | expectedMessageId 防止事件串扰 |

错误消息统一由 chat.ts catch 块发送给用户（event.ts 不发送，避免双重发送）。

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

### 5. 消息流程

| 场景 | 发送到 OpenCode | 飞书回复 |
|------|:-:|:-:|
| 单聊 | 是 | 是 |
| 群聊 + @bot | 是 | 是 |
| 群聊 + 未@bot | 是（noReply） | 否 |
| Bot 入群（历史摄入） | 是（noReply） | 否 |

完整产品行为契约（用户旅程、错误体验、责任分界、不变量）见 [BEHAVIOR.md](./BEHAVIOR.md)。

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
