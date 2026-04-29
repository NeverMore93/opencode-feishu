# CLAUDE.md

## 目录职责

- 本目录负责 OpenCode 会话、事件、交互和 run 生命周期编排。
- 它连接输入、队列、SSE 事件、abort、终态冻结和错误收口。

## 可以在这里放

- chat、event、interactive、action-bus、session-queue、reply-run-registry 等编排代码。

## 不要在这里放

- Feishu SDK 细节封装；那类代码进入 `src/feishu/`。
- 通过 synthetic 输入或启发式补写去代替 agent 生成主回复内容。

## 修改约束

- 对输入的增强仅限明确记录的最小必要上下文增强。
- 对输出的加工仅限状态控制、终态冻结和展示投影，不应发展为语义总结器。

## 文件职责

**chat.ts** — 核心对话处理器
- `handleChat()` 完整走完一条飞书消息：绑定 session → 构造 prompt → `promptAsync()` 异步发送 → 轮询等待输出稳定 → 写回飞书
- 启动 StreamingCard（CardKit 不可用时降级为纯文本占位），通过 action-bus 订阅 text-updated / tool-state-changed / permission / question 事件实时更新卡片
- 轮询期间每轮检查 SSE 缓存错误，检测到 `SessionErrorDetected` 立即终止
- catch 块是 `classify()` 的**唯一调用点**（FR-011）：通过 `matchPluginError` exhaustive handler 分发到具体错误处理路径

**event.ts** — SSE 事件分发与状态缓存
- `handleEvent()` 接收 OpenCode 事件，按类型分发：`message.part.updated` 更新占位消息或卡片，`permission.asked` / `question.asked` / `session.idle` 转发到 action-bus
- 维护 `pendingBySession` 映射（sessionId → 占位消息上下文），管理 `expectedMessageId` 首条 SSE 锁防止事件串线
- 缓存 `sessionErrors`（30s TTL，含 raw error 对象）和 `retryAttempts` 计数器，供 chat.ts 和 error-recovery.ts 消费

**session-queue.ts** — per-sessionKey FIFO 串行队列
- 按 sessionKey 归并消息，同一逻辑会话内严格串行消费，防止占位消息/流式卡片并发覆盖
- `enqueueMessage()` 是唯一入口；`shouldReply=false` 的静默消息直接透传，不占用队列
- 队列空闲时自动回收状态对象，避免长时间运行后空壳条目积累

**action-bus.ts** — per-session 轻量事件总线
- `subscribe(sessionId, cb)` 注册订阅，返回幂等的 unsubscribe 函数；最后一个订阅者移除后清理空集合
- `emit(sessionId, action)` fire-and-forget 广播，单个订阅者抛错不阻塞其他订阅者也不打断主流程
- `ProcessedAction` 联合类型覆盖 7 种事件：text-updated、details-updated、tool-state-changed、permission-requested、question-requested、session-idle、assistant-meta-updated

**interactive.ts** — 权限/问答交互卡片与按钮回调
- `handlePermissionRequested()` / `handleQuestionRequested()` 使用 `buildCardFromDSL` 构建交互卡片并发送到飞书，`seenIds` TtlMap 防止重复发送
- `handleCardAction()` 解析卡片按钮回调 value → 路由到 v2Client 的 permission / question / abort reply
- `buildCallbackResponse()` 返回 toast 即时反馈（飞书 3 秒约束），abort 按钮通过 reply-run-registry 管理取消流程

**errors.ts** — 错误分类（typed discriminated union）
- `classify(raw): PluginError` 纯函数，按优先级链判定：Auth → Context → Model → Poison → fallback
- `matchPluginError(err, handlers)` exhaustive matcher，漏 kind 直接编译报错
- `toLog(err)` 安全日志 payload，不暴露 raw（防 secrets 泄漏）
- `PluginErrorThrown` nominal wrapper，仅 throw/catch 边界使用
- 类型：`PluginError`（5 kinds）、`Evidence[]`、`RuleName`、`FieldPath`

**error-recovery.ts** — 模型错误自动恢复
- `tryModelRecovery()` 接收已分类的 `PluginError & { kind: "ModelUnavailable" }`，用全局默认模型自动重试（每 sessionKey 上限 2 次，成功后重置计数）
- `SessionErrorDetected` 专用异常类，使轮询期间发现的 SSE 错误与普通异常可区分
- `extractSessionError()` 从异常或 SSE 缓存中提取结构化错误，取到后立即清理缓存避免污染下一轮调用

**reply-run-registry.ts** — run 生命周期状态机与 abort 支持
- 管理 `ActiveReplyRun` 对象的创建、状态流转（starting → running → completing → completed/failed/timed_out/aborted）和 TTL 自动清理
- 通过 `activeBySessionKey` / `runsByRunId` / `runsBySessionId` 三张 TtlMap 提供多维度查找
- `requestAbortForRun()` 设置 abort 请求并切换状态到 aborting，`confirmAbortForRun()` / `resetAbortForRun()` 处理确认和回滚
- 每个 run 持有独立的 `AbortController`，`getRunAbortSignal()` 供轮询等可取消路径消费

