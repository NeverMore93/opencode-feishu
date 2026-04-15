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

## 隐性跨文件契约

以下契约不靠类型强保证，修改任一侧必须同步另一侧，否则是静默 bug：

### `mirrorTextToMessage`（chat.ts 写 / event.ts 读）

- CardKit 不可用或 `StreamingCard.start()` 失败时，`chat.ts` 在 `thinkingDelay` 后会发一条纯文本“正在思考…”占位消息。
- 该占位走 `registerPending({ placeholderId, feishuClient, mirrorTextToMessage: true })` 注册到 pending 表。
- `event.ts` 处理 `message.part.updated` 时读该 flag：`true` 直接更新飞书文本消息；否则走 `streamingCard` 卡片更新。
- 改 `chat.ts` 的 fallback 注册逻辑必须同步检查 `event.ts` 的 mirror 分支；反之亦然。该路径无法承载 abort 按钮，是有意的降级代价。

### `expectedMessageId` 首条 SSE 锁（event.ts 内部契约）

- `registerPending` 初始 `expectedMessageId` 为 `undefined`。
- 首个 `message.part.updated` 事件到达时把 `part.messageID` 写入 `expectedMessageId`。
- 之后所有 messageID 不匹配的事件**静默丢弃**，防止同一 session 内多 run 事件串线到当前卡片。
- 依赖：`session-queue.ts` 的 per-sessionKey FIFO 串行保证首个事件属于当前 run。改队列或 pending 生命周期时必须保留“首锁 + 后过滤”语义。
