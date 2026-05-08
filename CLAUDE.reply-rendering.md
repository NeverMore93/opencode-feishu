# CLAUDE.reply-rendering.md — 主回复渲染管道架构

> 项目架构文档（运行时数据流视图）。基于源码精确反推：从 OpenCode SSE 事件到飞书 CardKit 卡片的完整转换链路。

**文档类型**: 架构文档（运行时 process view）
**最近更新**: 2026-05-08（v1.10.7 baseline 机制注记 + § 1a/§ 3/§ 6 delta 路径标注为已删除）
**适用版本**: v1.10.7+
**范围**: 主回复路径（StreamingCard）；**不覆盖**独立卡片（`feishu_send_card` tool）、form 交互、权限/问答卡片

> ⚠️ **本文档与代码版本对应说明**：
> - § 1a / § 3 中提到的 `message.part.delta` 累积路径已在 v1.10.5 删除（PR #74），主回复仅依赖 `message.part.updated` 全量快照。
> - v1.10.7 新增 baseline 机制：`pollForResponse` 之前抓 baseline 快照，轮询时跳过与 baseline 相同的旧 turn 回复，避免复用 session 时把上一轮文本误当本轮输出。详见 `src/handler/CLAUDE.md` chat.ts 章节。

---

## 1. 文档定位

### 1.1 填补的 gap

项目既有架构文档只有"**静态组件视图**"（哪些文件、谁的职责），缺"**运行时数据流视图**"——一条飞书消息进来后 agent 输出如何 stage by stage 流到飞书 CardKit 卡片。本文档基于源码精确分析填补此 gap。

### 1.2 与现有文档的关系

| 文档 | 视角 | 与本文关系 |
|------|------|------|
| 根 `CLAUDE.md` 架构段 | 静态组件视图 | 互补（结构 vs 流动） |
| `src/feishu/CLAUDE.md` | 单文件职责 | 互补（孤立 vs 协作） |
| `src/handler/CLAUDE.md` | handler 内部契约 | 互补（handler 视角 vs 跨 handler→feishu） |
| `prompts/AUDIT.md § 2.9` | 审计视角 | 互补（合规 vs 工程流程） |
| `docs/fallback-design-rules.md` | 降级原则 | 互补（异常路径 vs 正常路径） |

互补不重叠。

---

## 2. 数据流全景图（字段级）

> 本图将 § 3（Stage 说明）和 § 10（类型参考）的字段级信息集成到一张流程图中。
> 每个节点标注输入/输出类型的关键字段，箭头标注流转的字段名。
> 标注 ✱ 的字段是管道契约（修改需跨文件同步），详见 § 4.2。

