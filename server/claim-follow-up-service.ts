import type pg from "pg"
import { accountCondition, type AccountScope } from "./access.js"
import { ServiceError } from "./register-service.js"

/**
 * Claim follow-ups (marketplace ticket tracking).
 *
 * A filed claim is not final. When a filing job completes, a follow-up row is created for the ticket. The
 * desktop re-opens the supplier portal on a cadence (default every 48 hours), reads the ticket status, and
 * reports it back here. Recording a result reschedules the next check, and the row stops being leased once the
 * ticket reaches a terminal state, the marketplace has no status reader yet, or the check budget is spent.
 *
 * The cadence and the terminal rules live in pure functions so they can be tested without a database
 * (server/tests/claim-follow-up.test.ts). Nothing here deletes a row: a stopped follow-up stays for history.
 */

export const FOLLOW_UP_INTERVAL_HOURS = 48
/** Safety budget: ~180 days of checks at the default cadence, then stop and flag for a human. */
export const FOLLOW_UP_MAX_CHECKS = 90
export const FOLLOW_UP_MAX_ERROR_STREAK = 3
export const FOLLOW_UP_LEASE_MINUTES = 15

/** Ticket states after which there is nothing left to chase. */
export const FOLLOW_UP_TERMINAL_STATUSES = ["approved", "rejected", "paid", "reconciled", "closed", "resolved"] as const

export type FollowUpOutcome = "status_read" | "not_supported" | "login_required" | "not_found" | "error"

export const FOLLOW_UP_OUTCOMES: readonly FollowUpOutcome[] = [
  "status_read",
  "not_supported",
  "login_required",
  "not_found",
  "error",
]

/**
 * Free text read from a supplier portal, mapped to one normalized ticket state. Ordered deliberately, and the
 * first match wins:
 *  1. A rejection or a negative reading first, so "not approved" and "closed without approval" are never read
 *     as approvals.
 *  2. The final positive states (approved, paid, reconciled), so "Claim approved, refund credited" is approved.
 *  3. The active states (escalated, reopened, under review, submitted).
 * A state that matches nothing is "unknown", which keeps the follow-up running rather than closing it, because
 * wrongly closing a live ticket loses it while an extra check costs nothing.
 */
const STATUS_PATTERNS: ReadonlyArray<{ key: string; test: RegExp }> = [
  { key: "rejected", test: /\breject|\bdeclin|\bdenied|\bnot\s+eligible|\bnot\s+approved|\bclosed\s+without/i },
  { key: "approved", test: /\bapprov|\baccept|\bsettled|\bcredited\b/i },
  { key: "paid", test: /\bpaid\b|payment\s+(done|completed|released|processed)/i },
  { key: "reconciled", test: /\breconcil|\badjusted\b/i },
  { key: "escalated", test: /\bescalat/i },
  { key: "reclaim", test: /\breclaim|re-?opened?\b/i },
  { key: "under_review", test: /\bunder\s*review|\bin\s*review|\bpending\b|processing|verification|in\s*progress|on\s*hold|action\s+required/i },
  { key: "submitted", test: /\bsubmitted|\braised|\bcreated|ticket\s+open|\bopen\b/i },
]

export function normalizeFollowUpStatus(raw: string): string {
  const value = String(raw || "").trim()
  if (!value) return "unknown"
  for (const pattern of STATUS_PATTERNS) {
    if (pattern.test.test(value)) return pattern.key
  }
  return "unknown"
}

export function isTerminalFollowUpStatus(normalized: string): boolean {
  return (FOLLOW_UP_TERMINAL_STATUSES as readonly string[]).includes(String(normalized || "").trim())
}

/**
 * The claim lifecycle status a normalized ticket state maps to, or null when the ticket state does not change
 * the claim status. Only the states in CLAIM_STATUSES can be returned (server/claims-service.ts).
 */
