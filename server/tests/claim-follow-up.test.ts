// Pure checks for the claim follow-up rules: ticket text normalization, the terminal rules, the claim-status
// mapping, and what one check should do next. No database. The database behaviour (leasing, scoping,
// rescheduling, audit) runs in claim-follow-up-db.test.ts when TEST_DATABASE_URL is set.

import assert from "node:assert/strict"
import test from "node:test"
import type pg from "pg"
import type { AccountScope } from "../access.js"
import {
  claimStatusForFollowUp,
  createFollowUpForJob,
  decideFollowUpStep,
  FOLLOW_UP_INTERVAL_HOURS,
  FOLLOW_UP_MAX_CHECKS,
  FOLLOW_UP_MAX_ERROR_STREAK,
  FOLLOW_UP_TERMINAL_STATUSES,
  isTerminalFollowUpStatus,
  leaseNextDueFollowUp,
  nextCheckAtFrom,
  normalizeFollowUpStatus,
  recordFollowUpResult,
} from "../claim-follow-up-service.js"

test("the cadence is two days and a stopped follow-up is a documented state", () => {
  assert.equal(FOLLOW_UP_INTERVAL_HOURS, 48)
  assert.ok(FOLLOW_UP_TERMINAL_STATUSES.includes("approved"))
  assert.ok(FOLLOW_UP_TERMINAL_STATUSES.includes("rejected"))
  assert.ok(FOLLOW_UP_TERMINAL_STATUSES.includes("paid"))
  assert.ok(FOLLOW_UP_TERMINAL_STATUSES.includes("reconciled"))
})

test("the next check is 48 hours after the last one", () => {
  const from = new Date("2026-01-01T00:00:00.000Z")
  assert.equal(nextCheckAtFrom(from).toISOString(), "2026-01-03T00:00:00.000Z")
  assert.equal(nextCheckAtFrom(from, 12).toISOString(), "2026-01-01T12:00:00.000Z")
})

test("portal ticket text maps to one normalized state", () => {
  const cases: Array<[string, string]> = [
    ["Claim Approved", "approved"],
    ["APPROVED - refund credited", "approved"],
    ["Refund settled on 12/01", "approved"],
    ["Claim Rejected", "rejected"],
    ["Return not eligible for claim", "rejected"],
    ["Payment released", "paid"],
    ["Payment Done", "paid"],
    ["Reconciled against payout", "reconciled"],
    ["Escalated to category team", "escalated"],
    ["Claim under review", "under_review"],
    ["Action Required - customer response pending", "under_review"],
    ["Claim submitted successfully", "submitted"],
    ["Raised", "submitted"],
    ["Ticket open", "submitted"],
    ["Claim reopened by seller", "reclaim"],
    ["Reclaim initiated", "reclaim"],
  ]
  for (const [text, expected] of cases) {
    assert.equal(normalizeFollowUpStatus(text), expected, `"${text}" should normalize to ${expected}`)
  }
})

test("a negative reading is never mistaken for approval", () => {
  assert.equal(normalizeFollowUpStatus("Not approved"), "rejected")
  assert.equal(normalizeFollowUpStatus("Closed without approval"), "rejected")
  assert.equal(normalizeFollowUpStatus("Return not eligible"), "rejected")
})

test("an approval that mentions the refund wins over the wording that follows it", () => {
  assert.equal(normalizeFollowUpStatus("Claim approved. Refund will be credited in 3 days."), "approved")
})

test("unreadable or empty ticket text is unknown and never mistaken for a final state", () => {
  assert.equal(normalizeFollowUpStatus(""), "unknown")
  assert.equal(normalizeFollowUpStatus("   "), "unknown")
  assert.equal(normalizeFollowUpStatus("zzzz"), "unknown")
  assert.equal(isTerminalFollowUpStatus("unknown"), false)
})

