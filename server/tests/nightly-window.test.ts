// Pure checks for the nightly tracking window (Asia/Kolkata 01:00-02:00) and the
// 48-hour eligibility rule. No database, no network, no clock dependency: every
// case uses a fixed instant.

import test from "node:test"
import assert from "node:assert/strict"
import {
  FOLLOW_UP_ELIGIBILITY_HOURS,
  isEligibleForNightlyCheck,
  isWithinNightlyWindow,
  istWallClock,
  msUntilNightlyWindow,
  nextEligibleCheckAt,
  nextNightlyWindowStart,
  nightlyWindowStartForIstDay,
  NIGHTLY_WINDOW_END_HOUR_IST,
  NIGHTLY_WINDOW_START_HOUR_IST,
} from "../nightly-window.js"

test("the window is 01:00-02:00 Asia/Kolkata", () => {
  assert.equal(NIGHTLY_WINDOW_START_HOUR_IST, 1)
  assert.equal(NIGHTLY_WINDOW_END_HOUR_IST, 2)
  assert.equal(FOLLOW_UP_ELIGIBILITY_HOURS, 48)
})

test("fixed instants convert to the expected IST wall clock", () => {
  // 2026-06-01T00:00:00Z is 05:30 IST (IST has no daylight saving).
  assert.equal(istWallClock(new Date("2026-06-01T00:00:00.000Z")).hour, 5)
  // 2026-01-31T19:30:00Z is exactly 01:00 IST on 2026-02-01.
  const wall = istWallClock(new Date("2026-01-31T19:30:00.000Z"))
  assert.equal(wall.hour, 1)
  assert.equal(wall.minute, 0)
  assert.equal(wall.day, 1)
})

test("the window covers [01:00, 02:00) IST and nothing else", () => {
  assert.equal(isWithinNightlyWindow(new Date("2026-01-31T19:30:00.000Z")), true) // 01:00 IST
  assert.equal(isWithinNightlyWindow(new Date("2026-01-31T20:15:00.000Z")), true) // 01:45 IST
  assert.equal(isWithinNightlyWindow(new Date("2026-01-31T20:29:59.000Z")), true) // 01:59:59 IST
  assert.equal(isWithinNightlyWindow(new Date("2026-01-31T19:29:59.000Z")), false) // 00:59:59 IST
  assert.equal(isWithinNightlyWindow(new Date("2026-01-31T20:30:00.000Z")), false) // 02:00 IST sharp
  assert.equal(isWithinNightlyWindow(new Date("2026-01-31T12:00:00.000Z")), false) // 17:30 IST
})

test("eligibility anchors on the submission timestamp at >= 48h", () => {
  const now = new Date("2026-03-10T10:00:00.000Z")
  assert.equal(isEligibleForNightlyCheck(new Date("2026-03-08T10:00:00.000Z"), now), true) // exactly 48h
  assert.equal(isEligibleForNightlyCheck(new Date("2026-03-08T09:00:00.000Z"), now), true) // 49h
  assert.equal(isEligibleForNightlyCheck(new Date("2026-03-08T10:00:01.000Z"), now), false) // 1s short
  assert.equal(isEligibleForNightlyCheck(new Date("2026-03-10T11:00:00.000Z"), now), false) // future
  assert.equal(isEligibleForNightlyCheck(new Date("not-a-date"), now), false)
})

test("the next window start is the coming 01:00 IST", () => {
  // Monday 2026-02-02 17:30 IST -> Tuesday 01:00 IST == Monday 19:30Z.
  assert.equal(
    nextNightlyWindowStart(new Date("2026-02-02T12:00:00.000Z")).toISOString(),
    "2026-02-02T19:30:00.000Z",
  )
  // Exactly at 01:00 IST stays on the same window.
  assert.equal(
    nextNightlyWindowStart(new Date("2026-02-02T19:30:00.000Z")).toISOString(),
    "2026-02-02T19:30:00.000Z",
  )
  // Inside the window, the day-start helper still points at 01:00.
  assert.equal(
    nightlyWindowStartForIstDay(new Date("2026-02-02T20:00:00.000Z")).toISOString(),
    "2026-02-02T19:30:00.000Z",
  )
})

test("a 48h candidate inside the window is kept, otherwise it moves to the next window", () => {
  // Wednesday 01:30 IST + 48h = Friday 01:30 IST: inside the window, kept.
  assert.equal(
    nextEligibleCheckAt(new Date("2026-02-03T20:00:00.000Z")).toISOString(),
    "2026-02-05T20:00:00.000Z",
  )
  // Monday 10:00 IST + 48h = Wednesday 10:00 IST: outside, moves to Thursday 01:00 IST.
  assert.equal(
    nextEligibleCheckAt(new Date("2026-02-02T04:30:00.000Z")).toISOString(),
    "2026-02-04T19:30:00.000Z",
  )
})

test("milliseconds-until-window is zero inside the window", () => {
  assert.equal(msUntilNightlyWindow(new Date("2026-01-31T20:00:00.000Z")), 0)
  assert.equal(msUntilNightlyWindow(new Date("2026-02-02T12:00:00.000Z")), 7.5 * 60 * 60 * 1000)
})
