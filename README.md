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

## 群聊行为

| 场景 | 发送到 OpenCode | AI 回复 | 飞书回复 |
|------|:---:|:---:|:---:|
| 单聊 | 是 | 是 | 是 |
| 群聊 + @bot | 是 | 是 | 是 |
| 群聊未 @bot | 是 | 否（静默积累上下文） | 否 |
| bot 入群 | 历史消息 | 否 | 否 |

## 开发

```bash
npm install        # 安装依赖
npm run build      # 构建
npm run dev        # 开发模式（监听变更）
npm run typecheck  # 类型检查
npm publish        # 发布到 npm
```

## 许可证

MIT
