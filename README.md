# opencode-feishu

[![npm](https://img.shields.io/npm/v/opencode-feishu)](https://www.npmjs.com/package/opencode-feishu)

[OpenCode](https://opencode.ai) 飞书插件 — 通过飞书 WebSocket 长连接将飞书消息接入 OpenCode AI 对话。

## 快速开始

### 1. 配置 OpenCode 加载插件

在 `~/.config/opencode/opencode.json` 中添加：

```json
{
  "plugin": ["opencode-feishu"]
}
```

> Windows 上 Bun 安装存在 EPERM 权限问题，建议使用项目绝对路径：`"plugin": ["D:/path/to/opencode-feishu"]`

### 2. 创建飞书配置文件

创建 `~/.config/opencode/plugins/feishu.json`：

```json
{
  "appId": "cli_xxxxxxxxxxxx",
  "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

也支持通过环境变量注入敏感值（适合容器部署）：

```json
{
  "appId": "${FEISHU_APP_ID}",
  "appSecret": "${FEISHU_APP_SECRET}"
}
```

`${VAR_NAME}` 占位符会在启动时从 `process.env` 读取，未设置则报错。明文值直接使用。

### 3. 配置飞书应用

在 [飞书开放平台](https://open.feishu.cn/app) 创建自建应用，然后：

1. **添加机器人能力**
2. **事件订阅** — 添加 `im.message.receive_v1` 和 `im.chat.member.bot.added_v1`
3. **订阅方式** — 选择「使用长连接接收事件/回调」（不是 Webhook）
4. **权限** — 开通 `im:message`、`im:message:send_as_bot`、`im:chat`、`im:message:readonly`、`contact:user.base:readonly`
5. **发布应用**

### 4. 启动 OpenCode

```bash
opencode
```

插件自动安装并连接飞书 WebSocket。

## 配置说明

`~/.config/opencode/plugins/feishu.json` 完整配置：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:----:|--------|------|
| `appId` | string | 是 | — | 飞书应用 App ID |
| `appSecret` | string | 是 | — | 飞书应用 App Secret |
| `timeout` | number | 否 | `未设置` | 对话轮询总超时（毫秒）；未配置时不设固定超时，持续等待直到响应稳定、检测到 SSE 错误或请求被中断 |
| `thinkingDelay` | number | 否 | `2500` | 发送"正在思考…"前的延迟（毫秒），设为 0 禁用 |
| `logLevel` | string | 否 | `"info"` | 日志级别：fatal/error/warn/info/debug/trace |
| `maxHistoryMessages` | number | 否 | `200` | 入群时最多摄入的历史消息条数（飞书接口按 50/页分页拉取） |
| `pollInterval` | number | 否 | `1000` | 轮询 AI 响应的间隔（毫秒） |
| `stablePolls` | number | 否 | `3` | 连续几次轮询内容不变视为回复完成 |
| `dedupTtl` | number | 否 | `600000` | 消息去重缓存过期时间（毫秒） |
| `maxResourceSize` | number | 否 | `524288000` | 单个资源最大下载大小（字节，默认 500MB） |
| `directory` | string | 否 | `OpenCode 当前工作目录` | 默认工作目录，支持 `~` 和 `${ENV_VAR}` 展开；若 OpenCode 未提供则为空字符串 |
| `nudge.enabled` | boolean | 否 | `false` | 启用 session.idle 催促；命中条件时向 OpenCode 发送 synthetic prompt，而不是直接向飞书新增可见消息 |
| `nudge.intervalSeconds` | number | 否 | `30` | 同一 session 连续催促的最小间隔（秒） |
| `nudge.maxIterations` | number | 否 | `3` | 同一 session 最大催促次数（用户新消息后重置） |
| `nudge.message` | string | 否 | `"上一步操作已完成。请继续执行下一步，同步当前进度。如果全部完成，给出完整结果和结论。"` | 发送给 OpenCode 的 synthetic prompt 内容 |

## 特性

- **CardKit 2.0 流式卡片** — AI 回复实时显示文本（markdown 渲染）和工具调用进度
- **交互式卡片** — 权限审批和问答通过按钮完成（card.action.trigger 回调）
- **Agent 卡片工具** — `feishu_send_card` tool，AI 自主决定何时使用卡片展示结构化内容
- **运行时 prompt 分层** — `prompt.md` 仅注入飞书渠道事实和工具契约，`SKILL.md` 负责维护与评审，不再用插件侧 skill 主动塑形会话
- **多媒体消息支持** — 图片、文件、音频、富文本（含内嵌图片）、卡片表格等，自动下载转换
- **用户名显示** — 群聊消息自动解析飞书用户名替代 open_id（24h 缓存）
- **消息引用解析** — 解析飞书回复/引用关系，将被引用消息内容作为上下文传给 AI
- **群聊静默监听** — 所有群消息作为上下文积累，仅 @提及时回复
- **FIFO 消息队列** — P2P 和群聊统一串行队列，消息按顺序处理不互相中断
- **入群自动摄入历史消息**
- **session.idle 催促** — 仅在工具调用后停止时，按需向 OpenCode 注入 synthetic prompt 继续执行（可配置）
- **Langfuse 用户关联** — 每条消息 fire-and-forget 发送 trace 到 Langfuse，关联 sessionId 和飞书 userId
- **代理支持** — `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`
- **消息去重** — 可配置 TTL（默认 10 分钟）
- **Zod 配置验证** — 启动时结构化验证 feishu.json，拼写/类型错误立即报出

## 消息行为

| 场景 | 发送到 OpenCode | AI 回复 | 飞书回复 |
|------|:---:|:---:|:---:|
| 单聊 | 是 | 是 | 是（流式卡片） |
| 群聊 + @bot | 是 | 是 | 是（流式卡片） |
| 群聊未 @bot | 是 | 否（静默积累上下文） | 否 |
| bot 入群 | 历史消息 | 否 | 否 |

## 消息类型支持

| 类型 | 处理方式 | AI 看到 |
|------|---------|--------|
| 文本 | 直接提取 | 纯文本（群聊带 `[用户名]:` 前缀） |
| 图片 | 下载 → base64 | `{ type: "file", mime, url }` |
| 富文本 | 文本 + 内嵌图片分别提取 | 交错的 text/file parts |
| 文件 | 下载 → base64 | `{ type: "file", filename, url }` |
| 音频 | 下载 → base64 | `{ type: "file", mime: "audio/opus" }` |
| 卡片 | 递归提取 markdown/table/button | `[卡片消息]\n内容...` |
| 视频 | 不下载 | `[视频消息]` |
| 其他 | 占位文本 | `[不支持的消息类型: xxx]` |

## 开发

```bash
npm install           # 安装依赖
npm run build         # 构建
npm run dev           # 开发模式（监听变更）
npm run typecheck     # 类型检查
npm run release       # 交互式版本发布（bumpp：选版本 → commit → tag → push）
npm publish           # 发布到 npm（自动先构建+类型检查）
npm publish --dry-run # 预览将要发布的内容
```

## 调试

```bash
# 启用调试日志（结构化 JSON 输出到 stderr）
FEISHU_DEBUG=1 opencode

# 过滤错误日志
FEISHU_DEBUG=1 opencode 2>&1 | grep '"level":"error"'

# 重定向到文件
FEISHU_DEBUG=1 opencode 2>feishu-debug.log
```

## 许可证

MIT
