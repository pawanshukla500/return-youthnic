// Database checks for M9 submission authorization. They run only when TEST_DATABASE_URL is set to a dedicated test
// database whose name contains "test". Otherwise every check is skipped. Nothing here uses real data: every value
// starts with SYN and every run uses its own suffix, so a rerun does not collide with an earlier one.
//
// What these checks cover, against a real PostgreSQL (not fakes):
//  - A queued job leased by a worker with a saved supplier login (stage downloading_media) cannot record a
//    ticket on an approval-required account: the completion endpoint rejects it with 409 and writes nothing.
//  - The authorized path works end to end: approve -> lease as submitting -> complete records the ticket once,
//    starts ticket follow-up, moves the claim to submitted; a same-ticket replay is idempotent, a different
//    ticket is rejected.
//  - Two desktop workers racing for one approved job: the first leases it, the second gets nothing (SKIP LOCKED).
//  - An expired lease cannot record a ticket; the next poll parks the job as manual_intervention_required.
//  - An auto-submit account (require_approval_before_submit = false) completes from a live lease.
//  - Retry cannot re-arm a submitting job.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import pg from "pg"
import { applySchema, connectionSettingsFor } from "../db.js"
import { ensureReferenceData } from "../reference-data.js"
import {
  approveJobForSubmission,
  completeJobSubmission,
  pollNextAutomationJob,
  retryAutomationJob,
} from "../claim-automation-service.js"
import { ServiceError, type Actor } from "../register-service.js"
import type { AccountScope } from "../access.js"

const rawUrl = process.env.TEST_DATABASE_URL?.trim() || ""

