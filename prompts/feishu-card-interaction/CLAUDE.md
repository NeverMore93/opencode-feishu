# CLAUDE.md

## 目录职责

- 本目录是飞书渠道的运行时 prompt 实例。
- 该目录的 `prompt.md` 在插件启动时由 `loadFeishuRuntimePrompt()`（`src/index.ts:62-66`）一次性读取，通过 `experimental.chat.system.transform` hook 注入到飞书会话的 system prompt。
- 修改 `prompt.md` 必须重启 OpenCode 进程才能生效（无 hot reload）。

## 可以在这里放

- `prompt.md`：本飞书运行时 prompt 的唯一内容源。

## 不要在这里放

- 输出策略、agent 行为指导（应被父级 `prompts/CLAUDE.md` 边界判定框架拒绝）。
- prompt 多变体或测试样本——本目录只承载生产运行时唯一一份。
- 非运行时使用的文档（设计决策、注入审计应归 `prompts/AUDIT.md`，跨目录文档应归 `docs/`）。

## 修改约束

- 任何修改必须遵守 `prompts/CLAUDE.md` 中的"注入边界判定框架"——逐句对照允许/禁止模式自检。
- 行数或措辞调整必须同步追加 `prompts/AUDIT.md § 5 修订历史` 条目，并在 `§ 1.3 演进路径` 反映新版本号。
- 内容须可被 Claude（接收方）字面解读——避免修辞、隐喻、双关、自指。
- 否定式控制约束改用正向陈述（例：✅ "abort 按钮专用于中断" / ❌ "按钮不是 abort"）。
