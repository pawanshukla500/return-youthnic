/**
 * Poll-cycle guards for the engine worker loop.
 *
 * These two decisions were the source of two CodeAnt findings on PR #35, and
 * both are pure so they can be tested without starting a server or a browser:
 *
 *   1. A manual "Poll Now" must run exactly one cycle even while the worker is
 *      paused, while a scheduled poll must not run at all when paused.
 *   2. A route that would open a second browser on a supplier profile must see
 *      that a cycle is in flight, not just that a job is being processed. The
 *      processing flag is only set after the queue lease returns, so testing it
 *      alone leaves a window where the engine looks idle but is about to launch.
 */

export type PollCycleState = {
  /** The continuous worker is switched on. */
  workerRunning: boolean
  /** A cycle is already in flight, from the queue lease through browser teardown. */
  pollInFlight: boolean
  /** A supplier login browser holds the shared profile. */
  portalBrowserHeld: boolean
  /**
   * A supplier login test is running.
   *
   * It pauses the poller and drives the profile itself, so it sets neither
   * `workerRunning` (it forces it off) nor `pollInFlight`. Without this the
   * manual one-shot would bypass the paused check and launch a claim browser on
   * the same profile the login test is using.
   */
  portalTestInFlight?: boolean
  /** A one-shot "Poll Now" rather than the scheduled chain. */
  manual?: boolean
}

/**
 * True when a poll cycle may start.
 *
 * `manual` bypasses only the paused check. Every other guard still applies: a
 * one-shot must never overlap a cycle already running, and it must never open a
 * browser while the login flow — a held browser or a running login test — owns
 * the profile.
 */
export function shouldRunPollCycle(state: PollCycleState): boolean {
  if (!state.workerRunning && !state.manual) return false
  if (state.pollInFlight) return false
  if (state.portalBrowserHeld) return false
  if (state.portalTestInFlight) return false
  return true
}

/**
 * True while the engine must be treated as busy.
 *
 * `isCurrentlyProcessing` is set only after the queue lease returns a job, so it
 * misses the lease window. `pollInFlight` covers the whole cycle. `portalTestInFlight`
 * covers a supplier login test, which pauses the poller and drives the supplier
 * profile itself, so it sets neither of the other two. Routes that would start a
 * browser on a supplier profile test this so they cannot race a claim that is
 * about to launch, or a login test that already owns the profile.
 */
export function engineBusy(state: {
  isCurrentlyProcessing: boolean
  pollInFlight: boolean
  portalTestInFlight?: boolean
}): boolean {
  return state.isCurrentlyProcessing || state.pollInFlight || Boolean(state.portalTestInFlight)
}

/**
 * True when a browser already owns a supplier profile.
 *
 * `engineBusy()` covers the engine's own cycles and a running login test. A
 * browser left open by the manual-login flow is the third case: the poll cycle
 * refuses to run until it closes, so a route that would queue work for that
 * profile must refuse too, or the claim is accepted and then never picked up.
 */
export function supplierProfileInUse(state: {
  isCurrentlyProcessing: boolean
  pollInFlight: boolean
  portalTestInFlight?: boolean
  portalBrowserHeld: boolean
}): boolean {
  return engineBusy(state) || state.portalBrowserHeld
}
