/**
 * index.ts v2 client config regression test.
 *
 * Ensures the Feishu plugin binds its secondary OpenCode SDK client
 * to the running server URL supplied by the plugin host.
 * Run: npx tsx --test tests/index-v2-client.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildV2ClientConfig } from "../src/index.js"

describe("buildV2ClientConfig", () => {
  it("uses plugin ctx.serverUrl as SDK baseUrl", () => {
    const config = buildV2ClientConfig({
      serverUrl: new URL("http://127.0.0.1:55249"),
      directory: "/repo",
    })

    assert.equal(config.baseUrl, "http://127.0.0.1:55249/")
    assert.equal(config.directory, "/repo")
  })

  it("omits blank directory while preserving baseUrl", () => {
    const config = buildV2ClientConfig({
      serverUrl: new URL("http://localhost:4096"),
      directory: "",
    })

    assert.equal(config.baseUrl, "http://localhost:4096/")
    assert.equal(config.directory, undefined)
  })
})
