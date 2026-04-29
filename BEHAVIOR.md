# 产品行为逻辑

opencode-feishu 在飞书会话里**会发生什么**、**不会发生什么**——产品视角的单一权威契约。

> 本文档面向产品经理、开发者、AI agent 以及下游用户。
> README.md 讲"如何安装与使用"，本文档讲"用了之后会观察到什么行为"。
> 实现细节见 `src/` 目录的 CLAUDE.md，规格演化见 `specs/`。

---

## 1. 产品形态

opencode-feishu 是 **AI 对话渠道适配器**，不是独立 AI 产品。它把飞书 IM 消息适配给 OpenCode AI agent，把 agent 的流式输出投影为飞书 CardKit 卡片，并承载 abort / 权限审批 / 问答交互。

**核心契约**：
- 所有内容生成由 agent 决定，plugin **不解析 `/` 命令、不选模型、不主动塑形 agent 输出**。
- plugin 负责**渠道承载、展示控制、交互回调**；agent 负责**内容生成、工具调用决策**；用户负责**消息内容、按钮点击、abort**。
- 这是 CLAUDE.md 的"插件尽量透传"原则在产品层的投影。

---

## 2. 责任分界（plugin × agent × 用户）

| 维度 | plugin 决定 | agent 决定 | 用户决定 |
|------|------------|-----------|---------|
| **何时回复** | p2p 直发；group 仅 @ 才回；入群历史 noReply；session-queue FIFO；dedup 10 分钟；session.idle + 末尾 tool part 时 nudge | 接收 prompt 后是否产出 text；是否调工具；何时 idle | 发消息、@ bot、入群、引用回复 |
| **主回复内容** | StreamingCard 实体、轮询 stable polls、markdown 28KB 截断、占位"正在思考…"、5 类错误终态文案 | text part / reasoning part 内容；是否调 `feishu_send_card` 发独立卡片 | 看到结果（无内容控制） |
| **工具决策** | 工具状态投影为详细面板（"等待授权"等 phase label）；`feishu_send_card` 唯一发卡入口；3 按钮固定（once/always/reject） | 是否调用工具、调哪个、入参 | 通过权限/问答交互卡片审批（once/always/reject） |
| **卡片视觉** | header template 颜色（蓝/橙/红）；3 按钮固定；collapse 默认折叠；emoji 前缀（🔐/✅/❌） | `feishu_send_card` 的 sections / template / 按钮文案 | 点击按钮、填表单 |
| **终止运行** | reply-run-registry 状态机；abort 按钮注入主回复卡；3 秒 toast；调 v2Client.session.abort | 接收 AbortError；不能拒绝 abort | 点击卡片"中断"按钮（**唯一**触发路径） |

---

## 3. 用户旅程 4 阶段

| 阶段 | 时间 | 用户感知 | 关键交互 |
|------|------|---------|---------|
| **1. 消息送达** | T=0~0.5s | 飞书消息已发，AI 暂无反应 | 立刻发第二条 → 进 session-queue 串行 |
| **2. 思考占位** | T+0~0.5s | CardKit 可用：卡片立即占位；CardKit 不可用：立即发送"正在思考…"纯文本 | 占位消息由 event.ts 通过 mirrorTextToMessage 持续更新为 AI 回复 |
| **3. 流式输出** | T+3s~N | 卡片实时刷新：文本增量 / 工具调用 / 权限弹窗 / abort 按钮 | 点 abort → state 切到 aborting；点权限按钮 → 转发回 OpenCode；CardKit 失败 → degraded（用户看似卡住） |
| **4. 终态冻结** | T+N~M | 卡片定格，header 颜色变（蓝=完成 / 红=失败 / 黄=中断） + 模型 / 费用 / 耗时 | 用户继续发新消息 → 进新一轮 session-queue |

**用户心智模型 vs 实际行为**：用户预期"发送 → 等待 → 看完整回复"（线性同步感），实际是消息排队 + SSE 订阅 + 卡片渲染 + 错误恢复多管道并行。**一次失败可能触发无声的 session 重建**——下一条消息的 prompt 已是全新空白上下文。

---

## 4. 消息行为矩阵

### 4.1 会话场景

| 场景 | 转给 OpenCode | AI 回复 | 飞书回复 | 备注 |
|------|:---:|:---:|:---:|------|
| 单聊 (p2p) | ✓ | ✓ | ✓（流式卡片） | session-queue 串行 |
| 群聊 + @ bot | ✓ | ✓ | ✓（流式卡片） | 文本前缀 `[用户名]:` 喂给模型，用户看不到 |
| 群聊 + 未 @ bot | ✓ | ✗（静默积累上下文） | ✗ | **完全无可见反应** — `noReply: true` 不入 session-queue |
| Bot 入群（历史摄入） | ✓（聚合 text part） | ✗ | ✗ | **完全无可见反应** — 拉 `maxHistoryMessages` 条 |
| session.idle 催促 | ✓（synthetic prompt） | ✓（agent 继续执行） | ✗（仅驱动 OpenCode） | 仅 idle + 末尾 tool part 时触发，可配置 |