```
飞书 WebSocket im.message.receive_v1
  │
  ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  gateway.ts:assembleFeishuContext                                                                                                                                   │
│  输出 → FeishuMessageContext { chatId, messageId, messageType, content, rawContent, chatType:"p2p"|"group", senderId, shouldReply, rootId?, parentId?, createTime? } │
└──────────────────────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                               │
                              ┌────────────────────────────────┴────────────────────────────────┐
                              │ shouldReply=false                                                │ shouldReply=true
                              ▼                                                                  ▼
                 ┌──────────────────────────┐                                     ┌──────────────────────────────────────────┐
                 │  chat.ts:346             │                                     │  session-queue.ts:enqueueMessage()        │
                 │  promptAsync(noReply)    │                                     │  per-sessionKey FIFO 串行                 │
                 │  catch → 仅 log (F54)    │                                     └──────────────────┬───────────────────────┘
                 └──────────────────────────┘                                                        │
                                                                                                     ▼
                                                                                        ┌──────────────────────────────────────────┐
                                                                                        │  chat.ts:handleChat()                     │
                                                                                        │                                           │
                                                                                        │  extractParts(ctx) → PromptPart[]         │
                                                                                        │  ┌─────────────────────────────────────┐  │
                                                                                        │  │ { type:"text", text, metadata? }    │  │
                                                                                        │  │ { type:"file", mime, url, filename?}│  │
                                                                                        │  └─────────────────────────────────────┘  │
                                                                                        │                                           │
                                                                                        │  promptAsync(session, parts)              │
                                                                                        │  pollForResponse()                        │
                                                                                        └─────────┬──────────────────┬──────────────┘
                                                                                                  │                  │
                                                                             SSE 事件流             │                  │  polling snapshot
                                                                             (event.ts)            │                  │  (chat.ts:545)
                                                                                                  │                  │
                              ┌───────────────────────────────────────────────────────────────────┤                  │
                              │                                                                   │                  │
                              ▼                                                                   │                  ▼
┌──────────────────────────────────────────┐                                          ┌───────────────────────────────────────┐
│  event.ts:148                            │                                          │  pollForResponse.onSnapshot             │
│  message.part.delta                      │                                          │  snapshot.text → streamingCard          │
│                                          │                                          │  .replaceText(fullText)                 │
│  part.delta → textBuffer += delta        │                                          │                                       │
│  → emit ProcessedAction                  │                                          │  整段替换（覆盖 delta 累积）             │
│  { type:"text-updated", sessionId,       │                                          │  event.ts:288 注释：有意设计            │
│    delta?, fullText? }                   │                                          └───────────────────────────────────────┘
└──────────────┬───────────────────────────┘
               │
               │  ⚠️ chat.ts:446-449 text-updated case = NO-OP
               │  text 不经 action-bus，走 polling snapshot 路径
               │
               ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  action-bus (event.ts emit → streaming-card.ts + chat.ts subscribe)                                                               │
│                                                                                                                                    │
│  ┌─ tool-state-changed ──────────────────────────────────────┐  ┌─ details-updated ──────────────────────────────────────────┐   │
│  │  { sessionId, callID, tool,                               │  │  { sessionId, phase: DetailPhaseSnapshot {                 │   │
│  │    state:"running"|"completed"|"error" }                  │  │      phaseId, label,                                       │   │
│  │                                                           │  │      status:"running"|"completed"|"error",                 │   │
│  │  → StreamingCard.toolStates.set(callID, {tool, state})    │  │      body, toolSummary?, updatedAt                         │   │
│  └───────────────────────────────────────────────────────────┘  │    }                                                       │   │
│                                                                 │  }                                                         │   │
│                                                                 │  → StreamingCard.detailPhases.set(phaseId, phase)           │   │
│                                                                 └────────────────────────────────────────────────────────────┘   │
│                                                                                                                                    │
│  ┌─ permission-requested ─────────────────────────────────────┐  ┌─ question-requested ──────────────────────────────────────┐   │
│  │  { sessionId, request: PermissionRequest {                 │  │  { sessionId, request: QuestionRequest {                   │   │
│  │      id?, sessionID?,                                      │  │      id?, sessionID?,                                       │   │
│  │      permission?,       ← 权限名称 (如 "bash","write")     │  │      questions?: [{                                         │   │
│  │      patterns?: string[],← 路径模式 (如 ["/src/**"])       │  │          question?,    ← 问题正文                           │   │
│  │      tool?: { messageID?, callID? }                        │  │          header?,      ← 卡片标题                           │   │
│  │    }                                                       │  │          options?: [{ label?, value? }]  ← 可选选项          │   │
│  │  }                                                         │  │        }]                                                   │   │
│  │  → interactive.ts → buildCardFromDSL → 飞书交互卡片         │  │    }                                                       │   │
│  └───────────────────────────────────────────────────────────┘  │  }                                                         │   │
│                                                                 │  → interactive.ts → buildCardFromDSL → 飞书问答卡片          │   │
│                                                                 └────────────────────────────────────────────────────────────┘   │
│                                                                                                                                    │
│  ┌─ session-idle ─────────────┐  ┌─ assistant-meta-updated ──────────────────────────────────────┐                               │
│  │  { sessionId }             │  │  { sessionId, providerID?, modelID?, cost?,                   │                               │
│  │  → nudgeIfToolIdle         │  │    tokens?: Record, time?: { created?, completed? } }         │                               │
│  └────────────────────────────┘  │  → StreamingCard.meta 更新                                    │                               │
│                                  └────────────────────────────────────────────────────────────────┘                               │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

                              ┌──────────────────────────── 200ms debounce ────────────────────────────────┐
                              │  StreamingCard.scheduleReplyRender()                                       │
                              │  clearTimeout(旧) → setTimeout(200ms) → enqueue(renderReply)               │
                              │  串行 Promise 队列：this.queue = this.queue.then(fn).catch(markDegraded)    │
                              └───────────────────────────────────────────────┬─────────────────────────────┘
                                                                              │
                                                                              ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Stage 5: renderReply (streaming-card.ts → result-card-view.ts → markdown.ts)                                                       │
│                                                                                                                                      │
│  输入 → ReplyCardView {                                                                                                              │
│    runId,                                                                                                                            │
│    title,             ← deriveReplyTitleFromParts(parts) 用户消息截首行                                                                │
│    compactStatus,     ← buildCompactStatus(runState) 见下方映射表                                                                     │
│    replyText,         ← this.replyText (agent 文本累积)                                                                               │
│    detailsCollapsed,                                                                                                                 │
│    detailsMarkdown?,  ← 工具步骤折叠面板内容                                                                                          │
│    terminalState?,    ← "completed"|"failed"|"timed_out"|"aborted"                                                                   │
│    actions[],         ← ReplyCardAction { text, style:"primary"|"default"|"danger", disabled?, value:{action:"abort_reply"} }        │
│    fallbackMode,      ← "structured"|"simple"                                                                                        │
│    headerTemplate     ← blue|green|orange|red|purple|grey (见下方映射表)                                                              │
│  }                                                                                                                                   │
│                                                                                                                                      │
│  处理链：                                                                                                                             │
│  buildReplyMarkdown(replyText) → cleanMarkdown() → truncateMarkdown(28*1024 bytes) → dedup vs this.rendered.replyText                │
│  EMPTY_REPLY_PLACEHOLDER = "_⏳ 等待 agent 回复_" (空时占位)                                                                           │
└────────────────────────────────────────────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                                                                 │
                                                                                 ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Stage 6: CardKit API (cardkit.ts)                                                                                                  │
│                                                                                                                                      │
│  → CardKitSchema {                                                                                                                   │
│    data: {                                                                                                                           │
│      schema: "2.0",                                                                                                                  │
│      config: { streaming_mode: true },  ← close 时改为 false                                                                         │
│      header: {                                                                                                                       │
│        title: "用户消息截首行",    ← 创建后不可变（无 element-level 更新 API）                                                          │
│        template: "blue"            ← 颜色编码，创建后不可变                                                                           │
│      },                                                                                                                              │
│      body: {                                                                                                                         │
│        elements: [                                                                                                                   │
│          { element_id: "reply_status",  ... },   ← buildCompactStatus 文案                                                           │
│          { element_id: "reply_text",    ... },   ← agent 文本（主路径 PATCH）                                                         │
│          { element_id: "reply_details", ... },   ← 工具步骤折叠面板（可选，首次 addElement，之后 replaceElement）                       │
│          { element_id: "reply_actions", ... },   ← 中止按钮（可选，首次 addElement，之后 replaceElement）                               │
│        ]                                                                                                                             │
│      }                                                                                                                               │
│    }                                                                                                                                 │
│  }                                                                                                                                   │
│                                                                                                                                      │
│  操作：card.create(card_id) → element.update(PATCH) ×N → card.settings(close)                                                        │
│  sequence: this.seq++ 单调递增，CardKit 服务端按序保证幂等                                                                             │
└────────────────────────────────────────────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                                                                 │
                                                                                 ▼
                                                                     飞书 server 渲染 → 用户看到卡片


═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
映射表
═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

buildCompactStatus (result-card-view.ts:80-101)                 headerTemplate 颜色 (result-card-view.ts:103-119)
┌──────────────────┬──────────────────────────┐                ┌──────────────────────────┬─────────────────┬──────────┐
│ ReplyRunState    │ compactStatus 文案        │                │ ReplyRunState            │ HeaderTemplate  │ 含义     │
├──────────────────┼──────────────────────────┤                ├──────────────────────────┼─────────────────┼──────────┤
│ starting         │ ⏳ 正在建立结果卡          │                │ starting / running       │ blue            │ 进行中   │
│ running          │ ⏳ 正在生成回复            │                │ completing               │ blue            │ 进行中   │
│ completing       │ ✅ 正在收尾               │                │ completed                │ green           │ 成功     │
│ aborting         │ 🛑 正在中断               │                │ failed                   │ red             │ 错误     │
│ completed        │ ✅ 已完成                 │                │ timed_out                │ orange          │ 超时     │
│ aborted          │ ⛔ 已中断                 │                │ aborting                 │ blue            │ 非 terminal（default） │
│ failed           │ ❌ 已失败                 │                │ aborted                  │ orange          │ 中断     │
│ timed_out        │ ⚠️ 已超时                 │                └──────────────────────────┴─────────────────┴──────────┘
└──────────────────┴──────────────────────────┘


═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
降级路径（CardKit 不可用时）
═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

chat.ts:399-412 start() 失败 ──► catch ──► sender.sendTextMessage("正在思考...")
                                                │
                                                ▼
                                    registerPending({ mirrorTextToMessage: true })
                                                │
                    ┌───────────────────────────┴───────────────────────────┐
                    │ event.ts:162-176 (delta)          event.ts:292-307 (updated)
                    │ payload.textBuffer += delta        textBuffer = fullText
                    │ sender.updateMessage(id, text)     sender.updateMessage(id, text)
                    └───────────────────────────────────────────────────────┘
                    绕过 CardKit：无 200ms debounce / 无 markdown 清理 / 无 abort 按钮
```

