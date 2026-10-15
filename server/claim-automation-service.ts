import crypto from "node:crypto"
import type pg from "pg"
import { accountCondition, type AccountScope } from "./access.js"
import { ServiceError, type Actor } from "./register-service.js"
import { listClaimTemplates } from "./claims-service.js"
import {
  MEESHO_PACKET_STATE,
  MEESHO_TAT_DAYS,
  MEESHO_ISSUES,
  type MeeshoIssueCode,
  istDate,
  addDays,
  daysBetween,
  meeshoClaimDueDate,
  meeshoClaimDescription,
} from "./meesho-claims.js"

// AES-256-GCM encryption for marketplace portal credentials
const ENCRYPTION_KEY = crypto
  .createHash("sha256")
  .update(process.env.AUTOMATION_SECRET_KEY || "taskflow-return-claims-agent-2026-secret-master")
  .digest()

export function encryptSecret(plainText: string): string {
  if (!plainText) return ""
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv)
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
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv)
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
  browserMode: string
  attempts: number
  maxAttempts: number
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
  },
): Promise<{ agentId: number; apiKey: string; authorized: boolean }> {
  const uuid = data.agentUuid.trim()
  if (!uuid) throw new ServiceError(400, "Agent UUID is required.")
  const name = data.agentName.trim() || "Desktop-Agent"
  const apiKey = data.apiKey?.trim() || crypto.randomBytes(24).toString("hex")
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex")

  const res = await db.query(
    `INSERT INTO claim_automation_agents (agent_uuid, agent_name, hostname, platform, version, status, last_heartbeat_at, api_key_hash)
     VALUES ($1, $2, $3, $4, $5, 'online', now(), $6)
     ON CONFLICT (agent_uuid) DO UPDATE SET
       agent_name = EXCLUDED.agent_name,
       hostname = EXCLUDED.hostname,
       platform = EXCLUDED.platform,
       version = EXCLUDED.version,
       status = 'online',
       last_heartbeat_at = now(),
       updated_at = now()
     RETURNING id, is_authorized`,
    [uuid, name, data.hostname || "", data.platform || "win32", data.version || "1.0.0", keyHash],
  )

  return {
    agentId: Number(res.rows[0].id),
    apiKey,
    authorized: Boolean(res.rows[0].is_authorized),
  }
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

export async function saveMarketplaceCredential(
  db: pg.Pool,
  actor: Actor,
  data: {
    id?: number
    marketplaceId?: number | null
    accountName: string
    portalUrl: string
    username?: string
    password?: string
    automationMode?: string
    requireApprovalBeforeSubmit?: boolean
    autoPrepare?: boolean
  },
): Promise<number> {
  const name = data.accountName.trim()
  if (!name) throw new ServiceError(400, "Account name is required.")

  const userEnc = data.username ? encryptSecret(data.username.trim()) : undefined
  const passEnc = data.password ? encryptSecret(data.password.trim()) : undefined

  if (data.id) {
    const setClauses: string[] = ["account_name = $1", "portal_url = $2", "updated_at = now()"]
    const params: unknown[] = [name, data.portalUrl.trim()]

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

    params.push(data.id)
    await db.query(
      `UPDATE marketplace_credentials SET ${setClauses.join(", ")} WHERE id = $${params.length}`,
      params,
    )
    return data.id
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
        data.portalUrl.trim(),
        userEnc || "",
        passEnc || "",
        data.automationMode || "assisted",
        data.requireApprovalBeforeSubmit !== false,
        data.autoPrepare !== false,
      ],
    )
    return Number(res.rows[0].id)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Automation Jobs Queue & Execution
// ---------------------------------------------------------------------------------------------------------------

export async function createOrQueueAutomationJob(
  db: pg.Pool,
  claimId: number,
  options: { browserMode?: string } = {},
): Promise<number> {
  // Check if job already exists for this claim
  const existing = await db.query(
    `SELECT id, stage FROM claim_automation_jobs WHERE claim_id = $1 ORDER BY id DESC LIMIT 1`,
    [claimId],
  )
  if (existing.rows[0] && existing.rows[0].stage !== "failed") {
    return Number(existing.rows[0].id)
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

export async function pollNextAutomationJob(
  db: pg.Pool,
  agentUuid: string,
): Promise<{
  jobId: number
  claimId: number
  stage: string
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

    // Select oldest queued job or approved job ready for submission
    const jobRes = await client.query(
      `SELECT j.id, j.claim_id, j.stage, m.name AS marketplace, er.order_number, er.tracking_id
       FROM claim_automation_jobs j
       JOIN claims c ON c.id = j.claim_id
       JOIN marketplaces m ON m.id = c.marketplace_id
       JOIN receipt_scans rs ON rs.id = c.receipt_scan_id
       JOIN expected_returns er ON er.id = rs.expected_return_id
       WHERE j.stage IN ('queued', 'approved')
       ORDER BY j.created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    )

    if (!jobRes.rows[0]) {
      await client.query("COMMIT")
      return null
    }

    const job = jobRes.rows[0]
    const nextStage = job.stage === "approved" ? "submitting" : "downloading_media"

    await client.query(
      `UPDATE claim_automation_jobs
       SET agent_id = $2,
           stage = $3,
           attempts = attempts + 1,
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
    claimReason: string
    claimTitle: string
    claimDescription: string
    claimContent: string
    remarks: string
  }
  evidenceFiles: Array<{
    id: number
    fieldKey: string
    fieldType: string
    originalFilename: string
    mimeType: string
    sizeBytes: number
    storageObjectPath: string
  }>
}> {
  const res = await db.query(
    `SELECT j.id AS job_id, j.claim_id, j.stage, j.browser_mode,
            m.name AS marketplace,
            mc.account_name, mc.portal_url, mc.username_encrypted, mc.password_encrypted,
            mc.auth_state, mc.automation_mode, mc.require_approval_before_submit,
            c.claim_reason, c.claim_title, c.claim_description, c.claim_content, c.remarks,
            c.sub_order_id_snapshot, c.awb_snapshot, c.packet_id_snapshot, c.customer_name_snapshot,
            c.total_price_snapshot, c.sku_snapshot,
            er.order_number, er.tracking_id
     FROM claim_automation_jobs j
     JOIN claims c ON c.id = j.claim_id
     JOIN marketplaces m ON m.id = c.marketplace_id
     JOIN receipt_scans rs ON rs.id = c.receipt_scan_id
     JOIN expected_returns er ON er.id = rs.expected_return_id
     LEFT JOIN marketplace_credentials mc ON mc.id = j.marketplace_credential_id
     WHERE j.id = $1`,
    [jobId],
  )

  const row = res.rows[0]
  if (!row) throw new ServiceError(404, "Automation job not found.")

  const mediaRes = await db.query(
    `SELECT id, field_key, mime_type, original_filename, size_bytes, storage_object_path
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
      sku: String(row.sku_snapshot || ""),
      customerName: String(row.customer_name_snapshot || ""),
      totalPrice: Number(row.total_price_snapshot || 0),
      claimReason: String(row.claim_reason),
      claimTitle: String(row.claim_title || ""),
      claimDescription: String(row.claim_description || ""),
      claimContent: String(row.claim_content || ""),
      remarks: String(row.remarks || ""),
    },
    evidenceFiles: mediaRes.rows.map((m) => ({
      id: Number(m.id),
      fieldKey: String(m.field_key),
      fieldType: m.mime_type.startsWith("video/") ? "video" : m.mime_type.startsWith("image/") ? "image" : "document",
      originalFilename: String(m.original_filename || "evidence"),
      mimeType: String(m.mime_type || "application/octet-stream"),
      sizeBytes: Number(m.size_bytes || 0),
      storageObjectPath: String(m.storage_object_path),
    })),
  }
}

export async function updateJobProgress(
  db: pg.Pool,
  jobId: number,
  data: {
    stage: string
    logMessage?: string
    screenshotPath?: string
    manualActionReason?: string
  },
): Promise<void> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const newLog = data.logMessage
      ? JSON.stringify([{ timestamp: new Date().toISOString(), level: "info", message: data.logMessage }])
      : "[]"

    const setClauses: string[] = ["stage = $2", "updated_at = now()", "logs = logs || $3::jsonb"]
    const params: unknown[] = [jobId, data.stage, newLog]

    if (data.screenshotPath) {
      params.push(data.screenshotPath)
      setClauses.push(`submission_screenshot_path = $${params.length}`)
    }
    if (data.manualActionReason) {
      params.push(data.manualActionReason)
      setClauses.push(`manual_action_reason = $${params.length}`)
    }

    await client.query(
      `UPDATE claim_automation_jobs SET ${setClauses.join(", ")} WHERE id = $1`,
      params,
    )

    // Sync claim status with job stage
    if (data.stage === "prepared") {
      await client.query(
        `UPDATE claims SET status = 'waiting_for_approval', updated_at = now() WHERE id = (SELECT claim_id FROM claim_automation_jobs WHERE id = $1)`,
        [jobId],
      )
    } else if (data.stage === "manual_intervention_required") {
      await client.query(
        `UPDATE claims SET status = 'manual_action_required', remarks = COALESCE(remarks, '') || '\nManual action required: ' || $2, updated_at = now() WHERE id = (SELECT claim_id FROM claim_automation_jobs WHERE id = $1)`,
        [jobId, data.manualActionReason || "Marketplace portal requires manual intervention"],
      )
    }

    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function completeJobSubmission(
  db: pg.Pool,
  jobId: number,
  data: {
    marketplaceClaimId: string
    screenshotPath?: string
    notes?: string
  },
): Promise<void> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const res = await client.query(
      `SELECT claim_id FROM claim_automation_jobs WHERE id = $1`,
      [jobId],
    )
    if (!res.rows[0]) throw new ServiceError(404, "Job not found.")
    const claimId = Number(res.rows[0].claim_id)

    const completedLog = JSON.stringify([
      {
        timestamp: new Date().toISOString(),
        level: "info",
        message: `Claim successfully submitted on marketplace. Ref ID: ${data.marketplaceClaimId}`,
      },
    ])

    await client.query(
      `UPDATE claim_automation_jobs
       SET stage = 'completed',
           marketplace_claim_id = $2,
           submission_screenshot_path = COALESCE($3, submission_screenshot_path),
           completed_at = now(),
           updated_at = now(),
           logs = logs || $4::jsonb
       WHERE id = $1`,
      [jobId, data.marketplaceClaimId, data.screenshotPath || null, completedLog],
    )

    await client.query(
      `UPDATE claims
       SET status = 'submitted',
           remarks = COALESCE(remarks, '') || '\nMarketplace Claim ID: ' || $2,
           updated_at = now()
       WHERE id = $1`,
      [claimId, data.marketplaceClaimId],
    )

    await client.query(
      `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
       VALUES ($1, 'processing', 'submitted', $2, NULL)`,
      [claimId, `Submitted by desktop automation. Marketplace Claim Ref: ${data.marketplaceClaimId}`],
    )

    await client.query("COMMIT")
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
): Promise<void> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const res = await client.query(
      `SELECT j.id, j.claim_id, c.marketplace_id
       FROM claim_automation_jobs j
       JOIN claims c ON c.id = j.claim_id
       WHERE j.id = $1`,
      [jobId],
    )
    if (!res.rows[0]) throw new ServiceError(404, "Automation job not found.")

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
  jobId: number,
): Promise<void> {
  const log = JSON.stringify([
    {
      timestamp: new Date().toISOString(),
      level: "info",
      message: `Job reset to queued for retry by ${actor.name || "user"}.`,
    },
  ])

  await db.query(
    `UPDATE claim_automation_jobs
     SET stage = 'queued',
         manual_action_reason = '',
         updated_at = now(),
         logs = logs || $2::jsonb
     WHERE id = $1`,
    [jobId, log],
  )
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

  if (filter.stage) {
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
            j.stage, j.browser_mode, j.attempts, j.max_attempts,
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
    browserMode: String(r.browser_mode),
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
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

export async function lookupReturnForClaim(
  db: pg.Pool,
  scope: AccountScope,
  query: string,
  marketplaceId?: number | null,
): Promise<ClaimReturnLookupResult | null> {
  const value = query.trim()
  if (value.length < 3) return null

  const params: unknown[] = []
  const scopeCondition = accountCondition(scope, "er.marketplace_id", params)

  params.push(value)
  params.push(`%${value}%`)

  let mktCondition = ""
  if (marketplaceId) {
    params.push(marketplaceId)
    mktCondition = `AND er.marketplace_id = $${params.length}`
  }

  // 1. First look for already scanned returns in receipt_scans
  const scanQuery = `
    SELECT rs.id AS scan_id, er.id AS expected_return_id, er.marketplace_id, m.name AS marketplace,
           er.order_number, er.tracking_id, er.alt_tracking_id, rs.flyer_id, rs.scanned_at,
           er.customer_name, er.total_price, er.return_status, er.shipped_date,
           c.id AS claim_id, c.status AS claim_status, c.claim_reason, c.claim_title,
           (SELECT COUNT(*)::int FROM claim_media cm WHERE cm.claim_id = c.id AND cm.is_active = true) AS media_count
    FROM expected_returns er
    JOIN marketplaces m ON m.id = er.marketplace_id
    LEFT JOIN receipt_scans rs ON rs.expected_return_id = er.id
    LEFT JOIN claims c ON c.receipt_scan_id = rs.id
    WHERE ${scopeCondition} ${mktCondition}
      AND (
        er.tracking_id = $1 OR er.alt_tracking_id = $1 OR er.order_number = $1
        OR rs.flyer_id = $1 OR rs.scanned_tracking = $1
        OR er.tracking_id ILIKE $2 OR er.order_number ILIKE $2
      )
    ORDER BY (rs.id IS NOT NULL) DESC, rs.scanned_at DESC NULLS LAST
    LIMIT 1
  `

  const res = await db.query(scanQuery, params)
  const row = res.rows[0]
  if (!row) return null

  const expectedReturnId = Number(row.expected_return_id)
  const resolvedMktId = Number(row.marketplace_id)
  const marketplaceName = String(row.marketplace)
  const isMeesho = marketplaceName.toLowerCase() === "meesho"

  // Fetch items for this expected return including Sub Order ID
  const itemsRes = await db.query(
    `SELECT eri.id, eri.sku, eri.master_sku, eri.product_title, eri.quantity, eri.catalog_image_url,
            COALESCE(NULLIF(eri.display_order_item_id, ''), eri.order_line_id, '') AS sub_order_id
     FROM expected_return_items eri
     WHERE eri.expected_return_id = $1
     ORDER BY eri.id ASC`,
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

  // If already scanned, check receipt_scan_items and issues for sub_order_id and missing components
  let scannedSubOrderId = ""
  const missingItems: Array<{ label: string; quantity: number; amountEach: number; amount: number }> = []
  if (row.scan_id) {
    const scanItemsRes = await db.query(
      `SELECT rsi.id, rsi.order_item_id, rsi.product_name,
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

  // Fetch claim templates and fields for this marketplace
  const templates = await listClaimTemplates(db, scope)
  const mktTemplates = templates
    .filter((t) => t.marketplaceId === resolvedMktId || t.marketplaceId === null)
    .map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      fields: t.fields.map((f) => ({
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

  if (isMeesho) {
    const meeshoBase = {
      subOrderId,
      awb: trackingNumber,
      packetId,
      missingItems,
      missingAmount,
    }
    standardReasons = (Object.keys(MEESHO_ISSUES) as MeeshoIssueCode[]).map((code) => ({
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
    scanId: row.scan_id ? Number(row.scan_id) : null,
    expectedReturnId,
    marketplace: marketplaceName,
    marketplaceId: resolvedMktId,
    subOrderId,
    orderId,
    trackingNumber,
    awb: trackingNumber,
    packetState: MEESHO_PACKET_STATE,
    packetId,
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
