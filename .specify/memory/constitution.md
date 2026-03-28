<!--
Sync Impact Report
==================
- Version change: 2.6.0 → 3.0.0 (MAJOR)
- Modified principles:
  - 四（配置管理）: autoPrompt → nudge 配置
  - 十一（自动提示）→ 十一（session.idle 催促）: 定时循环 → 事件驱动 + skill 指导
  - 十二（发布流程）: 新增"未经允许禁止 commit/push/发布"约束
- Added sections:
  - 十四（变更审批）: 禁止未经允许的 commit/push/发布
- Removed sections: None
- Templates requiring updates: None
- Follow-up TODOs: None
-->

# opencode-feishu 项目约定

## 项目定位

### 一、OpenCode 插件
opencode-feishu 是 OpenCode 的飞书插件，不是独立服务。
- 作为 OpenCode 生态的一部分运行
- 依赖 OpenCode Server 提供核心 AI 能力
- 通过飞书渠道扩展 OpenCode 的用户触达
- npm 包地址：https://www.npmjs.com/package/opencode-feishu

## 核心原则

### 二、测试策略
当前项目不需要单测。
- 专注于功能实现和集成测试
- 通过实际运行验证功能正确性
- 依赖 TypeScript 类型系统保证代码质量

### 三、文档语言
所有文档包括 .specify 目录下的文件尽量用中文编写。
- 提高团队协作效率
- 降低理解门槛
- 保持文档风格一致性
- 包括但不限于：README.md、CLAUDE.md、.specify/ 下的所有文档

## 开发约束

### 四、配置管理
- 必需配置：`appId`、`appSecret`（在 `~/.config/opencode/plugins/feishu.json` 中声明）
- 插件声明：在 `opencode.json` 的 `"plugin"` 字段中列出 `"opencode-feishu"`
- 可选配置：`timeout`、`thinkingDelay`、`logLevel`、`maxHistoryMessages`、
  `pollInterval`、`stablePolls`、`dedupTtl`、`maxResourceSize`、`directory`
- 催促配置：`nudge` 对象（`enabled`、`message`、`intervalSeconds`、`maxIterations`），
  默认关闭。由 session.idle 事件驱动，非定时轮询
- 配置类型：`FeishuPluginConfig`（z.input 推导）描述 JSON 输入，
  `ResolvedConfig`（z.infer 推导）描述运行时类型，两者自动与 Zod schema 同步

### 五、消息处理
- 纯中继模式：所有消息原样转发给 OpenCode
- 不解析命令、不选择模型、不做业务逻辑处理
- 群聊静默监听：未被 @提及时只转发上下文，不触发回复
- P2P 和群聊统一使用 FIFO 串行队列，消息按顺序处理不互相中断

### 六、会话管理
- 会话键格式：`feishu-p2p-<userId>` 或 `feishu-group-<chatId>`
- 会话标题格式：`Feishu-<sessionKey>-<timestamp>`
- TtlMap 1 小时内存缓存，过期后重新查找（按标题前缀匹配）

## 技术标准

### 七、TypeScript 规范
- 严格模式（strict mode）
- ES2022 目标，ESNext 模块
- 使用 tsup 构建，输出 ESM 格式
- 保持类型完整性和类型推导

### 八、日志规范
- JSON 格式输出到 stdout
- 服务标识：`"service": "opencode-feishu"`
- 日志级别：info、warn、error
- 关键事件必须记录：配置加载、健康检查、消息处理、错误异常
- 完整日志：MUST 不截断用户输入、模型输出、异常报错的内容
- 日志仅在 `FEISHU_DEBUG=1` 时输出到 stderr，不影响生产管道

### 九、错误处理
- 严格启动：bot open_id 获取失败直接抛错，阻止插件启动
- 超时保护：默认 120 秒请求超时
- 最佳努力：占位消息更新失败时 fallback 到发送新消息
- 日志静默：`client.app.log()` 失败通过 `.catch(() => {})` 静默处理
- 会话错误架构：L1 错误提取（SSE 事件）→ L2 轮询 SSE 检测 → L3 全局默认模型恢复 → L4 统一错误出口
- 恢复策略：只用全局配置默认模型，不在失败 provider 内搜索替代模型
- 重试安全防护：每 sessionKey 最多重试 2 次，成功后重置
- 错误消息统一出口：chat.ts catch 块负责向用户发送，event.ts 只缓存不发送

### 十、Infrastructure as Code
所有基础设施和配置均以代码形式管理，不做手工一次性操作。
- 配置文件（feishu.json、opencode.json）以声明式 JSON 管理
- 环境搭建步骤文档化并可复现（README 安装教程）
- 依赖版本锁定（package-lock.json / bun.lock）
- 构建和发布流程可通过命令行完成（npm run build / npm publish）

### 十一、session.idle 催促
AI 工具调用后停止时，通过 session.idle 事件按需催促继续，替代旧的定时轮询。
- 事件驱动：监听 OpenCode 的 `session.idle` SSE 事件，非定时循环
- 按需催促：检查最后一条 AI 消息是否以工具调用结尾，是则发送催促消息
- 次数限制：`nudge.maxIterations`（默认 3 次），用户新消息后重置
- 间隔保护：`nudge.intervalSeconds`（默认 30 秒），防止频繁催促
- 消息可配置：`nudge.message` 字段自定义催促内容
- Skill 指导优先：`feishu-card-interaction.md` 的"自主工作模式"指导 AI 主动继续，催促是兜底

### 十二、发布流程
任何代码变更 MUST 先更新 `package.json` 版本号再发布。
- 版本号遵循 semver：feat → minor，fix → patch，breaking → major
- 发布步骤：bump 版本 → commit → tag `v*` → push → GitHub Actions 自动发布
- 推荐使用 `npm run release`（bumpp 交互式选版本 + 自动 git 操作）
- main 分支受保护，所有变更 MUST 通过 PR 合并
- Gemini Code Assist + CodeRabbit 作为 PR 双 reviewer

### 十三、飞书卡片规范
飞书卡片相关开发 MUST 遵循飞书开放平台官方文档。
- 使用 Card 2.0 格式（schema: "2.0"），不使用 Card 1.0 标签
- 内联卡片（im.message.create）直接发送 Card 2.0 JSON，无 wrapper
- 卡片实体引用使用 `{ type: "card", data: { card_id: "..." } }`
- `feishu_send_card` tool 支持 22 种 Card 2.0 组件
- 所有组件 MUST 有空值防护（缺少必要数据时返回空数组而非空字符串）

### 十四、变更审批
**未经用户明确允许，禁止执行以下操作：**
- `git commit` — 不得自行提交代码
- `git push` — 不得自行推送到远端
- `npm publish` / `git tag` — 不得自行发布版本
- `gh pr merge` — 不得自行合并 PR

**允许的操作**（无需额外确认）：
- 代码编辑（Edit/Write）
- `npm run build` / `npm run typecheck` — 构建和类型检查
- `git diff` / `git status` / `git log` — 只读 git 操作
- 创建分支（`git checkout -b`）
- `gh pr create` — 创建 PR（不合并）
- `gh api` — 触发 review bot 或查看评论

**原则**：所有不可逆的共享状态变更（commit/push/merge/publish）MUST 等待用户确认。

## 治理规则

本约定文件优先级高于其他开发实践文档。

所有代码变更和文档修改必须符合本约定。

**版本**: 3.0.0 | **制定日期**: 2026-02-09 | **最后修订**: 2026-03-28
