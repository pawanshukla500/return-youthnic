// Evidence-ready gate (M7 §4): pollNextAutomationJob must never lease a job whose claim is still
// pending_evidence. Jobs for incomplete claims stay safely pending and become eligible automatically
// when addClaimMedia flips the claim to ready_for_claim. Fake-pool test, repo pattern (SYN data only).
import assert from "node:assert/strict"
import test from "node:test"
import type pg from "pg"
import { pollNextAutomationJob } from "../claim-automation-service.js"
import type { AccountScope } from "../access.js"

const SCOPE: AccountScope = { all: true }

type Captured = { sql: string; params: unknown[] }

function gatePool(jobRow: Record<string, unknown> | null): { pool: pg.Pool; queries: Captured[] } {
  const queries: Captured[] = []
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params })
      if (sql.includes("FROM claim_automation_agents")) {
        return { rows: [{ id: 7 }], rowCount: 1 }
      }
      if (sql.includes("FROM claim_automation_jobs j")) {
        return { rows: jobRow ? [jobRow] : [], rowCount: jobRow ? 1 : 0 }
      }
      return { rows: [], rowCount: 0 }
    },
    release: () => undefined,
  }
  return { pool: { connect: async () => client } as unknown as pg.Pool, queries }
}

function leaseSelectSql(queries: Captured[]): string {
  const found = queries.find((q) => q.sql.includes("FROM claim_automation_jobs j"))
  assert.ok(found, "expected a lease SELECT against claim_automation_jobs")
  return String(found.sql)
}

test("evidence gate: lease SELECT excludes claims still pending_evidence", async () => {
  const { pool, queries } = gatePool(null)
  const result = await pollNextAutomationJob(pool, "SYN-agent-uuid", SCOPE)
  assert.equal(result, null)
  const sql = leaseSelectSql(queries)
  assert.match(sql, /c\.status <> 'pending_evidence'/, "lease must filter out pending_evidence claims")
})

test("evidence gate: ready claims remain leasable", async () => {
  const jobRow = {
    id: 42,
    claim_id: 1001,
    stage: "queued",
    marketplace: "Meesho",
    order_number: "SYN-ORDER-1",
    tracking_id: "SYN-AWB-1",
  }
  const { pool, queries } = gatePool(jobRow)
  const result = await pollNextAutomationJob(pool, "SYN-agent-uuid", SCOPE)
  assert.ok(result, "expected a ready claim job to be leased")
  assert.equal(result.jobId, 42)
  assert.equal(result.claimId, 1001)
  assert.equal(result.stage, "downloading_media")
  assert.match(leaseSelectSql(queries), /c\.status <> 'pending_evidence'/)
})