export function claimStatusForFollowUp(normalized: string): string | null {
  switch (String(normalized || "").trim()) {
    case "approved":
      return "approved"
    case "rejected":
      return "rejected"
    case "paid":
      return "paid"
    case "reconciled":
      return "reconciled"
    case "under_review":
      return "under_review"
    case "escalated":
      return "escalated"
    case "reclaim":
      return "reclaim"
    default:
      return null
  }
}

export function stopReasonMessage(stopReason: string, marketplace: string): string {
  switch (stopReason) {
    case "ticket_resolved":
      return "Ticket reached a final state. No further checks are needed."
    case "check_not_supported":
      return `Automated ticket check is not implemented for ${marketplace || "this marketplace"} yet.`
    case "repeated_errors":
      return "Stopped after repeated check failures. Open the ticket once by hand to confirm its state."
    case "max_checks_reached":
      return `Stopped after ${FOLLOW_UP_MAX_CHECKS} checks. Confirm the ticket by hand.`
    default:
      return ""
  }
}

export type FollowUpStep = {
  stopReason: string
  countAsCheck: boolean
  countAsError: boolean
}

/**
 * What to do after one check. Pure: given the reported outcome and the row's counters, say whether this check
 * counts against the budget, whether it is an error, and whether the follow-up should stop.
 */
export function decideFollowUpStep(input: {
  outcome: FollowUpOutcome
  normalizedStatus?: string
  checkCount: number
  errorStreak: number
}): FollowUpStep {
  const outcome = input.outcome
  const normalized = String(input.normalizedStatus || "")

  // A marketplace whose status reader is not built yet cannot be chased; stop rather than open its portal every
  // two days for nothing. New submissions re-create an active follow-up, so building the reader is enough to
  // start tracking that marketplace.
  if (outcome === "not_supported") return { stopReason: "check_not_supported", countAsCheck: false, countAsError: false }

  // The saved session expired or the operator must confirm something on the portal. Not an error and not a
  // spent check: keep the follow-up active and let the next cadence try again.
  if (outcome === "login_required") return { stopReason: "", countAsCheck: false, countAsError: false }

  if (outcome === "status_read") {
    if (isTerminalFollowUpStatus(normalized)) return { stopReason: "ticket_resolved", countAsCheck: true, countAsError: false }
    if (input.checkCount + 1 >= FOLLOW_UP_MAX_CHECKS) {
      return { stopReason: "max_checks_reached", countAsCheck: true, countAsError: false }
    }
    return { stopReason: "", countAsCheck: true, countAsError: false }
  }

  // not_found | error: the ticket could not be read. Retry a few times, then stop and flag for a human.
  if (input.errorStreak + 1 >= FOLLOW_UP_MAX_ERROR_STREAK) {
    return { stopReason: "repeated_errors", countAsCheck: true, countAsError: true }
  }
  return { stopReason: "", countAsCheck: true, countAsError: true }
}

export function nextCheckAtFrom(from: Date, hours = FOLLOW_UP_INTERVAL_HOURS): Date {
  return new Date(from.getTime() + hours * 60 * 60 * 1000)
}

export type FollowUpRow = {
  id: number
  claimId: number
  jobId: number | null
  marketplaceId: number | null
  marketplace: string
  accountName: string
  marketplaceClaimId: string
  orderNumber: string
  claimStatus: string
  stage: string
  isActive: boolean
  stopReason: string
  statusAtLastCheck: string
  lastCheckedAt: string | null
  nextCheckAt: string
  checkIntervalHours: number
  checkCount: number
  errorStreak: number
  lastError: string
  history: Array<Record<string, unknown>>
  createdAt: string
  updatedAt: string
}

function iso(value: unknown): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

// ---------------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------------

/**
 * Create (or re-arm) the follow-up for a claim whose filing job just completed. Runs inside the caller's
 * transaction. One follow-up per claim: re-filing the same claim resets the timer instead of adding a row.
 */