function skipReason(): string {
  if (!rawUrl) return "Set TEST_DATABASE_URL to a dedicated test database to run these checks."
  try {
    const name = decodeURIComponent(new URL(rawUrl).pathname.replace(/^\//, ""))
    if (!/test/i.test(name)) return "TEST_DATABASE_URL must point to a database whose name contains 'test'."
  } catch {
    return "TEST_DATABASE_URL is not a valid postgresql:// URL."
  }
  return ""
}

const skip = skipReason()
const run = Date.now().toString(36).toUpperCase()
const scope: AccountScope = { all: true }

let pool: pg.Pool
let supervisor: Actor
let meeshoId = 0
let agent1 = 0
let agent2 = 0
let agentUuid1 = ""
let agentUuid2 = ""

function errCode(promise: Promise<unknown>): Promise<number> {
  return promise.then(
    () => -1,
    (err) => {
      assert.ok(err instanceof ServiceError, `expected ServiceError, got ${String(err)}`)
      return (err as ServiceError).status
    },
  )
}

async function makeClaim(label: string): Promise<number> {
  const courier = await pool.query(`INSERT INTO couriers (name) VALUES ($1) RETURNING id`, [`SYN-${run}-${label}-C`])
  const er = await pool.query(
    `INSERT INTO expected_returns (tracking_id, marketplace_id, order_number, courier_id, return_type, matched_from)
     VALUES ($1, $2, $3, $4, 'Customer Return', 'SYN') RETURNING id`,
    [`SYN-${run}-${label}-AWB`, meeshoId, `SYN-${run}-${label}-ORD`, Number(courier.rows[0].id)],
  )
  const scan = await pool.query(
    `INSERT INTO receipt_scans (expected_return_id, scanned_by, scanned_time_label, outcome, issue_label, status)
     VALUES ($1, $2, 'SYN', 'clear', '', 'Clear') RETURNING id`,
    [Number(er.rows[0].id), supervisor.id],
  )
  const claim = await pool.query(
    `INSERT INTO claims (receipt_scan_id, marketplace_id, claim_reason, created_by, status)
     VALUES ($1, $2, 'SYN damaged return', $3, 'ready_for_claim') RETURNING id`,
    [Number(scan.rows[0].id), meeshoId, supervisor.id],
  )
  return Number(claim.rows[0].id)
}

async function makeCredential(label: string, requireApproval: boolean): Promise<number> {
  const cred = await pool.query(
    `INSERT INTO marketplace_credentials (marketplace_id, account_name, require_approval_before_submit)
     VALUES ($1, $2, $3) RETURNING id`,
    [meeshoId, `SYN-${run}-${label}`, requireApproval],
  )
  return Number(cred.rows[0].id)
}

async function makeJob(claimId: number, credentialId: number, stage: string): Promise<number> {
  const job = await pool.query(
    `INSERT INTO claim_automation_jobs (claim_id, marketplace_credential_id, stage) VALUES ($1, $2, $3) RETURNING id`,
    [claimId, credentialId, stage],
  )
  return Number(job.rows[0].id)
}

async function jobRow(jobId: number): Promise<Record<string, unknown>> {
  const res = await pool.query(`SELECT stage, marketplace_claim_id, agent_id FROM claim_automation_jobs WHERE id = $1`, [jobId])
  return res.rows[0]
}

before(async () => {
  if (skip) return
  const settings = connectionSettingsFor(rawUrl)
  pool = new pg.Pool({ connectionString: settings.connectionString, ssl: settings.ssl, connectionTimeoutMillis: 8000 })
  await applySchema(pool)
  await ensureReferenceData(pool)
  meeshoId = Number((await pool.query(`SELECT id FROM marketplaces WHERE name = 'Meesho'`)).rows[0].id)
  const user = await pool.query(
    `INSERT INTO users (initials, name, email, password_hash, role, sidebar_label, has_all_marketplaces)
     VALUES ('SS', $1, $2, 'SYN-HASH', 'Supervisor', 'Supervisor', true) RETURNING id`,
    [`SYN supervisor ${run}`, `syn-supervisor-${run}@example.test`],
  )
  supervisor = { id: Number(user.rows[0].id), name: `SYN supervisor ${run}` } as Actor
  agentUuid1 = `SYN-${run}-AGENT-1`
  agentUuid2 = `SYN-${run}-AGENT-2`
  for (const [uuid, name] of [[agentUuid1, "SYN agent 1"], [agentUuid2, "SYN agent 2"]]) {
    const agent = await pool.query(
      `INSERT INTO claim_automation_agents (agent_uuid, agent_name, api_key_hash, is_authorized)
       VALUES ($1, $2, 'SYN-HASH', true) RETURNING id`,
      [uuid, `${name} ${run}`],
    )
    if (uuid === agentUuid1) agent1 = Number(agent.rows[0].id)
    else agent2 = Number(agent.rows[0].id)
  }
})

after(async () => {
  if (pool) await pool.end()
})

test("db: a saved-login (non-submitting) lease cannot record a ticket on an approval account", { skip: skip || false }, async () => {
  const claimId = await makeClaim("BYPASS")
  const credId = await makeCredential("BYPASS-APPR", true)
  const jobId = await makeJob(claimId, credId, "queued")
  const leased = await pollNextAutomationJob(pool, agentUuid1, scope)
  assert.ok(leased, "worker must lease the queued job for preparation")
  assert.equal(leased.jobId, jobId)
  assert.equal(leased.stage, "downloading_media")
  // This is the state a desktop with a saved supplier login holds. It must never authorize a ticket.
  const code = await errCode(completeJobSubmission(pool, jobId, { marketplaceClaimId: `SYN-${run}-T-BYPASS` }, scope, { agentId: agent1 }))
  assert.equal(code, 409)
  const row = await jobRow(jobId)
  assert.equal(row.stage, "downloading_media", "rejected submit must not move the job")
  assert.equal(String(row.marketplace_claim_id || ""), "", "rejected submit must not record a ticket")
})

test("db: the authorized path approves, leases, completes once and replays idempotently", { skip: skip || false }, async () => {
  const claimId = await makeClaim("HAPPY")
  const credId = await makeCredential("HAPPY-APPR", true)
  const jobId = await makeJob(claimId, credId, "queued")
  await approveJobForSubmission(pool, supervisor, scope, jobId)
  const leased = await pollNextAutomationJob(pool, agentUuid1, scope)
  assert.ok(leased, "approved job must lease")
  assert.equal(leased.jobId, jobId)
  assert.equal(leased.stage, "submitting", "an approved lease is the backend-issued submission authorization")
  const ticket = `SYN-${run}-T-HAPPY`
  const marketplaceId = await completeJobSubmission(pool, jobId, { marketplaceClaimId: ticket }, scope, { agentId: agent1 })
  assert.equal(marketplaceId, meeshoId)
  const row = await jobRow(jobId)
  assert.equal(row.stage, "completed")
  assert.equal(String(row.marketplace_claim_id), ticket)
  const claimStatus = await pool.query(`SELECT status FROM claims WHERE id = $1`, [claimId])
  assert.equal(claimStatus.rows[0].status, "submitted")
  const followUps = await pool.query(`SELECT COUNT(*)::int AS n FROM claim_automation_follow_ups WHERE claim_id = $1`, [claimId])
  assert.equal(followUps.rows[0].n, 1, "completion starts exactly one ticket follow-up")
  const replayed = await completeJobSubmission(pool, jobId, { marketplaceClaimId: ticket }, scope, { agentId: agent1 })
  assert.equal(replayed, meeshoId, "same-ticket replay is idempotent")
  const afterReplay = await pool.query(`SELECT COUNT(*)::int AS n FROM claim_automation_follow_ups WHERE claim_id = $1`, [claimId])
  assert.equal(afterReplay.rows[0].n, 1, "replay must not start a second follow-up")
  const clash = await errCode(completeJobSubmission(pool, jobId, { marketplaceClaimId: `SYN-${run}-T-OTHER` }, scope, { agentId: agent1 }))
  assert.equal(clash, 409, "a different ticket cannot overwrite a completed job")
})

test("db: two workers racing for one job — the second gets nothing", { skip: skip || false }, async () => {
  const claimId = await makeClaim("RACE")
  const credId = await makeCredential("RACE-APPR", true)
  const jobId = await makeJob(claimId, credId, "queued")
  await approveJobForSubmission(pool, supervisor, scope, jobId)
  const first = await pollNextAutomationJob(pool, agentUuid1, scope)
  assert.ok(first, "first worker must lease the approved job")
  assert.equal(first.jobId, jobId)
  const second = await pollNextAutomationJob(pool, agentUuid2, scope)
  assert.equal(second, null, "second worker must not lease a job already held")
  const row = await jobRow(jobId)
  assert.equal(Number(row.agent_id), agent1, "the lease stays with the first worker")
})

test("db: an expired lease cannot complete; the next poll parks the job", { skip: skip || false }, async () => {
  const claimId = await makeClaim("EXPIRE")
  const credId = await makeCredential("EXPIRE-APPR", true)
  const jobId = await makeJob(claimId, credId, "queued")
  await approveJobForSubmission(pool, supervisor, scope, jobId)
  const leased = await pollNextAutomationJob(pool, agentUuid1, scope)
  assert.ok(leased)
  assert.equal(leased.stage, "submitting")
  await pool.query(`UPDATE claim_automation_jobs SET lease_expires_at = now() - INTERVAL '1 minute' WHERE id = $1`, [jobId])
  const code = await errCode(completeJobSubmission(pool, jobId, { marketplaceClaimId: `SYN-${run}-T-EXP` }, scope, { agentId: agent1 }))
  assert.equal(code, 409, "an expired lease must not record a ticket")
  const afterPoll = await pollNextAutomationJob(pool, agentUuid2, scope)
  assert.equal(afterPoll, null, "nothing is leasable while the uncertain job is parked")
  const row = await jobRow(jobId)
  assert.equal(row.stage, "manual_intervention_required", "expired submission lease parks the job instead of re-filing")
})

test("db: an auto-submit account completes from a live prepare lease", { skip: skip || false }, async () => {
  const claimId = await makeClaim("AUTO")
  const credId = await makeCredential("AUTO-ACCT", false)
  const jobId = await makeJob(claimId, credId, "queued")
  const leased = await pollNextAutomationJob(pool, agentUuid1, scope)
  assert.ok(leased, "worker must lease the queued job")
  assert.equal(leased.jobId, jobId)
  assert.equal(leased.stage, "downloading_media")
  const ticket = `SYN-${run}-T-AUTO`
  const marketplaceId = await completeJobSubmission(pool, jobId, { marketplaceClaimId: ticket }, scope, { agentId: agent1 })
  assert.equal(marketplaceId, meeshoId)
  const row = await jobRow(jobId)
  assert.equal(row.stage, "completed")
  assert.equal(String(row.marketplace_claim_id), ticket)
})

test("db: retry cannot re-arm a submitting job", { skip: skip || false }, async () => {
  const claimId = await makeClaim("RETRY")
  const credId = await makeCredential("RETRY-APPR", true)
  const jobId = await makeJob(claimId, credId, "queued")
  await approveJobForSubmission(pool, supervisor, scope, jobId)
  const leased = await pollNextAutomationJob(pool, agentUuid1, scope)
  assert.ok(leased)
  assert.equal(leased.stage, "submitting")
  const code = await errCode(retryAutomationJob(pool, supervisor, scope, jobId))
  assert.equal(code, 409, "a mid-flight submission must never be re-armed by retry")
})
