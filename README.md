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
4. **权限** — 开通 `im:message`、`im:message:send_as_bot`、`im:chat`、`im:message:readonly`
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
| `timeout` | number | 否 | `120000` | AI 响应超时（毫秒） |
| `thinkingDelay` | number | 否 | `2500` | 发送"正在思考…"前的延迟（毫秒），设为 0 禁用 |
| `logLevel` | string | 否 | `"info"` | 日志级别：fatal/error/warn/info/debug/trace |
| `maxHistoryMessages` | number | 否 | `200` | 入群时拉取历史消息的最大条数 |
| `pollInterval` | number | 否 | `1000` | 轮询 AI 响应的间隔（毫秒） |
| `stablePolls` | number | 否 | `3` | 连续几次轮询内容不变视为回复完成 |
| `dedupTtl` | number | 否 | `600000` | 消息去重缓存过期时间（毫秒） |
| `directory` | string | 否 | `""` | 默认工作目录，支持 `~` 和 `${ENV_VAR}` 展开 |
| `autoPrompt.enabled` | boolean | 否 | `false` | 启用自动提示（响应完成后自动发送"继续"） |
| `autoPrompt.intervalSeconds` | number | 否 | `30` | 响应完成后等待秒数 |
| `autoPrompt.maxIterations` | number | 否 | `10` | 单轮对话最大自动提示次数 |
| `autoPrompt.message` | string | 否 | `"请同步当前进度，如需帮助请说明"` | 自动发送的提示内容 |

## 特性

- **多媒体消息支持** — 图片、文件、音频、富文本、卡片等，自动下载为 data URL
- **实时流式更新** — 通过 `message.part.updated` 事件更新占位消息
- **群聊静默监听** — 所有群消息作为上下文积累，仅 @提及时回复
- **入群自动摄入历史消息**
- **代理支持** — `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`
- **消息去重** — 可配置 TTL
- **自动提示** — 响应完成后自动发送"继续"，推动 OpenCode 持续工作；用户发新消息自动中断

## 群聊行为

| 场景 | 发送到 OpenCode | AI 回复 | 飞书回复 |
|------|:---:|:---:|:---:|
| 单聊 | 是 | 是 | 是 |
| 群聊 + @bot | 是 | 是 | 是 |
| 群聊未 @bot | 是 | 否（静默积累上下文） | 否 |
| bot 入群 | 历史消息 | 否 | 否 |

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