export async function createFollowUpForJob(
  client: pg.PoolClient,
  jobId: number,
  marketplaceClaimId: string,
): Promise<void> {
  const ref = String(marketplaceClaimId || "").trim()
  if (!ref) return
  await client.query(
    `INSERT INTO claim_automation_follow_ups (
       claim_id, job_id, marketplace_id, marketplace_credential_id, marketplace_claim_id, account_name,
       stage, is_active, stop_reason, next_check_at, check_interval_hours, updated_at
     )
     SELECT j.claim_id, j.id, c.marketplace_id, j.marketplace_credential_id, $2,
            COALESCE(mc.account_name, ''), 'scheduled', true, '',
            now() + make_interval(hours => $3::int), $3::int, now()
     FROM claim_automation_jobs j
     JOIN claims c ON c.id = j.claim_id
     LEFT JOIN marketplace_credentials mc ON mc.id = j.marketplace_credential_id
     WHERE j.id = $1
     ON CONFLICT (claim_id) DO UPDATE
       SET job_id = EXCLUDED.job_id,
           marketplace_id = EXCLUDED.marketplace_id,
           marketplace_credential_id = EXCLUDED.marketplace_credential_id,
           marketplace_claim_id = EXCLUDED.marketplace_claim_id,
           account_name = EXCLUDED.account_name,
           stage = 'scheduled',
           is_active = true,
           stop_reason = '',
           status_at_last_check = '',
           check_count = 0,
           error_streak = 0,
           lease_expires_at = NULL,
           agent_id = NULL,
           last_error = '',
           next_check_at = EXCLUDED.next_check_at,
           updated_at = now()`,
    [jobId, ref, FOLLOW_UP_INTERVAL_HOURS],
  )
}

export type FollowUpLease = {
  followUpId: number
  claimId: number
  marketplace: string
  accountName: string
  marketplaceClaimId: string
  portalUrl: string
}

/**
 * Lease the next due follow-up for this agent, scoped to the accounts the enrolling user may see. Reading a
 * ticket state has no external side effect, so an expired lease is simply returned to the queue.
 */
