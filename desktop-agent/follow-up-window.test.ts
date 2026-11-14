// Checks for the engine-side nightly gate: by default follow-up cycles lease
// whenever a ticket is due; FOLLOWUP_NIGHTLY_ONLY=1 opts back into leasing
// only inside the 01:00-02:00 Asia/Kolkata window.

import test from "node:test"
import assert from "node:assert/strict"
import {
  nightlyFollowUpOnly,
  nightlyWindowStatus,
  shouldSkipFollowUpCycle,
} from "./src/follow-up-window.ts"

const INSIDE_WINDOW = new Date("2026-01-31T20:00:00.000Z") // 01:30 IST
const OUTSIDE_WINDOW = new Date("2026-02-02T12:00:00.000Z") // 17:30 IST

test("check-whenever-due is the default and explicit values parse", () => {
  assert.equal(nightlyFollowUpOnly({} as NodeJS.ProcessEnv), false)
  assert.equal(nightlyFollowUpOnly({ FOLLOWUP_NIGHTLY_ONLY: "1" } as NodeJS.ProcessEnv), true)
  for (const value of ["0", "false", "no", "off", "OFF"]) {
    assert.equal(nightlyFollowUpOnly({ FOLLOWUP_NIGHTLY_ONLY: value } as NodeJS.ProcessEnv), false, value)
  }
})

test("cycles outside the window are skipped only when nightly-only is opted into", () => {
  assert.equal(shouldSkipFollowUpCycle(OUTSIDE_WINDOW, true), true)
  assert.equal(shouldSkipFollowUpCycle(INSIDE_WINDOW, true), false)
})

test("check-whenever-due never skips a cycle, at any hour", () => {
  assert.equal(shouldSkipFollowUpCycle(OUTSIDE_WINDOW, false), false)
  assert.equal(shouldSkipFollowUpCycle(INSIDE_WINDOW, false), false)
})

test("window status exposes the next window for the dashboard", () => {
  const status = nightlyWindowStatus(OUTSIDE_WINDOW, {} as NodeJS.ProcessEnv)
  assert.equal(status.nightlyOnly, false)
  assert.equal(status.inWindow, false)
  assert.equal(status.nextWindowStartIso, "2026-02-02T19:30:00.000Z")
  assert.equal(status.msUntilWindow, 7.5 * 60 * 60 * 1000)
  const inside = nightlyWindowStatus(INSIDE_WINDOW, {} as NodeJS.ProcessEnv)
  assert.equal(inside.inWindow, true)
  assert.equal(inside.msUntilWindow, 0)
  const optedIn = nightlyWindowStatus(OUTSIDE_WINDOW, { FOLLOWUP_NIGHTLY_ONLY: "1" } as NodeJS.ProcessEnv)
  assert.equal(optedIn.nightlyOnly, true)
  assert.equal(optedIn.inWindow, false)
})
