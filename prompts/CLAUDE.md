# CLAUDE.md

## 目录职责

- 本目录存放面向 AI 代理的运行时 prompt。
- 它只定义"如何在本渠道工作"，不直接承载业务实现。

## 可以在这里放

- 运行时 prompt（`<name>/prompt.md`）。
- prompt 治理规则。

## 不要在这里放

- 产品源码、构建产物、一次性调试日志。
- 输出策略、agent 行为指导、meta-maintenance 文档。

## 修改约束

- `prompt.md` 只写渠道事实和工具契约，不写输出策略或 agent 行为指导。
- `prompt.md` MUST NOT 包含"何时发卡""如何组织标题/摘要/结论""按钮推荐文案""发送前自检"等会塑形 agent 输出策略的内容。
- `prompt.md` 不得写入否定式控制约束；改用正向陈述描述行为事实。
