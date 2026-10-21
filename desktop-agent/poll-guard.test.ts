import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { engineBusy, shouldRunPollCycle } from "./src/poll-guard.js"

/**
 * These two rules were CodeAnt findings on PR #35. Both are easy to undo by
 * accident while refactoring the worker loop, so they are pinned here.
 */

describe("poll cycle guard", () => {
  it("runs a scheduled cycle only while the worker is on", () => {
    assert.equal(shouldRunPollCycle({ workerRunning: true, pollInFlight: false, portalBrowserHeld: false }), true)
    assert.equal(shouldRunPollCycle({ workerRunning: false, pollInFlight: false, portalBrowserHeld: false }), false)
  })

  it("runs a manual Poll Now even while the worker is paused", () => {
    // The operator paused continuous filing; a one-shot check is not consent to
    // resume it, but the check itself must still happen.
    assert.equal(
      shouldRunPollCycle({ workerRunning: false, pollInFlight: false, portalBrowserHeld: false, manual: true }),
      true,
    )
  })

  it("never overlaps a cycle that is already in flight, manual or not", () => {
    assert.equal(shouldRunPollCycle({ workerRunning: true, pollInFlight: true, portalBrowserHeld: false }), false)
    assert.equal(
      shouldRunPollCycle({ workerRunning: false, pollInFlight: true, portalBrowserHeld: false, manual: true }),
      false,
    )
  })

  it("never starts while a supplier login browser holds the profile, manual or not", () => {
    assert.equal(shouldRunPollCycle({ workerRunning: true, pollInFlight: false, portalBrowserHeld: true }), false)
    assert.equal(
      shouldRunPollCycle({ workerRunning: false, pollInFlight: false, portalBrowserHeld: true, manual: true }),
      false,
    )
  })
})

describe("engine busy guard", () => {
  it("reports busy while a job is being processed", () => {
    assert.equal(engineBusy({ isCurrentlyProcessing: true, pollInFlight: false }), true)
  })

  it("reports busy during the queue lease window, before the job is set", () => {
    // The regression this pins: the processing flag is only set after pollJob()
    // returns, so a route testing it alone could open a second browser on the
    // same supplier profile just as a claim launched.
    assert.equal(engineBusy({ isCurrentlyProcessing: false, pollInFlight: true }), true)
  })

  it("reports idle only when neither is set", () => {
    assert.equal(engineBusy({ isCurrentlyProcessing: false, pollInFlight: false }), false)
  })

  it("reports busy while a supplier login test is open", () => {
    // A login test pauses the poller and drives the profile itself, so it sets
    // neither of the other two flags. Without this, two concurrent login tests
    // would both pass the busy check and fight over the same profile and port.
    assert.equal(
      engineBusy({ isCurrentlyProcessing: false, pollInFlight: false, portalTestInFlight: true }),
      true,
    )
  })

  it("treats an omitted login-test flag as idle", () => {
    assert.equal(engineBusy({ isCurrentlyProcessing: false, pollInFlight: false, portalTestInFlight: undefined }), false)
  })
})