test("only the final ticket states end the follow-up", () => {
  assert.equal(isTerminalFollowUpStatus("approved"), true)
  assert.equal(isTerminalFollowUpStatus("rejected"), true)
  assert.equal(isTerminalFollowUpStatus("paid"), true)
  assert.equal(isTerminalFollowUpStatus("reconciled"), true)
  assert.equal(isTerminalFollowUpStatus("closed"), true)
  assert.equal(isTerminalFollowUpStatus("resolved"), true)
  assert.equal(isTerminalFollowUpStatus("under_review"), false)
  assert.equal(isTerminalFollowUpStatus("submitted"), false)
  assert.equal(isTerminalFollowUpStatus("escalated"), false)
})

test("a normalized ticket state maps to a real claim lifecycle status", () => {
  assert.equal(claimStatusForFollowUp("approved"), "approved")
  assert.equal(claimStatusForFollowUp("rejected"), "rejected")
  assert.equal(claimStatusForFollowUp("paid"), "paid")
  assert.equal(claimStatusForFollowUp("reconciled"), "reconciled")
  assert.equal(claimStatusForFollowUp("under_review"), "under_review")
  assert.equal(claimStatusForFollowUp("escalated"), "escalated")
  assert.equal(claimStatusForFollowUp("reclaim"), "reclaim")
  // States that do not change the claim status on their own.
  assert.equal(claimStatusForFollowUp("submitted"), null)
  assert.equal(claimStatusForFollowUp("unknown"), null)
  assert.equal(claimStatusForFollowUp(""), null)
})

test("a status read keeps the follow-up active and counts against the budget", () => {
  const step = decideFollowUpStep({ outcome: "status_read", normalizedStatus: "under_review", checkCount: 3, errorStreak: 0 })
  assert.equal(step.stopReason, "")
  assert.equal(step.countAsCheck, true)
  assert.equal(step.countAsError, false)
})

test("a final ticket state stops the follow-up", () => {
  for (const status of ["approved", "rejected", "paid", "reconciled"]) {
    const step = decideFollowUpStep({ outcome: "status_read", normalizedStatus: status, checkCount: 2, errorStreak: 0 })
    assert.equal(step.stopReason, "ticket_resolved", `${status} should stop the follow-up`)
    assert.equal(step.countAsCheck, true)
  }
})

test("a status read also clears an earlier failure streak", () => {
  const step = decideFollowUpStep({ outcome: "status_read", normalizedStatus: "submitted", checkCount: 1, errorStreak: 2 })
  assert.equal(step.countAsError, false)
})

test("a marketplace with no status reader stops instead of opening its portal every two days", () => {
  const step = decideFollowUpStep({ outcome: "not_supported", checkCount: 0, errorStreak: 0 })
  assert.equal(step.stopReason, "check_not_supported")
  assert.equal(step.countAsCheck, false)
  assert.equal(step.countAsError, false)
})

test("an expired sign-in is not an error and not a spent check", () => {
  const step = decideFollowUpStep({ outcome: "login_required", checkCount: 5, errorStreak: 2 })
  assert.equal(step.stopReason, "")
  assert.equal(step.countAsCheck, false)
  assert.equal(step.countAsError, false)
})

test("the check budget is bounded so a stuck ticket cannot be chased forever", () => {
  const last = decideFollowUpStep({
    outcome: "status_read",
    normalizedStatus: "under_review",
    checkCount: FOLLOW_UP_MAX_CHECKS - 1,
    errorStreak: 0,
  })
  assert.equal(last.stopReason, "max_checks_reached")
})

test("repeated failures stop the follow-up so a human looks at it", () => {
  const first = decideFollowUpStep({ outcome: "error", checkCount: 1, errorStreak: 0 })
  assert.equal(first.stopReason, "")
  assert.equal(first.countAsError, true)

  const last = decideFollowUpStep({ outcome: "error", checkCount: 2, errorStreak: FOLLOW_UP_MAX_ERROR_STREAK - 1 })
  assert.equal(last.stopReason, "repeated_errors")
  assert.equal(last.countAsError, true)
})

test("a ticket that cannot be found is retried, then stopped like a failure", () => {
  const retry = decideFollowUpStep({ outcome: "not_found", checkCount: 0, errorStreak: 0 })
  assert.equal(retry.stopReason, "")
  assert.equal(retry.countAsCheck, true)

  const stopped = decideFollowUpStep({ outcome: "not_found", checkCount: 0, errorStreak: FOLLOW_UP_MAX_ERROR_STREAK - 1 })
  assert.equal(stopped.stopReason, "repeated_errors")
})