## 会话错误处理（五层架构）

| 层 | 位置 | 职责 |
|----|------|------|
| L1 | event.ts | 从 `session.error` 提取错误消息 + raw error，缓存到 sessionErrors（30s TTL） |
| L2 | chat.ts pollForResponse | 每次轮询检查 SSE 缓存的错误，检测到立即终止 |
| L3 | error-recovery.ts | `classify()` 判定 `ModelUnavailable` 时用全局默认模型重试（每 sessionKey 上限 2 次） |
| L4 | session-queue.ts | per-sessionKey FIFO 防止消息竞态 |
| L5 | event.ts | expectedMessageId 防止事件串扰 |

错误消息统一由 chat.ts catch 块发送给用户（event.ts 不发送，避免双重发送）。

**Phase 0 临时日志**：`session.error.raw-shape` 记录完整 error 形状（name、keys、data.message），用于 spec 027 真实样本采集。此日志在 027 主 PR 合入后删除。

**L1** event.ts 缓存 raw error 对象 + 提取消息字符串。`classify()` 在 chat.ts catch 块中消费 raw error，按优先级链判定 kind。

**L2** `pollForResponse()` 每次轮询检查 SSE 缓存错误，检测到立即终止（~1s 内）。

**错误分类规则优先级**（`errors.ts` classify 链）：

| 优先级 | 规则函数 | 命中条件 | 证据强度 |
|-------|---------|---------|---------|
| 1 | `tryUnauthorized` | `raw.name === "ProviderAuthError"` | ⭐⭐⭐ 强 |
| 2 | `tryContextOverflow` | `raw.name === "ContextOverflowError"` | ⭐⭐⭐ 强 |
| 3 | `tryModelUnavailable` | `raw.name === "ProviderModelNotFoundError"` OR `UnknownError` + pattern | ⭐⭐ 中 |
| 4 | `trySessionPoisoned` | `raw.name` ∈ 白名单 AND `data.message` matches pattern（two-factor） | ⭐ 弱 |
| ∞ | fallback | 其余 → `UnknownUpstream` | — |

**中毒恢复**：`classify()` 判定 `SessionPoisoned` 后，chat.ts 调 `invalidateSession(sessionKey)`——仅清本地缓存 + 置 `forceCreateSession` 标记；下一条用户消息触发 `client.session.create()` 开**全新空白** session（**不 fork，不保留历史**）。旧 session 在 server 上仍存在但插件不再引用。历史记录丢失是有意权衡：fork 会复制中毒历史导致死循环。

**L3 模型恢复**：`tryModelRecovery()` 接收已分类的 `PluginError & { kind: "ModelUnavailable" }`，用 `getGlobalDefaultModel()` 读 `Config.model` 做重试（每 sessionKey 最多 `MAX_RETRY_ATTEMPTS=2` 次）。注意：**继续用原 session**，不换 session——这和中毒恢复是两条独立路径。**不 re-classify**（FR-011）。

**L4** per-sessionKey FIFO 串行排队，静默消息绕过队列。

**L5** `expectedMessageId` 首条锁，后续不匹配事件静默丢弃。

### 如何扩展错误类型

1. 在 `errors.ts` 加新 kind 到 `PluginError` union
2. 在 `errors.ts` 加对应 try* 规则函数，插入 `classify` 优先级链的正确位置
3. 跑 `npm run typecheck`，按编译错误逐个补齐 consumer 的 matchPluginError handlers
4. 加 `RuleName` / `FieldPath` 新成员（如需要）
5. 更新本文件的规则优先级表

## 隐性跨文件契约

以下契约不靠类型强保证，修改任一侧必须同步另一侧，否则是静默 bug：

### `mirrorTextToMessage`（chat.ts 写 / event.ts 读）

- CardKit 不可用或 `StreamingCard.start()` 失败时，`chat.ts` 立即发一条纯文本”正在思考…”占位消息。
- 该占位走 `registerPending({ placeholderId, feishuClient, mirrorTextToMessage: true })` 注册到 pending 表。
- `event.ts` 处理 `message.part.updated` 时读该 flag：`true` 直接更新飞书文本消息；否则走 `streamingCard` 卡片更新。
- 改 `chat.ts` 的 fallback 注册逻辑必须同步检查 `event.ts` 的 mirror 分支；反之亦然。该路径无法承载 abort 按钮，是有意的降级代价。

### `expectedMessageId` 首条 SSE 锁（event.ts 内部契约）

- `registerPending` 初始 `expectedMessageId` 为 `undefined`。
- 首个 `message.part.updated` 事件到达时把 `part.messageID` 写入 `expectedMessageId`。
- 之后所有 messageID 不匹配的事件**静默丢弃**，防止同一 session 内多 run 事件串线到当前卡片。
- 依赖：`session-queue.ts` 的 per-sessionKey FIFO 串行保证首个事件属于当前 run。改队列或 pending 生命周期时必须保留“首锁 + 后过滤”语义。
