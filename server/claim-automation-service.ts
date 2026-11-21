import crypto from "node:crypto"
import type pg from "pg"
import { accountCondition, scopeFor, type AccountScope } from "./access.js"
import { ServiceError, savedScansFor, type Actor } from "./register-service.js"
import { createFollowUpForJob } from "./claim-follow-up-service.js"
import { getClaimTemplate, resolveClaimTemplateId } from "./claims-service.js"
import {
  MEESHO_TAT_DAYS,
  MEESHO_ISSUES,
  type MeeshoIssueCode,
  istDate,
  addDays,
  daysBetween,
  meeshoClaimDueDate,
  meeshoClaimDescription,
} from "./meesho-claims.js"

// AES-256-GCM encryption for marketplace portal credentials. Production must provide a unique key; there is no
// source-code fallback because that would make every installation's encrypted supplier password recoverable.
function encryptionKey(): Buffer {
  const secret = process.env.AUTOMATION_SECRET_KEY?.trim() || ""
  if (secret.length < 32) {
    throw new ServiceError(503, "Marketplace credential encryption is not configured.")
  }
  return crypto.createHash("sha256").update(secret).digest()
}

export function encryptSecret(plainText: string): string {
  if (!plainText) return ""
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`
}

export function decryptSecret(cipherText: string): string {
  if (!cipherText || !cipherText.includes(":")) return ""
  try {
    const [ivHex, tagHex, dataHex] = cipherText.split(":")
    if (!ivHex || !tagHex || !dataHex) return ""
    const iv = Buffer.from(ivHex, "hex")
    const tag = Buffer.from(tagHex, "hex")
    const encrypted = Buffer.from(dataHex, "hex")
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv)
    decipher.setAuthTag(tag)
    return decipher.update(encrypted) + decipher.final("utf8")
  } catch {
    return ""
  }
}

export function maskSecret(val: string): string {
  if (!val) return ""
  if (val.length <= 4) return "****"
  return `${val.slice(0, 2)}****${val.slice(-2)}`
}

export type AutomationAgentRow = {
  id: number
  agentUuid: string
  agentName: string
  hostname: string
  platform: string
  version: string
  status: "online" | "busy" | "offline" | "error"
  lastHeartbeatAt: string
  currentTaskInfo: Record<string, unknown>
  isAuthorized: boolean
}

export type AutomationJobRow = {
  id: number
  claimId: number
  marketplace: string
  accountName: string
  orderNumber: string
  trackingId: string
  claimReason: string
  claimTitle: string
  stage: string
  checkpoint: string
  browserMode: string
  attempts: number
  maxAttempts: number
  nextRetryAt: string | null
  failureReason: string
  marketplaceClaimId: string
  submissionScreenshotPath: string
  manualActionReason: string
  logs: Array<{ timestamp: string; level: string; message: string }>
  agentName: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export function computeRetryBackoffSeconds(attempts: number): number {
  if (attempts <= 1) return 15
  if (attempts === 2) return 45
  return 90
}

export function isTerminalAttempt(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts
}

// ---------------------------------------------------------------------------------------------------------------
// Agent Registration and Heartbeat
// ---------------------------------------------------------------------------------------------------------------

export async function registerOrUpdateAgent(
  db: pg.Pool,
  data: {
    agentUuid: string
    agentName: string
    hostname?: string
    platform?: string
    version?: string
    apiKey?: string
    registeredByUserId: number
  },
): Promise<{ agentId: number; apiKey: string; authorized: boolean }> {
  const uuid = data.agentUuid.trim()
  if (!uuid) throw new ServiceError(400, "Agent UUID is required.")
  const name = data.agentName.trim() || "Desktop-Agent"
  const apiKey = data.apiKey?.trim() || crypto.randomBytes(24).toString("hex")
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex")

  const res = await db.query(
    `INSERT INTO claim_automation_agents (agent_uuid, agent_name, hostname, platform, version, status, last_heartbeat_at, api_key_hash, registered_by_user_id, is_authorized)
     VALUES ($1, $2, $3, $4, $5, 'online', now(), $6, $7, true)
     ON CONFLICT (agent_uuid) DO UPDATE SET
       agent_name = EXCLUDED.agent_name,
       hostname = EXCLUDED.hostname,
       platform = EXCLUDED.platform,
       version = EXCLUDED.version,
       api_key_hash = EXCLUDED.api_key_hash,
       registered_by_user_id = EXCLUDED.registered_by_user_id,
       is_authorized = true,
       status = 'online',
       last_heartbeat_at = now(),
       updated_at = now()
     RETURNING id, is_authorized`,
    [uuid, name, data.hostname || "", data.platform || "win32", data.version || "1.0.0", keyHash, data.registeredByUserId],
  )

  return {
    agentId: Number(res.rows[0].id),
    apiKey,
    authorized: Boolean(res.rows[0].is_authorized),
  }
}

export async function scopeForAutomationAgent(db: pg.Pool, agentUuid: string): Promise<AccountScope> {
  const result = await db.query(
    `SELECT u.role, u.has_all_marketplaces,
            COALESCE(array_agg(um.marketplace_id) FILTER (WHERE um.marketplace_id IS NOT NULL), '{}') AS marketplace_ids
     FROM claim_automation_agents a
     JOIN users u ON u.id = a.registered_by_user_id
     LEFT JOIN user_marketplaces um ON um.user_id = u.id
     WHERE a.agent_uuid = $1 AND a.is_authorized = true
     GROUP BY u.id, u.role, u.has_all_marketplaces`,
    [agentUuid],
  )
  const row = result.rows[0]
  if (!row) return { all: false, marketplaceIds: [] }
  return scopeFor({
    role: String(row.role || ""),
    hasAllMarketplaces: Boolean(row.has_all_marketplaces),
    marketplaceIds: Array.isArray(row.marketplace_ids) ? row.marketplace_ids.map(Number) : [],
  })
}

export async function authenticateAutomationAgent(
  db: pg.Pool,
  agentUuid: string,
  apiKey: string,
  jobId?: number,
): Promise<{ id: number; uuid: string }> {
  const uuid = agentUuid.trim()
  const key = apiKey.trim()
  if (!uuid || !key) throw new ServiceError(401, "Agent authentication required.")
  const keyHash = crypto.createHash("sha256").update(key).digest("hex")
  const result = await db.query(
    `SELECT a.id, a.agent_uuid, a.api_key_hash, a.is_authorized
     FROM claim_automation_agents a
     WHERE a.agent_uuid = $1`,
    [uuid],
  )
  const row = result.rows[0]
  const stored = String(row?.api_key_hash || "")
  const supplied = Buffer.from(keyHash, "hex")
  const expected = /^[0-9a-f]{64}$/i.test(stored) ? Buffer.from(stored, "hex") : Buffer.alloc(32)
  const keyMatches = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)
  if (!row || !row.is_authorized || !keyMatches) throw new ServiceError(401, "Agent authentication failed.")

  if (jobId) {
    const job = await db.query(
      `SELECT 1 FROM claim_automation_jobs WHERE id = $1 AND agent_id = $2`,
      [jobId, Number(row.id)],
    )
    if (!job.rows[0]) throw new ServiceError(404, "Automation job not found.")
  }
  return { id: Number(row.id), uuid: String(row.agent_uuid) }
}

export async function recordAgentHeartbeat(
  db: pg.Pool,
  agentUuid: string,
  status: "online" | "busy" | "offline" | "error",
  currentTaskInfo: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `UPDATE claim_automation_agents
     SET status = $2,
         current_task_info = $3,
         last_heartbeat_at = now(),
         updated_at = now()
     WHERE agent_uuid = $1`,
    [agentUuid, status, JSON.stringify(currentTaskInfo)],
  )
}

export async function listAutomationAgents(db: pg.Pool): Promise<AutomationAgentRow[]> {
  const res = await db.query(
    `SELECT id, agent_uuid, agent_name, hostname, platform, version,
            CASE
              WHEN last_heartbeat_at < now() - INTERVAL '90 seconds' THEN 'offline'
              ELSE status
            END AS computed_status,
            last_heartbeat_at, current_task_info, is_authorized
     FROM claim_automation_agents
     ORDER BY last_heartbeat_at DESC`,
  )

  return res.rows.map((r) => ({
    id: Number(r.id),
    agentUuid: String(r.agent_uuid),
    agentName: String(r.agent_name),
    hostname: String(r.hostname || ""),
    platform: String(r.platform || "win32"),
    version: String(r.version || "1.0.0"),
    status: r.computed_status as AutomationAgentRow["status"],
    lastHeartbeatAt: r.last_heartbeat_at instanceof Date ? r.last_heartbeat_at.toISOString() : String(r.last_heartbeat_at),
    currentTaskInfo: (r.current_task_info || {}) as Record<string, unknown>,
    isAuthorized: Boolean(r.is_authorized),
  }))
}

// ---------------------------------------------------------------------------------------------------------------
// Marketplace Credentials (Admin Configuration)
// ---------------------------------------------------------------------------------------------------------------

export async function listMarketplaceCredentials(
  db: pg.Pool,
  scope: AccountScope,
): Promise<Array<{
  id: number
  marketplaceId: number | null
  marketplaceName: string
  accountName: string
  portalUrl: string
  usernameMasked: string
  automationMode: string
  requireApprovalBeforeSubmit: boolean
  autoPrepare: boolean
  isActive: boolean
  lastLoginAt: string | null
}>> {
  const params: unknown[] = []
  const scopeCondition = accountCondition(scope, "mc.marketplace_id", params)

  const res = await db.query(
    `SELECT mc.id, mc.marketplace_id, m.name AS marketplace_name, mc.account_name,
            mc.portal_url, mc.username_encrypted, mc.automation_mode,
            mc.require_approval_before_submit, mc.auto_prepare, mc.is_active, mc.last_login_at
     FROM marketplace_credentials mc
     LEFT JOIN marketplaces m ON m.id = mc.marketplace_id
     WHERE mc.is_active = true AND (${scopeCondition} OR mc.marketplace_id IS NULL)
     ORDER BY mc.id`,
    params,
  )

  return res.rows.map((r) => {
    const rawUser = decryptSecret(String(r.username_encrypted || ""))
    return {
      id: Number(r.id),
      marketplaceId: r.marketplace_id ? Number(r.marketplace_id) : null,
      marketplaceName: String(r.marketplace_name || "All"),
      accountName: String(r.account_name),
      portalUrl: String(r.portal_url || ""),
      usernameMasked: maskSecret(rawUser),
      automationMode: String(r.automation_mode || "assisted"),
      requireApprovalBeforeSubmit: Boolean(r.require_approval_before_submit),
      autoPrepare: Boolean(r.auto_prepare),
      isActive: Boolean(r.is_active),
      lastLoginAt: r.last_login_at instanceof Date ? r.last_login_at.toISOString() : null,
    }
  })
}

export async function getPortalLoginForSetup(
  db: pg.Pool,
  accountName: string,
): Promise<{ accountName: string; portalUrl: string; username: string; password: string } | null> {
  const name = accountName.trim()
  if (!name) return null
  const res = await db.query(
    `SELECT mc.account_name, mc.portal_url, mc.username_encrypted, mc.password_encrypted
     FROM marketplace_credentials mc
     LEFT JOIN marketplaces m ON m.id = mc.marketplace_id
     WHERE mc.is_active = true
       AND (LOWER(mc.account_name) = LOWER($1) OR LOWER(COALESCE(m.name, '')) = LOWER($1))
     ORDER BY mc.id ASC
     LIMIT 1`,
    [name],
  )
  const row = res.rows[0]
  if (!row) return null
  const username = decryptSecret(String(row.username_encrypted || ""))
  const password = decryptSecret(String(row.password_encrypted || ""))
  if (!username || !password) return null
  return {
    accountName: String(row.account_name),
    portalUrl: String(row.portal_url || ""),
    username,
    password,
  }
}

export function isMeeshoAccountName(accountName: string): boolean {
  return accountName.toLowerCase().includes("meesho")
}

/**
 * Standing submission authorization for a new credential (M9: a saved login
 * never authorizes; this flag is the authorization). Meesho runs full-auto
 * by operator decision: the operator signs in manually once, the cookies
 * stay saved on the PC, and claims then submit automatically with the
 * ticket ID stored. Every other marketplace keeps approval-before-submit.
 */
export function defaultRequireApprovalBeforeSubmit(accountName: string): boolean {
  return !isMeeshoAccountName(accountName)
}

export function defaultMarketplacePortalUrl(accountName: string): string {
  const n = accountName.toLowerCase()
  if (n.includes("meesho")) return "https://supplier.meesho.com/panel/v3/new/root/login"
  if (n.includes("flipkart")) return "https://seller.flipkart.com/index.html#dashboard"
  if (n.includes("amazon")) return "https://sellercentral.amazon.in/"
  if (n.includes("myntra")) return "https://partners.myntrainfo.com/"
  if (n.includes("ajio")) return "https://supplier.ajio.com/"
  return "https://supplier.meesho.com/panel/v3/new/root/login"
}

export async function saveMarketplaceCredential(
  db: pg.Pool,
  actor: Actor,
  data: {
    id?: number
    marketplaceId?: number | null
    accountName: string
    portalUrl?: string
    username?: string
    password?: string
    automationMode?: string
    requireApprovalBeforeSubmit?: boolean
    autoPrepare?: boolean
  },
): Promise<number> {
  const name = data.accountName.trim()
  if (!name) throw new ServiceError(400, "Account name is required.")

  const portalUrl = (data.portalUrl || "").trim() || defaultMarketplacePortalUrl(name)
  const userEnc = data.username ? encryptSecret(data.username.trim()) : undefined
  const passEnc = data.password ? encryptSecret(data.password.trim()) : undefined

  let targetId = data.id
  if (!targetId) {
    const existing = await db.query(
      `SELECT id FROM marketplace_credentials 
       WHERE is_active = true AND (
         (marketplace_id IS NOT NULL AND marketplace_id = $1)
         OR LOWER(account_name) = LOWER($2)
       ) LIMIT 1`,
      [data.marketplaceId || null, name],
    )
    if (existing.rows.length > 0) {
      targetId = Number(existing.rows[0].id)
    }
  }

  if (targetId) {
    const setClauses: string[] = ["account_name = $1", "portal_url = $2", "updated_at = now()"]
    const params: unknown[] = [name, portalUrl]

    if (data.marketplaceId !== undefined) {
      params.push(data.marketplaceId)
      setClauses.push(`marketplace_id = $${params.length}`)
    }
    if (userEnc !== undefined) {
      params.push(userEnc)
      setClauses.push(`username_encrypted = $${params.length}`)
    }
    if (passEnc !== undefined) {
      params.push(passEnc)
      setClauses.push(`password_encrypted = $${params.length}`)
    }
    if (data.automationMode !== undefined) {
      params.push(data.automationMode)
      setClauses.push(`automation_mode = $${params.length}`)
    }
    if (data.requireApprovalBeforeSubmit !== undefined) {
      params.push(data.requireApprovalBeforeSubmit)
      setClauses.push(`require_approval_before_submit = $${params.length}`)
    }
    if (data.autoPrepare !== undefined) {
      params.push(data.autoPrepare)
      setClauses.push(`auto_prepare = $${params.length}`)
    }

    params.push(targetId)
    await db.query(
      `UPDATE marketplace_credentials SET ${setClauses.join(", ")} WHERE id = $${params.length}`,
      params,
    )
    return targetId
  } else {
    const res = await db.query(
      `INSERT INTO marketplace_credentials (
        marketplace_id, account_name, portal_url, username_encrypted, password_encrypted,
        automation_mode, require_approval_before_submit, auto_prepare
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        data.marketplaceId || null,
        name,
        portalUrl,
        userEnc || "",
        passEnc || "",
        data.automationMode || "assisted",
        data.requireApprovalBeforeSubmit !== undefined
          ? data.requireApprovalBeforeSubmit
          : defaultRequireApprovalBeforeSubmit(name),
        data.autoPrepare !== false,
      ],
    )
    return Number(res.rows[0].id)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Automation Jobs Queue & Execution