---

## 3. 各 Stage 详细说明

### Stage 1a：SSE `message.part.delta`（增量累加路径）

| 项 | 值 |
|---|---|
| 位置 | `src/handler/event.ts:148-185` |
| 输入 | `{ type: "message.part.delta", properties: { sessionID, messageID, delta: string } }` |
| 处理 | `matchOrLatchMessageId` 锁 → `payload.textBuffer += delta`（增量拼接，line 160）→ emit `text-updated` 含 delta + fullText |
| 输出 | `ProcessedAction { type: "text-updated", delta, fullText }` 到 action-bus |

### Stage 1b：SSE `message.part.updated`（snapshot 替换 + part.type 路由）

| 项 | 值 |
|---|---|
| 位置 | `src/handler/event.ts:186-193`（入口）→ `handleMessagePartUpdated` (230-318) |
| 输入 | `{ type: "message.part.updated", properties.part: { type: "text"\|"tool"\|"reasoning", text?, sessionID, messageID, callID?, state? } }` |
| part.type 路由 | **text**: `textBuffer = fullText`（**整段替换** line 289，覆盖 delta 累积——event.ts:288 注释明示"快照事件：整段替换 buffer，避免重复拼接"，这是**有意设计不是 bug**）<br>**tool**: emit `tool-state-changed`（不更新 textBuffer）<br>**reasoning**: emit `details-updated`（走折叠面板路径，不更新 textBuffer） |
| 输出 | `text-updated` action（`delta: undefined, fullText: string` snapshot）+ 其他 part.type 专用 action |

**delta vs updated 并存策略**：以最新事件为准，snapshot 直接覆盖，delta 直接累加，无去重协调（event.ts:160 累加 vs :289 覆盖）。

### Stage 2：chat.ts polling 分发（**关键修正：text 不经 action-bus**）

| 项 | 值 |
|---|---|
| 位置 | `src/handler/chat.ts:446-499`（订阅）+ `:501 handleSnapshot` + `:545 onSnapshot` |
| ⚠️ 关键事实 | `chat.ts:446-449` 的 `text-updated` case **是 deliberate no-op `break`**——text 不经 action-bus 进卡片 |
| text 实际路径 | `pollForResponse.onSnapshot`（chat.ts:545, 974-976）→ `handleSnapshot`（chat.ts:501）→ `streamingCard.replaceText(snapshot.text)` |
| action-bus 实际承载 | `details-updated`、`tool-state-changed`、`permission-requested`、`question-requested`、`assistant-meta-updated` |
| 设计原因 | text 通过 polling snapshot 比 SSE 更稳定（聚合多次 part 后取最终态），避免逐 delta 触发 CardKit HTTP 风暴 |

### Stage 3：StreamingCard 累积

| 项 | 值 |
|---|---|
| 位置 | `src/feishu/streaming-card.ts:replaceText (132-137)` / `updateText (122-127)` |
| 输入 | `fullText: string`（snapshot）或 `delta: string` |
| 处理 | `replaceText`: `this.replyText = fullText`<br>`updateText`: `this.replyText += delta`<br>两者都调 `scheduleReplyRender()`（前提：未 closed/degraded/terminal） |
| 输出 | mutated `this.replyText` + 排队 render task |

### Stage 4：200ms debounce + 串行队列

| 项 | 值 |
|---|---|
| 位置 | `src/feishu/streaming-card.ts:scheduleReplyRender (279-287)` + `enqueue (303-310)` |
| 处理 | `scheduleReplyRender`: clearTimeout 旧 timer → 200ms setTimeout → 触发 `enqueue(() => renderReply())`<br>`enqueue`: `this.queue = this.queue.then(fn).catch(markDegraded)`——严格串行 |
| 设计依据 | 流式场景每秒 30-100 次 delta，直接 enqueue 每次都发 CardKit HTTP 请求 → 服务端限流 → degraded。200ms 窗口压到 ~5 次/秒。注释引用 Vercel AI SDK `experimental_throttle(50ms)`，更宽松适配服务端 API |
| `flushReplyTimer` | close 前预触发 timer，确保最新 reply 进入队列 |

### Stage 5：renderReply（buildReplyMarkdown + cleanMarkdown + truncateMarkdown + dedup）

| 项 | 值 |
|---|---|
| 位置 | `streaming-card.ts:renderReply (341-347)` → `result-card-view.ts:buildReplyMarkdown (239-241)` → `markdown.ts:cleanMarkdown (49-66)` + `truncateMarkdown (82-102)` |
| `buildReplyMarkdown` | `normalizeBlockMarkdown(replyText) \|\| EMPTY_REPLY_PLACEHOLDER`<br>EMPTY_REPLY_PLACEHOLDER = `"_⏳ 等待 agent 回复_"`（斜体明示 plugin UI 占位） |
| `cleanMarkdown` | `<br>` → `\n` → `closeCodeBlocks` → `extractCodeBlocks`（保护代码块）→ HTML_TAG_RE 清除 → 二次 `closeCodeBlocks` 兜底 |
| `truncateMarkdown` | 28*1024 字节硬上限 → 预留 `TRUNCATION_SUFFIX_BYTES + CODE_FENCE_BYTES` → 在 lastNewline > 80% effectiveLimit 处切断 → 二次闭合代码块 → 追加 `"\n\n*内容过长，已截断*"` |
| Dedup | `streaming-card.ts:344` 检查 `this.rendered.replyText === content`，相同则 early return（避免无意义 PATCH） |
| **关键约束** | Principle 15：plugin 不贴 `**结论**` 语义标签；空时显式声明 plugin UI 状态 |

