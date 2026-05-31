/**
 * chat.ts polling regression tests.
 *
 * Run: npx tsx --test tests/handler/chat-polling.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { pollForResponse } from "../../src/handler/chat.js"
import { emit } from "../../src/handler/action-bus.js"

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
})
