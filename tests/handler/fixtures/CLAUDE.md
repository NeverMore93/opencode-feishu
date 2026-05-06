# CLAUDE.md

## 目录职责

- 本目录存放 `tests/handler/errors.test.ts` 使用的 JSON 测试样本。
- 两类样本各有用途：
  - `real-samples.json`：生产环境真实观测的错误样本，每条标注 `expectedKind` 验证 `classify()` 命中正确分类。
  - `trap-samples.json`：人工构造的边界陷阱（如错误 message 含其他错误关键词的子串），验证 `classify` 不会被字面匹配欺骗。

## 可以在这里放

- 与 `tests/handler/*.test.ts` 一一对应的 `*-samples.json`。
- 每个样本必须含 `id`、`raw`、`expectedKind` 字段；trap 样本额外含 `description` 解释陷阱性质。

## 不要在这里放

- 大型 fixture（>1MB）——若需要，应放在 gitignored 路径并通过下载脚本生成。
- 含敏感信息（API key、token、PII）的样本——必须先脱敏，保留错误的结构性特征即可。
- 与测试无对应关系的"参考数据"——这类应归 `docs/`。

## 修改约束

- 新增样本需在对应 `*.test.ts` 中加 assert，否则相当于死数据。
- 修改样本时确保 `expectedKind` 与 `src/handler/errors.ts` 当前 `classify` 行为一致——不一致说明 classify 改了但 fixture 没同步，应先确认实现意图。
- `expectedKind` 取值受限于 `src/handler/errors.ts` 中 `PluginError` union 的 5 种 kind：`Unauthorized` / `ContextOverflow` / `ModelUnavailable` / `SessionPoisoned` / `UnknownUpstream`。
