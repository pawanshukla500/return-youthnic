import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isSafeToSubmitBundle } from "./src/submit-guard.js"

/** M8 F4: the pre-submit gate stops stale runs before the portal is touched. */
/** M9: a saved supplier login never authorizes submission — only the backend-issued submitting lease does. */
describe("pre-submit bundle gate", () => {
  it("lets an actively leased, fileable submitting job through when approval is required", () => {
    assert.deepEqual(isSafeToSubmitBundle("submitting", "processing"), { ok: true })
    assert.deepEqual(isSafeToSubmitBundle("submitting", "ready_for_claim"), { ok: true })
    assert.deepEqual(isSafeToSubmitBundle("submitting", "escalated"), { ok: true })
  })

  it("stops a non-submitting stage when approval is required, even with a saved login", () => {
    // A saved supplier login must never arm submission: without the
    // backend-issued submitting lease every other stage aborts.
    for (const stage of ["downloading_media", "opening_portal", "filling_form", "approved", "prepared"]) {
      const verdict = isSafeToSubmitBundle(stage, "ready_for_claim")
      assert.equal(verdict.ok, false, `stage ${stage} must abort when approval is required`)
    }
  })

  it("lets an auto-submit account proceed from a leased stage without the submitting state", () => {
    assert.deepEqual(isSafeToSubmitBundle("downloading_media", "ready_for_claim", false), { ok: true })
    assert.deepEqual(isSafeToSubmitBundle("prepared", "processing", false), { ok: true })
    assert.deepEqual(isSafeToSubmitBundle("submitting", "processing", false), { ok: true })
  })

  it("still stops finished, failed, or re-queued jobs for auto-submit accounts", () => {
    for (const stage of ["completed", "queued", "failed", "not_eligible", "manual_intervention_required", ""]) {
      const verdict = isSafeToSubmitBundle(stage, "ready_for_claim", false)
      assert.equal(verdict.ok, false, `stage ${stage || "<missing>"} must abort`)
    }
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
