// Claims service: lifecycle records, evidence media, and configurable templates.
//
// Every read and write takes the user's account scope (server/access.ts). A claim outside the scope is reported
// as not found (404), so its existence is not revealed. Every status change is kept in claim_status_history.
// Media metadata is stored here; the file bytes live in Firebase Storage. Retrieval is scoped and server-side:
// the client never receives a direct public link.
//
// The claim lifecycle: pending_evidence -> ready_for_claim -> waiting_for_approval -> processing -> submitted.
// Terminal/failure: failed, manual_action_required. All transitions are allowed and audited.

import type pg from "pg"
import { accountCondition, allowsAccount, type AccountScope } from "./access.js"
import { ServiceError, type Actor } from "./register-service.js"
import { isFirebaseConfigured } from "./firebase-storage.js"

export const CLAIM_STATUSES = [
  "pending_evidence",
  "ready_for_claim",
  "waiting_for_approval",
  "processing",
  "submitted",
  "failed",
  "manual_action_required",
] as const

export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

export const RETENTION_MONTHS = 24
export const MAX_CLAIM_REASON = 200
export const MAX_CLAIM_TITLE = 200
export const MAX_CLAIM_DESCRIPTION = 2000
export const MAX_CLAIM_REMARKS = 2000
export const MAX_FIELD_LABEL = 100
export const MAX_TEMPLATE_NAME = 120
export const MAX_FIELD_KEY = 60
export const MAX_ORIGINAL_FILENAME = 255
export const MAX_STATUS_REASON = 500

export type ClaimTemplateField = {
  id: number
  fieldKey: string
  fieldLabel: string
  fieldType: string
  required: boolean
  minCount: number
  maxCount: number
  maxFileSizeMb: number
  sortOrder: number
  active: boolean
}

export type ClaimTemplate = {
  id: number
  marketplaceId: number | null
  marketplaceName: string
  name: string
  description: string
  active: boolean
  sortOrder: number
  fields: ClaimTemplateField[]
}

export type ClaimMediaRow = {
  id: number
  fieldKey: string
  contentHash: string
  sizeBytes: number
  mimeType: string
  originalFilename: string
  capturedAt: string | null
  uploadedBy: string
  uploadedAt: string
  active: boolean
  retentionUntil: string
}

export type ClaimStatusHistoryRow = {
  fromStatus: string
  toStatus: string
  reason: string
  changedBy: string
  changedAt: string
}

export type ClaimRow = {
  id: number
  receiptScanId: number
  marketplaceId: number
  marketplace: string
  claimTemplateId: number | null
  claimReason: string
  claimTitle: string
  claimDescription: string
  remarks: string
  status: string
  createdBy: string
  createdAt: string
  updatedAt: string
  trackingId: string
  orderId: string
  mediaCount: number
}

export type ClaimDetail = ClaimRow & {
  media: ClaimMediaRow[]
  history: ClaimStatusHistoryRow[]
  evidenceComplete: boolean
  missingEvidence: string[]
}

export type ClaimListResult = {
  rows: ClaimRow[]
  total: number
  page: number
  pageSize: number
}

// ---------------------------------------------------------------------------------------------------------------
// Validation helpers (pure)
// ---------------------------------------------------------------------------------------------------------------

export function isValidStatus(status: string): status is ClaimStatus {
  return (CLAIM_STATUSES as readonly string[]).includes(status)
}

const CLAIM_TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  pending_evidence: ["ready_for_claim"],
  ready_for_claim: ["pending_evidence", "waiting_for_approval"],
  waiting_for_approval: ["ready_for_claim", "processing", "manual_action_required"],
  processing: ["submitted", "failed", "manual_action_required"],
  submitted: [],
  failed: ["processing", "manual_action_required"],
  manual_action_required: ["processing", "failed"],
}

export function claimTransitionError(from: ClaimStatus, to: ClaimStatus): string | null {
  if (CLAIM_TRANSITIONS[from].includes(to)) return null
  return `A claim cannot move from ${from} to ${to}.`
}

export function claimReasonError(reason: string): string | null {
  const trimmed = reason.trim()
  if (!trimmed) return "A claim reason is required."
  if (trimmed.length > MAX_CLAIM_REASON) return `The claim reason must be ${MAX_CLAIM_REASON} characters or fewer.`
  return null
}

export function claimTitleError(title: string): string | null {
  const trimmed = title.trim()
  if (!trimmed) return "A claim title is required."
  if (trimmed.length > MAX_CLAIM_TITLE) return `The claim title must be ${MAX_CLAIM_TITLE} characters or fewer.`
  return null
}

export function claimDescriptionError(description: string): string | null {
  if (description.length > MAX_CLAIM_DESCRIPTION) return `The description must be ${MAX_CLAIM_DESCRIPTION} characters or fewer.`
  return null
}

export function claimRemarksError(remarks: string): string | null {
  if (remarks.length > MAX_CLAIM_REMARKS) return `Remarks must be ${MAX_CLAIM_REMARKS} characters or fewer.`
  return null
}

export function statusReasonError(reason: string): string | null {
  if (reason.length > MAX_STATUS_REASON) return `The reason must be ${MAX_STATUS_REASON} characters or fewer.`
  return null
}

export function templateNameError(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return "A template name is required."
  if (trimmed.length > MAX_TEMPLATE_NAME) return `The template name must be ${MAX_TEMPLATE_NAME} characters or fewer.`
  return null
}

