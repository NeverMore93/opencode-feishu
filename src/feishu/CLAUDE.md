# CLAUDE.md

## 目录职责

- 本目录负责飞书渠道适配、消息发送、CardKit 结构和网关接入。
- 它是 Feishu/Lark SDK 与插件内部模型之间的适配层和展示层。

## 可以在这里放

- gateway、sender、CardKit 薄封装、结果卡投影、Markdown 清洗、群聊过滤、历史摄入等渠道相关代码。

## 不要在这里放

- 会话级业务编排、恢复策略、run 状态机。
- 为了填满卡片而推断标题、摘要、结论等语义内容。

## 修改约束

- 用户可见卡片中的主内容应来自上游显式内容或稳定快照投影。
- 这里允许存在 UI 壳层文案和渠道协议字段，但不应扩展成内容重写层。

## 文件职责

**gateway.ts** — WebSocket 网关
- 创建 WSClient（WebSocket 长连接），处理 im.message.receive_v1 消息事件并组装 FeishuMessageContext
- 处理 card.action.trigger 卡片回调（权限/问答按钮，3 秒内返回 toast）
- 处理 im.chat.member.bot.added_v1 入群事件，触发历史摄入
- 消息去重（dedup.ts）+ 群消息 @提及过滤（group-filter.ts）+ 代理环境支持

**cardkit.ts** — CardKit 2.0 SDK 薄封装
- 封装 `client.cardkit.v1.card.create()` 创建卡片实体并返回 card_id
- 封装 `client.cardkit.v1.cardElement.content()` 更新卡片元素内容
- 封装 `client.cardkit.v1.card.settings()` 关闭流式模式
- 统一提取 SDK 底层 HTTP 响应体作为错误诊断信息

**streaming-card.ts** — 流式卡片生命周期管理
- 管理单次 AI 回复对应的结构化结果卡（创建 → 更新 → 关闭）
- 维护串行更新队列，保证多次异步更新按顺序执行
- 累积文本、工具状态、详细步骤快照，通过 result-card-view 渲染为 CardKit JSON
- CardKit 更新失败后进入 degraded 状态，UI 不再刷新但仍累积内存数据

**result-card-view.ts** — 结果卡 JSON 模板构建
- 构建 ReplyCardView（标题/紧凑状态/结论/详细步骤/动作区），转换为 CardKit schema
- 从 PromptPart 提炼标题、从 ReplyRunState 推导紧凑状态文案和头部模板颜色
- 构建工具调用详细步骤 markdown（折叠面板）和中止按钮动作元素
- 简单降级模式下生成纯文本兜底内容

**sender.ts** — 飞书消息发送/更新/删除
- 封装 `im.message.create` 统一发送文本消息、交互卡片和 CardKit 卡片
- 封装 `im.message.patch` 更新已有消息内容
- 封装 `im.message.delete` 删除消息（用于 abort 场景销毁占位卡片）
- 所有操作返回统一 `FeishuSendResult` 结构，自动提取 Lark SDK 错误诊断字段

**content-extractor.ts** — 飞书消息 → OpenCode PromptPart 翻译
- 按消息类型（text/image/post/file/audio/sticker 等）分发到专用提取函数
- 将飞书富文本（post）和交互卡片（interactive）解析为纯文本或文件 part
- 下载图片/文件/音频资源并转为 data URL 嵌入 file part
- 对不支持的消息类型生成占位文本（如 `[不支持的消息类型: xxx]`）

**resource.ts** — 飞书资源下载
- 通过 `im.messageResource.get` 流式下载消息中的图片/文件/音频
- 边下载边统计字节大小，超过 `maxResourceSize` 立即中断并返回 `too_large` 结果
- 将下载内容转为 `data:<mime>;base64,<data>` 格式的 data URL
- 根据文件扩展名猜测 MIME 类型（`guessMimeByFilename`）

**quote.ts** — 引用消息内容获取
- 通过 `im.message.get` 读取被引用消息的原始内容
- 将引用消息转换为人类可读的文本描述（复用 content-extractor 的 `describeMessageType`）
- 截断到 500 字符安全长度，防止超长引用撑爆上下文
- 获取失败时静默返回 undefined，不阻断主流程

**user-name.ts** — open_id → 用户名解析
- 通过飞书通讯录 API（`contact.user.get`）将 open_id 解析为真实姓名
- 使用 24 小时 TTL 缓存（TtlMap）避免重复请求
- 解析失败时回退返回原始 open_id，不阻断主流程

**markdown.ts** — HTML 清理 + 28KB 截断
- 移除 AI 输出中的 HTML 标签（保护代码块中的泛型语法如 `Map<string, number>`）
- 确保代码块正确闭合（流式输出可能在代码块中间截断）
- 按 UTF-8 字节截断到 28KB（预留 2KB 给飞书 ~30KB 上限），尽量在完整行处截断
- 截断后追加 `*内容过长，已截断*` 提示后缀

**history.ts** — bot 入群历史摄入
- 通过飞书 `im.message.list` 分页拉取群聊最近消息（每页 50 条，上限由 `maxHistoryMessages` 控制）
- 过滤已删除和空内容消息，将各消息类型转为人类可读文本
- 以 `noReply: true` 格式化注入 OpenCode 会话，仅提供上下文不触发 AI 回复

**session-chat-map.ts** — sessionId → chatId 映射
- 维护 OpenCode sessionId 到飞书 chatId + chatType 的映射关系
- 使用 24 小时 TTL 缓存（TtlMap）自动清理过期条目
- 供 feishu_send_card tool 和最小运行时 prompt 注入判定使用

**dedup.ts** — 消息去重
- 使用 TtlMap 记录已处理的 messageId，默认 10 分钟窗口内自动去重
- 防止飞书 WebSocket 在网络抖动或重连时重复投递同一事件
- 通过 `initDedup(ttl)` 支持启动时自定义去重窗口

**group-filter.ts** — @提及检测
- 遍历飞书消息 mentions 数组，与 bot 自身的 open_id 比较
- 群聊中仅在 bot 被直接 @提及时返回 true，决定是否生成 AI 回复

## 群聊行为

### 静默监听
- 所有群消息都转发到 OpenCode 作为上下文（`noReply: true`）
- Bot 仅在被直接 @提及时回复
- 静默转发：不消耗 AI token，无可见的 bot 活动

### @提及检测
- 需要 bot 的 `open_id`（通过 `/open-apis/bot/v3/info` 获取）
- 获取失败时直接抛出错误，阻止插件启动（严格模式）
- 检测逻辑在 `group-filter.ts`

### 入群历史摄入
- 由 `im.chat.member.bot.added_v1` 事件触发
- 按 `maxHistoryMessages` 拉取最近群消息（飞书接口按 50/页分页）
- 以 `noReply: true` 发送所有消息到 OpenCode（仅上下文）

## 降级语义说明

- `StreamingCard` 任一 CardKit 更新抛错后进入 `degraded` 状态。
- degraded 后本地仍累积文本 / 工具状态到内存，但 **UI 不再刷新** — 用户看起来像“卡住”。
- `close()` 时 drain 队列后抛 degraded 错误，让外层决定是否降级成纯文本尾消息。
- 修改降级逻辑时注意区分“一次失败即降级”（当前语义）和“可容错重试”两种选择；改语义会直接影响用户感知到的稳定性。