// ---------------------------------------------------------------------------------------------------------------
// SQL wiring. A fake pool records the statements and parameters so a wrong placeholder, a missing scope
// condition, or an inverted is_active is caught here rather than against a live database.
// ---------------------------------------------------------------------------------------------------------------

type Captured = { sql: string; params: unknown[] }

function fakeDb(options: { agentAuthorized?: boolean; due?: Record<string, unknown> | null; lease?: Record<string, unknown> | null } = {}) {
  const queries: Captured[] = []
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params })
      if (/FROM claim_automation_agents/.test(sql)) {
        const authorized = options.agentAuthorized !== false
        return { rows: authorized ? [{ id: 11 }] : [], rowCount: authorized ? 1 : 0 }
      }
      // A follow-up read that locks one specific row is the record step's lease lookup.
      if (/f\.agent_id = \$2/.test(sql)) {
        return { rows: options.lease ? [options.lease] : [], rowCount: options.lease ? 1 : 0 }
      }
      // A follow-up read that filters on the due time is the lease step's queue lookup.
      if (/f\.next_check_at <= now\(\)/.test(sql)) {
        return { rows: options.due ? [options.due] : [], rowCount: options.due ? 1 : 0 }
      }
      return { rows: [], rowCount: 0 }
    },
    release: () => undefined,
  }
  return {
    pool: { connect: async () => client } as unknown as pg.Pool,
    client: client as unknown as pg.PoolClient,
    queries,
  }
}

function matching(queries: Captured[], pattern: RegExp): Captured[] {
  return queries.filter((q) => pattern.test(q.sql))
}

const allAccounts: AccountScope = { all: true }
const oneAccount: AccountScope = { all: false, marketplaceIds: [7] }

test("filing completion creates one follow-up per claim and re-arms an existing one", async () => {
  const db = fakeDb()
  await createFollowUpForJob(db.client, 55, "MEESHO-12345")

  const inserts = matching(db.queries, /INSERT INTO claim_automation_follow_ups/)
  assert.equal(inserts.length, 1)
  assert.match(inserts[0].sql, /ON CONFLICT \(claim_id\) DO UPDATE/)
  assert.match(inserts[0].sql, /is_active = true/)
  assert.match(inserts[0].sql, /next_check_at = EXCLUDED\.next_check_at/)
  // Re-filing resets the counters, so the ticket starts its 2-day cycle again.
  assert.match(inserts[0].sql, /check_count = 0/)
  assert.deepEqual(inserts[0].params, [55, "MEESHO-12345", FOLLOW_UP_INTERVAL_HOURS])
})

test("filing completion writes nothing when the ticket reference is empty", async () => {
  const db = fakeDb()
  await createFollowUpForJob(db.client, 55, "   ")
  assert.equal(db.queries.length, 0)
})

test("leasing recovers an expired check lease before handing out work", async () => {
  const db = fakeDb({ due: null })
  await leaseNextDueFollowUp(db.pool, "agent-uuid", allAccounts)

  const recovery = matching(db.queries, /SET stage = 'scheduled',/)
  assert.equal(recovery.length, 1, "an expired lease is returned to the queue")
  assert.match(recovery[0].sql, /WHERE stage = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < now\(\)/)
})

test("leasing takes the oldest due ticket, only when it is active and unleased", async () => {
  const db = fakeDb({
    due: { id: 9, claim_id: 4, marketplace_claim_id: "AJIO-77", account_name: "vb-ajio", marketplace: "Ajio", portal_url: "https://supplier.ajio.com/returns" },
  })
  const lease = await leaseNextDueFollowUp(db.pool, "agent-uuid", allAccounts)

  const queueRead = matching(db.queries, /f\.next_check_at <= now\(\)/)
  assert.equal(queueRead.length, 1)
  assert.match(queueRead[0].sql, /f\.is_active = true/)
  assert.match(queueRead[0].sql, /f\.stage = 'scheduled'/)
  assert.match(queueRead[0].sql, /ORDER BY f\.next_check_at ASC/)
  assert.match(queueRead[0].sql, /FOR UPDATE OF f SKIP LOCKED/)

  const leaseWrite = matching(db.queries, /SET stage = 'leased'/)
  assert.equal(leaseWrite.length, 1)
  assert.deepEqual(leaseWrite[0].params, [9, 11, 15])

  assert.deepEqual(lease, {
    followUpId: 9,
    claimId: 4,
    marketplace: "Ajio",
    accountName: "vb-ajio",
    marketplaceClaimId: "AJIO-77",
    portalUrl: "https://supplier.ajio.com/returns",
  })
})

