/**
 * errors.ts 单元测试。
 *
 * 使用 Node 内置 test runner（node --test）。
 * 运行：npx tsx --test tests/handler/errors.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  classify,
  matchPluginError,
  toLog,
  stringify,
  truncate,
  PluginErrorThrown,
  type PluginError,
} from "../../src/handler/errors.js"

import realSamples from "./fixtures/real-samples.json" with { type: "json" }
import trapSamples from "./fixtures/trap-samples.json" with { type: "json" }

// ═══════════ Utilities ═══════════

describe("stringify", () => {
  it("handles null", () => assert.equal(stringify(null), "null"))
  it("handles undefined", () => assert.equal(stringify(undefined), "undefined"))
  it("handles string", () => assert.equal(stringify("hello"), "hello"))
  it("handles Error", () => assert.equal(stringify(new Error("boom")), "boom"))
  it("handles Error with only name", () => {
    const e = new Error()
    e.name = "CustomError"
    assert.equal(stringify(e), "CustomError")
  })
  it("handles plain object", () => assert.equal(stringify({ a: 1 }), '{"a":1}'))
  it("handles number", () => assert.equal(stringify(42), "42"))
  it("handles circular ref", () => {
    const obj: Record<string, unknown> = {}
    obj.self = obj
    assert.equal(stringify(obj), "[unserializable]")
  })
})

describe("truncate", () => {
  it("short string unchanged", () => assert.equal(truncate("abc", 5), "abc"))
  it("exact length unchanged", () => assert.equal(truncate("abcde", 5), "abcde"))
  it("long string truncated", () => assert.equal(truncate("abcdef", 5), "abcde..."))
  it("empty string", () => assert.equal(truncate("", 5), ""))
})

// ═══════════ classify — real samples ═══════════

describe("classify (real samples)", () => {
  for (const sample of realSamples) {
    it(`${sample.id}: ${sample.expectedKind}`, () => {
      const result = classify(sample.raw)
      assert.equal(result.kind, sample.expectedKind, `Expected ${sample.expectedKind} but got ${result.kind} for ${sample.id}`)
    })
  }
})

// ═══════════ classify — trap samples ═══════════

describe("classify (trap samples — should NOT be SessionPoisoned)", () => {
  for (const sample of trapSamples) {
    it(`${sample.id}: expect ${sample.expectedKind}`, () => {
      const result = classify(sample.raw)
      assert.equal(result.kind, sample.expectedKind,
        `Trap ${sample.id}: expected ${sample.expectedKind} but got ${result.kind}`)
      // 额外断言：绝不应该是 SessionPoisoned（除非 expectedKind 就是）
      if (sample.expectedKind !== "SessionPoisoned") {
        assert.notEqual(result.kind, "SessionPoisoned",
          `Trap ${sample.id}: should NOT be SessionPoisoned`)
      }
    })
  }
})

// ═══════════ classify — edge cases ═══════════

describe("classify (edge cases)", () => {
  it("null → UnknownUpstream", () => {
    assert.equal(classify(null).kind, "UnknownUpstream")
  })
  it("undefined → UnknownUpstream", () => {
    assert.equal(classify(undefined).kind, "UnknownUpstream")
  })
  it("number → UnknownUpstream", () => {
    assert.equal(classify(42).kind, "UnknownUpstream")
  })
  it("empty string → UnknownUpstream", () => {
    assert.equal(classify("").kind, "UnknownUpstream")
  })
  it("empty object → UnknownUpstream", () => {
    assert.equal(classify({}).kind, "UnknownUpstream")
  })
  it("Error with no name/message → UnknownUpstream", () => {
    assert.equal(classify(new Error()).kind, "UnknownUpstream")
  })
  it("circular ref → UnknownUpstream (no throw)", () => {
    const obj: Record<string, unknown> = {}
    obj.self = obj
    const result = classify(obj)
    assert.equal(result.kind, "UnknownUpstream")
  })
  it("classify never throws", () => {
    // 传入各种可能触发异常的输入
    const inputs = [null, undefined, 0, false, "", Symbol("test"), BigInt(1)]
    for (const input of inputs) {
      const result = classify(input)
      assert.ok(result.kind, `classify(${String(input)}) should return a valid PluginError`)
    }
  })
})

// ═══════════ classify — evidence completeness ═══════════

describe("classify (evidence completeness)", () => {
  it("Unauthorized has ≥1 evidence", () => {
    const err = classify({ name: "ProviderAuthError", data: { providerID: "x", message: "auth failed" } })
    assert.ok(err.evidence.length >= 1)
    assert.equal(err.evidence[0].via, "name")
  })
  it("ContextOverflow has ≥1 evidence", () => {
    const err = classify({ name: "ContextOverflowError", data: { message: "too long" } })
    assert.ok(err.evidence.length >= 1)
  })
  it("ModelUnavailable (exact name) has ≥1 evidence", () => {
    const err = classify({ name: "ProviderModelNotFoundError", data: { providerID: "x", modelID: "y" } })
    assert.ok(err.evidence.length >= 1)
    assert.equal(err.evidence[0].via, "name")
  })
  it("ModelUnavailable (pattern) has ≥1 evidence", () => {
    const err = classify({ name: "UnknownError", data: { message: "model not found" } })
    assert.ok(err.evidence.length >= 1)
    assert.equal(err.evidence[0].via, "pattern")
  })
  it("SessionPoisoned has ≥2 evidence (name + pattern)", () => {
    const err = classify({ name: "StructuredOutputError", data: { message: "file part media type text/x-yaml" } })
    assert.ok(err.evidence.length >= 2, `Expected ≥2 evidence, got ${err.evidence.length}`)
  })
  it("UnknownUpstream has 0 evidence", () => {
    const err = classify({ name: "UnknownError", data: { message: "random error" } })
    assert.equal(err.evidence.length, 0)
  })
})

// ═══════════ classify — priority chain ═══════════

describe("classify (priority chain)", () => {
  it("Auth beats Model (ProviderAuthError wins over model pattern in message)", () => {
    const err = classify({ name: "ProviderAuthError", data: { message: "model not found in provider" } })
    assert.equal(err.kind, "Unauthorized")
  })
  it("Auth beats Poison (ProviderAuthError wins over poison pattern in message)", () => {
    const err = classify({ name: "ProviderAuthError", data: { message: "file part media type unsupported" } })
    assert.equal(err.kind, "Unauthorized")
  })
  it("Context beats Model", () => {
    const err = classify({ name: "ContextOverflowError", data: { message: "model not found context overflow" } })
    assert.equal(err.kind, "ContextOverflow")
  })
  it("Model beats Poison (model pattern checked before poison)", () => {
    const err = classify({ name: "UnknownError", data: { message: "model not found: file part media type" } })
    assert.equal(err.kind, "ModelUnavailable")
  })
  it("Poison requires two-factor (name whitelist + pattern)", () => {
    // UnknownError name is in whitelist, but message has no poison pattern
    const err = classify({ name: "UnknownError", data: { message: "random error" } })
    assert.equal(err.kind, "UnknownUpstream")
  })
  it("Poison two-factor: name not in whitelist → not poison", () => {
    // MessageOutputLengthError is NOT in whitelist
    const err = classify({ name: "MessageOutputLengthError", data: { message: "file part media type" } })
    assert.notEqual(err.kind, "SessionPoisoned")
  })
})

// ═══════════ classify — toLog safety ═══════════

describe("toLog", () => {
  it("does not expose raw", () => {
    const err = classify({ name: "ProviderAuthError", data: { providerID: "x", message: "secret-key-12345" } })
    const logPayload = toLog(err)
    const serialized = JSON.stringify(logPayload)
    assert.ok(!serialized.includes("secret-key-12345"), "toLog should not expose raw error content")
    assert.ok(!serialized.includes("raw"), "toLog should not include raw field")
  })
  it("includes kind", () => {
    const err = classify({ name: "ProviderAuthError", data: { providerID: "x", message: "auth" } })
    assert.equal(toLog(err).kind, "Unauthorized")
  })
  it("includes rule for SessionPoisoned", () => {
    const err = classify({ name: "StructuredOutputError", data: { message: "file part media type" } })
    assert.ok(toLog(err).rule)
  })
  it("includes hint for UnknownUpstream", () => {
    const err = classify(null)
    assert.ok(toLog(err).hint)
  })
})

// ═══════════ matchPluginError — exhaustive ═══════════

describe("matchPluginError", () => {
  it("calls correct handler for each kind", () => {
    const kinds: PluginError["kind"][] = [
      "SessionPoisoned", "ModelUnavailable", "ContextOverflow", "Unauthorized", "UnknownUpstream",
    ]
    for (const kind of kinds) {
      const err = classify(
        kind === "Unauthorized" ? { name: "ProviderAuthError", data: { providerID: "x", message: "auth" } } :
        kind === "ContextOverflow" ? { name: "ContextOverflowError", data: { message: "overflow" } } :
        kind === "ModelUnavailable" ? { name: "ProviderModelNotFoundError", data: { providerID: "x", modelID: "y" } } :
        kind === "SessionPoisoned" ? { name: "StructuredOutputError", data: { message: "file part media type" } } :
        null
      )
      assert.equal(err.kind, kind, `classify should produce ${kind}`)
      const result = matchPluginError(err, {
        SessionPoisoned: () => "poison",
        ModelUnavailable: () => "model",
        ContextOverflow: () => "context",
        Unauthorized: () => "auth",
        UnknownUpstream: () => "unknown",
      })
      const expected =
        kind === "SessionPoisoned" ? "poison" :
        kind === "ModelUnavailable" ? "model" :
        kind === "ContextOverflow" ? "context" :
        kind === "Unauthorized" ? "auth" : "unknown"
      assert.equal(result, expected)
    }
  })
})

// ═══════════ PluginErrorThrown ═══════════

describe("PluginErrorThrown", () => {
  it("wraps PluginError", () => {
    const inner = classify({ name: "ProviderAuthError", data: { providerID: "x", message: "auth" } })
    const thrown = new PluginErrorThrown(inner)
    assert.equal(thrown.name, "PluginErrorThrown")
    assert.equal(thrown.inner.kind, "Unauthorized")
    assert.ok(thrown.message.includes("Unauthorized"))
  })
})