### 4.2 消息类型处理

| 类型 | 处理方式 | AI 看到 |
|------|---------|--------|
| 文本 | 直接提取 | 纯文本（群聊带 `[用户名]:` 前缀） |
| 图片 | 下载 → base64 data URL | `{ type: "file", mime, url }` |
| 富文本（post） | 文本 + 内嵌图片分别提取 | 交错的 text/file parts |
| 文件 | 下载 → base64 | `{ type: "file", filename, url }` |
| 音频 | 下载 → base64 | `{ type: "file", mime: "audio/opus" }` ⚠️ 模型可能不支持 |
| 卡片 | 递归提取 markdown/table/button | `[卡片消息]\n内容...` |
| 视频 | 不下载 | 占位文本 `[视频消息]` |
| 表情包 (sticker) | 不解析语义 | 占位文本 `[表情包]` ⚠️ emoji 含义全丢 |
| 引用 (quote) | 拉被引用消息 → 截 500 字 | 前缀 `[回复消息]: ...\n---\n` |

**资源大小限制**：单个资源 > `maxResourceSize`（默认 500MB）→ 下载中断 → file part 退化为占位文本，**用户不知道资源被拒**（agent 回复"我没看到图"时用户才发现）。

---

## 5. 错误体验地图（5 类 PluginError）

| 错误类型 | 触发场景 | 用户消息文案 | 可恢复性 | 信息密度 |
|---------|---------|------------|---------|---------|
| **Unauthorized** | provider API key 失效/过期 | `⚠️ 模型 provider 认证失败，请联系管理员检查 API key。` | 不自动恢复，需管理员介入 | 偏低（不说哪个 provider） |
| **ContextOverflow** | 上下文累积超出模型 context window | `⚠️ 对话历史过长。请开始新对话（/new 或直接在新会话里发消息）。` | 不自动重置 session，需用户手动开新会话 | 中偏低（`/new` 是 OpenCode 命令而非 plugin 命令，可能误导） |
| **ModelUnavailable** | 模型不存在 / 不可用 | 自动恢复成功 → 用户**无感**；失败 → `❌ <raw error>` | 自动用全局默认模型重试，每 sessionKey 上限 2 次 | 中等（成功完美，失败未提示已重试 X 次） |
| **SessionPoisoned** | 上下文含不兼容 file part / tool schema | `⚠️ 会话历史包含不兼容数据，已自动重置。请重新发送消息。` | 自动重置——下一条消息开**全新空白** session（**不 fork，历史丢失**） | 中等（**未明示历史丢失**——用"重置"暗示） |
| **UnknownUpstream** | 网络 / 5xx / 未知错误兜底 | `❌ <raw error message>` 或最后文本快照 | 不自动恢复 | 偏低（raw error 直接抛给用户；hint 字段 `non-error-throw` 等未透传） |

**错误处理的产品形态**：plugin 在 catch 块统一发用户消息，agent 不参与。所有错误文案都是 **plugin 写死的中文**——这是"反向越界"之一（agent 没机会改写）。

---

## 6. 用户感知的 3 个边角行为

### 6.1 群聊未 @ 时的"静默吞噬"

未 @ 时 `shouldReply=false`，消息以 `noReply:true` 透传给 OpenCode 但**绕过 session-queue**，无打字提示、无任何视觉反馈。失败仅记 stderr 日志，不告知任何人。

**用户疑惑**：在群里讨论复杂问题，几小时后 @ bot 总结，发现 bot **缺了关键消息**——无从得知是消息没送达、模型上下文已截断、还是 bot 忽略了。

### 6.2 Bot 入群历史摄入的不可见性

bot 入群事件 → `ingestGroupHistory` 拉 `maxHistoryMessages` 条历史 → 一条聚合 text part `noReply:true` 注入。**全程零反馈**——bot 入群不发"你好我是 xx"，更不发"我已读过最近 N 条"。

**用户疑惑**：邀请人无法验证摄入是否成功。群成员心理预期模糊：bot 第一次被 @ 时它知道多少？

### 6.3 多卡片并存的视觉混淆

一次回复可能出现 2-3 张卡片：主回复卡 + `feishu_send_card` tool 卡 + 权限/问答审批卡。

**用户疑惑**：
- 不知道哪张是"主答案"
- abort 按钮只在主回复卡上——在 send_card 卡上找停止键会困惑
- 权限/问答卡和主回复卡视觉相似度高，可能误以为审批后主回复就完成了，但**主回复仍在等模型继续**

---

## 7. 透传原则的 4 个反向边界

CLAUDE.md "插件尽量透传"原则下，plugin **主动越界**做的事（合理但需要明示）：