test("leasing narrows the queue to the accounts the enrolling user may see", async () => {
  const db = fakeDb({ due: null })
  await leaseNextDueFollowUp(db.pool, "agent-uuid", oneAccount)

  const queueRead = matching(db.queries, /f\.next_check_at <= now\(\)/)
  assert.match(queueRead[0].sql, /c\.marketplace_id = ANY\(\$1::integer\[\]\)/)
  assert.deepEqual(queueRead[0].params, [[7]])
})

test("an unauthorized agent leases nothing", async () => {
  const db = fakeDb({ agentAuthorized: false, due: { id: 9 } })
  assert.equal(await leaseNextDueFollowUp(db.pool, "agent-uuid", allAccounts), null)
  assert.equal(matching(db.queries, /FOR UPDATE OF f SKIP LOCKED/).length, 0)
})

test("an idle queue leases nothing and still commits", async () => {
  const db = fakeDb({ due: null })
  assert.equal(await leaseNextDueFollowUp(db.pool, "agent-uuid", allAccounts), null)
  assert.equal(matching(db.queries, /SET stage = 'leased'/).length, 0)
  assert.ok(matching(db.queries, /^COMMIT$/).length >= 1)
})

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    claim_id: 4,
    check_count: 1,
    error_streak: 0,
    status_at_last_check: "submitted",
    marketplace_claim_id: "AJIO-77",
    marketplace_id: 7,
    marketplace: "Ajio",
    claim_status: "submitted",
    ...overrides,
  }
}

test("a status read reschedules the next check two days out and stays active", async () => {
  const db = fakeDb({ lease: leaseRow() })
  const result = await recordFollowUpResult(db.pool, "agent-uuid", 9, {
    outcome: "status_read",
    statusText: "Claim under review",
  })

  const update = matching(db.queries, /UPDATE claim_automation_follow_ups/)
  assert.equal(update.length, 1)
  const params = update[0].params
  assert.equal(params[1], "scheduled")
  assert.equal(params[2], true, "the follow-up stays active")
  assert.equal(params[3], "", "no stop reason")
  assert.equal(params[4], "under_review", "the normalized state is stored")
  assert.equal(params[5], 2, "the check counts against the budget")
  assert.equal(params[6], 0, "a successful read clears the failure streak")
  assert.equal(typeof params[7], "string", "a next-check timestamp is set")
  assert.equal(params[8], "", "no error is recorded")

  // under_review maps to a lifecycle status, so the claim and its history advance.
  assert.equal(matching(db.queries, /INSERT INTO claim_status_history/).length, 1)
  assert.equal(matching(db.queries, /UPDATE claims SET status/).length, 1)
  assert.equal(matching(db.queries, /INSERT INTO register_audit_log/).length, 1)
  assert.equal(result.stopReason, "")
  assert.equal(result.isActive, true)
  assert.equal(result.normalizedStatus, "under_review")
  assert.equal(result.marketplaceId, 7)
})

test("a final ticket state stops the follow-up and releases the lease", async () => {
  const db = fakeDb({ lease: leaseRow() })
  const result = await recordFollowUpResult(db.pool, "agent-uuid", 9, {
    outcome: "status_read",
    statusText: "Claim approved",
  })

  const params = matching(db.queries, /UPDATE claim_automation_follow_ups/)[0].params
  assert.equal(params[1], "stopped")
  assert.equal(params[2], false, "a finished ticket is no longer leased")
  assert.equal(params[3], "ticket_resolved")
  assert.equal(params[7], null, "a stopped follow-up is not rescheduled")
  assert.match(String(params[8]), /final state/)

  const claimUpdate = matching(db.queries, /UPDATE claims SET status/)
  assert.equal(claimUpdate.length, 1)
  assert.deepEqual(claimUpdate[0].params, [4, "approved"])
  assert.equal(result.isActive, false)
})

