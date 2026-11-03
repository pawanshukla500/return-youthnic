import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isSafeToSubmitBundle } from "./src/submit-guard.js"

/** M8 F4: the pre-submit gate stops stale runs before the portal is touched. */
describe("pre-submit bundle gate", () => {
  it("lets an actively leased, fileable job through", () => {
    assert.deepEqual(isSafeToSubmitBundle("downloading_media", "ready_for_claim"), { ok: true })
    assert.deepEqual(isSafeToSubmitBundle("submitting", "processing"), { ok: true })
    assert.deepEqual(isSafeToSubmitBundle("approved", "escalated"), { ok: true })
    assert.deepEqual(isSafeToSubmitBundle("prepared", "reclaim"), { ok: true })
  })

  it("stops a job that finished, failed, or was re-queued since the lease", () => {
    for (const stage of ["completed", "queued", "failed", "not_eligible", "manual_intervention_required", ""]) {
      const verdict = isSafeToSubmitBundle(stage, "ready_for_claim")
      assert.equal(verdict.ok, false, `stage ${stage || "<missing>"} must abort`)
    }
  })

  it("stops a run whose claim already has a recorded outcome", () => {
    for (const claim of ["submitted", "under_review", "approved", "rejected", "reconciled", "paid"]) {
      const verdict = isSafeToSubmitBundle("submitting", claim)
      assert.equal(verdict.ok, false, `claim ${claim} must abort`)
    }
  })

  it("fails closed on claim states that are not explicitly fileable", () => {
    for (const claim of ["pending_evidence", "waiting_for_approval", "manual_action_required", "failed", "", "SYN-unknown"]) {
      const verdict = isSafeToSubmitBundle("submitting", claim)
      assert.equal(verdict.ok, false, `claim ${claim || "<missing>"} must abort`)
    }
  })
})
