# CLAUDE.md

## 目录职责

- 本目录存放 `src/handler/` 模块的针对性单测。
- 当前唯一保留的测试 `errors.test.ts` 验证 `src/handler/errors.ts` 的 `classify()` 优先级链与 `matchPluginError` 穷尽匹配——errors.ts 是会话错误五层架构（见 `src/handler/CLAUDE.md`）的核心 discriminated union，回归代价高，符合父级 `tests/CLAUDE.md` 例外原则 (a) + (c)。

## 可以在这里放

- `<module>.test.ts`——映射到 `src/handler/<module>.ts`。
- 仅当被测模块满足父级 `tests/CLAUDE.md` 例外原则时新增测试。

## 不要在这里放

- 对 `chat.ts` / `event.ts` 的 mock-heavy 测试（这两文件由集成路径覆盖，单测价值低）。
- 与 handler 编排无关的测试。

## 修改约束

- `errors.test.ts` 的样本必须来自 `fixtures/real-samples.json`（生产观测）和 `fixtures/trap-samples.json`（陷阱回归），不允许凭空构造样本。
- 修改 `src/handler/errors.ts` 的 classify 链时必须先扩展 fixtures，再跑测试，最后改实现——确保每条新规则都有对应样本。
- 运行：`npx tsx --test tests/handler/errors.test.ts`。
