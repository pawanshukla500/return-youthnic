/**
 * Per-cycle watchdog for the engine's two worker loops.
 *
 * Root cause of the 2026-11-17 silent-engine incident: an internet outage made
 * one backend fetch hang indefinitely inside a poll cycle. The cycle never
 * returned, pollInFlight stayed true, and because every later poll and
 * follow-up cycle is gated on those flags, both worker loops went quiet with
 * no error logged. Racing each cycle against a hard ceiling makes any hung
 * await self-heal: onTimeout force-resets the in-flight flags, the sentinel
 * returns, and the loops resume on their normal cadence.
 */

/**
 * Returned by withCycleTimeout when the timer wins the race. A unique symbol
 * so a cycle result can never collide with it.
 */
export const CYCLE_TIMEOUT: unique symbol = Symbol("cycle-timeout")

/** Hard ceiling for one filing poll cycle (lease through browser teardown). */
export const POLL_CYCLE_TIMEOUT_MS = 20 * 60 * 1000

/** Hard ceiling for one follow-up ticket check. */
export const FOLLOW_UP_CYCLE_TIMEOUT_MS = 8 * 60 * 1000

/**
 * Race a cycle body against a hard timeout. Resolves with the body's value
 * when the body wins, or with CYCLE_TIMEOUT after `timeoutMs` when it does
 * not. `onTimeout` runs exactly once, synchronously, before the sentinel
 * resolves; a throwing onTimeout is swallowed. A body that settles after the
 * timeout neither changes the result nor surfaces a late rejection — the
 * watchdog never throws and never leaks its timer.
 */
export function withCycleTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T | typeof CYCLE_TIMEOUT> {
  return new Promise<T | typeof CYCLE_TIMEOUT>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      try {
        onTimeout()
      } catch {
        // The watchdog must never throw into the worker loop.
      }
      resolve(CYCLE_TIMEOUT)
    }, timeoutMs)
    // A watchdog timer must never be the reason the 24/7 engine stays alive.
    timer.unref()
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