### Stage 6：CardKit API 推送

| 子操作 | 位置 | 用途 |
|--------|------|------|
| **6a** updateElement (PATCH) | `cardkit.ts:97-123` | 单元素 content PATCH（流式文本主路径，`reply_text` / `reply_status`） |
| **6b** createCard (首发) | `cardkit.ts:42-89` + `streaming-card.ts:start (102-115)` | 全量 schema 创建实体（仅一次）→ 返回 `card_id` → `sender.sendCardMessage` |
| **6c** replaceElement (PUT) | `cardkit.ts:167-193` | 全量替换组件 schema（`reply_actions` / `reply_details` 整块替换） |
| **6d** addElement | `cardkit.ts:131-160` | 首次出现 details/actions 时追加（支持 `insert_before ACTIONS_ELEMENT_ID`） |
| **6e** deleteElement | `cardkit.ts:231-255` | 元素清空时删除 |
| **6f** closeStreaming | `cardkit.ts:262-279` | 调 `card.settings` 设 `streaming_mode: false`；失败仅日志（内容已渲染） |

**header 不可变约束**：`header.title` 在 `card.create` 时设定后**服务端不再变化**——`streaming-card.ts:setTitle (142-149)` 只更新 `this.meta.title`（用于 simple fallback 文本），**不触发 server PATCH**。`header.template` 同理静态（v1.10.4 当前限制；未来可借 `card.update` 全量替换支持动态切色）。

---

## 4. 关键设计契约

### 4.1 数值常量

| 常量 | 位置 | 值 | 推导依据 |
|------|------|---|------|
| `MAX_CARD_BYTES` | `markdown.ts:16` | 28 * 1024 | 飞书 ~30KB 上限 - 2KB 余量（截断后缀 + 代码块闭合） |
| 截断点 80% 阈值 | `markdown.ts:97` | `effectiveLimit * 0.8` | 仅在 lastNewline > 80% 时切到该处，否则保留原长度（防截断丢内容过多） |
| Debounce 200ms | `streaming-card.ts:279-287` | 200ms | 注释引用 Vercel AI SDK `experimental_throttle(50ms)`，服务端 API 更宽松 |
| `TRUNCATION_SUFFIX_BYTES` | `markdown.ts:22` | 预计算 | `"\n\n*内容过长，已截断*"` UTF-8 字节，避免每次 encode |
| `CODE_FENCE_BYTES` | `markdown.ts:25` | 4 | `"\n```"` length，截断时预留闭合空间 |
| `RUN_CACHE_TTL` | `reply-run-registry.ts:5` | 2h | 覆盖超长对话生命周期 |
| `MAX_RETRY_ATTEMPTS` | `event.ts:87` | 2 | 模型恢复每 sessionKey 上限 |
| `sessionErrors TTL` | `event.ts:82` | 30s | SSE 错误缓存，供 chat.ts polling 路径消费 |

### 4.2 跨文件契约（修改任一侧必须同步另一侧）

| 契约 | 写方 | 读方 | 描述 |
|------|------|------|------|
| `mirrorTextToMessage` flag | `chat.ts:397/425` 写 | `event.ts:54/162/292` 读 | CardKit 失败降级时为 true，event.ts 据此走 `sender.updateMessage` 而非 streamingCard |
| `expectedMessageId` 首条 SSE 锁 | `event.ts:496-498`（声明在 58） | `event.ts:489-502 matchOrLatchMessageId` | 首事件写入，后续不匹配静默丢弃；依赖 session-queue per-sessionKey FIFO 保证首事件归属当前 run |
| `requestMessageIds` 双写 | `chat.ts:371/556/659/718` | `chat.ts:1121-1131/1156-1175 extractAssistantSnapshotForRequests` + `reply-run-registry.ts:90 addRunRequestMessageId` | parentID 匹配本轮 run；run 注册表用于 abort |
| `replyText` / `REPLY_ELEMENT_ID` | `result-card-view.ts:11` | `streaming-card.ts:62/346` | 元素 ID 是 CardKit `updateElement` PATCH 的 path key，必须与 `buildReplyCardSchema` 创建的 element_id 完全一致 |
| `streaming_mode` 开关 | `result-card-view.ts:220` 创建 true | `cardkit.ts:262-279 closeStreaming` 关闭 false | close 失败仅日志，不删卡片 |

### 4.3 状态机不变量（reply-run-registry.ts）

- **8 状态枚举**（行 7-15）：`starting | running | completing | completed | aborting | aborted | failed | timed_out`，4 个 terminal
- **terminalState 冻结**（行 103/126/149/193-194）：`markRunState` 检测 `isTerminalRunState` 立即 return；`archiveRun` 同时写 `state` 和 `terminalState` 锁定（注：163 是 `resetAbortForRun` 的 `cacheRun`，非冻结点）
- **abort 回滚**（行 135 写入/155-165 恢复）：`previousStateBeforeAbort` 在 `requestAbortForRun` 行 135 写入原状态，失败时由 `resetAbortForRun` 恢复（33-34 是 interface 字段声明，非写入点）
- **degraded 单向**（streaming-card.ts:84/312-317）：`markDegraded` 检测 `if (this.degraded) return` 不可逆；UI 停止刷新，内存仍累积，`close()` drain 后抛出供外层降级文本兜底

### 4.4 HTTP/SDK 契约

- **sequence 单调递增**：`streaming-card.ts:57 ++this.seq`，所有 cardkit element 操作都用此值，CardKit 服务端按 sequence 排序保证幂等
- **createCard 仅一次**（streaming-card.ts:103-104）；后续全部走 element-level PATCH/PUT/DELETE
- **header 创建后不可变**（无 element-level 更新 API）；只能用 `card.update` 全量替换实现头部动态切换（当前未使用）

### 4.5 SSE 协议契约

- **delta 增量** vs **updated snapshot**：明确分流，event.ts:288 注释证实是有意设计
- **session.idle 早退条件**：仅在 `pending?.hasActivity === true` 时 emit（event.ts:385-389），防止首事件未到就 idle 退出
- **part type 路由**：`text` 进 textBuffer，`tool` 进 tool-state-changed，`reasoning` 进 details-updated（事件:245-281）

