// Server tests for autonomous retry backoff, 3-attempt Manual Required rule,
// duplicate order guard, RTO category promotion, and operator manual resolution.
// Real PostgreSQL test runs only when TEST_DATABASE_URL is set. SYN- data only.

import assert from "node:assert/strict"
import test from "node:test"
import pg from "pg"
import { applySchema, connectionSettingsFor } from "../db.js"
import { ensureReferenceData } from "../reference-data.js"
import {
  computeRetryBackoffSeconds,
  createOrQueueAutomationJob,
  isTerminalAttempt,
  lookupReturnForClaim,
  pollNextAutomationJob,
  resolveManualClaim,
  updateJobProgress,
} from "../claim-automation-service.js"
import { listClaims } from "../claims-service.js"
import type { AccountScope } from "../access.js"
import type { Actor } from "../register-service.js"

const scope: AccountScope = { all: true }
const actor: Actor = { id: 1, name: "SYN Supervisor" } as Actor

function fakePool(handler: (sql: string, params: unknown[]) => { rows: any[]; rowCount?: number }) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const exec = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params })
    const out = handler(sql, params)
    return { rows: out.rows, rowCount: out.rowCount ?? out.rows.length }
  }
  const client = { query: exec, release: () => undefined }
  const pool = { query: exec, connect: async () => client } as unknown as pg.Pool
  return { pool, queries }
}

test("retry backoff schedule increases exponentially and flags terminal 3rd attempt", () => {
  assert.equal(computeRetryBackoffSeconds(1), 15)
  assert.equal(computeRetryBackoffSeconds(2), 45)
  assert.equal(computeRetryBackoffSeconds(3), 90)
  assert.equal(isTerminalAttempt(1, 3), false)
  assert.equal(isTerminalAttempt(2, 3), false)
  assert.equal(isTerminalAttempt(3, 3), true)
})

test("3-attempt rule: attempt 1 schedules 15s backoff, attempt 3 moves claim to manual_action_required", async () => {
  let attemptCount = 1
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes("SELECT j.attempts, j.max_attempts")) {
      return {
        rows: [
          {
            attempts: attemptCount,
            max_attempts: 3,
            stage: "filling_form",
            marketplace_id: 3,
            agent_id: 9,
            lease_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          },
        ],
      }
    }
    return { rows: [] }
  })

  await updateJobProgress(pool, 42, { stage: "failed", logMessage: "Timeout waiting for upload" }, 9)
  const retryUpdate = queries.find((q) => q.sql.includes("UPDATE claim_automation_jobs SET") && q.sql.includes("next_retry_at"))
  assert.ok(retryUpdate, "attempt 1 must schedule next_retry_at backoff")
  assert.equal(retryUpdate.params[1], "queued")
  assert.ok(retryUpdate.params.includes(15), "attempt 1 backoff should be 15 seconds")

  queries.length = 0
  attemptCount = 3
  await updateJobProgress(pool, 42, { stage: "failed", logMessage: "Portal timeout on attempt 3" }, 9)
  const manualJobUpdate = queries.find((q) => q.sql.includes("UPDATE claim_automation_jobs SET"))
  assert.ok(manualJobUpdate)
  assert.equal(manualJobUpdate.params[1], "manual_intervention_required", "attempt 3 must transition to manual_intervention_required")
  assert.ok(
    queries.some((q) => q.sql.includes("UPDATE claims SET status = 'manual_action_required'")),
    "exhausted claim must enter manual_action_required list",
  )
})

test("createOrQueueAutomationJob blocks duplicate active filing when completed ticket already exists for same sub-order", async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes("SELECT m.name")) return { rows: [{ name: "Meesho" }] }
    if (sql.includes("duplicate_order_guard_create")) return { rows: [{ ticket_id: "795277339999" }] }
    return { rows: [] }
  })

  const jobId = await createOrQueueAutomationJob(pool, 99)
  assert.equal(jobId, null)
  assert.ok(
    queries.some((q) => q.sql.includes("UPDATE claims") && q.sql.includes("manual_action_required")),
    "duplicate order claim must be parked in manual_action_required without creating a new job",
  )
})

test("listClaims supports status=manual_list filtering for Manual Required list", async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes("COUNT(*)::int AS total")) return { rows: [{ total: 0 }] }
    return { rows: [] }
  })

  await listClaims(pool, scope, { status: "manual_list", page: 1, pageSize: 25 })
  const querySql = queries.map((q) => q.sql).join("\n")
  assert.ok(
    querySql.includes("c.status IN ('manual_action_required', 'failed')"),
    "manual_list filter must query manual_action_required and failed claims",
  )
})