| 越界点 | plugin 做了什么 | 影响 |
|--------|---------------|------|
| `replyTitle` 启发式推导 | 从 prompt parts 自动生成主回复卡标题 | agent 没机会决定主回复卡叫什么 |
| 5 类错误终态文案写死 | 用户看到的错误消息全是中文，agent 不参与 | agent 没机会改写错误措辞 |
| markdown 28KB 静默截断 + HTML 标签剥离 | 长输出被截断追加"*内容过长，已截断*"，HTML 无差别移除（仅保护 code-block 内泛型） | agent 不知道自己输出被改写 |
| nudge synthetic prompt | session.idle + 末尾 tool part 时插"上一步操作已完成。请继续..."给 agent | plugin 主动塑形 agent 输入（已 documented exception） |

---

## 8. 透传不到位的 3 个灰区

plugin 已经透传给 agent，但 agent 实际上**缺信息做对决策**：

| 灰区 | agent 缺什么 |
|------|-----------|
| 群聊上下文区分 | 不知道当前是 p2p 还是 group，是否被 @（`shouldReply` 仅 plugin 内部消费）；群聊静默条目同样进上下文，agent 看到的就是普通 prompt，无法区分"观察学习" vs "要我回" |
| `feishu_send_card` 完整能力契约 | tool description 没说独立卡不能放 abort/permission/question 控制按钮（actionPayload 是内部字段不暴露给 Zod schema）；没说主回复卡是 plugin 自动起的；没说 markdown 28KB 上限 |
| Session 生命周期 | agent 不知道当前 run 的 abort 状态、不知道 session 已被 invalidate（中毒后开**全新空白** session）——新 session 第一条消息 agent **完全不记得**之前 |

---

## 9. 配置项对产品行为的关键影响

完整配置见 README.md，本节仅说明**会改变用户感知**的字段。

| 字段 | 默认 | 影响产品行为 |
|------|------|------------|
| `timeout` | 未设置 | 未配置时不设固定超时；显式配置后超时会展示"⚠️ 响应超时"终态 |
| `dedupTtl` | 600000ms（10 分钟） | 同一 messageId 在窗口内重复投递会被静默忽略；缩小该值 → 飞书 ack 重投可能误处理两次 |
| `maxHistoryMessages` | 200 | bot 入群时摄入历史的上限；增大 → 上下文更全但 OpenCode 接收的首条 prompt 更长 |
| `maxResourceSize` | 500MB | 资源 > 此值会下载中断 + 退化为占位文本，**用户不会被告知** |
| `nudge.enabled` | false | 启用后 session.idle + 末尾 tool part 时 plugin 自发 synthetic prompt 让 agent 继续；用户**看不到这条 prompt**但能看到 agent 继续输出 |
| `nudge.maxIterations` | 3 | 同一 session nudge 上限；超过后停止催促 |

---

## 10. 不变量与约束

**plugin 永远做的事**：
- 同一 messageId 在 `dedupTtl` 窗口内只处理一次（v1.8.1 起 dedup map 跨 plugin re-init 持久）
- p2p 消息总是触发 AI 回复
- 群聊消息总是转给 OpenCode 作为上下文
- 主回复总是流式卡片（CardKit 失败时降级为纯文本占位）
- abort 按钮总是出现在主回复卡（直到 v1.8.x 任何 plan/tasks 修改前）

**plugin 永远不做的事**：
- 不解析 `/` 命令（`/new`、`/reset`、`/help` 等都原样转给 agent）
- 不选择模型 / 代理（OpenCode 自决）
- 不写跨 session 持久化的对话内容
- 不在群聊未 @ 时主动回复
- 不在配置未变更（同一 process 周期内）时重读 `feishu.json`（v1.8.1 起 daemon 标准）

**用户必须知道但容易忽略**：
- 修改 `feishu.json` 后必须**重启 OpenCode 进程**才生效
- 群聊未 @ bot 时消息会进 OpenCode 上下文，**但 plugin 不告诉任何人**
- bot 入群后默默读了最近 N 条历史，**没有可见 ack**
- session 中毒重置后**历史丢失**（用"重置"暗示，非明说）
- 资源 > 500MB 会被静默丢弃

---

## 文档关系

- **本文档（BEHAVIOR.md）**：用户视角下产品会发生什么
- [README.md](./README.md)：如何安装、配置、运行
- [AGENTS.md](./AGENTS.md)：项目自述 + 开发约定（针对 AI agent + 开发者）
- [CLAUDE.md](./CLAUDE.md)：项目级开发规则 + 目录职责（针对 Claude Code 等 AI 工具）
- `src/*/CLAUDE.md`：每个子目录的实现细节边界
- `specs/`：feature 级规格演化（gitignored，本地）

---

**变更历史**：

- 2026-04-27 初版 — v1.8.1 时点（hotfix dedup 幂等已发布；spec 028 完整 lifecycle invariants 待 plan）
