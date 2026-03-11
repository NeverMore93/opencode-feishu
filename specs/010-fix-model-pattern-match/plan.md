# Implementation Plan: 修复模型恢复模式匹配间隙

**Branch**: `010-fix-model-pattern-match` | **Date**: 2026-03-11 | **Spec**: N/A（bug fix，无独立 spec）
**Input**: v0.7.12 诊断日志 + research.md 反省分析

## Summary

v0.7.12 的诊断日志 `fields=["APIError","The requested model is not supported."] isModel=false` 揭示了两个独立 bug：
1. **模式间隙**：`"model not supported"` 不匹配 `"model is not supported"`（中间有 "is"）
2. **嵌套遗漏**：`data.error.code = "model_not_supported"` 未被提取（只检查 `data.message`）

两个 fix 各自独立即可解决问题（belt-and-suspenders）。

## Technical Context

**Language/Version**: TypeScript 5.x（strict mode, ES2022 target）
**Primary Dependencies**: `@opencode-ai/sdk`, `@larksuiteoapi/node-sdk`, tsup
**Testing**: 无单测（项目约定，通过诊断日志 + 端到端验证）
**Target Platform**: Node 20, ESM
**Constraints**: 不改变现有行为，补充模式覆盖和数据提取
**Scale/Scope**: 1 个文件，~10 行代码变更

## Constitution Check

| Gate | Status | Notes |
|------|--------|-------|
| 二、测试策略：不需要单测 | ✅ | 通过诊断日志和端到端验证 |
| 三、文档语言：中文编写 | ✅ | research.md 全部中文 |
| 八、日志规范：完整不截断 | ✅ | 诊断日志已在 v0.7.12 就位 |
| 九、错误处理：四层架构 | ✅ | 修复 L1（模式匹配）和 L1（字段提取）层 |
| 十二、发布流程：先更新版本号 | ✅ | 已 bump 到 v0.7.13 |

## Project Structure

### Source Code Changes

```text
src/handler/event.ts    # extractErrorFields: +data.error 提取; isModelError: +模式
```

### Documentation

```text
specs/010-fix-model-pattern-match/
├── plan.md              # 本文件
└── research.md          # 深度反省（反模式分析 + 修复验证缺失）
```

## 实现（已完成）

### Fix 1: `isModelError` 添加 "model is not supported"

```diff
- const patterns = ["model not found", "modelnotfound", "model not supported", "model_not_supported"]
+ const patterns = ["model not found", "modelnotfound", "model not supported", "model_not_supported", "model is not supported"]
```

### Fix 2: `extractErrorFields` 提取 `data.error` 嵌套字段

```typescript
// 提取 data.error 嵌套字段（API 错误响应标准结构：{ error: { message, code, type } }）
if (e.data && typeof e.data === "object" && "error" in e.data) {
  const dataErr = (e.data as Record<string, unknown>).error
  if (dataErr && typeof dataErr === "object") {
    const errStrings = Object.values(dataErr as Record<string, unknown>)
      .filter((v): v is string => typeof v === "string" && v.length > 0)
    fields.push(...errStrings)
  }
}
```

## 验证

1. ✅ `npm run build && npm run typecheck` 通过
2. 逻辑验证：`"the requested model is not supported.".includes("model is not supported")` → `true`
3. PR #24 已创建，CodeRabbit review 通过（1 nitpick: 建议测试）
4. 待部署到服务器后端到端验证
