import { afterEach, describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import { CYCLE_TIMEOUT, FOLLOW_UP_CYCLE_TIMEOUT_MS, POLL_CYCLE_TIMEOUT_MS, withCycleTimeout } from "./src/cycle-watchdog.js"

/**
 * Pins the per-cycle watchdog contract behind the 2026-11-17 silent-engine
 * incident: a cycle body that hangs forever must resolve with the sentinel,
 * fire onTimeout exactly once, and stay inert when the hung body settles late.
 *
 * Timer-dependent tests drive node:test's fake timers (tick) instead of real
 * 30ms sleeps, so they stay deterministic under full-suite load on the CI
 * runner. cleanup in afterEach restores the real setTimeout; it is a safe
 * no-op for tests that never enabled fake timers.
 */

afterEach(() => {
  mock.timers.reset()
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe("withCycleTimeout", () => {
  it("resolves with the promise value when the promise wins", async () => {
    let timeoutCalls = 0
    const result = await withCycleTimeout(Promise.resolve("done"), 30, () => {
      timeoutCalls += 1
    })
    assert.equal(result, "done")
    assert.equal(timeoutCalls, 0)
  })

  it("awaits a slow promise that settles inside the budget, then clears the timer", async () => {
    mock.timers.enable({ apis: ["setTimeout"], now: 1000 })
    let timeoutCalls = 0
    const slow = deferred<string>()
    const watched = withCycleTimeout(slow.promise, 30, () => {
      timeoutCalls += 1
    })
    slow.resolve("slow-but-fine")
    assert.equal(await watched, "slow-but-fine")
    // The pending watchdog timer must have been cleared: even past the budget
    // it never fires.
    mock.timers.tick(1000)
    assert.equal(timeoutCalls, 0)
  })

  it("returns the sentinel and fires onTimeout exactly once when the timer wins", async () => {
    mock.timers.enable({ apis: ["setTimeout"], now: 1000 })
    let timeoutCalls = 0
    const watched = withCycleTimeout(
      new Promise<string>(() => {
        // never settles
      }),
      30,
      () => {
        timeoutCalls += 1
      },
    )
    let settledValue: string | typeof CYCLE_TIMEOUT | undefined
    void watched.then((value) => {
      settledValue = value
    })
    await flushMicrotasks()
    assert.equal(settledValue, undefined)
    assert.equal(timeoutCalls, 0)

    mock.timers.tick(31)
    assert.equal(timeoutCalls, 1)
    assert.equal(await watched, CYCLE_TIMEOUT)
    // No second firing while the caller keeps running.
    mock.timers.tick(1000)
    assert.equal(timeoutCalls, 1)
    assert.equal(await watched, CYCLE_TIMEOUT)
  })

  it("honors the timeout budget: fires only after the full budget has ticked past", async () => {
    mock.timers.enable({ apis: ["setTimeout"], now: 1000 })
    let timeoutCalls = 0
    const watched = withCycleTimeout(new Promise<string>(() => {}), 30, () => {
      timeoutCalls += 1
    })
    mock.timers.tick(29)
    assert.equal(timeoutCalls, 0)
    mock.timers.tick(1)
    assert.equal(timeoutCalls, 1)
    assert.equal(await watched, CYCLE_TIMEOUT)
  })

  it("a late resolution does not change the sentinel result", async () => {
    mock.timers.enable({ apis: ["setTimeout"], now: 1000 })
    const body = deferred<string>()
    const watched = withCycleTimeout(body.promise, 30, () => undefined)
    mock.timers.tick(31)
    assert.equal(await watched, CYCLE_TIMEOUT)
    // The hung body settles after the timeout: same promise, same sentinel,
    // no throw, no replacement value.
    body.resolve("too-late")
    await flushMicrotasks()
    assert.equal(await watched, CYCLE_TIMEOUT)
    mock.timers.tick(1000)
    assert.equal(await watched, CYCLE_TIMEOUT)
  })

  it("a late rejection does not throw and does not fire onTimeout a second time", async () => {
    mock.timers.enable({ apis: ["setTimeout"], now: 1000 })
    let timeoutCalls = 0
    const body = deferred<string>()
    const watched = withCycleTimeout(body.promise, 30, () => {
      timeoutCalls += 1
    })
    mock.timers.tick(31)
    assert.equal(await watched, CYCLE_TIMEOUT)
    body.reject(new Error("network came back angry"))
    await flushMicrotasks()
    assert.equal(timeoutCalls, 1)
    assert.equal(await watched, CYCLE_TIMEOUT)
  })

  it("never throws even when onTimeout itself throws", async () => {
    mock.timers.enable({ apis: ["setTimeout"], now: 1000 })
    const watched = withCycleTimeout(new Promise<string>(() => {}), 30, () => {
      throw new Error("onTimeout exploded")
    })
    mock.timers.tick(31)
    assert.equal(await watched, CYCLE_TIMEOUT)
  })

  it("propagates a body rejection that arrives before the timeout, then clears the timer", async () => {
    mock.timers.enable({ apis: ["setTimeout"], now: 1000 })
    let timeoutCalls = 0
    const failure = new Error("cycle failed fast")
    const failing = deferred<string>()
    const watched = withCycleTimeout(failing.promise, 30, () => {
      timeoutCalls += 1
    })
    failing.reject(failure)
    await assert.rejects(watched, (err: unknown) => err === failure)
    // The watchdog timer was cleared on the fast reject path: past the budget
    // it still never fires.
    mock.timers.tick(1000)
    assert.equal(timeoutCalls, 0)
  })

  it("ships the engine cycle budgets", () => {
    assert.equal(POLL_CYCLE_TIMEOUT_MS, 20 * 60 * 1000)
    assert.equal(FOLLOW_UP_CYCLE_TIMEOUT_MS, 8 * 60 * 1000)
  })
})