---

## 5. 边界场景

### 5.1 输入异常

| 触发 | 位置 | 用户感知 | agent 感知 |
|------|------|---------|:---:|
| agent 输出空文本 | `result-card-view.ts:240 buildReplyMarkdown` | 显示斜体 `_⏳ 等待 agent 回复_`（明示 plugin UI 占位） | 透明 |
| 仅 HTML 标签 | `markdown.ts:34 HTML_TAG_RE` | 同空文本路径 | 透明 |
| 文本 > 28KB | `markdown.ts:82 truncateMarkdown` | UTF-8 字节截断 + 行边界 + 代码块闭合 + 后缀 `*内容过长，已截断*` | 透明（OpenCode buffer 完整） |
| 未闭合代码块 | `markdown.ts:143 closeCodeBlocks` | 自动追加 ``` 闭合 | 透明 |

### 5.2 时序异常

| 触发 | 位置 | 用户感知 | agent 感知 |
|------|------|---------|:---:|
| `part.updated` 在 `part.delta` 之前 | `event.ts:289` | snapshot 整段替换 buffer（自纠正） | 透明 |
| 同 session 多 run 串扰 | `event.ts:496 expectedMessageId 首条锁` | 不匹配 messageID 的事件**静默丢弃** | 透明 |
| 用户在 poll 期间发新消息 | `event.ts:412 clearNudge` + session-queue FIFO | 当前卡片继续渲染，新消息排队 | 透明 |
| compaction autocontinue | `event.ts:425 nudgeIfToolIdle` | **看不到任何新消息**（不发飞书消息） | **非透明**：agent 收到 `synthetic: true, metadata: { compaction_continue: true }` |

### 5.3 CardKit 失败

| 触发 | 位置 | 用户感知 | agent 感知 |
|------|------|---------|:---:|
| `card.create / start()` 失败 | `chat.ts:399-412 catch` | destroy 卡片 → fallback 发"正在思考..."占位（mirrorTextToMessage=true） | 透明 |
| 中途 `updateElement` 失败 | `streaming-card.ts:303-310 queue.catch → markDegraded` | UI 卡死在最后成功状态（不再刷新，看似"卡住"） | 透明（buffer 仍累积） |
| `close()` 中 `renderAll` 失败 | `streaming-card.ts:227-231` | chat.ts finalizeReply catch → destroy → 简单纯文本兜底 | 透明 |
| `closeStreaming` 失败 | `streaming-card.ts:236-242` | 内容已渲染，仅日志（保留卡片） | 透明 |

### 5.4 用户操作

| 触发 | 位置 | 用户感知 | agent 感知 |
|------|------|---------|:---:|
| 点中止按钮 | `interactive.ts:467-506` → `reply-run-registry.ts:116 requestAbortForRun` | toast `"已接收中断请求"` → state 切 `aborting` (🛑) → v2.session.abort → 终态 `aborted` (⛔ 橙色) + 保留已渲染内容 | OpenCode 收到 abort，agent 停止 |
| v2Client 缺失 | `interactive.ts:491-498` | toast warning + 状态回滚 | 透明 |
| chat.ts catch AbortError | `chat.ts:606-628` | `"已中断，保留当前可见结果。"` + 已累积 latestSnapshot.text | 透明 |
| 重复点中止 | `reply-run-registry.ts:130` | toast `"已收到中断请求，正在停止回答"`（duplicate outcome） | 透明 |

### 5.5 系统错误（PluginError 5 kinds）

| Kind | chat.ts catch 块 | 用户感知 |
|------|---|------|
| `SessionPoisoned` | `chat.ts:639-712` | **L1**: deleteMessage 精准删中毒 msg + 同 session 重发 prompt → 显示正常完成态<br>**L2**: invalidateSession + 卡片 `"⚠️ 会话历史包含不兼容数据，已自动重置。请重新发送消息。"`（**下次开全新空白 session，丢历史**） |
| `ModelUnavailable` | `chat.ts:715-772` + `error-recovery.ts:100` | tryModelRecovery 用全局默认模型重试（max 2 次/sessionKey）；成功显示完成态 / 失败显示 `"❌ <错误>"` |
| `ContextOverflow` | `chat.ts:774-791` | `"⚠️ 对话历史过长。请开始新对话..."` |
| `Unauthorized` | `chat.ts:793-810` | `"⚠️ 模型 provider 认证失败，请联系管理员检查 API key。"` |
| `UnknownUpstream` | `chat.ts:812-837` | `latestSnapshot.text \|\| "❌ <errorMessage>"`（保留已累积部分文本） |

### 5.6 资源限制（**对 agent 非透明**）

| 触发 | 位置 | agent 看到的占位 |
|------|------|------|
| `maxResourceSize` 超限 | `resource.ts:63-68` 流式中断 + `content-extractor.ts:427-431` | `[文件过大: <label>, 已下载 X.XMB 时超出 YMB 限制]` |
| 资源下载错误 | `resource.ts:79-87` + `content-extractor.ts:432` | `[下载失败: <label>]` |
| 视频消息（不下载） | `content-extractor.ts:419-421 extractMediaFallback` | `[视频消息]` |

---

## 6. Fallback 路径（CardKit 不可用时降级）

```
chat.ts:416-440 (CardKit 创建失败的 catch 分支)
  ↓
sender.sendTextMessage("正在思考...") → placeholder text msg
  ↓
registerPending({ ..., mirrorTextToMessage: true })
  ↓
后续 SSE 事件:
  - event.ts:162-176 (delta 路径)
  - event.ts:292-307 (updated 路径)
两者都直接调 sender.updateMessage(placeholderId, textBuffer)
  ↓
