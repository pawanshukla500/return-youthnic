import { isWithinNightlyWindow, msUntilNightlyWindow, nextNightlyWindowStart } from "../../server/nightly-window.js"

/**
 * Engine-side nightly gate for follow-up ticket checks.
 *
 * The server only hands out due tickets and aligns reschedules into the
 * 01:00-02:00 Asia/Kolkata window; this gate stops the engine from even
 * leasing outside it. Due rows simply wait for the next window (an expired
 * lease returns to `scheduled`), so a PC that is offline during the window
 * loses nothing. `FOLLOWUP_NIGHTLY_ONLY=0` restores the previous
 * check-whenever-due behaviour for operators who need it.
 */

export function nightlyFollowUpOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.FOLLOWUP_NIGHTLY_ONLY ?? "1")
    .trim()
    .toLowerCase()
  return !["0", "false", "no", "off"].includes(raw)
}

/** True when this cycle must not lease a ticket right now. */
export function shouldSkipFollowUpCycle(now: Date, nightlyOnly: boolean): boolean {
  return nightlyOnly && !isWithinNightlyWindow(now)
}

export type NightlyWindowStatus = {
  nightlyOnly: boolean
  inWindow: boolean
  nextWindowStartIso: string
  msUntilWindow: number
}

export function nightlyWindowStatus(now: Date, env: NodeJS.ProcessEnv = process.env): NightlyWindowStatus {
  const nightlyOnly = nightlyFollowUpOnly(env)
  const inWindow = isWithinNightlyWindow(now)
  return {
    nightlyOnly,
    inWindow,
    nextWindowStartIso: nextNightlyWindowStart(now).toISOString(),
    msUntilWindow: msUntilNightlyWindow(now),
  }
}
