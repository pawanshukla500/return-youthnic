import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { pickIntervalMs, isTrustedBackendUrl, saveAgentConfig, loadAgentConfig, DEFAULT_PRODUCTION_URL } from "./src/config.js"
import { isBackendUrlExternallyControlled } from "./src/load-env.js"

/**
 * The engine's timers are built straight from these values. `Number("")` is 0 and
 * `Number("abc")` is NaN; Node clamps either timer delay to 1 ms, so an unusable
 * value would turn the follow-up look-up (and the claim poll) into a tight loop
 * against the backend. CodeAnt flagged this on the follow-up interval, and the
 * same guard now covers all three.
 */

describe("interval env parsing", () => {
  it("accepts a positive number of milliseconds", () => {
    assert.equal(pickIntervalMs(["30000"], 1000), 30000)
    assert.equal(pickIntervalMs([1800000], 1000), 1800000)
  })

  it("accepts a numeric string and floors a fractional value", () => {
    assert.equal(pickIntervalMs([" 45000 "], 1000), 45000)
    assert.equal(pickIntervalMs(["1000.9"], 1000), 1000)
  })

  it("rejects a non-numeric value instead of producing NaN", () => {
    assert.equal(pickIntervalMs(["abc"], 1800000), 1800000)
    assert.equal(pickIntervalMs([undefined], 15000), 15000)
    assert.equal(pickIntervalMs([null], 15000), 15000)
  })

  it("rejects an empty string instead of producing zero", () => {
    // A blank FOLLOWUP_INTERVAL_MS used to become 0 and Node clamped the timer to
    // 1 ms, so the engine polled the backend continuously.
    assert.equal(pickIntervalMs([""], 1800000), 1800000)
    assert.equal(pickIntervalMs(["   "], 1800000), 1800000)
  })

  it("rejects zero and negative values", () => {
    assert.equal(pickIntervalMs([0], 10000), 10000)
    assert.equal(pickIntervalMs([-5], 10000), 10000)
  })

  it("rejects a value below the minimum", () => {
    assert.equal(pickIntervalMs(["999"], 10000), 10000)
    assert.equal(pickIntervalMs(["1000"], 10000), 1000)
    // The minimum itself is configurable for a faster-cadence test setup.
    assert.equal(pickIntervalMs(["250"], 10000, 250), 250)
  })

  it("falls through an unusable candidate to the next one", () => {
    // An env typo must not discard a good saved setting.
    assert.equal(pickIntervalMs(["", 1800000], 10000), 1800000)
    assert.equal(pickIntervalMs(["abc", 30000, 20000], 10000), 30000)
  })

  it("uses the documented default when nothing is usable", () => {
    assert.equal(pickIntervalMs([], 1800000), 1800000)
    assert.equal(pickIntervalMs(["", undefined, "x"], 15000), 15000)
  })

  it("rejects an infinity that would keep a timer from firing", () => {
    assert.equal(pickIntervalMs([Infinity], 15000), 15000)
    assert.equal(pickIntervalMs(["Infinity"], 15000), 15000)
  })
})

describe("backend URL configuration and consistency", () => {
  it("trusted backend URL recognizes production origin and configured overrides", () => {
    assert.equal(isTrustedBackendUrl(DEFAULT_PRODUCTION_URL), true)
    assert.equal(isTrustedBackendUrl("https://evil.example.com"), false)
    assert.equal(isTrustedBackendUrl("invalid-url"), false)
  })

  it("isBackendUrlExternallyControlled returns a boolean without throwing", () => {
    assert.equal(typeof isBackendUrlExternallyControlled(), "boolean")
  })

  it("saveAgentConfig updates process.env.BACKEND_URL to ensure consumers share the same URL", () => {
    const original = process.env.BACKEND_URL
    try {
      const updated = saveAgentConfig({ backendUrl: DEFAULT_PRODUCTION_URL })
      assert.equal(updated.backendUrl, DEFAULT_PRODUCTION_URL)
      assert.equal(loadAgentConfig().backendUrl, DEFAULT_PRODUCTION_URL)
      assert.equal(process.env.BACKEND_URL, DEFAULT_PRODUCTION_URL)
    } finally {
      if (original !== undefined) {
        process.env.BACKEND_URL = original
      } else {
        delete process.env.BACKEND_URL
      }
    }
  })
})
