/**
 * chat.ts polling regression tests.
 *
 * Run: npx tsx --test tests/handler/chat-polling.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { pollForResponse } from "../../src/handler/chat.js"
import { emit, getSessionIdleVersion } from "../../src/handler/action-bus.js"

describe("pollForResponse", () => {
  it("waits for session-idle instead of completing on stable partial text", async () => {
    let calls = 0
    const client = {
      session: {
        async messages() {
          calls++
          if (calls === 5) {
            emit("session-1", { type: "session-idle", sessionId: "session-1" })
          }

          const text = calls >= 5 ? "final answer" : "partial answer"
          return {
            data: [{
              info: { role: "assistant" },
              parts: [{ type: "text", text }],
            }],
          }
        },
      },
    }

    const result = await pollForResponse(client as any, "session-1", {
      pollInterval: 0,
      stablePolls: 2,
    })

    assert.equal(
      result,
      "final answer",
      "pollForResponse must wait for session-idle instead of treating stable partial text as completion",
    )
    assert.ok(calls >= 5, "polling should continue until the session-idle event arrives")
  })

  it("observes session-idle emitted before polling subscribes", async () => {
    let timedOut = false
    const idleAfterVersion = getSessionIdleVersion("early-idle-session")
    emit("early-idle-session", { type: "session-idle", sessionId: "early-idle-session" })

    const client = {
      session: {
        async messages() {
          return {
            data: [{
              info: { role: "assistant" },
              parts: [{ type: "text", text: "final answer" }],
            }],
          }
        },
      },
    }

    const result = await pollForResponse(client as any, "early-idle-session", {
      timeout: 20,
      pollInterval: 0,
      stablePolls: 2,
      idleAfterVersion,
      onTimedOut: () => {
        timedOut = true
      },
    })

    assert.equal(result, "final answer")
    assert.equal(timedOut, false, "early session-idle should not be lost until timeout")
  })

  it("ignores session-idle while the snapshot still matches the baseline", async () => {
    let calls = 0
    const baseline = { text: "previous answer", reasoning: "" }
    const client = {
      session: {
        async messages() {
          calls++
          return {
            data: [{
              info: { role: "assistant" },
              parts: [{ type: "text", text: calls >= 2 ? "new final answer" : "previous answer" }],
            }],
          }
        },
      },
    }

    const result = await pollForResponse(client as any, "stale-idle-session", {
      pollInterval: 0,
      stablePolls: 2,
      baseline,
      onTick: () => {
        emit("stale-idle-session", { type: "session-idle", sessionId: "stale-idle-session" })
      },
    })

    assert.equal(result, "new final answer")
    assert.ok(calls >= 2, "baseline-matching idle must not finalize the previous turn")
  })
})
