// M8 submission-integrity regression tests: idempotent completion, guarded retry/approve,
// explicit lease allowlist, server-authoritative follow-up normalization, auditable ticket history.
// Fake-pool style, no database. Synthetic SYN- values only.
import assert from "node:assert/strict"
import test from "node:test"
import type pg from "pg"
import type { AccountScope } from "../access.js"
import {
  approveJobForSubmission,
  completeJobSubmission,
  pollNextAutomationJob,
  retryAutomationJob,
  syncClaimTicketToRegister,
} from "../claim-automation-service.js"
import { normalizeFollowUpStatus, recordFollowUpResult } from "../claim-follow-up-service.js"
import { ServiceError } from "../register-service.js"

const scope: AccountScope = { all: false, marketplaceIds: [3] }
const actor = { id: 7, name: "SYN-operator" } as never

type Handler = (sql: string, params: unknown[]) => { rows: Record<string, unknown>[] }

function fakePool(handler: Handler) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params })
      return handler(sql, params)
    },
    release: () => undefined,
  }
  const pool = { connect: async () => client } as unknown as pg.Pool
  const poolClient = client as unknown as pg.PoolClient
  return { pool, poolClient, queries }
}

function serviceErrorCode(promise: Promise<unknown>): Promise<number> {
  return promise.then(
    () => -1,
    (err) => {
      assert.ok(err instanceof ServiceError, `expected ServiceError, got ${String(err)}`)
      return (err as ServiceError).status
    },
  )
}

// F1: a lost ack retried with the SAME ticket is an idempotent replay, not a second filing.
test("complete: same-ticket replay on a completed job returns the marketplace without rewriting", async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes("FROM claim_automation_jobs j")) {
      return {
        rows: [
          { claim_id: 5, stage: "completed", marketplace_claim_id: "SYN-T1", marketplace_id: 3, claim_status: "processing" },
        ],
      }
    }
    return { rows: [] }
  })
  const marketplaceId = await completeJobSubmission(pool, 42, { marketplaceClaimId: "SYN-T1" }, scope)
  assert.equal(marketplaceId, 3)
  assert.ok(!queries.some((q) => q.sql.includes("UPDATE claim_automation_jobs")), "replay must not rewrite the job")
})

// F1: a DIFFERENT ticket for an already-completed job is rejected, never recorded.
test("complete: a different ticket cannot overwrite a completed job", async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes("FROM claim_automation_jobs j")) {
      return {
        rows: [
          { claim_id: 5, stage: "completed", marketplace_claim_id: "SYN-T1", marketplace_id: 3, claim_status: "processing" },
        ],
      }
    }
    return { rows: [] }
  })
  const code = await serviceErrorCode(completeJobSubmission(pool, 42, { marketplaceClaimId: "SYN-T9" }, scope))
  assert.equal(code, 409)
  assert.ok(!queries.some((q) => q.sql.includes("UPDATE claim_automation_jobs")), "rejected submit must not rewrite the job")
})

// F1: a claim that already has a recorded outcome cannot accept another ticket.
test("complete: a claim with a recorded outcome rejects a new ticket", async () => {
  const { pool } = fakePool((sql) => {
    if (sql.includes("FROM claim_automation_jobs j")) {
      return {
        rows: [{ claim_id: 5, stage: "approved", marketplace_claim_id: "", marketplace_id: 3, claim_status: "submitted" }],
      }
    }
    return { rows: [] }
  })
  const code = await serviceErrorCode(completeJobSubmission(pool, 42, { marketplaceClaimId: "SYN-T2" }, scope))
  assert.equal(code, 409)
})

// F2: retry never re-arms a finished, in-flight, or already-recorded job.
test("retry: a completed job cannot be retried into a second filing", async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes("FROM claim_automation_jobs j")) {
      return { rows: [{ id: 42, claim_id: 5, stage: "completed", claim_status: "processing", marketplace_id: 3 }] }
    }
    return { rows: [] }
  })
  const code = await serviceErrorCode(retryAutomationJob(pool, actor, scope, 42))
  assert.equal(code, 409)
  assert.ok(!queries.some((q) => q.sql.includes("SET stage = 'queued'")), "rejected retry must not re-queue")
})

test("retry: a job whose claim already has an outcome cannot be retried", async () => {
  const { pool } = fakePool((sql) => {
    if (sql.includes("FROM claim_automation_jobs j")) {
      return { rows: [{ id: 42, claim_id: 5, stage: "queued", claim_status: "approved", marketplace_id: 3 }] }
    }
    return { rows: [] }
  })
  assert.equal(await serviceErrorCode(retryAutomationJob(pool, actor, scope, 42)), 409)
})

