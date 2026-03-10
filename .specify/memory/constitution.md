<!--
Sync Impact Report
==================
- Version change: 2.3.0 → 2.3.1 (PATCH)
- Modified principles: 八（日志规范）— 移除 maskKey 脱敏要求
- Added sections: None
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
  `maxIterations`、`message`），默认关闭

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
- 会话错误三层架构：L1 错误提取（SSE 事件）→ L2 模型不兼容自动恢复（fork + fallback）→ L3 竞态协调（100ms 窗口）
- Fork 安全防护：每 sessionKey 最多 fork 2 次，成功后重置；fork 失败 fallback 到新建 session
- 错误消息统一出口：chat.ts catch 块负责向用户发送，event.ts 只缓存不发送

### 十、Infrastructure as Code
所有基础设施和配置均以代码形式管理，不做手工一次性操作。
- 配置文件（feishu.json、opencode.json）以声明式 JSON 管理
- 环境搭建步骤文档化并可复现（README 安装教程）
- 依赖版本锁定（package-lock.json / bun.lock）
- 构建和发布流程可通过命令行完成（npm run build / npm publish）

### 十一、自动提示
响应完成后自动发送"继续"推动 OpenCode 持续工作，实现主动式交互。
- 完成检测哲学：不做模式匹配或关键词扫描，让 AI 自己判断任务是否完成
- 安全兜底：`maxIterations` 限制防止无限循环
- 用户优先：用户发送新消息时立即中断自动提示循环
- 仅在主动回复模式（shouldReply）下触发，静默监听不触发
- 各会话独立计数，互不干扰

### 十二、发布流程
任何代码变更 MUST 先更新 `package.json` 版本号再发布。
- 版本号遵循 semver：feat → minor，fix → patch，breaking → major
- 发布步骤：bump 版本 → commit → tag `v*` → push → GitHub Actions 自动发布
- 推荐使用 `npm run release`（bumpp 交互式选版本 + 自动 git 操作）
- main 分支受保护，所有变更 MUST 通过 PR 合并（release commit 除外）
- Gemini Code Assist 作为 PR reviewer 自动触发

## 治理规则

本约定文件优先级高于其他开发实践文档。

所有代码变更和文档修改必须符合本约定。

**版本**: 2.3.1 | **制定日期**: 2026-02-09 | **最后修订**: 2026-03-10
