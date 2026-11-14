import { isWithinNightlyWindow, msUntilNightlyWindow, nextNightlyWindowStart } from "../../server/nightly-window.js"

/**
 * Engine-side nightly gate for follow-up ticket checks.
 *
 * Default behaviour is check-whenever-due: the server only hands out due
 * tickets, the look-up is a cheap poll, and the operator evidence is that a
 * nightly-only engine starves follow-ups on any PC that is not running inside
 * the 01:00-02:00 Asia/Kolkata window. Operators who still want the engine to
 * lease only inside that window opt in with FOLLOWUP_NIGHTLY_ONLY=1; due rows
 * outside it then wait for the next window (an expired lease returns to
 * `scheduled`), so a PC that is offline during the window loses nothing.
 */

export function nightlyFollowUpOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.FOLLOWUP_NIGHTLY_ONLY ?? "0")
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
