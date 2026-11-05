import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { followUpStateLabel, whenText } from "./FollowUps.js"

const NOW = Date.parse("2026-11-04T12:00:00.000Z")

describe("whenText", () => {
  it("renders a dash when the timestamp is missing or unparseable", () => {
    assert.equal(whenText(null, NOW), "—")
    assert.equal(whenText(undefined, NOW), "—")
    assert.equal(whenText("", NOW), "—")
    assert.equal(whenText("not-a-date", NOW), "—")
  })

  it("renders 'just now' within the same minute", () => {
    assert.equal(whenText("2026-11-04T12:00:00.000Z", NOW), "just now")
    assert.equal(whenText("2026-11-04T11:59:30.000Z", NOW), "just now")
  })

  it("renders minutes, hours and days for past times", () => {
    assert.equal(whenText("2026-11-04T11:55:00.000Z", NOW), "5m ago")
    assert.equal(whenText("2026-11-04T10:30:00.000Z", NOW), "2h ago")
    assert.equal(whenText("2026-11-04T00:00:00.000Z", NOW), "12h ago")
    assert.equal(whenText("2026-11-01T12:00:00.000Z", NOW), "3d ago")
  })

  it("renders relative times for future checks", () => {
    assert.equal(whenText("2026-11-04T12:10:00.000Z", NOW), "in 10m")
    assert.equal(whenText("2026-11-04T17:00:00.000Z", NOW), "in 5h")
    assert.equal(whenText("2026-11-07T12:00:00.000Z", NOW), "in 3d")
  })
})

describe("followUpStateLabel", () => {
  it("reports the error streak for an active follow-up that keeps failing", () => {
    assert.equal(
      followUpStateLabel({ isActive: true, errorStreak: 3, checkIntervalHours: 48, stopReason: "" }),
      "errors ×3",
    )
  })

  it("reports the check cadence for a healthy active follow-up", () => {
    assert.equal(
      followUpStateLabel({ isActive: true, errorStreak: 0, checkIntervalHours: 48, stopReason: "" }),
      "checking every 48h",
    )
    assert.equal(
      followUpStateLabel({ isActive: true, errorStreak: 0, checkIntervalHours: 24, stopReason: "" }),
      "checking every 24h",
    )
  })

  it("maps every stop reason to its short label", () => {
    const stopped = { isActive: false, errorStreak: 0, checkIntervalHours: 48 }
    assert.equal(followUpStateLabel({ ...stopped, stopReason: "ticket_resolved" }), "resolved")
    assert.equal(followUpStateLabel({ ...stopped, stopReason: "check_not_supported" }), "tracking not supported")
    assert.equal(followUpStateLabel({ ...stopped, stopReason: "repeated_errors" }), "stopped: repeated errors")
    assert.equal(followUpStateLabel({ ...stopped, stopReason: "max_checks_reached" }), "stopped: max checks")
  })

  it("falls back to a generic stopped label for unknown or missing reasons", () => {
    const stopped = { isActive: false, errorStreak: 0, checkIntervalHours: 48 }
    assert.equal(followUpStateLabel({ ...stopped, stopReason: "mystery" }), "stopped")
    assert.equal(followUpStateLabel({ ...stopped, stopReason: "" }), "stopped")
    assert.equal(followUpStateLabel({ ...stopped, stopReason: null }), "stopped")
  })
})
