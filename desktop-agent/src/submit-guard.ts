/**
 * Pre-submit revalidation for the desktop claim worker (M8 F4, hardened in M9).
 *
 * Minutes can pass between the queue lease (evidence download, browser work)
 * and the moment the engine would click Submit on the supplier portal. In that
 * window an operator may have retried the job, another agent may have filed it,
 * or the claim may have gained a recorded outcome. The engine re-fetches the
 * execution bundle just before submitting and runs this pure gate; anything
 * that is not actively fileable stops the run before the portal is touched.
 *
 * Fail-closed: unknown stages or statuses abort. The server re-checks the same
 * conditions atomically in completeJobSubmission; this gate exists so a stale
 * run never files a real portal ticket that the server would then have to 409.
 *
 * M9: a saved supplier login (or any local cookie/marker state) never counts
 * as submission authorization. When the account requires approval, only the
 * backend-issued `submitting` lease authorizes the portal click.
 */

export const SUBMIT_BLOCKED_JOB_STAGES: ReadonlySet<string> = new Set([
  "queued", // re-queued by retry; this run no longer holds the lease
  "completed", // already filed; a second portal ticket would be a duplicate
  "failed",
  "not_eligible",
  "manual_intervention_required",
])

/** Claim lifecycle states that already record an outcome: filing again would duplicate. */
export const SUBMIT_BLOCKED_CLAIM_STATUSES: ReadonlySet<string> = new Set([
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "reconciled",
  "paid",
])

/** Claim states a submit run may proceed with. Mirrors the server lease allowlist. */
export const SUBMITTABLE_CLAIM_STATUSES: ReadonlySet<string> = new Set([
  "ready_for_claim",
  "processing",
  "reclaim",
  "escalated",
])

export function isSafeToSubmitBundle(
  stage: string | null | undefined,
  claimStatus: string | null | undefined,
  /**
   * True (default) when the account requires explicit approval: only the
   * backend-issued `submitting` lease authorizes the portal click. False for
   * auto-submit accounts, where the credential flag is the standing
   * authorization and the gate checks only freshness and recorded outcomes.
   * A saved supplier login never satisfies either path.
   */
  approvalRequired: boolean = true,
): { ok: true } | { ok: false; reason: string } {
  const jobStage = String(stage || "").trim()
  const claim = String(claimStatus || "").trim()
  if (!jobStage) return { ok: false, reason: "Job no longer exists on the server; the run stops before touching the portal." }
  if (approvalRequired && jobStage !== "submitting") {
    return {
      ok: false,
      reason: `Job is in stage ${jobStage}, not the authorized submitting state; approval is required before the portal is touched.`,
    }
  }
  if (SUBMIT_BLOCKED_JOB_STAGES.has(jobStage)) {
    return {
      ok: false,
      reason: `Job moved to ${jobStage} since the lease; the run stops before touching the portal.`,
    }
  }
  if (!claim) {
    return { ok: false, reason: "Claim status is unknown; the run stops before touching the portal." }
  }
  if (SUBMIT_BLOCKED_CLAIM_STATUSES.has(claim)) {
    return {
      ok: false,
      reason: `Claim already has recorded outcome ${claim}; filing again would duplicate the ticket.`,
    }
  }
  if (!SUBMITTABLE_CLAIM_STATUSES.has(claim)) {
    return {
      ok: false,
      reason: `Claim in status ${claim} is not fileable; the run stops before touching the portal.`,
    }
  }
  return { ok: true }
}
