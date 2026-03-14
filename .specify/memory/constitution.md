<!--
Sync Impact Report
==================
- Version change: 2.5.0 → 2.6.0 (MINOR)
- Modified principles: None
- Added sections: 十三（飞书卡片规范）— 引用官方 CardKit API 文档
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
  `pollInterval`、`stablePolls`、`dedupTtl`、`directory`
- 自动提示配置：`autoPrompt` 对象（`enabled`、`intervalSeconds`、
  `maxIterations`、`message`、`idleThreshold`、`idleMaxLength`），默认关闭

### 五、消息处理
- 纯中继模式：所有消息原样转发给 OpenCode
- 不解析命令、不选择模型、不做业务逻辑处理
- 群聊静默监听：未被 @提及时只转发上下文，不触发回复

### 六、会话管理
- 会话键格式：`feishu-p2p-<userId>` 或 `feishu-group-<chatId>`
- 会话标题格式：`Feishu-<sessionKey>-<timestamp>`
- 24 小时内存缓存，支持进程重启后按标题前缀恢复

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
- 会话错误四层架构：L1 错误提取（SSE 事件）→ L2 轮询 SSE 检测（pollForResponse 每次 poll 检查 sessionError）→ L3 全局默认模型恢复（`client.config.get()` 读取 Config.model）→ L4 竞态协调（SessionErrorDetected 或 100ms 窗口）
- 轮询 SSE 错误检测：`pollForResponse()` 每次 poll 周期检查 `getSessionError()`，检测到错误时抛出 `SessionErrorDetected` 异常立即终止（~1 秒而非 120 秒超时）
- 恢复策略：只用全局配置默认模型（`Config.model`，如 `aigw/claude-opus-4-6-v1`），不在失败 provider 内搜索替代模型
- 重试安全防护：每 sessionKey 最多重试 2 次，成功后重置；全局默认模型未配置时直接显示错误
- 错误消息统一出口：chat.ts catch 块负责向用户发送，event.ts 只缓存不发送

### 十、Infrastructure as Code
所有基础设施和配置均以代码形式管理，不做手工一次性操作。
- 配置文件（feishu.json、opencode.json）以声明式 JSON 管理
- 环境搭建步骤文档化并可复现（README 安装教程）
- 依赖版本锁定（package-lock.json / bun.lock）
- 构建和发布流程可通过命令行完成（npm run build / npm publish）

### 十一、自动提示
响应完成后自动发送"继续"推动 OpenCode 持续工作，实现主动式交互。
- 空闲检测：通过简单的文本长度 + 关键词匹配（`isIdleResponse`）识别空闲响应，
  连续空闲次数达到 `idleThreshold` 时自动退出循环
- 安全兜底：`maxIterations` 限制防止无限循环
- 用户优先：用户发送新消息时立即中断自动提示循环（P2P 通过 abort，群聊通过队列检查）
- 仅在主动回复模式（shouldReply）下触发，静默监听不触发
- 各会话独立计数，互不干扰

### 十二、发布流程
任何代码变更 MUST 先更新 `package.json` 版本号再发布。
- 版本号遵循 semver：feat → minor，fix → patch，breaking → major
- 发布步骤：bump 版本 → commit → tag `v*` → push → GitHub Actions 自动发布
- 推荐使用 `npm run release`（bumpp 交互式选版本 + 自动 git 操作）
- main 分支受保护，所有变更 MUST 通过 PR 合并（release commit 除外）
- Gemini Code Assist 作为 PR reviewer 自动触发

### 十三、飞书卡片规范
飞书卡片相关开发 MUST 遵循飞书开放平台官方文档。
- CardKit 2.0 创建卡片 API：https://open.larkenterprise.com/document/cardkit-v1/card/create?appId=cli_a90943a30978dbcb
- API 参数（如 `type` 字段的合法值 `card_json` / `template`）以官方文档为准，
  不得使用未文档化的值
- 卡片 JSON schema、元素更新、流式模式等均参照 CardKit 2.0 官方指南
- 发送消息时的 `msg_type` / content `type` 与创建卡片 API 的 `type` 含义不同，
  MUST 区分使用场景

## 治理规则

本约定文件优先级高于其他开发实践文档。

所有代码变更和文档修改必须符合本约定。

**版本**: 2.6.0 | **制定日期**: 2026-02-09 | **最后修订**: 2026-03-12