test("lookupReturnForClaim promotes wrong_product + RTO returns to wrong_barcode_rto", async () => {
  const { pool } = fakePool((sql) => {
    if (sql.includes("FROM expected_returns er")) {
      return {
        rows: [
          {
            scan_id: 10,
            expected_return_id: 20,
            marketplace_id: 3,
            marketplace: "Meesho",
            order_number: "SYN-ORD-RTO-1",
            tracking_id: "SYN-AWB-RTO-1",
            alt_tracking_id: "",
            flyer_id: "SYN-PKT-RTO-1",
            scanned_at: new Date().toISOString(),
            customer_name: "SYN Customer",
            total_price: 599,
            return_status: "RTO",
            expected_return_type: "RTO",
            shipped_date: new Date().toISOString(),
            detected_issue_code: "wrong_product",
            claim_id: null,
            claim_status: null,
            claim_reason: null,
            claim_title: null,
            media_count: 0,
            exact: true,
          },
        ],
      }
    }
    if (sql.includes("FROM receipt_scan_items rsi")) {
      return {
        rows: [{ id: 1, order_item_id: "SYN-SUB-RTO-1", product_name: "SYN Shirt", return_type: "RTO", category_code: "wrong_product" }],
      }
    }
    return { rows: [] }
  })

  const res = await lookupReturnForClaim(pool, scope, "SYN-AWB-RTO-1", 3)
  assert.ok(res)
  assert.equal(res.detectedIssueCode, "wrong_barcode_rto")
  assert.equal(res.standardReasons[0]?.code, "wrong_barcode_rto")
})

test("resolveManualClaim works without existing job row, sets submitted, creates follow-up, and syncs register", async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes("FROM claims c") && sql.includes("FOR UPDATE OF c")) {
      return {
        rows: [
          {
            id: 55,
            marketplace_id: 3,
            status: "manual_action_required",
            receipt_scan_id: 12,
            claim_reason: "Wrong return",
            marketplace_issue_code: "wrong_return",
            marketplace_issue_label: "I have received wrong return",
          },
        ],
      }
    }
    if (sql.includes("INSERT INTO claim_automation_jobs")) return { rows: [{ id: 801 }] }
    if (sql.includes("INSERT INTO claim_tickets")) return { rows: [{ id: 901 }] }
    return { rows: [] }
  })

  const out = await resolveManualClaim(pool, actor, scope, 55, { marketplaceClaimId: "SYN-MNL-795277" })
  assert.equal(out.marketplaceClaimId, "SYN-MNL-795277")
  assert.ok(queries.some((q) => q.sql.includes("INSERT INTO claim_automation_follow_ups")))
  assert.ok(queries.some((q) => q.sql.includes("SET status = 'submitted'")))
  assert.ok(queries.some((q) => q.sql.includes("INSERT INTO claim_tickets")))
})