// ---------------------------------------------------------------------------------------------------------------

const ACTIVE_AUTOMATION_STAGES = new Set([
  "queued",
  "approved",
  "downloading_media",
  "opening_portal",
  "filling_form",
  "submitting",
])

export async function createOrQueueAutomationJob(
  db: pg.Pool,
  claimId: number,
  options: { browserMode?: string; requeueReopened?: boolean } = {},
): Promise<number | null> {
  const marketplace = await db.query(
    `SELECT m.name
     FROM claims c
     JOIN marketplaces m ON m.id = c.marketplace_id
     WHERE c.id = $1`,
    [claimId],
  )
  if (String(marketplace.rows[0]?.name || "").trim().toLowerCase() !== "meesho") {
    return null
  }
  // Check if job already exists for this claim
  const existing = await db.query(
    `SELECT id, stage FROM claim_automation_jobs WHERE claim_id = $1 ORDER BY id DESC LIMIT 1`,
    [claimId],
  )
  const existingStage = String(existing.rows[0]?.stage || "")
  const shouldRequeue = existingStage === "failed" || (Boolean(options.requeueReopened) && !ACTIVE_AUTOMATION_STAGES.has(existingStage))
  if (existing.rows[0] && !shouldRequeue) {
    return Number(existing.rows[0].id)
  }

  // Duplicate order/sub-order prevention: never queue another active filing job if a completed
  // ticket already exists for the same sub-order (or order when sub-order is blank) unless reopened as reclaim.
  if (!options.requeueReopened) {
    const dupOrder = await db.query<{ ticket_id: string }>(
      `/* duplicate_order_guard_create */
       SELECT other_j.marketplace_claim_id AS ticket_id
       FROM claims c
       JOIN receipt_scans rs ON rs.id = c.receipt_scan_id
       JOIN expected_returns er ON er.id = rs.expected_return_id
       JOIN claim_automation_jobs other_j ON other_j.stage = 'completed' AND other_j.marketplace_claim_id <> ''
       JOIN claims other_c ON other_c.id = other_j.claim_id AND other_c.marketplace_id = c.marketplace_id
       JOIN receipt_scans other_rs ON other_rs.id = other_c.receipt_scan_id
       JOIN expected_returns other_er ON other_er.id = other_rs.expected_return_id
       WHERE c.id = $1
         AND c.status <> 'reclaim'
         AND other_j.claim_id <> c.id
         AND (
           (NULLIF(BTRIM(c.sub_order_id_snapshot), '') IS NOT NULL
             AND NULLIF(BTRIM(other_c.sub_order_id_snapshot), '') IS NOT NULL
             AND UPPER(BTRIM(other_c.sub_order_id_snapshot)) = UPPER(BTRIM(c.sub_order_id_snapshot)))
           OR (
             (NULLIF(BTRIM(c.sub_order_id_snapshot), '') IS NULL OR NULLIF(BTRIM(other_c.sub_order_id_snapshot), '') IS NULL)
             AND NULLIF(BTRIM(er.order_number), '') IS NOT NULL
             AND UPPER(BTRIM(other_er.order_number)) = UPPER(BTRIM(er.order_number))
           )
         )
       LIMIT 1`,
      [claimId],
    )
    const dupTicket = dupOrder.rows[0]?.ticket_id ? String(dupOrder.rows[0].ticket_id) : ""
    if (dupTicket) {
      await db.query(
        `UPDATE claims
         SET status = 'manual_action_required',
             remarks = COALESCE(remarks, '') || '\nDuplicate prevented: existing ticket ' || $2,
             updated_at = now()
         WHERE id = $1 AND status NOT IN ('submitted', 'approved', 'reconciled', 'paid', 'manual_action_required')`,
        [claimId, dupTicket],
      )
      return null
    }
  }

  // Find matching credential for claim's marketplace
  const cred = await db.query(
    `SELECT mc.id, mc.automation_mode
     FROM claims c
     JOIN marketplace_credentials mc ON mc.marketplace_id = c.marketplace_id AND mc.is_active = true
     WHERE c.id = $1
     LIMIT 1`,
    [claimId],
  )

  const credId = cred.rows[0]?.id ? Number(cred.rows[0].id) : null
  const browserMode = options.browserMode || (cred.rows[0]?.automation_mode === "headless" ? "headless" : "visible")

  const res = await db.query(
    `INSERT INTO claim_automation_jobs (claim_id, marketplace_credential_id, stage, browser_mode, logs)
     VALUES ($1, $2, 'queued', $3, $4)
     RETURNING id`,
    [
      claimId,
      credId,
      browserMode,
      JSON.stringify([{ timestamp: new Date().toISOString(), level: "info", message: "Job created and queued." }]),
    ],
  )
  return Number(res.rows[0].id)
}

/**
 * `skipMarketplaces` names the marketplaces whose desktop panel is held for the operator (prepared, manual action)
 * or cooling down. Their queued jobs are not leased, so they keep every attempt instead of burning one per poll on a
 * lease the desktop would drop. Approved jobs still lease: submitting is how a held panel's prepared claim is filed.
 */
