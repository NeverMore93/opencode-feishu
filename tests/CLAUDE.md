# CLAUDE.md

## 目录职责

- 本目录存放仓库中**有意保留的少量针对性单测**。
- 项目整体策略是"不需要单测"（见根 `CLAUDE.md` 二、测试策略），此处例外原则——测试对象必须满足至少一项：
  - (a) 复杂的 discriminated union / 优先级链类型分类（如 `errors.ts` 的 `classify`）；
  - (b) 易回归的安全边界判定；
  - (c) 真实 trap 样本驱动的回归集合。
- 所有测试使用 Node 内置 `node:test` runner，不引入额外测试框架（避免依赖膨胀）。

## 可以在这里放

- 针对单个生产模块的 `*.test.ts`，文件路径映射到被测源文件路径（例：`tests/handler/errors.test.ts` ↔ `src/handler/errors.ts`）。
- 测试 fixtures（按子目录组织，如 `handler/fixtures/`）。

## 不要在这里放

- 集成测试或端到端测试（项目不维护此层级，靠实际飞书会话验证）。
- 用 mock 替代生产依赖的"假"测试——若必须 mock，请评估是否值得保留。
- 与生产逻辑无对应关系的纯 utility 测试。

## 修改约束

- 新增测试需在被测模块的 CLAUDE.md 或 PR 描述里说明"为什么需要这个测试"（例外原则归属）。
- 运行：`npx tsx --test tests/<path>/<file>.test.ts`。
- 不应通过测试驱动改写生产代码风格——生产代码不为测试方便妥协。
- 测试文件不进 `dist/` 或 npm 包（受 `package.json` `files` 字段约束）。