export function fieldKeyError(key: string): string | null {
  if (!key) return "A field key is required."
  if (!/^[a-z0-9_]+$/.test(key)) return "The field key must be lowercase letters, digits, and underscores only."
  if (key.length > MAX_FIELD_KEY) return `The field key must be ${MAX_FIELD_KEY} characters or fewer.`
  return null
}

export function fieldLabelError(label: string): string | null {
  const trimmed = label.trim()
  if (!trimmed) return "A field label is required."
  if (trimmed.length > MAX_FIELD_LABEL) return `The field label must be ${MAX_FIELD_LABEL} characters or fewer.`
  return null
}

export function fieldTypeError(type: string): string | null {
  if (!["image", "video", "document"].includes(type)) return "The field type must be image, video, or document."
  return null
}

export function fieldCountError(min: number, max: number): string | null {
  if (!Number.isInteger(min) || min < 0) return "The minimum count must be a non-negative whole number."
  if (!Number.isInteger(max) || max < 1) return "The maximum count must be a positive whole number."
  if (min > max) return "The minimum count cannot exceed the maximum count."
  return null
}

export function evidenceContentError(fieldType: string, content: Uint8Array): string | null {
  const isJpeg = content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
  const isPng =
    content.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => content[index] === value)
  const isWebp =
    content.length >= 12 &&
    Buffer.from(content.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(content.subarray(8, 12)).toString("ascii") === "WEBP"
  const isPdf = content.length >= 5 && Buffer.from(content.subarray(0, 5)).toString("ascii") === "%PDF-"
  const isMp4 = content.length >= 12 && Buffer.from(content.subarray(4, 8)).toString("ascii") === "ftyp"
  const isWebm =
    content.length >= 4 &&
    content[0] === 0x1a &&
    content[1] === 0x45 &&
    content[2] === 0xdf &&
    content[3] === 0xa3
  const isImage = isJpeg || isPng || isWebp
  const isVideo = isMp4 || isWebm
  if (fieldType === "image" && !isImage) return "The uploaded file content is not a supported JPEG, PNG, or WebP image."
  if (fieldType === "video" && !isVideo) return "The uploaded file content is not a supported MP4 or WebM video."
  if (fieldType === "document" && !isPdf && !isImage) {
    return "The uploaded file content is not a supported PDF or image document."
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Audit helper (writes to the shared register_audit_log)
// ---------------------------------------------------------------------------------------------------------------

async function auditClaimChange(
  client: pg.PoolClient,
  actorId: number,
  action: string,
  claimId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, 'claim', $3, $4::jsonb)`,
    [actorId, action, claimId, JSON.stringify(details)],
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Templates (Admin-managed, but readable by any signed-in user)
// ---------------------------------------------------------------------------------------------------------------

export async function listClaimTemplates(db: pg.Pool, scope: AccountScope): Promise<ClaimTemplate[]> {
  const params: unknown[] = []
  const scopeCondition = accountCondition(scope, "t.marketplace_id", params)
  const result = await db.query(
    `SELECT t.id, t.marketplace_id, COALESCE(m.name, 'All marketplaces') AS marketplace_name,
            t.name, t.description, t.is_active, t.sort_order
     FROM claim_templates t
     LEFT JOIN marketplaces m ON m.id = t.marketplace_id
     WHERE t.marketplace_id IS NULL OR ${scopeCondition}
     ORDER BY t.sort_order, t.id`,
    params,
  )

  if (result.rows.length === 0) return []

  const ids = result.rows.map((r) => r.id)
  const fieldResult = await db.query(
    `SELECT id, template_id, field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order, is_active
     FROM claim_template_fields
     WHERE template_id = ANY($1::integer[])
     ORDER BY template_id, sort_order, id`,
    [ids],
  )

  const fieldsByTemplate = new Map<number, ClaimTemplateField[]>()
  for (const row of fieldResult.rows) {
    const list = fieldsByTemplate.get(row.template_id) || []
    list.push({
      id: row.id,
      fieldKey: row.field_key,
      fieldLabel: row.field_label,
      fieldType: row.field_type,
      required: Boolean(row.required),
      minCount: row.min_count,
      maxCount: row.max_count,
      maxFileSizeMb: row.max_file_size_mb,
      sortOrder: row.sort_order,
      active: Boolean(row.is_active),
    })
    fieldsByTemplate.set(row.template_id, list)
  }

  return result.rows.map((row) => ({
    id: row.id,
    marketplaceId: row.marketplace_id,
    marketplaceName: row.marketplace_name,
    name: row.name,
    description: row.description,
    active: Boolean(row.is_active),
    sortOrder: row.sort_order,
    fields: fieldsByTemplate.get(row.id) || [],
  }))
}

export async function getClaimTemplate(db: pg.Pool, scope: AccountScope, templateId: number): Promise<ClaimTemplate> {
  const params: unknown[] = [templateId]
  const scopeCondition = accountCondition(scope, "t.marketplace_id", params)
  const result = await db.query(
    `SELECT t.id, t.marketplace_id, COALESCE(m.name, 'All marketplaces') AS marketplace_name,
            t.name, t.description, t.is_active, t.sort_order
     FROM claim_templates t
     LEFT JOIN marketplaces m ON m.id = t.marketplace_id
     WHERE t.id = $1 AND (t.marketplace_id IS NULL OR ${scopeCondition})`,
    params,
  )
  if (!result.rows[0]) throw new ServiceError(404, "Claim template not found.")

  const fieldResult = await db.query(
    `SELECT id, field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order, is_active
     FROM claim_template_fields
     WHERE template_id = $1
     ORDER BY sort_order, id`,
    [templateId],
  )

  return {
    id: result.rows[0].id,
    marketplaceId: result.rows[0].marketplace_id,
    marketplaceName: result.rows[0].marketplace_name,
    name: result.rows[0].name,
    description: result.rows[0].description,
    active: Boolean(result.rows[0].is_active),
    sortOrder: result.rows[0].sort_order,
    fields: fieldResult.rows.map((row: Record<string, unknown>) => ({
      id: Number(row.id),
      fieldKey: String(row.field_key),
      fieldLabel: String(row.field_label),
      fieldType: String(row.field_type),
      required: Boolean(row.required),
      minCount: Number(row.min_count),
      maxCount: Number(row.max_count),
      maxFileSizeMb: Number(row.max_file_size_mb),
      sortOrder: Number(row.sort_order),
      active: Boolean(row.is_active),
    })),
  }
}

export async function createClaimTemplate(
  db: pg.Pool,
  actor: Actor,
  input: { marketplaceId: number | null; name: string; description: string },
): Promise<ClaimTemplate> {
  const nameError = templateNameError(input.name)
  if (nameError) throw new ServiceError(400, nameError)

  const client = await db.connect()
  try {
    await client.query("BEGIN")

    // Verify the marketplace exists when one is named.
    if (input.marketplaceId !== null) {
      const mp = await client.query("SELECT 1 FROM marketplaces WHERE id = $1", [input.marketplaceId])
      if (!mp.rows[0]) throw new ServiceError(400, "That marketplace does not exist.")
    }

    const result = await client.query<{ id: number }>(
      `INSERT INTO claim_templates (marketplace_id, name, description, is_active, sort_order, created_by)
       VALUES ($1, $2, $3, true, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM claim_templates), $4)
       RETURNING id`,
      [input.marketplaceId, input.name.trim(), input.description.trim(), actor.id],
    )
    const templateId = result.rows[0].id

    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'claim_template.create', 'claim_template', $2, $3::jsonb)`,
      [actor.id, String(templateId), JSON.stringify({ name: input.name.trim(), marketplaceId: input.marketplaceId })],
    )

    await client.query("COMMIT")
    return await getClaimTemplate(db, { all: true }, templateId)
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function updateClaimTemplate(
  db: pg.Pool,
  actor: Actor,
  templateId: number,
  input: { name?: string; description?: string; isActive?: boolean },
): Promise<ClaimTemplate> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const existing = await client.query("SELECT id FROM claim_templates WHERE id = $1", [templateId])
    if (!existing.rows[0]) throw new ServiceError(404, "Claim template not found.")

    const updates: string[] = []
    const params: unknown[] = []
    if (input.name !== undefined) {
      const err = templateNameError(input.name)
      if (err) throw new ServiceError(400, err)
      params.push(input.name.trim())
      updates.push(`name = $${params.length}`)
    }
    if (input.description !== undefined) {
      params.push(input.description.trim())
      updates.push(`description = $${params.length}`)
    }
    if (input.isActive !== undefined) {
      params.push(input.isActive)
      updates.push(`is_active = $${params.length}`)
    }
    if (updates.length === 0) throw new ServiceError(400, "Nothing to change.")

    params.push(templateId)
    await client.query(
      `UPDATE claim_templates SET ${updates.join(", ")}, updated_at = now() WHERE id = $${params.length}`,
      params,
    )

    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'claim_template.update', 'claim_template', $2, $3::jsonb)`,
      [actor.id, String(templateId), JSON.stringify({ ...input })],
    )

    await client.query("COMMIT")
    return await getClaimTemplate(db, { all: true }, templateId)
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function addTemplateField(
  db: pg.Pool,
  actor: Actor,
  templateId: number,
  input: {
    fieldKey: string
    fieldLabel: string
    fieldType: string
    required: boolean
    minCount: number
    maxCount: number
    maxFileSizeMb: number
  },
): Promise<ClaimTemplateField> {
  const keyErr = fieldKeyError(input.fieldKey)
  if (keyErr) throw new ServiceError(400, keyErr)
  const labelErr = fieldLabelError(input.fieldLabel)
  if (labelErr) throw new ServiceError(400, labelErr)
  const typeErr = fieldTypeError(input.fieldType)
  if (typeErr) throw new ServiceError(400, typeErr)
  const countErr = fieldCountError(input.minCount, input.maxCount)
  if (countErr) throw new ServiceError(400, countErr)
  if (!Number.isInteger(input.maxFileSizeMb) || input.maxFileSizeMb < 1 || input.maxFileSizeMb > 100) {
    throw new ServiceError(400, "The file size limit must be a whole number from 1 to 100 MB.")
  }

  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const tpl = await client.query("SELECT id FROM claim_templates WHERE id = $1", [templateId])
    if (!tpl.rows[0]) throw new ServiceError(404, "Claim template not found.")

    const result = await client.query<{ id: number }>(
      `INSERT INTO claim_template_fields (template_id, field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM claim_template_fields WHERE template_id = $1), true)
       RETURNING id`,
      [
        templateId,
        input.fieldKey,
        input.fieldLabel.trim(),
        input.fieldType,
        input.required,
        input.minCount,
        input.maxCount,
        input.maxFileSizeMb,
      ],
    )

    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'claim_template_field.add', 'claim_template', $2, $3::jsonb)`,
      [actor.id, String(templateId), JSON.stringify({ fieldKey: input.fieldKey, fieldLabel: input.fieldLabel.trim() })],
    )

    await client.query("COMMIT")
    return {
      id: result.rows[0].id,
      fieldKey: input.fieldKey,
      fieldLabel: input.fieldLabel.trim(),
      fieldType: input.fieldType,
      required: input.required,
      minCount: input.minCount,
      maxCount: input.maxCount,
      maxFileSizeMb: input.maxFileSizeMb,
      sortOrder: 0,
      active: true,
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function deactivateTemplateField(db: pg.Pool, actor: Actor, fieldId: number): Promise<void> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const result = await client.query(
      "UPDATE claim_template_fields SET is_active = false WHERE id = $1 AND is_active = true RETURNING template_id, field_key",
      [fieldId],
    )
    if (result.rows[0]) {
      await client.query(
        `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'claim_template_field.deactivate', 'claim_template_field', $2, $3::jsonb)`,
        [actor.id, String(fieldId), JSON.stringify({ fieldKey: result.rows[0].field_key })],
      )
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Claims queue and detail (scoped reads)
// ---------------------------------------------------------------------------------------------------------------

export async function listClaims(
  db: pg.Pool,
  scope: AccountScope,
  filters: { status?: string; marketplaceId?: number | null; search?: string; page?: number; pageSize?: number },
): Promise<ClaimListResult> {
  const params: unknown[] = []
  const conditions: string[] = []
  conditions.push(accountCondition(scope, "c.marketplace_id", params))

  if (filters.status && isValidStatus(filters.status)) {
    params.push(filters.status)
    conditions.push(`c.status = $${params.length}`)
  }
  if (filters.marketplaceId && filters.marketplaceId > 0) {
    params.push(filters.marketplaceId)
    conditions.push(`c.marketplace_id = $${params.length}`)
  }
  const search = (filters.search || "").trim()
  if (search) {
    params.push(`%${search}%`)
    conditions.push(`(c.claim_reason ILIKE $${params.length} OR c.claim_title ILIKE $${params.length} OR er.tracking_id ILIKE $${params.length} OR er.order_number ILIKE $${params.length})`)
  }

  const where = conditions.join(" AND ")
  const page = Math.max(1, filters.page || 1)
  const pageSize = Math.min(100, Math.max(1, filters.pageSize || 25))

  const countResult = await db.query(
    `SELECT COUNT(*)::int AS total
     FROM claims c
     JOIN receipt_scans rs ON rs.id = c.receipt_scan_id
     JOIN expected_returns er ON er.id = rs.expected_return_id
     WHERE ${where}`,
    params,
  )
  const total = countResult.rows[0]?.total || 0

  const offset = (page - 1) * pageSize
  const dataParams = [...params, pageSize, offset]
  const result = await db.query(
    `SELECT c.id, c.receipt_scan_id, c.marketplace_id, m.name AS marketplace,
            c.claim_template_id, c.claim_reason, c.claim_title, c.claim_description, c.remarks, c.status,
            u.name AS created_by, c.created_at, c.updated_at,
            er.tracking_id, er.order_number,
            (SELECT COUNT(*)::int FROM claim_media cm WHERE cm.claim_id = c.id AND cm.is_active = true) AS media_count
     FROM claims c
     JOIN marketplaces m ON m.id = c.marketplace_id
     JOIN receipt_scans rs ON rs.id = c.receipt_scan_id
     JOIN expected_returns er ON er.id = rs.expected_return_id
     JOIN users u ON u.id = c.created_by
     WHERE ${where}
     ORDER BY c.created_at DESC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams,
  )

  return {
    rows: result.rows.map((row: Record<string, unknown>) => ({
      id: Number(row.id),
      receiptScanId: Number(row.receipt_scan_id),
      marketplaceId: Number(row.marketplace_id),
      marketplace: String(row.marketplace || ""),
      claimTemplateId: row.claim_template_id ? Number(row.claim_template_id) : null,
      claimReason: String(row.claim_reason || ""),
      claimTitle: String(row.claim_title || ""),
      claimDescription: String(row.claim_description || ""),
      remarks: String(row.remarks || ""),
      status: String(row.status || ""),
      createdBy: String(row.created_by || ""),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ""),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || ""),
      trackingId: String(row.tracking_id || ""),
      orderId: String(row.order_number || ""),
      mediaCount: Number(row.media_count || 0),
    })),
    total,
    page,
    pageSize,
  }
}

export async function getClaim(db: pg.Pool, scope: AccountScope, claimId: number): Promise<ClaimDetail> {
  const params: unknown[] = [claimId]
  const scopeCondition = accountCondition(scope, "c.marketplace_id", params)
  const result = await db.query(
    `SELECT c.id, c.receipt_scan_id, c.marketplace_id, m.name AS marketplace,
            c.claim_template_id, c.claim_reason, c.claim_title, c.claim_description, c.remarks, c.status,
            u.name AS created_by, c.created_at, c.updated_at,
            er.tracking_id, er.order_number
     FROM claims c
     JOIN marketplaces m ON m.id = c.marketplace_id
     JOIN receipt_scans rs ON rs.id = c.receipt_scan_id
     JOIN expected_returns er ON er.id = rs.expected_return_id
     JOIN users u ON u.id = c.created_by
     WHERE c.id = $1 AND ${scopeCondition}`,
    params,
  )
  if (!result.rows[0]) throw new ServiceError(404, "Claim not found.")
  const row = result.rows[0]

  const [mediaResult, historyResult] = await Promise.all([
    db.query(
      `SELECT cm.id, cm.field_key, cm.storage_object_path, cm.content_hash, cm.size_bytes,
              cm.mime_type, cm.original_filename, cm.captured_at, cm.uploaded_at,
              u.name AS uploaded_by, cm.is_active, cm.retention_until
       FROM claim_media cm
       JOIN users u ON u.id = cm.uploaded_by
       WHERE cm.claim_id = $1
       ORDER BY cm.is_active DESC, cm.field_key, cm.id`,
      [claimId],
    ),
    db.query(
      `SELECT from_status, to_status, reason, u.name AS changed_by, changed_at
       FROM claim_status_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.claim_id = $1
       ORDER BY h.changed_at`,
      [claimId],
    ),
  ])

  const activeCounts = new Map<string, number>()
  for (const media of mediaResult.rows) {
    if (media.is_active) {
      const key = String(media.field_key)
      activeCounts.set(key, (activeCounts.get(key) || 0) + 1)
    }
  }
  const requiredFields = row.claim_template_id
    ? (
        await db.query(
          `SELECT field_key, field_label, min_count
           FROM claim_template_fields
           WHERE template_id = $1 AND is_active = true AND required = true
           ORDER BY sort_order, id`,
          [row.claim_template_id],
        )
      ).rows
    : []
  const missingEvidence = requiredFields
    .filter((field: Record<string, unknown>) => (activeCounts.get(String(field.field_key)) || 0) < Number(field.min_count))
    .map((field: Record<string, unknown>) => String(field.field_label))

  return {
    id: Number(row.id),
    receiptScanId: Number(row.receipt_scan_id),
    marketplaceId: Number(row.marketplace_id),
    marketplace: String(row.marketplace || ""),
    claimTemplateId: row.claim_template_id ? Number(row.claim_template_id) : null,
    claimReason: String(row.claim_reason || ""),
    claimTitle: String(row.claim_title || ""),
    claimDescription: String(row.claim_description || ""),
    remarks: String(row.remarks || ""),
    status: String(row.status || ""),
    createdBy: String(row.created_by || ""),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ""),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || ""),
    trackingId: String(row.tracking_id || ""),
    orderId: String(row.order_number || ""),
    mediaCount: mediaResult.rows.filter((r: Record<string, unknown>) => Boolean(r.is_active)).length,
    media: mediaResult.rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      fieldKey: String(r.field_key || ""),
      contentHash: String(r.content_hash || ""),
      sizeBytes: Number(r.size_bytes || 0),
      mimeType: String(r.mime_type || ""),
      originalFilename: String(r.original_filename || ""),
      capturedAt: r.captured_at instanceof Date ? r.captured_at.toISOString() : null,
      uploadedBy: String(r.uploaded_by || ""),
      uploadedAt: r.uploaded_at instanceof Date ? r.uploaded_at.toISOString() : String(r.uploaded_at || ""),
      active: Boolean(r.is_active),
      retentionUntil: String(r.retention_until || ""),
    })),
    history: historyResult.rows.map((r: Record<string, unknown>) => ({
      fromStatus: String(r.from_status || ""),
      toStatus: String(r.to_status || ""),
      reason: String(r.reason || ""),
      changedBy: String(r.changed_by || ""),
      changedAt: r.changed_at instanceof Date ? r.changed_at.toISOString() : String(r.changed_at || ""),
    })),
    evidenceComplete: missingEvidence.length === 0,
    missingEvidence,
  }
}

export type ClaimScanSearchRow = {
  scanId: number
  marketplaceId: number
  marketplace: string
  trackingId: string
  orderId: string
  scannedAt: string
  hasClaim: boolean
}

export async function searchClaimScans(
  db: pg.Pool,
  scope: AccountScope,
  search: string,
  marketplaceId?: number | null,
): Promise<ClaimScanSearchRow[]> {
  const value = search.trim()
  if (value.length < 3) return []
  const params: unknown[] = []
  const conditions = [accountCondition(scope, "er.marketplace_id", params)]
  params.push(`%${value}%`)
  conditions.push(`(er.tracking_id ILIKE $${params.length} OR er.alt_tracking_id ILIKE $${params.length} OR er.order_number ILIKE $${params.length})`)
  if (marketplaceId) {
    params.push(marketplaceId)
    conditions.push(`er.marketplace_id = $${params.length}`)
  }
  const result = await db.query(
    `SELECT rs.id AS scan_id, er.marketplace_id, m.name AS marketplace, er.tracking_id,
            er.order_number, rs.scanned_at, (c.id IS NOT NULL) AS has_claim
     FROM receipt_scans rs
     JOIN expected_returns er ON er.id = rs.expected_return_id
     JOIN marketplaces m ON m.id = er.marketplace_id
     LEFT JOIN claims c ON c.receipt_scan_id = rs.id
     WHERE ${conditions.join(" AND ")}
     ORDER BY rs.scanned_at DESC
     LIMIT 20`,
    params,
  )
  return result.rows.map((row) => ({
    scanId: Number(row.scan_id),
    marketplaceId: Number(row.marketplace_id),
    marketplace: String(row.marketplace),
    trackingId: String(row.tracking_id || ""),
    orderId: String(row.order_number || ""),
    scannedAt: row.scanned_at instanceof Date ? row.scanned_at.toISOString() : String(row.scanned_at || ""),
    hasClaim: Boolean(row.has_claim),
  }))
}

// ---------------------------------------------------------------------------------------------------------------
// Create a claim (with duplicate prevention and immutable scan linkage)
// ---------------------------------------------------------------------------------------------------------------

export async function createClaim(
  db: pg.Pool,
  actor: Actor,
  scope: AccountScope,
  input: {
    receiptScanId: number
    claimReason: string
    claimTitle: string
    claimDescription: string
    remarks: string
    claimTemplateId?: number | null
  },
): Promise<ClaimDetail> {
  const reasonErr = claimReasonError(input.claimReason)
  if (reasonErr) throw new ServiceError(400, reasonErr)
  const titleErr = claimTitleError(input.claimTitle)
  if (titleErr) throw new ServiceError(400, titleErr)
  const descErr = claimDescriptionError(input.claimDescription)
  if (descErr) throw new ServiceError(400, descErr)
  const remarksErr = claimRemarksError(input.remarks)
  if (remarksErr) throw new ServiceError(400, remarksErr)

  const client = await db.connect()
  try {
    await client.query("BEGIN")

    // Find the scan and verify it is in scope. The scan links to an expected_return which has the marketplace_id.
    const scanResult = await client.query(
      `SELECT rs.id, er.marketplace_id, er.tracking_id, er.order_number
       FROM receipt_scans rs
       JOIN expected_returns er ON er.id = rs.expected_return_id
       WHERE rs.id = $1`,
      [input.receiptScanId],
    )
    if (!scanResult.rows[0]) throw new ServiceError(404, "Scanned return not found.")
    const scan = scanResult.rows[0]
    const marketplaceId = Number(scan.marketplace_id)
    if (!allowsAccount(scope, marketplaceId)) {
      throw new ServiceError(404, "Scanned return not found.")
    }

    // Duplicate prevention: one claim per scan.
    const existing = await client.query("SELECT id FROM claims WHERE receipt_scan_id = $1", [input.receiptScanId])
    if (existing.rows[0]) throw new ServiceError(409, "A claim already exists for this scanned return.")

    // Verify the template if one is named.
    let templateId: number | null = input.claimTemplateId ?? null
    if (templateId === null) {
      const fallback = await client.query(
        `SELECT id FROM claim_templates
         WHERE is_active = true AND (marketplace_id = $1 OR marketplace_id IS NULL)
         ORDER BY (marketplace_id = $1) DESC, sort_order, id
         LIMIT 1`,
        [marketplaceId],
      )
      templateId = fallback.rows[0] ? Number(fallback.rows[0].id) : null
    }
    if (templateId !== null) {
      const tpl = await client.query(
        `SELECT id FROM claim_templates
         WHERE id = $1 AND is_active = true AND (marketplace_id IS NULL OR marketplace_id = $2)`,
        [templateId, marketplaceId],
      )
      if (!tpl.rows[0]) throw new ServiceError(400, "Choose an active claim template for this marketplace.")
    }
    if (templateId === null) throw new ServiceError(409, "No active claim template is configured for this marketplace.")

    const result = await client.query<{ id: number }>(
      `INSERT INTO claims (receipt_scan_id, marketplace_id, claim_template_id, claim_reason, claim_title, claim_description, remarks, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_evidence', $8)
       RETURNING id`,
      [
        input.receiptScanId,
        marketplaceId,
        templateId,
        input.claimReason.trim(),
        input.claimTitle.trim(),
        input.claimDescription.trim(),
        input.remarks.trim(),
        actor.id,
      ],
    )
    const claimId = result.rows[0].id

    // First status history entry.
    await client.query(
      `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
       VALUES ($1, NULL, 'pending_evidence', 'Claim created', $2)`,
      [claimId, actor.id],
    )

    await auditClaimChange(client, actor.id, "claim.create", String(claimId), {
      receiptScanId: input.receiptScanId,
      marketplaceId,
      claimReason: input.claimReason.trim(),
    })

    await client.query("COMMIT")
    return await getClaim(db, scope, claimId)
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Update claim status (with audit history)
// ---------------------------------------------------------------------------------------------------------------

export async function updateClaimStatus(
  db: pg.Pool,
  actor: Actor,
  scope: AccountScope,
  claimId: number,
  input: { status: string; reason?: string },
): Promise<{ id: number; status: string }> {
  if (!isValidStatus(input.status)) throw new ServiceError(400, "Choose a valid claim status.")
  const reason = (input.reason || "").trim()
  const reasonErr = statusReasonError(reason)
  if (reasonErr) throw new ServiceError(400, reasonErr)

  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const params: unknown[] = [claimId]
    const scopeCondition = accountCondition(scope, "c.marketplace_id", params)
    const result = await client.query(
      `SELECT c.id, c.status FROM claims c WHERE c.id = $1 AND ${scopeCondition}`,
      params,
    )
    if (!result.rows[0]) throw new ServiceError(404, "Claim not found.")

    const currentStatus = String(result.rows[0].status)
    if (currentStatus === input.status) throw new ServiceError(400, `The claim is already ${input.status}.`)
    if (!isValidStatus(currentStatus)) throw new ServiceError(409, "The claim has an unsupported current status.")
    const transitionError = claimTransitionError(currentStatus, input.status)
    if (transitionError) throw new ServiceError(409, transitionError)
    if (input.status === "ready_for_claim") {
      const detail = await getClaim(db, scope, claimId)
      if (!detail.evidenceComplete) {
        throw new ServiceError(409, `Required evidence is missing: ${detail.missingEvidence.join(", ")}.`)
      }
    }

    await client.query("UPDATE claims SET status = $1, updated_at = now() WHERE id = $2", [input.status, claimId])

    await client.query(
      `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [claimId, currentStatus, input.status, reason, actor.id],
    )

    await auditClaimChange(client, actor.id, "claim.status_change", String(claimId), {
      from: currentStatus,
      to: input.status,
      reason,
    })

    await client.query("COMMIT")
    return { id: claimId, status: input.status }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Claim media: metadata storage and scoped retrieval
// ---------------------------------------------------------------------------------------------------------------

export async function addClaimMedia(
  db: pg.Pool,
  actor: Actor,
  scope: AccountScope,
  claimId: number,
  input: {
    fieldKey: string
    storageObjectPath: string
    contentHash: string
    sizeBytes: number
    mimeType: string
    originalFilename: string
    capturedAt: string | null
  },
): Promise<{ id: number }> {
  if (!input.fieldKey) throw new ServiceError(400, "A field key is required.")
  if (!input.storageObjectPath.trim()) throw new ServiceError(400, "A storage object path is required.")
  if (input.originalFilename.length > MAX_ORIGINAL_FILENAME) throw new ServiceError(400, `Filename must be ${MAX_ORIGINAL_FILENAME} characters or fewer.`)

  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const params: unknown[] = [claimId]
    const scopeCondition = accountCondition(scope, "c.marketplace_id", params)
    const claimResult = await client.query(`SELECT c.id FROM claims c WHERE c.id = $1 AND ${scopeCondition}`, params)
    if (!claimResult.rows[0]) throw new ServiceError(404, "Claim not found.")

    const result = await client.query<{ id: number }>(
      `INSERT INTO claim_media (claim_id, field_key, storage_object_path, content_hash, size_bytes, mime_type, original_filename, captured_at, uploaded_by, uploaded_at, is_active, retention_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), true, (current_date + INTERVAL '${RETENTION_MONTHS} months')::date)
       RETURNING id`,
      [
        claimId,
        input.fieldKey,
        input.storageObjectPath.trim(),
        input.contentHash,
        input.sizeBytes,
        input.mimeType,
        input.originalFilename,
        input.capturedAt || null,
        actor.id,
      ],
    )

    await auditClaimChange(client, actor.id, "claim.media_add", String(claimId), {
      fieldKey: input.fieldKey,
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
    })

    const readiness = await evidenceReadiness(client, claimId)
    if (readiness.complete) {
      const statusUpdate = await client.query(
        `UPDATE claims SET status = 'ready_for_claim', updated_at = now()
         WHERE id = $1 AND status = 'pending_evidence'
         RETURNING id`,
        [claimId],
      )
      if (statusUpdate.rows[0]) {
        await client.query(
          `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
           VALUES ($1, 'pending_evidence', 'ready_for_claim', 'All required evidence uploaded', $2)`,
          [claimId, actor.id],
        )
        await auditClaimChange(client, actor.id, "claim.status_change", String(claimId), {
          from: "pending_evidence",
          to: "ready_for_claim",
          reason: "All required evidence uploaded",
        })
      }
    }

    await client.query("COMMIT")
    return { id: result.rows[0].id }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function getClaimMediaMeta(
  db: pg.Pool,
  scope: AccountScope,
  claimId: number,
  mediaId: number,
): Promise<{ storageObjectPath: string; mimeType: string; sizeBytes: number; originalFilename: string }> {
  const params: unknown[] = [claimId, mediaId]
  const scopeCondition = accountCondition(scope, "c.marketplace_id", params)
  const result = await db.query(
    `SELECT cm.storage_object_path, cm.mime_type, cm.size_bytes, cm.original_filename
     FROM claim_media cm
     JOIN claims c ON c.id = cm.claim_id
     WHERE cm.claim_id = $1 AND cm.id = $2 AND cm.is_active = true AND ${scopeCondition}`,
    params,
  )
  if (!result.rows[0]) throw new ServiceError(404, "Media not found.")
  return {
    storageObjectPath: String(result.rows[0].storage_object_path),
    mimeType: String(result.rows[0].mime_type || "application/octet-stream"),
    sizeBytes: Number(result.rows[0].size_bytes || 0),
    originalFilename: String(result.rows[0].original_filename || "file"),
  }
}

export async function deactivateClaimMedia(
  db: pg.Pool,
  actor: Actor,
  scope: AccountScope,
  claimId: number,
  mediaId: number,
): Promise<void> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const params: unknown[] = [claimId, mediaId]
    const scopeCondition = accountCondition(scope, "c.marketplace_id", params)
    const result = await client.query(
      `UPDATE claim_media cm SET is_active = false
       FROM claims c
       WHERE cm.claim_id = $1 AND cm.id = $2 AND cm.is_active = true AND c.id = cm.claim_id AND ${scopeCondition}
       RETURNING cm.id`,
      params,
    )
    if (result.rows[0]) {
      await auditClaimChange(client, actor.id, "claim.media_deactivate", String(claimId), { mediaId })
      const readiness = await evidenceReadiness(client, claimId)
      if (!readiness.complete) {
        const statusUpdate = await client.query(
          `UPDATE claims SET status = 'pending_evidence', updated_at = now()
           WHERE id = $1 AND status = 'ready_for_claim'
           RETURNING id`,
          [claimId],
        )
        if (statusUpdate.rows[0]) {
          await client.query(
            `INSERT INTO claim_status_history (claim_id, from_status, to_status, reason, changed_by)
             VALUES ($1, 'ready_for_claim', 'pending_evidence', 'Required evidence was removed', $2)`,
            [claimId, actor.id],
          )
        }
      }
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

// Whether Firebase Storage is available for the evidence media. The route uses this to decide whether
// a download attempt can be made.
export function isEvidenceStorageConfigured(): boolean {
  return isFirebaseConfigured().configured
}

async function evidenceReadiness(
  client: pg.PoolClient,
  claimId: number,
): Promise<{ complete: boolean; missing: string[] }> {
  const result = await client.query(
    `SELECT f.field_label, f.min_count, COUNT(cm.id)::int AS uploaded_count
     FROM claims c
     JOIN claim_template_fields f ON f.template_id = c.claim_template_id
       AND f.is_active = true AND f.required = true
     LEFT JOIN claim_media cm ON cm.claim_id = c.id AND cm.field_key = f.field_key AND cm.is_active = true
     WHERE c.id = $1
     GROUP BY f.id, f.field_label, f.min_count
     ORDER BY f.sort_order, f.id`,
    [claimId],
  )
  const missing = result.rows
    .filter((row) => Number(row.uploaded_count) < Number(row.min_count))
    .map((row) => String(row.field_label))
  return { complete: result.rows.length > 0 && missing.length === 0, missing }
}

export type ClaimMediaUploadTarget = {
  duplicateMediaId: number | null
  objectPath: string
  fieldType: string
}

function safeStorageSegment(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return (cleaned || fallback).slice(0, 100)
}

export async function prepareClaimMediaUpload(
  db: pg.Pool,
  scope: AccountScope,
  claimId: number,
  input: { fieldKey: string; contentHash: string; mimeType: string; extension: string; sizeBytes: number },
): Promise<ClaimMediaUploadTarget> {
  const params: unknown[] = [claimId]
  const scopeCondition = accountCondition(scope, "c.marketplace_id", params)
  const result = await db.query(
    `SELECT c.id, c.status, c.claim_template_id, m.name AS marketplace, er.order_number,
            f.field_type, f.max_count, f.max_file_size_mb,
            (SELECT COUNT(*)::int FROM claim_media cm
             WHERE cm.claim_id = c.id AND cm.field_key = f.field_key AND cm.is_active = true) AS field_count,
            (SELECT cm.id FROM claim_media cm
             WHERE cm.claim_id = c.id AND cm.content_hash = $${params.length + 1} AND cm.is_active = true
             LIMIT 1) AS duplicate_media_id
     FROM claims c
     JOIN marketplaces m ON m.id = c.marketplace_id
     JOIN receipt_scans rs ON rs.id = c.receipt_scan_id
     JOIN expected_returns er ON er.id = rs.expected_return_id
     JOIN claim_template_fields f ON f.template_id = c.claim_template_id
       AND f.field_key = $${params.length + 2} AND f.is_active = true
     WHERE c.id = $1 AND ${scopeCondition}`,
    [...params, input.contentHash, input.fieldKey],
  )
  const row = result.rows[0]
  if (!row) throw new ServiceError(400, "Choose an active evidence field from this claim's template.")
  if (row.duplicate_media_id) {
    return { duplicateMediaId: Number(row.duplicate_media_id), objectPath: "", fieldType: String(row.field_type) }
  }
  if (Number(row.field_count) >= Number(row.max_count)) {
    throw new ServiceError(409, `This evidence field already has its maximum of ${row.max_count} file(s).`)
  }
  if (input.sizeBytes > Number(row.max_file_size_mb) * 1024 * 1024) {
    throw new ServiceError(400, `This evidence field allows files up to ${row.max_file_size_mb} MB.`)
  }
  const fieldType = String(row.field_type)
  const mimeMatches =
    (fieldType === "image" && input.mimeType.startsWith("image/")) ||
    (fieldType === "video" && input.mimeType.startsWith("video/")) ||
    (fieldType === "document" && (input.mimeType === "application/pdf" || input.mimeType.startsWith("image/")))
  if (!mimeMatches) throw new ServiceError(400, `Upload a valid ${fieldType} file for this evidence field.`)

  const objectPath = [
    "claim-evidence",
    safeStorageSegment(String(row.marketplace), "marketplace"),
    safeStorageSegment(String(row.order_number), "no-order"),
    `claim-${claimId}`,
    `${safeStorageSegment(input.fieldKey, "evidence")}-${input.contentHash.slice(0, 20)}${input.extension}`,
  ].join("/")
  return { duplicateMediaId: null, objectPath, fieldType }
}
