# Research: v0.7.12 模型恢复仍失败 — 第二层反省

**Branch**: `010-fix-model-pattern-match` | **Date**: 2026-03-11
**前置**: 009-fix-model-recovery-trigger 的 research.md（第一层反省）

## 一、v0.7.12 诊断日志取证

v0.7.12 的核心改进是添加了诊断日志。这次日志终于揭示了**真实的错误数据**：

```
fields=["APIError","The requested model is not supported."] isModel=false
```

**关键发现**：
1. `extractErrorFields` 提取到了 2 个字段：`name="APIError"`, `message="The requested model is not supported."`
2. `isModelError` 返回 `false` — 模式匹配失败
3. `code: "model_not_supported"` **从未出现在 fields 中**

## 二、双重失败的 Root Cause

### Bug 1: 模式匹配的"自然语言陷阱"

| 模式 | 实际文本 | 匹配？ |
|------|---------|--------|
| `"model not supported"` | `"the requested model is not supported."` | ❌ `"model is not supported"` 中间有 `"is "` |
| `"model_not_supported"` | `"the requested model is not supported."` | ❌ 下划线格式不在自然语言中 |

**为什么 009 没发现这个问题**：009 的分析关注的是「字段提取不完整」，从未实际验证「模式是否匹配已有字段」。我们一直**假设** `"model not supported"` 能匹配任何包含这三个词的句子。

**教训**：子串匹配（`.includes()`）不是语义匹配。`"model not supported"` 是一个精确子串，`"model is not supported"` 不包含它。

### Bug 2: 数据嵌套层级假设错误

API HTTP 响应体（原始 JSON）：
```json
{"error":{"message":"The requested model is not supported.","code":"model_not_supported","param":"model","type":"invalid_request_error"}}
```

AI SDK `AI_APICallError` 对象结构：
```
e.name = "APIError"
e.message = "The requested model is not supported."
e.data = { error: { message: "...", code: "model_not_supported", type: "..." } }
```

`extractErrorFields` v0.7.12 只检查 `data.message`（不存在），不检查 `data.error`。因此 `code: "model_not_supported"` 永远不被提取。

## 三、反模式深度反省

### 反模式 1：假设驱动开发 — "我觉得应该匹配"

**009 的修复过程**：
1. 看到 `isModelError` 有 `"model_not_supported"` 模式
2. 发现 `extractErrorFields` 没提取 `code` 字段
3. 结论：「只要提取 `code` 字段，`"model_not_supported"` 就能匹配」
4. **从未验证**：`message` 字段 `"The requested model is not supported."` 是否能被 `"model not supported"` 匹配

这是**假设驱动**而非**数据驱动**的修复。如果 009 在写代码前先做一个简单的子串匹配测试：
```javascript
"the requested model is not supported.".includes("model not supported")  // false!
```
就能发现 Bug 1。

### 反模式 2：修复"提取"但不验证"匹配"

009 做了大量工作改善 `extractErrorFields`（白名单 → Object.values → 显式+枚举+去重），但**零次**验证 `isModelError` 的模式是否覆盖实际错误消息。

这是**单侧修复**的典型例子：只修复数据流的一端（提取），不验证另一端（匹配）。

### 反模式 3：不使用生产数据验证

009 的 research.md 分析了 40+ commits 的 git history，写了 5 个 root cause，产出了 Object.values 策略。但**没有一个步骤使用实际生产日志中的错误对象来验证**。

如果 009 在修复前运行过：
```bash
grep "session.error" logs/stderr.txt | head -1
```
就能看到 `"The requested model is not supported."` 的实际文本，发现模式间隙。

### 反模式 4：反省的反省 — 009 的反省也是"局部最优"

009 的 research.md 批评了"AI 辅助开发的局部最优陷阱"，指出 10 个版本都在做"症状修复"。但 009 自身也犯了同样的错误：
- 发现了 `code` 字段未提取（一个具体症状）
- 提出了 Object.values 策略（解决提取问题）
- **没有系统性验证**：所有现有模式是否覆盖所有现有错误消息

009 的反省深度：「为什么提取不完整？」→ 白名单思维
010 的反省深度：「为什么匹配失败？」→ 假设驱动 + 单侧验证

### 反模式 5：13 个版本的"打地鼠"进化史

| 版本 | 修了什么 | 验证方式 | 漏了什么 |
|------|---------|---------|---------|
| v0.7.0 | 基础恢复 | 编译通过 | SSE 检测 |
| v0.7.2 | [object Object] | 编译通过 | data.message |
| v0.7.4 | data.message | 编译通过 | 大小写 |
| v0.7.6 | case-insensitive | 编译通过 | code 字段 |
| v0.7.12 | Object.values + code | 编译通过 | 模式间隙 + data.error |
| **v0.7.13** | **模式 + data.error** | **诊断日志** | **?** |

每个版本的验证方式都是"编译通过"。v0.7.12 终于添加了诊断日志，v0.7.13 是**第一个基于生产数据驱动的修复**。

## 四、v0.7.13 修复分析

### Fix 1: 添加 `"model is not supported"` 模式
- **确定性**：✅ 100% 解决当前 bug（子串匹配验证通过）
- **可持续性**：⚠️ 低 — 下一个 provider 可能用 "model does not exist" 或 "unsupported model"

### Fix 2: 提取 `data.error` 嵌套字段
- **确定性**：⚠️ 取决于 SSE session.error 事件是否保留 `data.error` 结构
- **可持续性**：✅ 中 — 覆盖 OpenAI 标准错误格式

### 两个 fix 的关系
- Fix 1 单独就能解决当前问题
- Fix 2 提供冗余保护（belt-and-suspenders）
- 如果 SSE 事件的 error 对象不含 `data.error`，Fix 2 不生效但 Fix 1 仍然有效

## 五、系统性改进建议

### 短期（v0.7.13，已实施）
1. 添加具体模式 "model is not supported"
2. 提取 data.error 嵌套字段

### 中期（建议）
1. **模式匹配改为关键词组合**：检测 "model" + ("not" | "unsupported" | "invalid" | "unavailable") 而非精确子串
2. **递归字符串提取**：不仅提取顶层和 data.message/data.error，而是递归提取所有嵌套 string 值
3. **生产验证 checklist**：每次修改 isModelError 或 extractErrorFields 后，用实际 stderr.txt 日志验证

### 长期（建议提给 OpenCode）
1. SSE session.error 事件应包含结构化错误分类（如 `errorType: "model_incompatible"`），而非让插件猜测
2. 服务端统一错误格式，减少客户端模式匹配负担

## 六、对"反省深度"本身的反省

009 的反省被用户评价为"不够深刻彻底"。原因：
- 009 反省了"为什么字段提取不完整"，但没反省"为什么匹配不完整"
- 009 提出了 Object.values 策略（技术方案），但没质疑"模式列表是否正确"（业务假设）
- 009 批评了"AI 局部最优"，但自身也是局部最优 — 只修复了数据流的一端

**真正的系统性思维**：修复 `extractErrorFields` 时，应该同时：
1. 用实际错误数据验证提取结果
2. 用提取结果验证 `isModelError` 的模式覆盖
3. 用端到端测试验证恢复流程触发

v0.7.13 的诊断日志让步骤 1 自动化了。步骤 2 和 3 仍需手动执行。