const rawDbUrl = process.env.TEST_DATABASE_URL?.trim() || ""
const dbSkip = (() => {
  if (!rawDbUrl) return "Set TEST_DATABASE_URL to a dedicated test DB to run DB autonomous-loop checks."
  try {
    const name = decodeURIComponent(new URL(rawDbUrl).pathname.replace(/^\//, ""))
    if (!/test/i.test(name)) return "TEST_DATABASE_URL must point to a test database."
  } catch {
    return "Invalid TEST_DATABASE_URL."
  }
  return ""
})()

test("db: 3 failed attempts move claim to Manual Required while second claim still leases, then manual-resolve clears it", { skip: dbSkip || false }, async () => {
  const settings = connectionSettingsFor(rawDbUrl)
  const pool = new pg.Pool({ connectionString: settings.connectionString, ssl: settings.ssl, connectionTimeoutMillis: 8000 })
  try {
    await applySchema(pool)
    await ensureReferenceData(pool)
    const run = `SYN-LOOP-${Date.now().toString(36).toUpperCase()}`
    const mktRes = await pool.query(`SELECT id FROM marketplaces WHERE name = 'Meesho'`)
    const meeshoId = Number(mktRes.rows[0].id)
    const courierRes = await pool.query(`INSERT INTO couriers (name) VALUES ($1) RETURNING id`, [`${run}-C`])
    const courierId = Number(courierRes.rows[0].id)
    const uRes = await pool.query(
      `INSERT INTO users (initials, name, email, password_hash, role, sidebar_label, has_all_marketplaces)
       VALUES ('SL', $1, $2, 'SYN-HASH', 'Supervisor', 'Supervisor', true) RETURNING id`,
      [`${run}-SUP`, `${run.toLowerCase()}@example.test`],
    )
    const sup: Actor = { id: Number(uRes.rows[0].id), name: `${run}-SUP` } as Actor
    const agRes = await pool.query(
      `INSERT INTO claim_automation_agents (agent_uuid, agent_name, api_key_hash, is_authorized)
       VALUES ($1, $2, 'SYN-HASH', true) RETURNING id`,
      [`${run}-AG`, `${run}-Agent`],
    )
    const agId = Number(agRes.rows[0].id)
    const credRes = await pool.query(
      `INSERT INTO marketplace_credentials (marketplace_id, account_name, automation_mode, require_approval_before_submit)
       VALUES ($1, $2, 'autonomous', false) RETURNING id`,
      [meeshoId, `${run}-CRED`],
    )
    const credId = Number(credRes.rows[0].id)

    const createReadyClaim = async (tag: string) => {
      const er = await pool.query(
        `INSERT INTO expected_returns (tracking_id, marketplace_id, order_number, courier_id, return_type, matched_from)
         VALUES ($1, $2, $3, $4, 'Customer Return', 'SYN') RETURNING id`,
        [`${run}-${tag}-AWB`, meeshoId, `${run}-${tag}-ORD`, courierId],
      )
      const scan = await pool.query(
        `INSERT INTO receipt_scans (expected_return_id, scanned_by, scanned_time_label, outcome, issue_label, status)
         VALUES ($1, $2, 'SYN', 'issue', 'Wrong product', 'Draft') RETURNING id`,
        [Number(er.rows[0].id), sup.id],
      )
      const claim = await pool.query(
        `INSERT INTO claims (receipt_scan_id, marketplace_id, sub_order_id_snapshot, claim_reason, created_by, status)
         VALUES ($1, $2, $3, 'SYN wrong return', $4, 'ready_for_claim') RETURNING id`,
        [Number(scan.rows[0].id), meeshoId, `${run}-${tag}-SUB`, sup.id],
      )
      const claimId = Number(claim.rows[0].id)
      const job = await pool.query(
        `INSERT INTO claim_automation_jobs (claim_id, marketplace_credential_id, stage) VALUES ($1, $2, 'queued') RETURNING id`,
        [claimId, credId],
      )
      return { claimId, jobId: Number(job.rows[0].id) }
    }

    const first = await createReadyClaim("ONE")
    const second = await createReadyClaim("TWO")

    // Force attempts to 3 on first job and fail it -> must become manual_intervention_required + claim manual_action_required
    await pool.query(`UPDATE claim_automation_jobs SET attempts = 3, agent_id = $2, lease_expires_at = now() + INTERVAL '10 minutes', stage = 'filling_form' WHERE id = $1`, [first.jobId, agId])
    await updateJobProgress(pool, first.jobId, { stage: "failed", checkpoint: "evidence_uploaded", logMessage: "Upload ack failed" }, agId)

    const manualList = await listClaims(pool, scope, { status: "manual_list", search: `${run}-ONE`, pageSize: 20 })
    assert.equal(manualList.rows.length, 1)
    assert.equal(manualList.rows[0].id, first.claimId)
    assert.match(String(manualList.rows[0].manualActionReason || ""), /Failed after 3 attempts/)

    // Second claim must NOT be blocked by the first failed claim
    const leased = await pollNextAutomationJob(pool, `${run}-AG`, scope)
    assert.ok(leased, "second queued claim must lease immediately despite first claim entering manual required")
    assert.equal(leased.claimId, second.claimId)

    // Operator submits manual Ticket ID -> claim leaves manual_list and enters submitted
    await resolveManualClaim(pool, sup, scope, first.claimId, { marketplaceClaimId: `${run}-TKT-795` })
    const afterManualList = await listClaims(pool, scope, { status: "manual_list", search: `${run}-ONE`, pageSize: 20 })
    assert.equal(afterManualList.rows.length, 0, "resolved manual claim must disappear from manual_list")
  } finally {
    await pool.end()
  }
})