export async function pollNextAutomationJob(
  db: pg.Pool,
  agentUuid: string,
  scope: AccountScope,
  skipMarketplaces: readonly string[] = [],
): Promise<{
  jobId: number
  claimId: number
  stage: string
  checkpoint: string
  marketplace: string
  orderNumber: string
  trackingId: string
} | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    // Find agent id
    const agentRes = await client.query(
      `SELECT id FROM claim_automation_agents WHERE agent_uuid = $1 AND is_authorized = true`,
      [agentUuid],
    )
    if (!agentRes.rows[0]) {
      await client.query("ROLLBACK")
      return null
    }
    const agentId = Number(agentRes.rows[0].id)

    // Once submission starts, an expired lease has an unknown external outcome. Never submit it again automatically,
    // because Meesho may have accepted the claim before the worker lost connectivity.
    const uncertainSubmissions = await client.query(
      `UPDATE claim_automation_jobs
       SET stage = 'manual_intervention_required',
           lease_expires_at = NULL,
           last_error = 'Submission lease expired; verify the Meesho portal before retrying.',
           manual_action_reason = 'The desktop lost contact during submission. Verify whether Meesho created a ticket before retrying.',
           updated_at = now()
       WHERE stage = 'submitting'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < now()
       RETURNING id, claim_id`,
    )
    for (const row of uncertainSubmissions.rows) {
      await client.query(
        `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
         SELECT id, status, 'manual_action_required', 'Desktop submission lease expired; marketplace outcome is unknown.', NULL
         FROM claims
         WHERE id = $1 AND status NOT IN ('submitted', 'approved', 'reconciled', 'paid', 'manual_action_required')`,
        [row.claim_id],
      )
      await client.query(
        `UPDATE claims SET status = 'manual_action_required', updated_at = now()
         WHERE id = $1 AND status NOT IN ('submitted', 'approved', 'reconciled', 'paid')`,
        [row.claim_id],
      )
      await client.query(
        `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
         VALUES (NULL, 'claim.automation_submission_uncertain', 'claim_automation_job', $1, $2::jsonb)`,
        [String(row.id), JSON.stringify({ claimId: Number(row.claim_id) })],
      )
    }

    // Earlier process stages are safe to retry. Expired leases return to the queue with short backoff
    // until attempts >= max_attempts (3-attempt rule), after which the job moves to manual_intervention_required
    // ("Manual required") so an operator can resolve it without blocking remaining claims.
    const recoveredJobs = await client.query(
      `UPDATE claim_automation_jobs
       SET stage = CASE WHEN attempts >= max_attempts THEN 'manual_intervention_required' ELSE 'queued' END,
           agent_id = CASE WHEN attempts >= max_attempts THEN agent_id ELSE NULL END,
           lease_expires_at = NULL,
           next_retry_at = CASE WHEN attempts >= max_attempts THEN NULL ELSE now() + INTERVAL '15 seconds' END,
           last_error = CASE
             WHEN attempts >= max_attempts THEN 'Desktop worker lease expired after the final attempt.'
             ELSE 'Desktop worker lease expired; queued for retry.'
           END,
           failure_reason = CASE
             WHEN attempts >= max_attempts THEN 'Failed after 3 attempts: Desktop worker lease expired before completion.'
             ELSE 'Desktop worker lease expired; queued for retry.'
           END,
           manual_action_reason = CASE
             WHEN attempts >= max_attempts THEN 'Failed after 3 attempts: Desktop worker lease expired before completion.'
             ELSE manual_action_reason
           END,
           updated_at = now()
       WHERE stage IN ('downloading_media', 'opening_portal', 'filling_form')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < now()
       RETURNING id, claim_id, stage`,
    )
    for (const row of recoveredJobs.rows) {
      if (row.stage !== "manual_intervention_required") continue
      await client.query(
        `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
         SELECT id, status, 'manual_action_required', 'Failed after 3 attempts: Desktop worker lease expired.', NULL
         FROM claims
         WHERE id = $1 AND status NOT IN ('submitted', 'approved', 'reconciled', 'paid', 'manual_action_required')`,
        [row.claim_id],
      )
      await client.query(
        `UPDATE claims SET status = 'manual_action_required', updated_at = now()
         WHERE id = $1 AND status NOT IN ('submitted', 'approved', 'reconciled', 'paid')`,
        [row.claim_id],
      )
      await client.query(
        `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
         VALUES (NULL, 'claim.automation_lease_manual_required', 'claim_automation_job', $1, $2::jsonb)`,
        [String(row.id), JSON.stringify({ claimId: Number(row.claim_id) })],
      )
    }

    // Backfill queue jobs for any pre-existing ready Meesho claims in scope that have
    // never entered claim_automation_jobs yet (preserves failed/prepared/completed rows).
    const backfillParams: unknown[] = []
    const backfillScope = accountCondition(scope, "c.marketplace_id", backfillParams)
    await client.query(
      `WITH missing AS (
         SELECT c.id, c.marketplace_id
         FROM claims c
         JOIN marketplaces m ON m.id = c.marketplace_id
         WHERE LOWER(m.name) = 'meesho'
           AND c.status IN ('ready_for_claim', 'reclaim', 'escalated')
           AND ${backfillScope}
           AND NOT EXISTS (
             SELECT 1 FROM claim_automation_jobs existing_j WHERE existing_j.claim_id = c.id
           )
         FOR UPDATE OF c SKIP LOCKED
       )
       INSERT INTO claim_automation_jobs (claim_id, marketplace_credential_id, stage, browser_mode, logs)
       SELECT missing.id,
              mc.id,
              'queued',
              CASE WHEN mc.automation_mode = 'headless' THEN 'headless' ELSE 'visible' END,
              '[{"level":"info","message":"Queued existing eligible claim for desktop automation."}]'::jsonb
       FROM missing
       LEFT JOIN LATERAL (
         SELECT id, automation_mode
         FROM marketplace_credentials
         WHERE marketplace_id = missing.marketplace_id AND is_active = true
         ORDER BY id ASC
         LIMIT 1
       ) mc ON true`,
      backfillParams,
    )

    // Select oldest queued job or approved job ready for submission
    const jobParams: unknown[] = []
    const scopeCondition = accountCondition(scope, "c.marketplace_id", jobParams)
    jobParams.push(
      skipMarketplaces
        .map((name) => String(name).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 20),
    )
    const skipParam = `$${jobParams.length}::text[]`
    const jobRes = await client.query(
      `SELECT j.id, j.claim_id, j.stage, j.checkpoint, c.marketplace_id, c.status AS claim_status,
              c.sub_order_id_snapshot, m.name AS marketplace, er.order_number, er.tracking_id
       FROM claim_automation_jobs j
       JOIN claims c ON c.id = j.claim_id
       JOIN marketplaces m ON m.id = c.marketplace_id
       JOIN receipt_scans rs ON rs.id = c.receipt_scan_id
       JOIN expected_returns er ON er.id = rs.expected_return_id
       WHERE j.stage IN ('queued', 'approved')
         AND LOWER(m.name) = 'meesho'
         AND j.attempts < j.max_attempts
         AND (j.next_retry_at IS NULL OR j.next_retry_at <= now())
         -- Filing eligibility allowlist (M8): only claims that are ready to file, being
         -- processed, or explicitly re-opened may lease. Pending states (pending_evidence,
         -- waiting_for_approval), recorded outcomes (submitted, under_review, approved, rejected,
         -- reconciled, paid) and operator-held states (failed, manual_action_required) never
         -- lease directly; they re-enter only through retry/approve/manual-resolve. Jobs for
         -- incomplete claims stay safely pending and become eligible automatically when
         -- addClaimMedia flips the claim to ready_for_claim.
         AND c.status IN ('ready_for_claim', 'processing', 'reclaim', 'escalated')
         AND NOT (j.stage = 'queued' AND LOWER(m.name) = ANY(${skipParam}))
         AND ${scopeCondition}
       ORDER BY j.created_at ASC
       LIMIT 1
       FOR UPDATE OF j SKIP LOCKED`,
      jobParams,
    )

    if (!jobRes.rows[0]) {
      await client.query("COMMIT")
      return null
    }

    const job = jobRes.rows[0]

    // Duplicate order/sub-order guard at lease time: if another completed job already filed
    // a ticket for this sub-order (or order when sub-order is blank), never file a second time.
    if (String(job.claim_status || "") !== "reclaim") {
      const dupCheck = await client.query<{ ticket_id: string }>(
        `/* completed_other_order_check */
         SELECT other_j.marketplace_claim_id AS ticket_id
         FROM claim_automation_jobs other_j
         JOIN claims other_c ON other_c.id = other_j.claim_id AND other_c.marketplace_id = $1
         JOIN receipt_scans other_rs ON other_rs.id = other_c.receipt_scan_id
         JOIN expected_returns other_er ON other_er.id = other_rs.expected_return_id
         WHERE other_j.stage = 'completed'
           AND other_j.marketplace_claim_id <> ''
           AND other_j.claim_id <> $2
           AND (
             (NULLIF(BTRIM($3::text), '') IS NOT NULL
               AND NULLIF(BTRIM(other_c.sub_order_id_snapshot), '') IS NOT NULL
               AND UPPER(BTRIM(other_c.sub_order_id_snapshot)) = UPPER(BTRIM($3::text)))
             OR (
               (NULLIF(BTRIM($3::text), '') IS NULL OR NULLIF(BTRIM(other_c.sub_order_id_snapshot), '') IS NULL)
               AND NULLIF(BTRIM($4::text), '') IS NOT NULL
               AND UPPER(BTRIM(other_er.order_number)) = UPPER(BTRIM($4::text))
             )
           )
         LIMIT 1`,
        [
          Number(job.marketplace_id || 0),
          Number(job.claim_id),
          String(job.sub_order_id_snapshot || ""),
          String(job.order_number || ""),
        ],
      )
      const duplicateTicket = dupCheck.rows[0]?.ticket_id ? String(dupCheck.rows[0].ticket_id) : ""
      if (duplicateTicket) {
        const dupReason = `Duplicate prevented: already filed with Ticket ID ${duplicateTicket}`
        await client.query(
          `UPDATE claim_automation_jobs
           SET stage = 'manual_intervention_required',
               manual_action_reason = $2,
               failure_reason = $2,
               next_retry_at = NULL,
               lease_expires_at = NULL,
               updated_at = now()
           WHERE id = $1`,
          [job.id, dupReason],
        )
        await client.query(
          `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
           SELECT id, status, 'manual_action_required', $2, NULL FROM claims WHERE id = $1 AND status <> 'manual_action_required'`,
          [job.claim_id, dupReason],
        )
        await client.query(
          `UPDATE claims SET status = 'manual_action_required', remarks = COALESCE(remarks, '') || '\n' || $2, updated_at = now() WHERE id = $1`,
          [job.claim_id, dupReason],
        )
        await client.query("COMMIT")
        return await pollNextAutomationJob(db, agentUuid, scope, skipMarketplaces)
      }
    }

    const nextStage = job.stage === "approved" ? "submitting" : "downloading_media"

    await client.query(
      `UPDATE claim_automation_jobs
       SET agent_id = $2,
           stage = $3,
           attempts = attempts + 1,
           lease_expires_at = now() + INTERVAL '15 minutes',
           next_retry_at = NULL,
           last_error = '',
           started_at = COALESCE(started_at, now()),
           updated_at = now(),
           logs = logs || $4::jsonb
       WHERE id = $1`,
      [
        job.id,
        agentId,
        nextStage,
        JSON.stringify([
          {
            timestamp: new Date().toISOString(),
            level: "info",
            message: `Claim picked up by agent (UUID: ${agentUuid}, new stage: ${nextStage}).`,
          },
        ]),
      ],
    )

    await client.query("COMMIT")

    return {
      jobId: Number(job.id),
      claimId: Number(job.claim_id),
      stage: nextStage,
      checkpoint: String(job.checkpoint || ""),
      marketplace: String(job.marketplace),
      orderNumber: String(job.order_number),
      trackingId: String(job.tracking_id),
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function getJobExecutionBundle(
  db: pg.Pool,
  jobId: number,
): Promise<{
  jobId: number
  claimId: number
  stage: string
  checkpoint: string
  /** Live claim lifecycle status, so the engine can revalidate before it clicks Submit. */
  claimStatus: string
  marketplace: string
  accountName: string
  portalUrl: string
  credentials: { username: string; password: string; authState: Record<string, unknown> }
  automationMode: string
  requireApprovalBeforeSubmit: boolean
  claim: {
    orderNumber: string
    subOrderId: string
    trackingId: string
    packetId: string
    sku: string
    customerName: string
    totalPrice: number
    packetState: string
    marketplaceIssueCode: string
    claimReason: string
    claimTitle: string
    claimDescription: string
    claimContent: string
    remarks: string
    returnType: string
  }
  evidenceFiles: Array<{
    id: number
    fieldKey: string
    fieldType: string
    originalFilename: string
    mimeType: string
    sizeBytes: number
    contentHash: string
    storageObjectPath: string
  }>
}> {
  const res = await db.query(
    `SELECT j.id AS job_id, j.claim_id, j.stage, j.checkpoint, c.status AS claim_status, j.browser_mode,
            m.name AS marketplace,
            mc.account_name, mc.portal_url, mc.username_encrypted, mc.password_encrypted,
            mc.auth_state, mc.automation_mode, mc.require_approval_before_submit,
            c.claim_reason, c.claim_title, c.claim_description, c.claim_content, c.remarks,
            c.sub_order_id_snapshot, c.awb_snapshot, c.packet_id_snapshot, c.customer_name_snapshot,
            c.total_price_snapshot, c.sku_snapshot, c.packet_state_snapshot, c.marketplace_issue_code,
            COALESCE(
              NULLIF(c.return_type_snapshot, ''),
              NULLIF((SELECT string_agg(DISTINCT btrim(rsi.return_type), ', ') FROM receipt_scan_items rsi WHERE rsi.receipt_scan_id = c.receipt_scan_id AND btrim(rsi.return_type) <> ''), ''),
              er.return_type,
              ''
            ) AS return_type_snapshot,
            er.order_number, er.tracking_id
     FROM claim_automation_jobs j
     JOIN claims c ON c.id = j.claim_id
     JOIN marketplaces m ON m.id = c.marketplace_id
     JOIN receipt_scans rs ON rs.id = c.receipt_scan_id
     JOIN expected_returns er ON er.id = rs.expected_return_id
     LEFT JOIN LATERAL (
       SELECT * FROM marketplace_credentials mc
       WHERE (mc.id = j.marketplace_credential_id OR (j.marketplace_credential_id IS NULL AND mc.marketplace_id = c.marketplace_id AND mc.is_active = true))
       ORDER BY (mc.id = j.marketplace_credential_id) DESC, mc.id ASC
       LIMIT 1
     ) mc ON true
     WHERE j.id = $1`,
    [jobId],
  )

  const row = res.rows[0]
  if (!row) throw new ServiceError(404, "Automation job not found.")

  const mediaRes = await db.query(
    `SELECT id, field_key, mime_type, original_filename, size_bytes, content_hash, storage_object_path
     FROM claim_media
     WHERE claim_id = $1 AND is_active = true
     ORDER BY id ASC`,
    [row.claim_id],
  )

  const rawUser = decryptSecret(String(row.username_encrypted || ""))
  const rawPass = decryptSecret(String(row.password_encrypted || ""))

  return {
    jobId: Number(row.job_id),
    claimId: Number(row.claim_id),
    stage: String(row.stage),
    checkpoint: String(row.checkpoint || ""),
    claimStatus: String(row.claim_status || ""),
    marketplace: String(row.marketplace),
    accountName: String(row.account_name || row.marketplace),
    portalUrl: String(row.portal_url || ""),
    credentials: {
      username: rawUser,
      password: rawPass,
      authState: (row.auth_state || {}) as Record<string, unknown>,
    },
    automationMode: String(row.browser_mode || row.automation_mode || "visible"),
    requireApprovalBeforeSubmit: Boolean(row.require_approval_before_submit),
    claim: {
      orderNumber: String(row.order_number),
      subOrderId: String(row.sub_order_id_snapshot || row.order_number),
      trackingId: String(row.awb_snapshot || row.tracking_id),
      packetId: String(row.packet_id_snapshot || ""),
      packetState: String(row.packet_state_snapshot || ""),
      marketplaceIssueCode: String(row.marketplace_issue_code || ""),
      sku: String(row.sku_snapshot || ""),
      customerName: String(row.customer_name_snapshot || ""),
      totalPrice: Number(row.total_price_snapshot || 0),
      claimReason: String(row.claim_reason),
      claimTitle: String(row.claim_title || ""),
      claimDescription: String(row.claim_description || ""),
      claimContent: String(row.claim_content || ""),
      remarks: String(row.remarks || ""),
      returnType: String(row.return_type_snapshot || ""),
    },
    evidenceFiles: mediaRes.rows.map((m) => ({
      id: Number(m.id),
      fieldKey: String(m.field_key),
      fieldType: m.mime_type.startsWith("video/") ? "video" : m.mime_type.startsWith("image/") ? "image" : "document",
      originalFilename: String(m.original_filename || "evidence"),
      mimeType: String(m.mime_type || "application/octet-stream"),
      sizeBytes: Number(m.size_bytes || 0),
      contentHash: String(m.content_hash || ""),
      storageObjectPath: String(m.storage_object_path),
    })),
  }
}

export async function updateJobProgress(
  db: pg.Pool,
  jobId: number,
  data: {
    stage: string
    checkpoint?: string
    logMessage?: string
    screenshotPath?: string
    manualActionReason?: string
    nextRetrySeconds?: number
  },
  /**
   * M9: the desktop worker's agent id. When provided, the update is accepted
   * only from the worker that currently holds a live lease on the job, so a
   * stale worker cannot resurrect or redirect a job it no longer owns.
   */
  agentId?: number | null,
): Promise<number> {
  const allowedStages = new Set([
    "downloading_media",
    "opening_portal",
    "filling_form",
    "prepared",
    "submitting",
    "manual_intervention_required",
    "not_eligible",
    "failed",
  ])
  if (!allowedStages.has(data.stage)) throw new ServiceError(400, "Choose a valid automation job stage.")
  // M9: the submitting state is entered only through the queue lease (an
  // approved job leased for submission). No worker may self-authorize by
  // reporting its way into submitting.
  if (data.stage === "submitting") {
    throw new ServiceError(409, "The submitting state is granted only by the queue lease; report progress for the leased stage instead.")
  }
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const currentJob = await client.query(
      `SELECT j.attempts, j.max_attempts, j.stage, j.agent_id, j.lease_expires_at, c.marketplace_id
       FROM claim_automation_jobs j
       JOIN claims c ON c.id = j.claim_id
       WHERE j.id = $1
       FOR UPDATE OF j`,
      [jobId],
    )
    if (!currentJob.rows[0]) throw new ServiceError(404, "Automation job not found.")
    if (agentId != null) {
      if (Number(currentJob.rows[0].agent_id) !== Number(agentId)) {
        throw new ServiceError(404, "Automation job not found.")
      }
      const leaseExpiresAt = currentJob.rows[0].lease_expires_at
      if (!leaseExpiresAt || new Date(String(leaseExpiresAt)).getTime() <= Date.now()) {
        throw new ServiceError(409, "Submission lease expired; the job must be re-leased before progress is reported.")
      }
    }
    if (String(currentJob.rows[0].stage) === "completed") {
      throw new ServiceError(409, "Completed automation jobs cannot be changed.")
    }
    const attempts = Number(currentJob.rows[0].attempts || 0)
    const maxAttempts = Number(currentJob.rows[0].max_attempts || 3)
    const rawReason = String(data.manualActionReason || data.logMessage || "Desktop automation attempt failed.").trim()
    const retryAfterFailure = data.stage === "failed" && !isTerminalAttempt(attempts, maxAttempts)
    const exhaustedToManual = data.stage === "failed" && isTerminalAttempt(attempts, maxAttempts)
    const storedStage = retryAfterFailure
      ? "queued"
      : exhaustedToManual
        ? "manual_intervention_required"
        : data.stage
    const finalManualReason = exhaustedToManual
      ? (rawReason.startsWith("Failed after ") ? rawReason : `Failed after ${attempts} attempts: ${rawReason}`)
      : data.manualActionReason

    const newLog = data.logMessage
      ? JSON.stringify([{ timestamp: new Date().toISOString(), level: "info", message: data.logMessage }])
      : "[]"

    const setClauses: string[] = [
      "stage = $2",
      "updated_at = now()",
      "logs = logs || $3::jsonb",
      "lease_expires_at = CASE WHEN $2 IN ('downloading_media', 'opening_portal', 'filling_form', 'submitting') THEN now() + INTERVAL '15 minutes' ELSE NULL END",
    ]
    const params: unknown[] = [jobId, storedStage, newLog]

    if (data.checkpoint) {
      params.push(data.checkpoint)
      setClauses.push(`checkpoint = $${params.length}`)
    }
    if (retryAfterFailure) {
      const backoffSec =
        data.nextRetrySeconds && data.nextRetrySeconds > 0
          ? Math.min(300, Math.round(data.nextRetrySeconds))
          : computeRetryBackoffSeconds(attempts)
      params.push(backoffSec)
      setClauses.push(`next_retry_at = now() + ($${params.length}::int * INTERVAL '1 second')`)
      params.push(rawReason)
      setClauses.push(`last_error = $${params.length}`)
      setClauses.push(`failure_reason = $${params.length}`)
      setClauses.push("agent_id = NULL")
    } else if (exhaustedToManual) {
      params.push(finalManualReason || rawReason)
      setClauses.push(`last_error = $${params.length}`)
      setClauses.push(`failure_reason = $${params.length}`)
      setClauses.push("next_retry_at = NULL")
      setClauses.push("agent_id = NULL")
    } else if (storedStage === "queued" || storedStage === "approved" || storedStage === "manual_intervention_required" || storedStage === "not_eligible") {
      setClauses.push("next_retry_at = NULL")
    }

    if (data.screenshotPath) {
      params.push(data.screenshotPath)
      setClauses.push(`submission_screenshot_path = $${params.length}`)
    }
    if (finalManualReason) {
      params.push(finalManualReason)
      setClauses.push(`manual_action_reason = $${params.length}`)
    }
    // A refused order was never filed; any earlier reference or completion time is stale. The job log keeps it.
    if (storedStage === "not_eligible") {
      setClauses.push("marketplace_claim_id = ''", "completed_at = NULL")
    }

    await client.query(
      `UPDATE claim_automation_jobs SET ${setClauses.join(", ")} WHERE id = $1`,
      params,
    )

    // Sync claim status with job stage
    const targetClaimStatus =
      storedStage === "prepared"
        ? "waiting_for_approval"
        : storedStage === "manual_intervention_required" || storedStage === "not_eligible"
          ? "manual_action_required"
          : storedStage === "failed"
            ? "failed"
            : ""
    if (targetClaimStatus) {
      await client.query(
        `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
         SELECT c.id, c.status, $2, $3, NULL
         FROM claims c
         JOIN claim_automation_jobs j ON j.claim_id = c.id
         WHERE j.id = $1 AND c.status <> $2`,
        [jobId, targetClaimStatus, finalManualReason || data.logMessage || `Desktop automation entered ${storedStage}.`],
      )
    }
    if (storedStage === "prepared") {
      await client.query(
        `UPDATE claims SET status = 'waiting_for_approval', updated_at = now() WHERE id = (SELECT claim_id FROM claim_automation_jobs WHERE id = $1)`,
        [jobId],
      )
    } else if (storedStage === "manual_intervention_required") {
      await client.query(
        `UPDATE claims SET status = 'manual_action_required', remarks = COALESCE(remarks, '') || '\nManual action required: ' || $2, updated_at = now() WHERE id = (SELECT claim_id FROM claim_automation_jobs WHERE id = $1)`,
        [jobId, finalManualReason || "Marketplace portal requires manual intervention"],
      )
    } else if (storedStage === "not_eligible") {
      // The marketplace refused the order (for example Meesho's packaging policy). It is not claimed; the claim stays
      // for manual review, and the job is not picked up again unless someone retries it.
      await client.query(
        `UPDATE claims SET status = 'manual_action_required', remarks = COALESCE(remarks, '') || '\nNot eligible on marketplace: ' || $2, updated_at = now() WHERE id = (SELECT claim_id FROM claim_automation_jobs WHERE id = $1)`,
        [jobId, finalManualReason || "The marketplace says this order is not eligible for a claim"],
      )
    } else if (storedStage === "failed") {
      await client.query(
        `UPDATE claims SET status = 'failed', remarks = COALESCE(remarks, '') || '\nDesktop automation failed: ' || $2, updated_at = now()
         WHERE id = (SELECT claim_id FROM claim_automation_jobs WHERE id = $1)`,
        [jobId, finalManualReason || data.logMessage || "Desktop automation failed"],
      )
    }
    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES (NULL, 'claim.automation_progress', 'claim_automation_job', $1, $2::jsonb)`,
      [String(jobId), JSON.stringify({ stage: storedStage, requestedStage: data.stage, checkpoint: data.checkpoint || "", reason: finalManualReason || "" })],
    )

    await client.query("COMMIT")
    return Number(currentJob.rows[0].marketplace_id)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export function mapToReceiptIssueCategory(codeOrReason?: string): { code: string; label: string } {
  const norm = (codeOrReason || "").toLowerCase()
  if (norm.includes("missing")) {
    return { code: "missing_component", label: "Missing product or component" }
  }
  if (norm.includes("damage")) {
    return { code: "damaged_product", label: "Damaged product" }
  }
  if (norm.includes("sku")) {
    return { code: "sku_change", label: "SKU Change" }
  }
  if (norm.includes("size")) {
    return { code: "size_change", label: "Size Change" }
  }
  if (norm.includes("iron")) {
    return { code: "iron_send", label: "Iron Send" }
  }
  if (norm.includes("other")) {
    return { code: "other_issue", label: "Other issue" }
  }
  return { code: "wrong_product", label: "Wrong product" }
}

export async function syncClaimTicketToRegister(
  dbOrClient: pg.Pool | pg.PoolClient,
  params: {
    receiptScanId: number
    ticketCode: string
    status?: "Draft" | "Raised" | "Review" | "Approved" | "Rejected"
    actorId?: number | null
    issueCategoryCode?: string
    issueCategoryLabel?: string
    notes?: string
  },
): Promise<number | null> {
  const scanId = Number(params.receiptScanId)
  if (!Number.isInteger(scanId) || scanId <= 0) return null

  const rawCode = (params.ticketCode || "").trim()
  const ticketCode = rawCode || `CLM-${scanId}`
  const status = params.status || "Raised"
  const actorId = params.actorId || null

  const existingTicket = await dbOrClient.query(
    `SELECT id, ticket_code, status FROM claim_tickets WHERE receipt_scan_id = $1 ORDER BY id DESC LIMIT 1`,
    [scanId],
  )

  let ticketId: number
  if (existingTicket.rows[0]) {
    ticketId = Number(existingTicket.rows[0].id)
    const oldCode = String(existingTicket.rows[0].ticket_code)
    const oldStatus = String(existingTicket.rows[0].status)

    if (ticketCode !== oldCode || status !== oldStatus) {
      let safeCode = ticketCode
      let attempts = 0
      while (true) {
        const conflict = await dbOrClient.query(
          `SELECT id FROM claim_tickets WHERE ticket_code = $1 AND id <> $2`,
          [safeCode, ticketId],
        )
        if (!conflict.rows[0]) break
        attempts++
        safeCode = `${ticketCode}-${scanId}-${attempts}`
      }

      await dbOrClient.query(
        `UPDATE claim_tickets
         SET ticket_code = $2, status = $3, updated_at = now()
         WHERE id = $1`,
        [ticketId, safeCode, status],
      )
      // History keeps both codes: the replaced ticket stays auditable instead of silently dropping out.
      const replaceReason =
        ticketCode !== oldCode
          ? `Ticket replaced ${oldCode} with ${safeCode}`
          : `Ticket status ${oldStatus} to ${status}`
      await dbOrClient.query(
        `INSERT INTO claim_ticket_history (claim_ticket_id, from_status, to_status, reason, changed_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [ticketId, oldStatus, status, replaceReason, actorId],
      )
    }
  } else {
    let safeCode = ticketCode
    let attempts = 0
    while (true) {
      const conflict = await dbOrClient.query(
        `SELECT id FROM claim_tickets WHERE ticket_code = $1`,
        [safeCode],
      )
      if (!conflict.rows[0]) break
      attempts++
      safeCode = `${ticketCode}-${scanId}-${attempts}`
    }

    const inserted = await dbOrClient.query(
      `INSERT INTO claim_tickets (receipt_scan_id, ticket_code, status, rejection_reason, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, '', $4, now(), now())
       RETURNING id`,
      [scanId, safeCode, status, actorId],
    )
    ticketId = Number(inserted.rows[0].id)
    await dbOrClient.query(
      `INSERT INTO claim_ticket_history (claim_ticket_id, from_status, to_status, reason, changed_by)
       VALUES ($1, NULL, $2, 'Initial claim ticket created', $3)`,
      [ticketId, status, actorId],
    )
  }

  // Ensure scan outcome is 'issue' and status is 'Draft' or 'Raised'
  await dbOrClient.query(
    `UPDATE receipt_scans
     SET outcome = 'issue',
         status = CASE WHEN status = 'Clear' THEN 'Draft' ELSE status END
     WHERE id = $1`,
    [scanId],
  )

  // The issue links to the scan's first line. Lines come only from the bench scan with the operator's counts: a scan
  // without one keeps just its ticket, and no line is ever invented with a received or verified quantity.
  const itemRes = await dbOrClient.query(
    `SELECT id FROM receipt_scan_items WHERE receipt_scan_id = $1 ORDER BY id ASC LIMIT 1`,
    [scanId],
  )
  if (!itemRes.rows[0]) return ticketId
  const itemId = Number(itemRes.rows[0].id)

  // Ensure receipt_scan_issues exists and links to ticketId
  const issueRes = await dbOrClient.query(
    `SELECT id, claim_ticket_id FROM receipt_scan_issues WHERE receipt_scan_item_id = $1 ORDER BY id ASC LIMIT 1`,
    [itemId],
  )

  // Verify whether ticketId is already linked to another receipt_scan_issues row (partial unique index)
  const ticketAlreadyLinked = await dbOrClient.query(
    `SELECT id FROM receipt_scan_issues WHERE claim_ticket_id = $1`,
    [ticketId],
  )
  const existingLinkedIssueId = ticketAlreadyLinked.rows[0]?.id ? Number(ticketAlreadyLinked.rows[0].id) : null

  if (issueRes.rows[0]) {
    const currentIssueId = Number(issueRes.rows[0].id)
    if (Number(issueRes.rows[0].claim_ticket_id) !== ticketId) {
      if (existingLinkedIssueId === null || existingLinkedIssueId === currentIssueId) {
        await dbOrClient.query(
          `UPDATE receipt_scan_issues SET claim_ticket_id = $1 WHERE id = $2`,
          [ticketId, currentIssueId],
        )
      }
    }
  } else {
    const targetTicketId = existingLinkedIssueId === null ? ticketId : null
    const cat = mapToReceiptIssueCategory(params.issueCategoryCode || params.issueCategoryLabel)
    await dbOrClient.query(
      `INSERT INTO receipt_scan_issues (receipt_scan_item_id, category_code, category_label, sub_issue_label, qty, claim_ticket_id, notes, created_by)
       VALUES ($1, $2, $3, 'Claim Filed', 1, $4, $5, $6)`,
      [itemId, cat.code, cat.label, targetTicketId, params.notes || "Linked to claim ticket", actorId],
    )
  }

  return ticketId
}

