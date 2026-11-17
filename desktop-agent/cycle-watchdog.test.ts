import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { CYCLE_TIMEOUT, FOLLOW_UP_CYCLE_TIMEOUT_MS, POLL_CYCLE_TIMEOUT_MS, withCycleTimeout } from "./src/cycle-watchdog.js"

/**
 * Pins the per-cycle watchdog contract behind the 2026-11-17 silent-engine
 * incident: a cycle body that hangs forever must resolve with the sentinel,
 * fire onTimeout exactly once, and stay inert when the hung body settles late.
 */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("withCycleTimeout", () => {
  it("resolves with the promise value when the promise wins", async () => {
    let timeoutCalls = 0
    const result = await withCycleTimeout(Promise.resolve("done"), 30, () => {
      timeoutCalls += 1
    })
    assert.equal(result, "done")
    assert.equal(timeoutCalls, 0)
  })

  it("awaits a slow promise that still settles inside the budget", async () => {
    const result = await withCycleTimeout(delay(10).then(() => "slow-but-fine"), 30, () => {
      throw new Error("onTimeout must not fire when the promise wins")
    })
    assert.equal(result, "slow-but-fine")
  })

  it("returns the sentinel and fires onTimeout exactly once when the timer wins", async () => {
    let timeoutCalls = 0
    const result = await withCycleTimeout(
      new Promise(() => {
        // never settles
      }),
      30,
      () => {
        timeoutCalls += 1
      },
    )
    assert.equal(result, CYCLE_TIMEOUT)
    assert.equal(timeoutCalls, 1)
    // The timer must not fire a second time while the caller keeps running.
    await delay(60)
    assert.equal(timeoutCalls, 1)
  })

  it("honors the timeout budget: a 30ms ceiling fires well inside the test window", async () => {
    const started = Date.now()
    const result = await withCycleTimeout(new Promise(() => {}), 30, () => undefined)
    const elapsed = Date.now() - started
    assert.equal(result, CYCLE_TIMEOUT)
    assert.ok(elapsed >= 25, `expected the watchdog to wait ~30ms, only waited ${elapsed}ms`)
    assert.ok(elapsed < 2000, `watchdog took ${elapsed}ms — timer not cleared on the fast path?`)
  })

  it("a late resolution does not change the sentinel result", async () => {
    let lateResolve!: (value: string) => void
    const body = new Promise<string>((resolve) => {
      lateResolve = resolve
    })
    const watched = withCycleTimeout(body, 30, () => undefined)
    assert.equal(await watched, CYCLE_TIMEOUT)
    // The hung body settles after the timeout: same promise, same sentinel,
    // no throw, no replacement value.
    lateResolve("too-late")
    await delay(25)
    assert.equal(await watched, CYCLE_TIMEOUT)
  })

  it("a late rejection does not throw and does not fire onTimeout a second time", async () => {
    let timeoutCalls = 0
    let lateReject!: (err: Error) => void
    const body = new Promise<string>((_resolve, reject) => {
      lateReject = reject
    })
    const watched = withCycleTimeout(body, 30, () => {
      timeoutCalls += 1
    })
    assert.equal(await watched, CYCLE_TIMEOUT)
    lateReject(new Error("network came back angry"))
    await delay(25)
    assert.equal(timeoutCalls, 1)
    assert.equal(await watched, CYCLE_TIMEOUT)
  })

  it("never throws even when onTimeout itself throws", async () => {
    const result = await withCycleTimeout(new Promise(() => {}), 30, () => {
      throw new Error("onTimeout exploded")
    })
    assert.equal(result, CYCLE_TIMEOUT)
  })

  it("propagates a body rejection that arrives before the timeout", async () => {
    const failure = new Error("cycle failed fast")
    await assert.rejects(withCycleTimeout(Promise.reject(failure), 30, () => undefined), (err: unknown) => err === failure)
  })

  it("ships the engine cycle budgets", () => {
    assert.equal(POLL_CYCLE_TIMEOUT_MS, 20 * 60 * 1000)
    assert.equal(FOLLOW_UP_CYCLE_TIMEOUT_MS, 8 * 60 * 1000)
  })
})