test("a marketplace with no status reader stops the ticket without spending a check", async () => {
  const db = fakeDb({ lease: leaseRow({ check_count: 4 }) })
  const result = await recordFollowUpResult(db.pool, "agent-uuid", 9, {
    outcome: "not_supported",
    note: "Automated ticket status check is not implemented for Ajio yet.",
  })

  const params = matching(db.queries, /UPDATE claim_automation_follow_ups/)[0].params
  assert.equal(params[2], false)
  assert.equal(params[3], "check_not_supported")
  assert.equal(params[5], 4, "the check budget is untouched")
  assert.equal(matching(db.queries, /INSERT INTO claim_status_history/).length, 0, "the claim status does not move")
  assert.equal(result.isActive, false)
})

test("an expired panel sign-in keeps the ticket active without spending a check", async () => {
  const db = fakeDb({ lease: leaseRow({ check_count: 4, error_streak: 1 }) })
  const result = await recordFollowUpResult(db.pool, "agent-uuid", 9, {
    outcome: "login_required",
    note: "No saved Ajio sign-in on this PC.",
  })

  const params = matching(db.queries, /UPDATE claim_automation_follow_ups/)[0].params
  assert.equal(params[1], "scheduled")
  assert.equal(params[2], true, "the ticket is still tracked")
  assert.equal(params[5], 4, "the check budget is untouched")
  assert.equal(params[6], 0, "a missing sign-in is not a failure")
  assert.equal(result.isActive, true)
})

test("a failed check is recorded and the failure streak grows", async () => {
  const db = fakeDb({ lease: leaseRow({ error_streak: 1 }) })
  const result = await recordFollowUpResult(db.pool, "agent-uuid", 9, {
    outcome: "error",
    note: "Timed out reading the ticket page.",
  })

  const params = matching(db.queries, /UPDATE claim_automation_follow_ups/)[0].params
  assert.equal(params[1], "scheduled")
  assert.equal(params[2], true)
  assert.equal(params[6], 2, "the failure streak grows")
  assert.equal(params[8], "Timed out reading the ticket page.")
  assert.equal(result.isActive, true)
})

test("the third failed check stops the ticket for a human", async () => {
  const db = fakeDb({ lease: leaseRow({ error_streak: FOLLOW_UP_MAX_ERROR_STREAK - 1 }) })
  const result = await recordFollowUpResult(db.pool, "agent-uuid", 9, { outcome: "error", note: "still failing" })
  assert.equal(result.stopReason, "repeated_errors")
  assert.equal(result.isActive, false)
})

test("a result is refused for a ticket this agent does not hold", async () => {
  const db = fakeDb({ lease: null })
  await assert.rejects(
    () => recordFollowUpResult(db.pool, "agent-uuid", 9, { outcome: "status_read", statusText: "Approved" }),
    /Follow-up not found or not leased by this agent/,
  )
  assert.equal(matching(db.queries, /UPDATE claim_automation_follow_ups/).length, 0)
  assert.ok(matching(db.queries, /^ROLLBACK$/).length >= 1, "a refused result rolls back")
})

test("an unknown outcome is refused before any work is done", async () => {
  const db = fakeDb({ lease: leaseRow() })
  await assert.rejects(
    () => recordFollowUpResult(db.pool, "agent-uuid", 9, { outcome: "whatever" as never }),
    /Unknown follow-up outcome/,
  )
  assert.equal(db.queries.length, 0)
})

test("an unauthorized agent cannot record a result", async () => {
  const db = fakeDb({ agentAuthorized: false, lease: leaseRow() })
  await assert.rejects(
    () => recordFollowUpResult(db.pool, "agent-uuid", 9, { outcome: "status_read", statusText: "Approved" }),
    /Agent authentication failed/,
  )
  assert.equal(matching(db.queries, /UPDATE claim_automation_follow_ups/).length, 0)
})