// F2: approval arms a submission, so finished work and recorded outcomes are out of scope.
test("approve: a completed job cannot be approved for submission", async () => {
  const { pool } = fakePool((sql) => {
    if (sql.includes("FROM claim_automation_jobs j")) {
      return { rows: [{ id: 42, claim_id: 5, stage: "completed", claim_status: "processing", marketplace_id: 3 }] }
    }
    return { rows: [] }
  })
  assert.equal(await serviceErrorCode(approveJobForSubmission(pool, actor, scope, 42)), 409)
})

test("approve: a claim with a recorded outcome cannot be approved", async () => {
  const { pool } = fakePool((sql) => {
    if (sql.includes("FROM claim_automation_jobs j")) {
      return { rows: [{ id: 42, claim_id: 5, stage: "queued", claim_status: "submitted", marketplace_id: 3 }] }
    }
    return { rows: [] }
  })
  assert.equal(await serviceErrorCode(approveJobForSubmission(pool, actor, scope, 42)), 409)
})

// F3: the queue leases only explicitly eligible claim states.
test("lease: only ready/processing/reclaim/escalated claims are leasable", async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes("FROM claim_automation_agents")) return { rows: [{ id: 9 }] }
    return { rows: [] }
  })
  await pollNextAutomationJob(pool, "SYN-agent", scope)
  const lease = queries.filter((q) => q.sql.includes("FOR UPDATE") && q.sql.includes("claim_automation_jobs"))
  assert.ok(lease.length > 0, "expected a lease select")
  const sql = lease.map((q) => q.sql).join("\n")
  assert.ok(
    sql.includes("IN ('ready_for_claim', 'processing', 'reclaim', 'escalated')"),
    "lease must use the explicit eligibility allowlist",
  )
  assert.ok(!sql.includes("<> 'pending_evidence'"), "lease must not use the old negative gate")
})

// F5: a client hint of "approved" loses to the server reading of a bare "Resolved" row.
test("follow-up: a resolved-portal hint never approves the claim", async () => {
  assert.equal(normalizeFollowUpStatus("Ticket resolved. Thank you."), "unknown")
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes("FROM claim_automation_agents")) return { rows: [{ id: 9 }] }
    if (sql.includes("FROM claim_automation_follow_ups f")) {
      return {
        rows: [
          {
            id: 1,
            claim_id: 5,
            check_count: 0,
            error_streak: 0,
            status_at_last_check: "",
            marketplace_claim_id: "SYN-T1",
            marketplace_id: 3,
            marketplace: "Meesho",
            claim_status: "under_review",
          },
        ],
      }
    }
    return { rows: [] }
  })
  const result = await recordFollowUpResult(pool, "SYN-agent", 1, {
    outcome: "status_read",
    statusText: "Ticket resolved. Thank you.",
    normalizedStatus: "approved",
  })
  assert.equal(result.normalizedStatus, "unknown")
  assert.ok(
    !queries.some((q) => q.sql.includes("UPDATE claims SET")),
    "an unknown reading must not move the claim",
  )
})

// F6: replacing a ticket keeps the replaced code in history.
test("register sync: ticket replacement history keeps the replaced code", async () => {
  const { poolClient, queries } = fakePool((sql) => {
    if (sql.includes("FROM claim_tickets WHERE receipt_scan_id")) {
      return { rows: [{ id: 11, ticket_code: "OLD-1", status: "Raised" }] }
    }
    if (sql.includes("FROM receipt_scan_items WHERE receipt_scan_id")) return { rows: [{ id: 21 }] }
    if (sql.includes("FROM receipt_scan_issues WHERE receipt_scan_item_id")) {
      return { rows: [{ id: 31, claim_ticket_id: 11 }] }
    }
    if (sql.includes("FROM receipt_scan_issues WHERE claim_ticket_id")) return { rows: [{ id: 31 }] }
    return { rows: [] }
  })
  const ticketId = await syncClaimTicketToRegister(poolClient, { receiptScanId: 8, ticketCode: "NEW-2", actorId: 7 })
  assert.equal(ticketId, 11)
  const history = queries.filter((q) => q.sql.includes("INTO claim_ticket_history"))
  assert.equal(history.length, 1)
  assert.match(String(history[0].params[3]), /OLD-1.*NEW-2|NEW-2.*OLD-1/, "history must keep both codes")
})