export async function leaseNextDueFollowUp(
  db: pg.Pool,
  agentUuid: string,
  scope: AccountScope,
): Promise<FollowUpLease | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const agentRes = await client.query(
      `SELECT id FROM claim_automation_agents WHERE agent_uuid = $1 AND is_authorized = true`,
      [agentUuid],
    )
    if (!agentRes.rows[0]) {
      await client.query("ROLLBACK")
      return null
    }
    const agentId = Number(agentRes.rows[0].id)

    await client.query(
      `UPDATE claim_automation_follow_ups
       SET stage = 'scheduled',
           lease_expires_at = NULL,
           agent_id = NULL,
           last_error = CASE WHEN last_error = '' THEN 'Desktop check lease expired; rescheduled.' ELSE last_error END,
           updated_at = now()
       WHERE stage = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()`,
    )

    const params: unknown[] = []
    const scopeCondition = accountCondition(scope, "c.marketplace_id", params)
    const res = await client.query(
      `SELECT f.id, f.claim_id, f.marketplace_claim_id, f.account_name,
              COALESCE(m.name, '') AS marketplace,
              COALESCE(mc.portal_url, '') AS portal_url
       FROM claim_automation_follow_ups f
       JOIN claims c ON c.id = f.claim_id
       LEFT JOIN marketplaces m ON m.id = c.marketplace_id
       LEFT JOIN marketplace_credentials mc ON mc.id = f.marketplace_credential_id
       WHERE f.is_active = true
         AND f.stage = 'scheduled'
         AND f.next_check_at <= now()
         AND ${scopeCondition}
       ORDER BY f.next_check_at ASC
       LIMIT 1
       FOR UPDATE OF f SKIP LOCKED`,
      params,
    )
    const row = res.rows[0]
    if (!row) {
      await client.query("COMMIT")
      return null
    }

    await client.query(
      `UPDATE claim_automation_follow_ups
       SET stage = 'leased',
           agent_id = $2,
           lease_expires_at = now() + make_interval(mins => $3::int),
           updated_at = now()
       WHERE id = $1`,
      [row.id, agentId, FOLLOW_UP_LEASE_MINUTES],
    )
    await client.query("COMMIT")

    return {
      followUpId: Number(row.id),
      claimId: Number(row.claim_id),
      marketplace: String(row.marketplace || ""),
      accountName: String(row.account_name || ""),
      marketplaceClaimId: String(row.marketplace_claim_id || ""),
      portalUrl: String(row.portal_url || ""),
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export type FollowUpResultInput = {
  outcome: FollowUpOutcome
  statusText?: string
  normalizedStatus?: string
  note?: string
  screenshotPath?: string
}

/**
 * Record the outcome of one ticket check for the agent that holds the lease.
 *
 * On a status read the ticket text is normalized here (one place for the wording rules), the claim status and
 * history advance when the ticket state maps to a lifecycle status, and the next check is scheduled. Terminal
 * states, a missing status reader, and repeated failures stop the row without deleting it.
 */
export async function recordFollowUpResult(
  db: pg.Pool,
  agentUuid: string,
  followUpId: number,
  input: FollowUpResultInput,
): Promise<{ marketplaceId: number | null; stopReason: string; normalizedStatus: string; isActive: boolean }> {
  if (!FOLLOW_UP_OUTCOMES.includes(input.outcome)) throw new ServiceError(400, "Unknown follow-up outcome.")

  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const agentRes = await client.query(
      `SELECT id FROM claim_automation_agents WHERE agent_uuid = $1 AND is_authorized = true`,
      [agentUuid],
    )
    if (!agentRes.rows[0]) throw new ServiceError(401, "Agent authentication failed.")
    const agentId = Number(agentRes.rows[0].id)

    const leaseRes = await client.query(
      `SELECT f.id, f.claim_id, f.check_count, f.error_streak, f.status_at_last_check, f.marketplace_claim_id,
              f.marketplace_id, COALESCE(m.name, '') AS marketplace, c.status AS claim_status
       FROM claim_automation_follow_ups f
       JOIN claims c ON c.id = f.claim_id
       LEFT JOIN marketplaces m ON m.id = c.marketplace_id
       WHERE f.id = $1 AND f.agent_id = $2 AND f.is_active = true
       FOR UPDATE OF f`,
      [followUpId, agentId],
    )
    const row = leaseRes.rows[0]
    if (!row) throw new ServiceError(404, "Follow-up not found or not leased by this agent.")

    const statusText = String(input.statusText || "").trim()
    const normalizedStatus =
      input.outcome === "status_read"
        ? String(input.normalizedStatus || "").trim() || normalizeFollowUpStatus(statusText)
        : ""
    const marketplace = String(row.marketplace || "")

    const decision = decideFollowUpStep({
      outcome: input.outcome,
      normalizedStatus,
      checkCount: Number(row.check_count || 0),
      errorStreak: Number(row.error_streak || 0),
    })
    const stopping = decision.stopReason !== ""
    const nextCheckCount = Number(row.check_count || 0) + (decision.countAsCheck ? 1 : 0)
    const nextErrorStreak = decision.countAsError ? Number(row.error_streak || 0) + 1 : 0
    const stopMessage = stopping ? stopReasonMessage(decision.stopReason, marketplace) : ""
    const lastError = stopping
      ? stopMessage
      : input.outcome === "status_read"
        ? ""
        : String(input.note || statusText || `Check reported ${input.outcome}.`).slice(0, 500)

    const historyEntry = JSON.stringify([
      {
        at: new Date().toISOString(),
        outcome: input.outcome,
        statusText: statusText.slice(0, 500),
        normalizedStatus,
        note: String(input.note || "").slice(0, 500),
        agentId,
      },
    ])

    await client.query(
      `UPDATE claim_automation_follow_ups
       SET stage = $2,
           is_active = $3,
           stop_reason = $4,
           status_at_last_check = CASE WHEN $5::text <> '' THEN $5 ELSE status_at_last_check END,
           last_checked_at = now(),
           check_count = $6,
           error_streak = $7,
           next_check_at = CASE WHEN $8::timestamptz IS NULL THEN next_check_at ELSE $8::timestamptz END,
           lease_expires_at = NULL,
           agent_id = NULL,
           last_error = $9,
           history = history || $10::jsonb,
           updated_at = now()
       WHERE id = $1`,
      [
        followUpId,
        stopping ? "stopped" : "scheduled",
        !stopping,
        decision.stopReason,
        normalizedStatus || statusText,
        nextCheckCount,
        nextErrorStreak,
        stopping ? null : nextCheckAtFrom(new Date()).toISOString(),
        lastError,
        historyEntry,
      ],
    )

    // Advance the claim when the ticket state maps to a lifecycle status and the claim is not already there.
    const claimStatus = input.outcome === "status_read" ? claimStatusForFollowUp(normalizedStatus) : null
    if (claimStatus && claimStatus !== String(row.claim_status || "")) {
      await client.query(
        `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
         SELECT id, status, $2, $3, NULL FROM claims WHERE id = $1 AND status <> $2`,
        [row.claim_id, claimStatus, `Follow-up check: ${statusText || normalizedStatus}`],
      )
      await client.query(
        `UPDATE claims SET status = $2, updated_at = now() WHERE id = $1 AND status <> $2`,
        [row.claim_id, claimStatus],
      )
    }

    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES (NULL, 'claim.follow_up_check', 'claim_automation_follow_up', $1, $2::jsonb)`,
      [
        String(followUpId),
        JSON.stringify({
          claimId: Number(row.claim_id),
          marketplaceClaimId: String(row.marketplace_claim_id || ""),
          outcome: input.outcome,
          statusText: statusText.slice(0, 200),
          normalizedStatus,
          stopReason: decision.stopReason,
          screenshotPath: String(input.screenshotPath || ""),
        }),
      ],
    )

    await client.query("COMMIT")
    return {
      marketplaceId: row.marketplace_id === null || row.marketplace_id === undefined ? null : Number(row.marketplace_id),
      stopReason: decision.stopReason,
      normalizedStatus,
      isActive: !stopping,
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading (dashboard)
// ---------------------------------------------------------------------------------------------------------------

export type FollowUpSummary = {
  active: number
  due: number
  dueSoon: number
  resolved: number
  stopped: number
  withErrors: number
}

export async function listFollowUps(
  db: pg.Pool,
  scope: AccountScope,
  filter: { activeOnly?: boolean; search?: string; page?: number; pageSize?: number } = {},
): Promise<{ rows: FollowUpRow[]; total: number; summary: FollowUpSummary }> {
  const page = Math.max(1, Number(filter.page) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(filter.pageSize) || 50))

  const params: unknown[] = []
  const scopeCondition = accountCondition(scope, "c.marketplace_id", params)
  const conditions: string[] = [scopeCondition]
  if (filter.activeOnly) conditions.push("f.is_active = true")
  const search = String(filter.search || "").trim()
  if (search) {
    params.push(`%${search}%`)
    conditions.push(`(f.marketplace_claim_id ILIKE $${params.length} OR er.order_number ILIKE $${params.length})`)
  }
  const where = conditions.join(" AND ")

  const summaryRes = await db.query(
    `SELECT
       (COUNT(*) FILTER (WHERE f.is_active))::int AS active,
       (COUNT(*) FILTER (WHERE f.is_active AND f.next_check_at <= now()))::int AS due,
       (COUNT(*) FILTER (WHERE f.is_active AND f.next_check_at <= now() + make_interval(hours => 24)))::int AS due_soon,
       (COUNT(*) FILTER (WHERE NOT f.is_active AND f.stop_reason = 'ticket_resolved'))::int AS resolved,
       (COUNT(*) FILTER (WHERE NOT f.is_active AND f.stop_reason <> 'ticket_resolved'))::int AS stopped,
       (COUNT(*) FILTER (WHERE f.error_streak > 0))::int AS with_errors
     FROM claim_automation_follow_ups f
     JOIN claims c ON c.id = f.claim_id
     LEFT JOIN receipt_scans rs ON rs.id = c.receipt_scan_id
     LEFT JOIN expected_returns er ON er.id = rs.expected_return_id
     WHERE ${where}`,
    params,
  )
  const summaryRow = summaryRes.rows[0] || {}
  const summary: FollowUpSummary = {
    active: Number(summaryRow.active || 0),
    due: Number(summaryRow.due || 0),
    dueSoon: Number(summaryRow.due_soon || 0),
    resolved: Number(summaryRow.resolved || 0),
    stopped: Number(summaryRow.stopped || 0),
    withErrors: Number(summaryRow.with_errors || 0),
  }

  const listParams = [...params, pageSize, (page - 1) * pageSize]
  const listRes = await db.query(
    `SELECT f.id, f.claim_id, f.job_id, f.marketplace_id, f.marketplace_claim_id, f.account_name, f.stage,
            f.is_active, f.stop_reason, f.status_at_last_check, f.last_checked_at, f.next_check_at,
            f.check_interval_hours, f.check_count, f.error_streak, f.last_error, f.history,
            f.created_at, f.updated_at,
            COALESCE(m.name, '') AS marketplace, COALESCE(er.order_number, '') AS order_number,
            c.status AS claim_status, (COUNT(*) OVER())::int AS total_count
     FROM claim_automation_follow_ups f
     JOIN claims c ON c.id = f.claim_id
     LEFT JOIN marketplaces m ON m.id = c.marketplace_id
     LEFT JOIN receipt_scans rs ON rs.id = c.receipt_scan_id
     LEFT JOIN expected_returns er ON er.id = rs.expected_return_id
     WHERE ${where}
     ORDER BY f.is_active DESC, f.next_check_at ASC, f.id DESC
     LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams,
  )

  const rows: FollowUpRow[] = listRes.rows.map((r) => ({
    id: Number(r.id),
    claimId: Number(r.claim_id),
    jobId: r.job_id === null || r.job_id === undefined ? null : Number(r.job_id),
    marketplaceId: r.marketplace_id === null || r.marketplace_id === undefined ? null : Number(r.marketplace_id),
    marketplace: String(r.marketplace || ""),
    accountName: String(r.account_name || ""),
    marketplaceClaimId: String(r.marketplace_claim_id || ""),
    orderNumber: String(r.order_number || ""),
    claimStatus: String(r.claim_status || ""),
    stage: String(r.stage || ""),
    isActive: Boolean(r.is_active),
    stopReason: String(r.stop_reason || ""),
    statusAtLastCheck: String(r.status_at_last_check || ""),
    lastCheckedAt: iso(r.last_checked_at),
    nextCheckAt: iso(r.next_check_at) || "",
    checkIntervalHours: Number(r.check_interval_hours || FOLLOW_UP_INTERVAL_HOURS),
    checkCount: Number(r.check_count || 0),
    errorStreak: Number(r.error_streak || 0),
    lastError: String(r.last_error || ""),
    history: Array.isArray(r.history) ? (r.history as Array<Record<string, unknown>>) : [],
    createdAt: iso(r.created_at) || "",
    updatedAt: iso(r.updated_at) || "",
  }))

  return { rows, total: Number(listRes.rows[0]?.total_count || 0), summary }
}