export async function completeJobSubmission(
  db: pg.Pool,
  jobId: number,
  data: {
    marketplaceClaimId: string
    screenshotPath?: string
    notes?: string
  },
  scope?: AccountScope,
  /**
   * M9: agent submissions pass the worker's agent id so the endpoint verifies
   * lease ownership, lease liveness and submission authorization atomically.
   * Operator-approved manual resolution passes `operatorOverride: true` instead,
   * keeping that path separate from normal automated submission.
   */
  opts?: { agentId?: number | null; operatorOverride?: boolean },
): Promise<number> {
  const ticket = String(data.marketplaceClaimId || "").trim()
  if (!ticket) throw new ServiceError(400, "Marketplace Claim Reference ID is required.")
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const params: unknown[] = [jobId]
    const scopeCondition = scope ? accountCondition(scope, "c.marketplace_id", params) : "TRUE"
    const res = await client.query(
      `SELECT j.claim_id, j.stage, j.marketplace_claim_id, j.agent_id, j.lease_expires_at,
              COALESCE(mc.require_approval_before_submit, TRUE) AS approval_required,
              c.marketplace_id, c.status AS claim_status
       FROM claim_automation_jobs j
       JOIN claims c ON c.id = j.claim_id
       LEFT JOIN marketplace_credentials mc ON mc.id = j.marketplace_credential_id
       WHERE j.id = $1 AND ${scopeCondition}
       FOR UPDATE OF j`,
      params,
    )
    if (!res.rows[0]) throw new ServiceError(404, "Job not found.")
    const claimId = Number(res.rows[0].claim_id)
    const marketplaceId = Number(res.rows[0].marketplace_id)
    const jobStage = String(res.rows[0].stage || "")
    const priorTicket = String(res.rows[0].marketplace_claim_id || "")
    const claimStatus = String(res.rows[0].claim_status || "")
    // Idempotent replay: the same ticket recorded twice (network retry) changes nothing.
    if (jobStage === "completed") {
      if (priorTicket === ticket) {
        await client.query("ROLLBACK")
        return marketplaceId
      }
      throw new ServiceError(409, `Job already completed with ticket ${priorTicket}. A different ticket cannot overwrite it; verify on the portal and use manual-resolve.`)
    }
    if (jobStage === "not_eligible") throw new ServiceError(409, "Job was ruled not eligible. A marketplace ticket cannot be recorded for it.")
    if (["submitted", "under_review", "approved", "rejected", "reconciled", "paid"].includes(claimStatus)) {
      throw new ServiceError(409, `Claim already has recorded outcome ${claimStatus}. Record corrections through manual-resolve.`)
    }

    const otherCompleted = await client.query(
      `SELECT id FROM claim_automation_jobs WHERE claim_id = $1 AND id <> $2 AND stage = 'completed' AND marketplace_claim_id <> $3 LIMIT 1`,
      [claimId, jobId, ticket],
    )
    if (otherCompleted.rows[0]) throw new ServiceError(409, "Claim already completed with a different ticket. A second ticket cannot overwrite it.")
    const sameCompleted = await client.query(
      `SELECT id FROM claim_automation_jobs WHERE claim_id = $1 AND id <> $2 AND stage = 'completed' AND marketplace_claim_id = $3 LIMIT 1`,
      [claimId, jobId, ticket],
    )
    if (sameCompleted.rows[0]) {
      await client.query("ROLLBACK")
      return marketplaceId
    }
    // M9 submission authorization: only the worker that holds a live lease may
    // record a ticket, and on approval-required accounts that lease must be the
    // backend-issued submitting state. Operator-approved manual resolution
    // carries its own Supervisor/Admin gate at the route and skips these checks.
    if (!opts?.operatorOverride) {
      if (opts?.agentId != null && Number(res.rows[0].agent_id) !== Number(opts.agentId)) {
        throw new ServiceError(404, "Job not found.")
      }
      const leaseExpiresAt = res.rows[0].lease_expires_at
      if (!leaseExpiresAt || new Date(String(leaseExpiresAt)).getTime() <= Date.now()) {
        throw new ServiceError(409, "Submission lease expired; the job must be re-leased before a ticket is recorded.")
      }
      if (res.rows[0].approval_required && jobStage !== "submitting") {
        throw new ServiceError(409, "This account requires approval: only a submitting job may record a marketplace ticket.")
      }
    }
    // The ticket is recorded exactly once per job from here on.
    const completedLog = JSON.stringify([
      {
        timestamp: new Date().toISOString(),
        level: "info",
        message: `Claim successfully submitted on marketplace. Ref ID: ${ticket}`,
      },
    ])

    await client.query(
      `UPDATE claim_automation_jobs
       SET stage = 'completed',
           checkpoint = 'completed',
           marketplace_claim_id = $2,
           submission_screenshot_path = COALESCE($3, submission_screenshot_path),
           completed_at = now(),
           lease_expires_at = NULL,
           next_retry_at = NULL,
           failure_reason = '',
           updated_at = now(),
           logs = logs || $4::jsonb
       WHERE id = $1`,
      [jobId, ticket, data.screenshotPath || null, completedLog],
    )

    // Start tracking the ticket. The desktop re-opens the supplier portal on a cadence and reads the ticket
    // status until it reaches a final state (server/claim-follow-up-service.ts). One row per claim: re-filing
    // resets the timer instead of adding a second follow-up.
    await createFollowUpForJob(client, jobId, ticket)

    await client.query(
      `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
       SELECT id, status, 'submitted', $2, NULL FROM claims WHERE id = $1 AND status <> 'submitted'`,
      [claimId, `Submitted by desktop automation. Marketplace Claim Ref: ${ticket}`],
    )
    await client.query(
      `UPDATE claims
       SET status = 'submitted',
           remarks = COALESCE(remarks, '') || '\nMarketplace Claim ID: ' || $2,
           updated_at = now()
       WHERE id = $1`,
      [claimId, ticket],
    )
    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES (NULL, 'claim.automation_completed', 'claim', $1, $2::jsonb)`,
      [String(claimId), JSON.stringify({ jobId, marketplaceClaimId: ticket })],
    )

    // Sync ticket ID and Raised status into return register
    const claimRow = await client.query(
      `SELECT receipt_scan_id, claim_reason, marketplace_issue_code, marketplace_issue_label
       FROM claims WHERE id = $1`,
      [claimId],
    )
    if (claimRow.rows[0]?.receipt_scan_id) {
      await syncClaimTicketToRegister(client, {
        receiptScanId: Number(claimRow.rows[0].receipt_scan_id),
        ticketCode: ticket,
        status: "Raised",
        actorId: null,
        issueCategoryCode: claimRow.rows[0].marketplace_issue_code || undefined,
        issueCategoryLabel: claimRow.rows[0].marketplace_issue_label || claimRow.rows[0].claim_reason || "Marketplace Claim",
        notes: `Claim ticket filed on marketplace: ${ticket}`,
      })
    }

    await client.query("COMMIT")
    return marketplaceId
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function approveJobForSubmission(
  db: pg.Pool,
  actor: Actor,
  scope: AccountScope,
  jobId: number,
): Promise<number> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const scopeParams: unknown[] = [jobId]
    const scopeCondition = accountCondition(scope, "c.marketplace_id", scopeParams)
    const res = await client.query(
      `SELECT j.id, j.claim_id, j.stage, c.status AS claim_status, c.marketplace_id
       FROM claim_automation_jobs j
       JOIN claims c ON c.id = j.claim_id
       WHERE j.id = $1 AND ${scopeCondition}
       FOR UPDATE OF j`,
      scopeParams,
    )
    if (!res.rows[0]) throw new ServiceError(404, "Automation job not found.")
    const jobStage = String(res.rows[0].stage || "")
    const claimStatus = String(res.rows[0].claim_status || "")
    // Approval arms a submission: never approve finished, mid-flight, ruled-out or already-recorded work.
    // A worker actively preparing or submitting this job keeps its lease; approving
    // underneath it would arm a second filing path, so the operator waits or cancels first.
    if (["completed", "submitting", "failed", "not_eligible", "downloading_media", "opening_portal", "filling_form"].includes(jobStage)) {
      throw new ServiceError(409, `Job in stage ${jobStage} cannot be approved for submission.`)
    }
    if (!["waiting_for_approval", "ready_for_claim", "processing", "manual_action_required", "failed"].includes(claimStatus)) {
      throw new ServiceError(409, `Claim in status ${claimStatus} cannot be approved for submission.`)
    }

    const log = JSON.stringify([
      {
        timestamp: new Date().toISOString(),
        level: "info",
        message: `Submission approved by ${actor.name || "authorized user"}.`,
      },
    ])

    await client.query(
      `UPDATE claim_automation_jobs
       SET stage = 'approved',
           updated_at = now(),
           logs = logs || $2::jsonb
       WHERE id = $1`,
      [jobId, log],
    )

    await client.query(
      `UPDATE claims
       SET status = 'processing',
           updated_at = now()
       WHERE id = $1`,
      [res.rows[0].claim_id],
    )

    await client.query(
      `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
       VALUES ($1, 'waiting_for_approval', 'processing', $2, $3)`,
      [res.rows[0].claim_id, `Submission approved by ${actor.name || "user"} for automated submission (Job #${jobId}).`, actor.id],
    )
    await client.query("COMMIT")
    return Number(res.rows[0].marketplace_id)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function retryAutomationJob(
  db: pg.Pool,
  actor: Actor,
  scope: AccountScope,
  jobId: number,
): Promise<number> {
  const log = JSON.stringify([
    {
      timestamp: new Date().toISOString(),
      level: "info",
      message: `Job reset to queued for retry by ${actor.name || "user"}.`,
    },
  ])

  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const guardParams: unknown[] = [jobId]
    const guardScope = accountCondition(scope, "c.marketplace_id", guardParams)
    const current = await client.query(
      `SELECT j.id, j.claim_id, j.stage, c.status AS claim_status, c.marketplace_id
       FROM claim_automation_jobs j
       JOIN claims c ON c.id = j.claim_id
       WHERE j.id = $1 AND ${guardScope}
       FOR UPDATE OF j`,
      guardParams,
    )
    if (!current.rows[0]) {
      await client.query("ROLLBACK")
      throw new ServiceError(404, "Automation job not found.")
    }
    const jobStage = String(current.rows[0].stage || "")
    const claimId = Number(current.rows[0].claim_id)
    const claimStatus = String(current.rows[0].claim_status || "")
    // A finished or mid-flight submission must never be re-armed by retry.
    if (jobStage === "completed" || jobStage === "submitting") {
      throw new ServiceError(409, `Job in stage ${jobStage} cannot be retried; file a new claim or use manual-resolve.`)
    }
    // A recorded claim outcome must never be re-filed by retry.
    if (["submitted", "under_review", "approved", "reconciled", "paid"].includes(claimStatus)) {
      throw new ServiceError(409, `Claim already has recorded outcome ${claimStatus}; retry would re-file it.`)
    }
    // Re-arm operator-held claims so the re-queued job can actually lease.
    if (["manual_action_required", "failed", "rejected"].includes(claimStatus)) {
      await client.query(
        `UPDATE claims SET status = 'ready_for_claim', updated_at = now() WHERE id = $1`,
        [claimId],
      )
      await client.query(
        `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
         VALUES ($1, $2, 'ready_for_claim', 'Job retried by operator', $3)`,
        [claimId, claimStatus, actor.id],
      )
    }

    const params: unknown[] = [jobId, log]
    const scopeCondition = accountCondition(scope, "c.marketplace_id", params)
    const result = await client.query(
      `UPDATE claim_automation_jobs j
       SET stage = 'queued',
           checkpoint = '',
           attempts = 0,
           agent_id = NULL,
           manual_action_reason = '',
           failure_reason = '',
           next_retry_at = NULL,
           lease_expires_at = NULL,
           last_error = '',
           updated_at = now(),
           logs = logs || $2::jsonb
       FROM claims c
       WHERE j.id = $1 AND c.id = j.claim_id AND ${scopeCondition}
       RETURNING j.id, c.marketplace_id`,
      params,
    )
    if (!result.rows[0]) {
      await client.query("ROLLBACK")
      throw new ServiceError(404, "Automation job not found.")
    }
    await client.query("COMMIT")
    return Number(result.rows[0].marketplace_id)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

/**
 * Mark a claim (including Manual Required claims with or without a job row) as manually filed
 * with an operator-supplied Marketplace Ticket ID, moving it to submitted and starting ticket follow-up.
 */
export async function resolveManualClaim(
  db: pg.Pool,
  actor: Actor,
  scope: AccountScope,
  claimId: number,
  data: { marketplaceClaimId: string; notes?: string; screenshotPath?: string },
): Promise<{ claimId: number; marketplaceId: number; marketplaceClaimId: string }> {
  const ticket = String(data.marketplaceClaimId || "").trim()
  if (!ticket) throw new ServiceError(400, "Marketplace Ticket ID is required.")
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const claimParams: unknown[] = [claimId]
    const claimScope = accountCondition(scope, "c.marketplace_id", claimParams)
    const claimRes = await client.query(
      `SELECT c.id, c.marketplace_id, c.status, c.receipt_scan_id, c.claim_reason,
              c.marketplace_issue_code, c.marketplace_issue_label
       FROM claims c
       WHERE c.id = $1 AND ${claimScope}
       FOR UPDATE OF c`,
      claimParams,
    )
    if (!claimRes.rows[0]) throw new ServiceError(404, "Claim not found.")
    const claim = claimRes.rows[0]
    const marketplaceId = Number(claim.marketplace_id)
    const claimStatus = String(claim.status || "")
    if (["approved", "reconciled", "paid"].includes(claimStatus)) {
      throw new ServiceError(409, `Claim already has settled outcome ${claimStatus}.`)
    }

    const jobRes = await client.query(
      `SELECT id, stage, marketplace_claim_id
       FROM claim_automation_jobs
       WHERE claim_id = $1
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [claimId],
    )
    let jobId: number
    const resolvedLog = JSON.stringify([
      {
        timestamp: new Date().toISOString(),
        level: "info",
        message: `Resolved manually by ${actor.name || "operator"}. Ticket ID: ${ticket}${data.notes ? ` (${data.notes})` : ""}`,
      },
    ])
    if (jobRes.rows[0]) {
      jobId = Number(jobRes.rows[0].id)
      const prevTicket = String(jobRes.rows[0].marketplace_claim_id || "")
      if (String(jobRes.rows[0].stage) === "completed" && prevTicket === ticket && claimStatus === "submitted") {
        await client.query("ROLLBACK")
        return { claimId, marketplaceId, marketplaceClaimId: ticket }
      }
      if (String(jobRes.rows[0].stage) === "completed" && prevTicket && prevTicket !== ticket) {
        throw new ServiceError(409, `Claim already completed with ticket ${prevTicket}.`)
      }
      await client.query(
        `UPDATE claim_automation_jobs
         SET stage = 'completed',
             checkpoint = 'manual_resolved',
             marketplace_claim_id = $2,
             submission_screenshot_path = CASE WHEN $3 <> '' THEN $3 ELSE submission_screenshot_path END,
             completed_at = COALESCE(completed_at, now()),
             lease_expires_at = NULL,
             next_retry_at = NULL,
             failure_reason = '',
             updated_at = now(),
             logs = logs || $4::jsonb
         WHERE id = $1`,
        [jobId, ticket, data.screenshotPath || "", resolvedLog],
      )
    } else {
      const inserted = await client.query(
        `INSERT INTO claim_automation_jobs
          (claim_id, stage, checkpoint, browser_mode, marketplace_claim_id, completed_at, logs)
         VALUES ($1, 'completed', 'manual_resolved', 'visible', $2, now(), $3::jsonb)
         RETURNING id`,
        [claimId, ticket, resolvedLog],
      )
      jobId = Number(inserted.rows[0].id)
    }

    await createFollowUpForJob(client, jobId, ticket)

    await client.query(
      `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
       SELECT id, status, 'submitted', $2, $3 FROM claims WHERE id = $1 AND status <> 'submitted'`,
      [claimId, `Manually filed by ${actor.name || "operator"}. Marketplace Ticket ID: ${ticket}`, actor.id],
    )
    await client.query(
      `UPDATE claims
       SET status = 'submitted',
           remarks = COALESCE(remarks, '') || '\nManual Ticket ID: ' || $2,
           updated_at = now()
       WHERE id = $1`,
      [claimId, ticket],
    )
    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'claim.manual_resolve', 'claim', $2, $3::jsonb)`,
      [actor.id, String(claimId), JSON.stringify({ jobId, marketplaceClaimId: ticket, notes: data.notes || "" })],
    )
    if (claim.receipt_scan_id) {
      await syncClaimTicketToRegister(client, {
        receiptScanId: Number(claim.receipt_scan_id),
        ticketCode: ticket,
        status: "Raised",
        actorId: actor.id,
        issueCategoryCode: claim.marketplace_issue_code ? String(claim.marketplace_issue_code) : undefined,
        issueCategoryLabel: String(claim.marketplace_issue_label || claim.claim_reason || "Marketplace Claim"),
        notes: data.notes || `Manually filed claim ticket: ${ticket}`,
      })
    }
    await client.query("COMMIT")
    return { claimId, marketplaceId, marketplaceClaimId: ticket }
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}
export async function listAutomationJobs(
  db: pg.Pool,
  scope: AccountScope,
  filter: { stage?: string; marketplaceId?: number; search?: string; page?: number; pageSize?: number } = {},
): Promise<{ rows: AutomationJobRow[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, filter.page || 1)
  const pageSize = Math.min(100, Math.max(1, filter.pageSize || 25))
  const offset = (page - 1) * pageSize

  const params: unknown[] = []
  const conditions = [accountCondition(scope, "c.marketplace_id", params)]

  if (filter.stage === "manual") {
    conditions.push(`j.stage IN ('manual_intervention_required', 'failed', 'not_eligible')`)
  } else if (filter.stage) {
    params.push(filter.stage)
    conditions.push(`j.stage = $${params.length}`)
  }
  if (filter.marketplaceId) {
    params.push(filter.marketplaceId)
    conditions.push(`c.marketplace_id = $${params.length}`)
  }
  if (filter.search) {
    params.push(`%${filter.search.trim()}%`)
    conditions.push(`(er.order_number ILIKE $${params.length} OR er.tracking_id ILIKE $${params.length} OR c.claim_title ILIKE $${params.length} OR j.marketplace_claim_id ILIKE $${params.length})`)
  }

  const whereClause = conditions.join(" AND ")

  const countRes = await db.query(
    `SELECT COUNT(*)::int AS total
     FROM claim_automation_jobs j
     JOIN claims c ON c.id = j.claim_id
     JOIN receipt_scans rs ON rs.id = c.receipt_scan_id
     JOIN expected_returns er ON er.id = rs.expected_return_id
     WHERE ${whereClause}`,
    params,
  )
  const total = Number(countRes.rows[0]?.total || 0)

  const rowsRes = await db.query(
    `SELECT j.id, j.claim_id, m.name AS marketplace,
            COALESCE(mc.account_name, m.name) AS account_name,
            er.order_number, er.tracking_id, c.claim_reason, c.claim_title,
            j.stage, j.checkpoint, j.browser_mode, j.attempts, j.max_attempts,
            j.next_retry_at, j.failure_reason,
            j.marketplace_claim_id, j.submission_screenshot_path,
            j.manual_action_reason, j.logs, a.agent_name,
            j.started_at, j.completed_at, j.created_at, j.updated_at
     FROM claim_automation_jobs j
     JOIN claims c ON c.id = j.claim_id
     JOIN marketplaces m ON m.id = c.marketplace_id
     JOIN receipt_scans rs ON rs.id = c.receipt_scan_id
     JOIN expected_returns er ON er.id = rs.expected_return_id
     LEFT JOIN marketplace_credentials mc ON mc.id = j.marketplace_credential_id
     LEFT JOIN claim_automation_agents a ON a.id = j.agent_id
     WHERE ${whereClause}
     ORDER BY j.id DESC
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )

  const rows: AutomationJobRow[] = rowsRes.rows.map((r) => ({
    id: Number(r.id),
    claimId: Number(r.claim_id),
    marketplace: String(r.marketplace),
    accountName: String(r.account_name),
    orderNumber: String(r.order_number),
    trackingId: String(r.tracking_id),
    claimReason: String(r.claim_reason),
    claimTitle: String(r.claim_title || ""),
    stage: String(r.stage),
    checkpoint: String(r.checkpoint || ""),
    browserMode: String(r.browser_mode),
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    nextRetryAt: r.next_retry_at instanceof Date ? r.next_retry_at.toISOString() : r.next_retry_at ? String(r.next_retry_at) : null,
    failureReason: String(r.failure_reason || r.manual_action_reason || ""),
    marketplaceClaimId: String(r.marketplace_claim_id || ""),
    submissionScreenshotPath: String(r.submission_screenshot_path || ""),
    manualActionReason: String(r.manual_action_reason || ""),
    logs: (Array.isArray(r.logs) ? r.logs : []) as AutomationJobRow["logs"],
    agentName: r.agent_name ? String(r.agent_name) : null,
    startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : null,
    completedAt: r.completed_at instanceof Date ? r.completed_at.toISOString() : null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  }))

  return { rows, total, page, pageSize }
}

// ---------------------------------------------------------------------------------------------------------------
// Unified Return Lookup for Claims (Scanned & Unscanned Returns, for Mobile + Desktop)
// ---------------------------------------------------------------------------------------------------------------

export type ClaimReturnLookupResult = {
  found: boolean
  // False when the return was found by a partial (contains) match. A caller confirms it; nothing binds to it alone.
  exactMatch: boolean
  scanId: number | null
  expectedReturnId: number
  marketplace: string
  marketplaceId: number
  subOrderId: string
  orderId: string
  trackingNumber: string
  awb: string
  packetState: string
  packetId: string
  detectedIssueCode: string | null
  customerName: string
  totalPrice: number
  totalAmount: number
  returnStatus: string
  shippedDate: string | null
  daysSinceShipped: number
  tatDays: number
  receivedDate: string | null
  dueDate: string | null
  daysRemaining: number | null
  overdue: boolean
  missingItems: Array<{
    label: string
    quantity: number
    amountEach: number
    amount: number
  }>
  missingAmount: number
  existingClaim: {
    id: number
    status: string
    reason: string
    title: string
    mediaCount: number
  } | null
  items: Array<{
    itemId: number
    sku: string
    masterSku: string
    title: string
    quantity: number
    imageUrl: string
    subOrderId: string
  }>
  templates: Array<{
    id: number
    name: string
    description: string
    fields: Array<{
      fieldKey: string
      fieldLabel: string
      fieldType: string
      required: boolean
      minCount: number
      maxCount: number
      maxFileSizeMb: number
    }>
  }>
  standardReasons: Array<{
    code: string
    label: string
    suggestedTitle: string
    suggestedContent: string
  }>
}

// A contains-pattern for ILIKE that matches the text literally. % and _ are LIKE wildcards; backslash is LIKE's
// default escape character, so each of the three is escaped with one.
export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`
}

// A claim always attaches to a saved bench scan in the caller's accounts (owner decision 2026-11-20): the claim flow
// never creates a receipt scan and never records received quantities. An app that sends the saved scan's id uses it
// (createClaim still checks its account). An older APK that sends none is matched by its first non-empty key (AWB,
// then sub order, then order ID) to the saved scan, by the bench's exact rules. Only that key is tried: an older APK
// can carry a previous return's sub order, which must never rescue an AWB that has no scan. A partial match never
// binds, and neither does an ambiguous one.
export async function resolveClaimScanId(
  db: pg.Pool,
  scope: AccountScope,
  input: { scanId: number | null; keys: string[] },
): Promise<number> {
  if (input.scanId) return input.scanId
  const key = input.keys.find(Boolean)
  const scanIds = key ? await savedScansFor(db, key, scope) : []
  if (scanIds.length === 1) return scanIds[0]
  if (scanIds.length > 1) {
    throw new ServiceError(409, `More than one saved scan matches ${key}. File the claim from the saved scan.`, {
      extra: { code: "scan_ambiguous" },
    })
  }
  throw new ServiceError(409, "This return has no saved bench scan. Save the bench scan first, then file the claim.", {
    extra: { code: "bench_scan_required" },
  })
}

export async function lookupReturnForClaim(
  db: pg.Pool,
  scope: AccountScope,
  query: string,
  marketplaceId?: number | null,
): Promise<ClaimReturnLookupResult | null> {
  const value = query.trim()
  if (value.length < 3) return null

  // $1 and $2 first: the account list of a restricted user is pushed after them, so it never takes their numbers.
  const params: unknown[] = [value, likeContains(value)]
  const scopeCondition = accountCondition(scope, "er.marketplace_id", params)

  let mktCondition = ""
  if (marketplaceId) {
    params.push(marketplaceId)
    mktCondition = `AND er.marketplace_id = $${params.length}`
  }

  // Candidates are active lookup rows, plus rows the register already holds a saved scan for: every upload supersedes
  // the account's active rows, scanned or not, and the scan stays the permanent record. Staging rows and superseded
  // rows with no scan are never returned. Exact matches rank before partial (ILIKE) ones, then scanned before not.
  const scanQuery = `
    SELECT rs.id AS scan_id, er.id AS expected_return_id, er.marketplace_id, m.name AS marketplace,
           er.order_number, er.tracking_id, er.alt_tracking_id, rs.flyer_id, rs.scanned_at,
           COALESCE(er.shopify_order_name, er.customer_city, 'Customer') AS customer_name,
           COALESCE((SELECT SUM(eri.sales_amount) FROM expected_return_items eri WHERE eri.expected_return_id = er.id), 0)::numeric AS total_price,
           COALESCE(er.lookup_status, er.return_type, 'Return Initiated') AS return_status,
           COALESCE(er.return_type, '') AS expected_return_type,
           COALESCE(rs.scanned_at, er.created_at) AS shipped_date,
           (
             SELECT rsi_issue.category_code
             FROM receipt_scan_items rsi
             JOIN receipt_scan_issues rsi_issue ON rsi_issue.receipt_scan_item_id = rsi.id
             WHERE rsi.receipt_scan_id = rs.id
             ORDER BY rsi.line_no, rsi_issue.id
             LIMIT 1
           ) AS detected_issue_code,
           c.id AS claim_id, c.status AS claim_status, c.claim_reason, c.claim_title,
           (SELECT COUNT(*)::int FROM claim_media cm WHERE cm.claim_id = c.id AND cm.is_active = true) AS media_count,
           mt.exact
    FROM expected_returns er
    JOIN marketplaces m ON m.id = er.marketplace_id
    LEFT JOIN receipt_scans rs ON rs.expected_return_id = er.id
    LEFT JOIN claims c ON c.receipt_scan_id = rs.id
    CROSS JOIN LATERAL (
      SELECT (
        UPPER(er.tracking_id) = UPPER($1::text)
        OR UPPER(COALESCE(er.alt_tracking_id, '')) = UPPER($1::text)
        OR UPPER(COALESCE(er.forward_tracking_id, '')) = UPPER($1::text)
        OR UPPER(COALESCE(er.return_event_id, '')) = UPPER($1::text)
        OR UPPER(er.order_number) = UPPER($1::text)
        OR UPPER(COALESCE(rs.flyer_id, '')) = UPPER($1::text)
        OR UPPER(COALESCE(rs.scanned_tracking, '')) = UPPER($1::text)
        OR (
          LENGTH(REPLACE(REPLACE($1::text, '-', ''), ' ', '')) >= 8
          AND REPLACE(REPLACE(UPPER(er.order_number), '-', ''), ' ', '') = REPLACE(REPLACE(UPPER($1::text), '-', ''), ' ', '')
        )
        OR EXISTS (
          SELECT 1 FROM expected_return_items eri
          WHERE eri.expected_return_id = er.id
            AND (
              UPPER(COALESCE(eri.display_order_item_id, '')) = UPPER($1::text)
              OR UPPER(COALESCE(eri.order_line_id, '')) = UPPER($1::text)
              OR UPPER(COALESCE(eri.shipment_id, '')) = UPPER($1::text)
              OR (
                LENGTH(REPLACE(REPLACE($1::text, '-', ''), ' ', '')) >= 8
                AND REPLACE(REPLACE(UPPER(COALESCE(eri.display_order_item_id, '')), '-', ''), ' ', '') = REPLACE(REPLACE(UPPER($1::text), '-', ''), ' ', '')
              )
            )
        )
        OR EXISTS (
          SELECT 1 FROM receipt_scan_items rsi
          WHERE rsi.receipt_scan_id = rs.id AND UPPER(COALESCE(rsi.order_item_id, '')) = UPPER($1::text)
        )
      ) AS exact
    ) mt
    WHERE ${scopeCondition} ${mktCondition}
      AND (er.lookup_status = 'active' OR (er.lookup_status = 'superseded' AND rs.id IS NOT NULL))
      AND (
        mt.exact
        OR er.tracking_id ILIKE $2
        OR er.order_number ILIKE $2
        OR EXISTS (
          SELECT 1 FROM receipt_scan_items rsi
          WHERE rsi.receipt_scan_id = rs.id AND rsi.order_item_id ILIKE $2
        )
      )
    ORDER BY mt.exact DESC, (rs.id IS NOT NULL) DESC, rs.scanned_at DESC NULLS LAST, er.id DESC
    LIMIT 1
  `

  const res = await db.query(scanQuery, params)
  const row = res.rows[0]
  if (!row) return null

  const expectedReturnId = Number(row.expected_return_id)
  const resolvedMktId = Number(row.marketplace_id)
  const marketplaceName = String(row.marketplace)
  const isMeesho = marketplaceName.toLowerCase() === "meesho"

  // Fetch items for this expected return including Sub Order ID and product images
  const itemsRes = await db.query(
    `SELECT eri.id, eri.qty AS quantity,
            COALESCE(NULLIF(eri.label, ''), s.name, 'Returned Product') AS product_title,
            COALESCE(s.code, '') AS master_sku,
            COALESCE(NULLIF(eri.marketplace_sku_identifier, ''), NULLIF(eri.channel_listing_id, ''), s.code, '') AS sku,
            COALESCE(s.image_url, '') AS catalog_image_url,
            COALESCE(NULLIF(eri.display_order_item_id, ''), eri.order_line_id, '') AS sub_order_id
     FROM expected_return_items eri
     LEFT JOIN skus s ON s.id = eri.sku_id
     WHERE eri.expected_return_id = $1
     ORDER BY eri.sort_order ASC, eri.id ASC`,
    [expectedReturnId],
  )

  const items = itemsRes.rows.map((i) => ({
    itemId: Number(i.id),
    sku: String(i.sku || ""),
    masterSku: String(i.master_sku || i.sku || ""),
    title: String(i.product_title || "Returned Product"),
    quantity: Math.max(1, Number(i.quantity || 1)),
    imageUrl: String(i.catalog_image_url || ""),
    subOrderId: String(i.sub_order_id || ""),
  }))

  // If already scanned, check receipt_scan_items and issues for sub_order_id, return_type and missing components
  let scannedSubOrderId = ""
  const scanReturnTypes = new Set<string>()
  const missingItems: Array<{ label: string; quantity: number; amountEach: number; amount: number }> = []
  if (row.scan_id) {
    const scanItemsRes = await db.query(
      `SELECT rsi.id, rsi.order_item_id, rsi.product_name, rsi.return_type,
              rsi_issue.category_code, rsi_issue.sub_issue_label, rsi_issue.qty,
              COALESCE(option.claim_amount, 0)::numeric AS claim_amount
       FROM receipt_scan_items rsi
       LEFT JOIN receipt_scan_issues rsi_issue ON rsi_issue.receipt_scan_item_id = rsi.id
       LEFT JOIN missing_component_options option ON option.id = rsi_issue.sub_issue_id
       WHERE rsi.receipt_scan_id = $1
       ORDER BY rsi.line_no, rsi_issue.id`,
      [row.scan_id],
    )
    for (const r of scanItemsRes.rows) {
      if (r.order_item_id && !scannedSubOrderId) {
        scannedSubOrderId = String(r.order_item_id).trim()
      }
      if (r.return_type) {
        scanReturnTypes.add(String(r.return_type).trim())
      }
      if (r.category_code === "missing_component") {
        const qty = Number(r.qty || 0)
        const each = Number(r.claim_amount || 0)
        missingItems.push({
          label: String(r.sub_issue_label || "Missing item"),
          quantity: qty,
          amountEach: each,
          amount: qty * each,
        })
      }
    }
  }

  const orderId = String(row.order_number || "")
  const trackingNumber = String(row.tracking_id || "")
  const subOrderId = scannedSubOrderId || items[0]?.subOrderId || orderId
  const packetId = String(row.flyer_id || "NA")
  const missingAmount = missingItems.reduce((acc, it) => acc + it.amount, 0)

  // Turnaround Time (TAT) Calculation: 7 calendar days inclusive for Meesho
  const receivedAtVal = row.scanned_at || new Date()
  const receivedDate = istDate(receivedAtVal)
  const tatDays = isMeesho ? MEESHO_TAT_DAYS : 7
  const dueDate = isMeesho ? meeshoClaimDueDate(receivedAtVal) : addDays(receivedDate, tatDays - 1)
  const today = istDate(new Date())
  const daysRemaining = daysBetween(today, dueDate)
  const overdue = daysRemaining < 0

  // The one template a claim for this marketplace uses, with its active fields only. Empty when claims for this
  // marketplace are not supported yet (Amazon today), so a client never shows switched-off slots.
  const templateId = await resolveClaimTemplateId(db, resolvedMktId)
  const templates = templateId === null ? [] : [await getClaimTemplate(db, scope, templateId)]
  const mktTemplates = templates
    .map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      fields: t.fields.filter((f) => f.active).map((f) => ({
        fieldKey: f.fieldKey,
        fieldLabel: f.fieldLabel,
        fieldType: f.fieldType,
        required: f.required,
        minCount: f.minCount,
        maxCount: f.maxCount,
        maxFileSizeMb: f.maxFileSizeMb,
      })),
    }))

  // Calculate days since shipped
  let daysSinceShipped = 0
  const shippedDateVal = row.shipped_date instanceof Date ? row.shipped_date : row.shipped_date ? new Date(row.shipped_date) : null
  if (shippedDateVal) {
    const diffMs = Date.now() - shippedDateVal.getTime()
    daysSinceShipped = Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)))
  }

  // Standard claim reasons & pre-filled content (Marketplace-specific for Meesho)
  let standardReasons: Array<{
    code: string
    label: string
    suggestedTitle: string
    suggestedContent: string
  }> = []

  const combinedReturnType = [...scanReturnTypes, String(row.expected_return_type || "")].filter(Boolean).join(", ")
  const isRto = /\brto\b/i.test(combinedReturnType)

  let normalizedDetected: string | null = null
  if (isMeesho) {
    const rawCodes = Object.keys(MEESHO_ISSUES) as MeeshoIssueCode[]
    const detectedRaw = row.detected_issue_code ? String(row.detected_issue_code).toLowerCase() : null
    normalizedDetected =
      detectedRaw === "wrong_product" || detectedRaw === "wrong_return" ? (isRto ? "wrong_barcode_rto" : "wrong_return") :
      detectedRaw === "missing_component" || detectedRaw === "missing_items" || detectedRaw === "missing_product" ? "missing_items" :
      detectedRaw === "damaged_product" || detectedRaw === "damaged_return" ? "damaged_return" :
      detectedRaw === "used_product" ? "used_product" :
      detectedRaw === "wrong_barcode_rto" || detectedRaw === "sku_change" ? "wrong_barcode_rto" :
      isRto ? "wrong_barcode_rto" :
      null

    const sortedCodes = rawCodes.slice().sort((a, b) => {
      if (normalizedDetected && a === normalizedDetected) return -1
      if (normalizedDetected && b === normalizedDetected) return 1
      return 0
    })

    const meeshoBase = {
      subOrderId,
      awb: trackingNumber,
      packetId,
      masterSku: items[0]?.masterSku || items[0]?.sku,
      productNames: items.map((i) => i.title),
      missingItems,
      missingAmount,
    }
    standardReasons = sortedCodes.map((code) => ({
      code,
      label: MEESHO_ISSUES[code],
      suggestedTitle: `${MEESHO_ISSUES[code]} - Sub Order ${subOrderId}`,
      suggestedContent: meeshoClaimDescription(code, meeshoBase),
    }))
  } else {
    standardReasons = [
      {
        code: "wrong_product",
        label: "Wrong Product Received",
        suggestedTitle: `Wrong Item Received - Order ${orderId}`,
        suggestedContent: `Received completely different product in return package for Order ${orderId} (AWB: ${trackingNumber}). The received item does not match the ordered master SKU ${items[0]?.masterSku || ""}. Please refer to the attached unboxing evidence and photos.`,
      },
      {
        code: "missing_product",
        label: "Missing Product / Empty Packet",
        suggestedTitle: `Missing / Empty Package - Order ${orderId}`,
        suggestedContent: `Return package was received empty or with missing items for Order ${orderId}. Expected ${items[0]?.quantity || 1} units of SKU ${items[0]?.masterSku || ""}. Outer packet ID is ${packetId}. Attached unboxing video shows condition upon opening.`,
      },
      {
        code: "damaged_product",
        label: "Damaged / Defective Product",
        suggestedTitle: `Damaged Return Item - Order ${orderId}`,
        suggestedContent: `Product arrived in damaged / broken condition for Order ${orderId}. See attached photos of product condition and shipping reverse waybill.`,
      },
      {
        code: "used_product",
        label: "Used / Worn Product Received",
        suggestedTitle: `Used / Soiled Item - Order ${orderId}`,
        suggestedContent: `Returned item shows clear signs of prior use / wear / odor / missing tags for Order ${orderId}. Not in resalable condition. Evidence attached.`,
      },
      {
        code: "quantity_mismatch",
        label: "Quantity Mismatch",
        suggestedTitle: `Quantity Shortage - Order ${orderId}`,
        suggestedContent: `Short shipment received in return for Order ${orderId}. Expected quantity does not match physically received quantity.`,
      },
      {
        code: "wrong_barcode_rto",
        label: "Wrong Barcode / RTO Mismatch",
        suggestedTitle: `Barcode Mismatch RTO - Order ${orderId}`,
        suggestedContent: `Barcode or tracking label on package does not match our return manifest. Packet ID: ${packetId}. Reverse Waybill: ${trackingNumber}.`,
      },
      {
        code: "other",
        label: "Other Return Issue",
        suggestedTitle: `Return Issue - Order ${orderId}`,
        suggestedContent: `Issue observed on returned shipment for Order ${orderId}. Evidence attached.`,
      },
    ]
  }

  return {
    found: true,
    exactMatch: Boolean(row.exact),
    scanId: row.scan_id ? Number(row.scan_id) : null,
    expectedReturnId,
    marketplace: marketplaceName,
    marketplaceId: resolvedMktId,
    subOrderId,
    orderId,
    trackingNumber,
    awb: trackingNumber,
    packetState: "Unknown",
    packetId,
    detectedIssueCode: normalizedDetected || (row.detected_issue_code ? String(row.detected_issue_code) : null),
    customerName: String(row.customer_name || "Customer"),
    totalPrice: Number(row.total_price || 0),
    totalAmount: Number(row.total_price || 0),
    returnStatus: String(row.return_status || "Return Initiated"),
    shippedDate: shippedDateVal ? shippedDateVal.toISOString().split("T")[0] : null,
    daysSinceShipped,
    tatDays,
    receivedDate,
    dueDate,
    daysRemaining,
    overdue,
    missingItems,
    missingAmount,
    existingClaim: row.claim_id
      ? {
          id: Number(row.claim_id),
          status: String(row.claim_status),
          reason: String(row.claim_reason || ""),
          title: String(row.claim_title || ""),
          mediaCount: Number(row.media_count || 0),
        }
      : null,
    items,
    templates: mktTemplates,
    standardReasons,
  }
}