绕过 CardKit 完全 — 无 200ms debounce / 无 markdown 清理
直接覆盖飞书纯文本消息
```

**降级代价**：无 abort 按钮（纯文本消息无法承载交互）、无折叠工具步骤、无终态颜色。是有意接受的代价。

---

## 7. 修改本管道时的注意事项

### 7.1 触及任一契约的同步清单

| 触及 | 必须协同改动 |
|------|------|
| `expectedMessageId` 首条锁逻辑 | event.ts ↔ session-queue.ts FIFO 串行假设 |
| `requestMessageIds` 过滤 | chat.ts ↔ reply-run-registry.ts 同名字段 |
| `mirrorTextToMessage` flag | chat.ts 写 ↔ event.ts 读分支 |
| `replyText` / `REPLY_ELEMENT_ID` | streaming-card.ts ↔ result-card-view.ts 同名 |
| `MAX_CARD_BYTES` 阈值 | markdown.ts ↔ prompt.md 文档 ↔ AUDIT.md 元数据 |

### 7.2 添加新 stage 的检查清单

- [ ] 是否需要更新 `prompts/AUDIT.md § 2.9` 注入点清单？
- [ ] 是否触碰 Principle 15 边界（贴语义标签 / 编造内容）？
- [ ] 是否影响 degraded 降级路径？
- [ ] 是否引入新跨文件契约？记入第 4.2 节？
- [ ] 200ms debounce 窗口是否仍合理？

### 7.3 v1.10.4 渲染层重构后的不变量

- 卡片 body 元素结构：`[STATUS, REPLY, DETAILS?, ACTIONS?]`（v1.10.4 确认）
- `header.title` 来源用户消息截首行（创建时定，无服务端动态更新）
- `header.template` 颜色编码 4 状态（创建时定）
- agent 文本不贴 `**结论**` 语义标签
- 空状态显示 `_⏳ 等待 agent 回复_`（plugin 占位，非编造）

---

## 8. agent 透明性边界

**对 agent 非透明的场景**（agent 能感知 plugin 的处理）：
- 资源限制超限 → agent 看到占位文本（`[文件过大: ...]`、`[下载失败: ...]`、`[视频消息]`）
- compaction autocontinue → agent 收到带 `metadata: { compaction_continue: true }` 标记的 synthetic prompt

**对 agent 透明的场景**（agent 不感知）：
- 所有 UI 失败 / 降级 / 错误恢复
- StreamingCard degraded 状态
- 28KB 截断 / HTML 清理 / 代码块闭合
- 终态冻结
- 用户中止操作（agent 仅收到 abort signal）
- 5 类 PluginError 处理

---

## 10. 管道数据类型参考

> 本节列出各 Stage 间传递的精确数据类型（源码类型镜像）。标注 ✱ 的字段是管道契约（修改需跨文件同步），其余为内部实现。
>
> 管道入口类型（PromptPart、FeishuMessageContext）和交互类型（PermissionRequest、QuestionRequest）一并列出，覆盖从"飞书消息进入"到"CardKit 输出"的完整链路。

### 10.1 PromptPart（content-extractor.ts:12-14）

飞书消息 → OpenCode parts 的翻译结果，管道输入：

| 分支 | 字段 | 说明 |
|------|------|------|
| `type: "text"` | ✱ text, metadata? | 文本内容 + 可选元数据 |
| `type: "file"` | ✱ mime, url, filename? | data URL 格式 `data:<mime>;base64,<data>` |

### 10.2 FeishuMessageContext（types.ts:9-35）

gateway.ts 组装的消息上下文，handler 入口：

| 字段 | 类型 | 说明 |
|------|------|------|
| chatId | string | ✱ 飞书 chat_id |
| messageId | string | ✱ 当前消息 ID（去重 key） |
| messageType | string | 飞书原始类型（text/image/post/file 等） |
| content | string | ✱ 已提取可读文本 |
| rawContent | string | 飞书原始 JSON content |
| chatType | "p2p" \| "group" | ✱ 决定是否走群聊逻辑 |
| senderId | string | ✱ 发送者 open_id |
| rootId? | string | 线程根消息 ID |
| parentId? | string | 被引用父消息 ID |
| createTime? | string | 毫秒时间戳字符串 |
| shouldReply | boolean | ✱ false=静默转发上下文，true=触发 AI 回复 |

### 10.3 ProcessedAction（action-bus.ts:17-43）

action-bus 广播的 7 种事件，streaming-card 和 chat.ts 消费：

| type | 字段 | 说明 |
|------|------|------|
| `text-updated` | sessionId, delta?, fullText? | ✱ delta+fullText 均可选；snapshot 时 delta=undefined |
| `tool-state-changed` | sessionId, ✱ callID, ✱ tool, ✱ state | state: "running" \| "completed" \| "error" |
| `details-updated` | sessionId, ✱ phase | phase: DetailPhaseSnapshot（见 10.9） |
| `permission-requested` | sessionId, request | ✱ PermissionRequest（见 10.10） |
| `question-requested` | sessionId, request | ✱ QuestionRequest（见 10.11） |
| `session-idle` | sessionId | 无额外字段 |
| `assistant-meta-updated` | sessionId, providerID?, modelID?, cost?, tokens?, time? | 来源 message.updated 事件 |

### 10.4 StreamingCard 内部状态（streaming-card.ts:51-87）

| 字段 | 类型 | 说明 |
|------|------|------|
| cardId | string? | ✱ CardKit 卡片实体 ID，createCard 后赋值 |
| messageId | string? | ✱ 飞书消息 ID，sendCardMessage 后赋值 |
| seq | number | ✱ 单调递增 sequence，CardKit 幂等保证 |
| queue | Promise\<void\> | 串行 Promise 队列 |
| closed | boolean | 终态锁 |
| replyText | string | ✱ agent 文本累积（Stage 3 核心） |
| runState | ReplyRunState | 当前运行状态（见 10.12） |
| terminalState? | ReplyTerminalState | 终态后冻结 |
| toolStates | Map\<callID, ToolState\> | ✱ callID → {tool, state} |
| detailPhases | Map\<phaseId, DetailPhaseSnapshot\> | ✱ 详细步骤快照 |
| actionsElementPresent | boolean | actions 元素是否已追加 |
| detailsElementPresent | boolean | details 元素是否已追加 |
| rendered | { status, replyText, details, actionsSignature } | ✱ dedup 缓存，避免冗余 PATCH |
| degraded | boolean | ✱ 单向降级标记 |
| degradedError? | Error | 首个触发降级的错误 |
| replyTimer | ReturnType\<typeof setTimeout\> \| null | 200ms debounce timer（source 用 null 非 undefined） |

### 10.5 ReplyCardView（result-card-view.ts:40-51）

Stage 5 渲染的输入（StreamingCard 私有状态 → CardKit JSON 的中间表示）：

| 字段 | 类型 | 说明 |
|------|------|------|
| runId | string | 运行 ID |
| title | string | ✱ header.title 来源（用户消息截首行） |
| compactStatus | string | ✱ buildCompactStatus(state) 映射（见 10.13） |
| replyText | string | ✱ buildReplyMarkdown(replyText) 输入 |
| detailsCollapsed | boolean | 折叠面板默认状态 |
| detailsMarkdown? | string | ✱ 工具步骤 markdown（折叠面板内容） |
| terminalState? | ReplyTerminalState | 终态颜色映射（见 10.14） |
| actions | ReplyCardAction[] | ✱ 按钮数组（含 abort） |
| fallbackMode | "structured" \| "simple" | 降级模式 |
| headerTemplate | HeaderTemplate | ✱ 颜色主题（见 10.14） |

### 10.6 ReplyCardAction（result-card-view.ts:32-38）

actions 数组元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| kind | "abort" | ✱ 动作类型标记 |
| text | string | 按钮显示文本 |
| style | "primary" \| "default" \| "danger" | 按钮样式 |
| disabled? | boolean | 是否禁用 |
| value | AbortActionValue | 按钮 payload（含 action: "abort_reply"） |

### 10.7 CardKitSchema（cardkit.ts:14-27）

Stage 6 的 API payload：

| 字段 | 类型 | 说明 |
|------|------|------|
| data.schema | "2.0" | 固定 Card 2.0 |
| data.config? | Record | ✱ streaming_mode: true（创建时）→ false（close 时） |
| data.header? | Record | ✱ title + template（创建后不可变） |
| data.body.elements[] | Record[] | ✱ 卡片元素数组（body 中间层不可省，cardkit.ts:22-24） |

### 10.8 element-level 操作（cardkit.ts:97-279）

CardKit API 7 种子操作的请求结构：

| 操作 | 关键字段 | 说明 |
|------|---------|------|
| createCard | data: CardKitSchema | 创建实体 → 返回 card_id |
| updateElement (PATCH) | card_id, element_id, content | ✱ 单元素内容更新（流式文本主路径） |
| replaceElement (PUT) | card_id, element_id, data.elements[] | ✱ 全量替换组件 schema |
| patchElement | card_id, element_id, content | 部分更新（cardElement.patch，保留备用，cardkit.ts:200-226） |
| addElement | card_id, data.elements[], target_element_id? | 首次追加 details/actions |
| deleteElement | card_id, element_id | 元素清空时删除 |
| closeStreaming | card_id, settings.streaming_mode=false | 关闭流式模式 |

### 10.9 DetailPhaseSnapshot（types.ts:118-125）

工具调用详细步骤的单阶段快照：

| 字段 | 类型 | 说明 |
|------|------|------|
| phaseId | string | ✱ 阶段唯一 ID（Map key） |
| label | string | 显示标签 |
| status | "running" \| "completed" \| "error" | ✱ 阶段状态 |
| body | string | ✱ markdown 内容（折叠面板正文） |
| toolSummary? | string[] | 工具名称列表 |
| updatedAt | string | ISO 时间戳 |

### 10.10 PermissionRequest（types.ts:132-146）

权限请求事件，通过 action-bus 流入 interactive.ts → 构建权限卡片：

| 字段 | 类型 | 说明 |
|------|------|------|
| id? | string \| number | ✱ 请求唯一 ID（按钮回传 key） |
| sessionID? | string | 关联 session |
| permission? | string | ✱ 权限名称（如 "bash", "write"） |
| patterns? | string[] | ✱ 路径模式列表（如 ["/src/**"]） |
| tool?.messageID? | string | 触发工具的消息 ID |
| tool?.callID? | string | 触发工具的调用 ID |

### 10.11 QuestionRequest（types.ts:151-164）

问答请求事件，通过 action-bus 流入 interactive.ts → 构建问答卡片：

| 字段 | 类型 | 说明 |
|------|------|------|
| id? | string \| number | ✱ 请求唯一 ID（按钮回传 key） |
| sessionID? | string | 关联 session |
| questions? | Array | ✱ 问题数组（当前卡片只消费第一题） |
| questions[].question? | string | ✱ 问题正文 |
| questions[].header? | string | 卡片标题 |
| questions[].options? | Array\<{label?, value?}\> | ✱ 用户可选选项 |
| tool?.messageID? | string | 触发工具的消息 ID |
| tool?.callID? | string | 触发工具的调用 ID |

### 10.12 ReplyRunState / ReplyTerminalState（reply-run-registry.ts:7-17）

```
ReplyRunState     = "starting" | "running" | "completing" | "completed"
                  | "aborting" | "aborted" | "failed" | "timed_out"

ReplyTerminalState = "completed" | "failed" | "timed_out" | "aborted"
```

4 个 terminal 状态：completed / failed / timed_out / aborted。terminalState 一旦写入不可变（§ 4.3）。

### 10.13 buildCompactStatus 映射（result-card-view.ts:80-101）

| ReplyRunState | compactStatus 文案 |
|---|---|
| starting | `⏳ 正在建立结果卡` |
| running | `⏳ 正在生成回复` |
| completing | `✅ 正在收尾` |
| aborting | `🛑 正在中断` |
| completed | `✅ 已完成` |
| aborted | `⛔ 已中断` |
| failed | `❌ 已失败` |
| timed_out | `⚠️ 已超时` |

### 10.14 headerTemplate 颜色映射（result-card-view.ts:103-119）

| ReplyRunState | HeaderTemplate | 含义 |
|---|---|---|
| starting / running / completing | blue | 进行中（default） |
| completed | green | 成功 |
| failed | red | 错误 |
| timed_out / aborted | orange | 超时/中断 |
| aborting | blue | 非 terminal（走 default） |

---

## 11. 管道待改进项（TODO）

> 基于源码分析和 SDK 文档对比发现的响应处理不合理之处。按优先级排序。

> **v1.10.5 状态更新**：T1 / T3 / T7 通过删除整个 `message.part.delta` case 一并解决（PR #74 commit 7b00548）；T9 经审查为误判（streaming-card.ts L333/L394/L436 各 render 路径已独立 dedup）。本节及第 § 2/3/4.5 节中所有 `event.ts:148-185` 行号引用、`message.part.delta` handler 描述、"delta 累加 vs updated 覆盖"对比均为 v1.10.4 历史快照，**不再反映当前代码**。当前 SSE 流程：`message.part.updated → handleMessagePartUpdated → sender.updateMessage`（mirrorTextToMessage=true 兜底）/ `pollForResponse.onSnapshot`（主路径整段替换）。

### P1 潜在 bug

| # | 项 | 现状 | 风险 | 建议修法 |
|---|---|------|------|---------|
| ~~T1~~ | ~~delta `field` 未过滤~~ | **✅ 已修复 (v1.10.5)**：整个 `message.part.delta` case 在 event.ts 已删除（PR #74），reasoning_content 等非 text 字段不再有污染 textBuffer 的路径 | — | — |

### P2 设计改进

| # | 项 | 现状 | 影响 | 建议 |
|---|---|------|------|------|
| T2 | CardKit 失败一次即 degraded，无重试 | streaming-card.ts:303-310 的 `enqueue.catch(markDegraded)` 一次失败永久降级。网络抖动/飞书 API 429 等瞬态错误不应永久放弃 | 用户看到卡片"卡住"（UI 停在最后成功状态），agent 不知道 | enqueue catch 加 1-2 次重试（间隔 500ms），仍失败再 degraded |
| ~~T3~~ | ~~delta 累积在正常路径下是白功~~ | **✅ 已修复 (v1.10.5)**：删除 delta case 后 textBuffer 累积循环不再存在；正常路径走 polling onSnapshot 整段替换，降级路径靠 message.part.updated 兜底 | — | — |
| T4 | 200ms debounce 偏保守 | 注释引用 Vercel AI SDK 的 50ms，但选了 200ms（4 倍）。飞书 CardKit API 限流阈值远高于 5 次/秒 | 用户感知到的"打字速度"被人为压慢 | 实测飞书 API 限流后降到 100-150ms |
| T5 | 两条 text 路径并存，降级反而更实时 | 正常路径：polling snapshot → 200ms debounce → CardKit；降级路径：snapshot → sender.updateMessage（跳过 debounce） | 降级路径比正常路径更快显示文本，违反直觉 | 统一路径或标注设计意图 |

### P3 代码质量

| # | 项 | 现状 | 建议 |
|---|---|------|------|
| T6 | 9 种 Part 类型静默丢弃 | event.ts handleMessagePartUpdated `if (part.type !== "text") return` 丢弃 subtask/file/step-start/step-finish/snapshot/patch/agent/retry/compaction | 当前不影响主回复卡片。若未来需要展示 step 边界或 compaction 事件，需补充处理 |
| ~~T7~~ | ~~`partID` 未使用~~ | **✅ 已修复 (v1.10.5)**：delta case 删除后已无 partID 解构需求；多 part 并行如未来需要，应在 message.part.updated 路径上规划 | — |
| T8 | dedup 检查在 render 阶段而非 enqueue 阶段 | streaming-card.ts:344 的 dedup 在 renderReply 内——此时已过 debounce + enqueue。content 不变时整个周期白做 | 移到 scheduleReplyRender 入口 |
| ~~T9~~ | ~~`rendered` 缓存只检查 replyText~~ | **❌ 误判**：streaming-card.ts L333/L394/L436 各 render 路径独立 dedup，跨字段重复 PATCH 物理上不可能。详见 § 9 修订历史 | — |

---

## 9. 修订历史

| 日期 | 事件 |
|------|------|
| 2026-05-05 | 创建本架构文档（v1.10.4 渲染层重构后）。基于 3 个并行 subagent 源码精确分析（每条数据带文件:行号引用）：Pipeline Stages / Contracts & Constraints / Edge Cases。修正了之前合成版本的 4 处误解：(1) `text-updated` action 是 deliberate no-op，text 走 polling onSnapshot 路径不经 action-bus；(2) SSE `message.part.updated` 覆盖 textBuffer 是有意设计（event.ts:288 注释明示），不是 bug；(3) `setTitle` 服务端不可变（仅更新 meta，不触发 server PATCH）；(4) Stage 1 拆分 1a/1b 才能精确反映 delta 累积 vs snapshot 替换的分流。命名采用 `CLAUDE.<scope>.md` kebab-case，为未来同类架构文档（`CLAUDE.session-lifecycle.md` / `CLAUDE.error-classification.md` 等）预留扩展空间。 |
| 2026-05-06 | (1) § 2 从窄幅流程图替换为**字段级全景图**（v1.10.5）：每个节点标注输入/输出类型的关键字段，箭头标注流转字段名，action-bus 4 种事件并排展示，CardKit 元素结构内联，映射表和降级路径作为独立底部区块；(2) 新增 § 10 管道数据类型参考：覆盖完整链路 14 类数据类型，标注 ✱ 管道契约字段；(3) **4 agent 并行源码校验**发现并修复 15 处 diff：compactStatus 文案 2 处（failed/timed_out）、headerTemplate 颜色 2 处（timed_out→orange, aborting→blue）、StreamingCard 缺 2 字段（detailsElementPresent/rendered）、ReplyCardAction 缺 `kind`、CardKitSchema 嵌套层级修正（`data.body.elements`）、补 patchElement 操作、QuestionRequest 补 `tool?` 字段、行号修正 5 处（buildCompactStatus 80-101、resolveHeaderTemplate 103-119、terminalState 冻结点、previousStateBeforeAbort 写入点、expectedMessageId 写入点）。 |
| 2026-05-07 | **PR #74 (v1.10.5) 后文档维护 + § 11 TODO 清理**：(1) v1.10.5 commit 7b00548 删除整个 `message.part.delta` case（事件、emit、textBuffer 累积全部移除），导致 § 1a / § 2 主图 delta 框 / § 4.5 delta vs updated 对比 / § 6 fallback 双路径图等多处描述失效——本版本在 § 11 顶部加 disclaimer 显式标记这些段落为 v1.10.4 历史快照，TODO T1/T3/T7 标 ✅ 已修复，T9 标 ❌ 误判（CodeRabbit thread 反馈整合）；(2) v1.10.6 PR-A（commit 9a642a5）补修 PR #74 漏扫的 3 个 F21 同构反模式（permission/question/abort toast 完成态 → 进行态），并在 src/handler/CLAUDE.md 加"反模式修复回归原则"指引；(3) **6 agent 并行 fallback 专项审查**完成（reduction-first / drift / checklist / 反模式 / UX 断层 / 阶梯完整性 6 视角）：发现 inventory 自身 4 项重复编号 + 18 项行号偏移 + 3 个未漏扫的 F21 同构反模式（已修） + 多项 UX 断层。详见 PR #74 评论。 |
