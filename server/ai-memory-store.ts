import type pg from "pg"
import { accountCondition, type AccountScope } from "./access.js"
import { ServiceError } from "./register-service.js"
import {
  isUsableProcedure,
  normalizeErrorSignature,
  procedureTransition,
  type MemoryProcedure,
  type ProcedureStatus,
  type ProcedureTransition,
} from "./ai-memory.js"

/**
 * Authoritative memory store: PostgreSQL CRUD for approved recovery
 * procedures (`ai_memory_procedures`, created in Milestone 1).
 *
 * Rules enforced here, not just in the UI:
 * - New rows always enter as `pending`, whatever the caller asked for. Only
 *   an explicit approve transition makes a procedure usable by the worker.
 * - `procedureTransition` from `ai-memory.ts` is the only allowed status
 *   change (pure, tested).
 * - Correcting a procedure's content re-queues it to `pending`: an edited
 *   fix must be re-approved before the worker trusts it again.
 * - `normalizeErrorSignature` runs on write so lookups match deterministically.
 * - Nothing is deleted. `disable` is the off switch; history stays.
 */

export type ProcedureRow = {
  id: number
  marketplace: string
  errorSignature: string
  title: string
  steps: string[]
  status: ProcedureStatus
  source: string
  successCount: number
  failureCount: number
  approvedBy: string
  createdAt: string
  updatedAt: string
}

function rowOf(r: Record<string, unknown>): ProcedureRow {
  return {
    id: Number(r.id),
    marketplace: String(r.marketplace || ""),
    errorSignature: String(r.error_signature || ""),
    title: String(r.title || ""),
    steps: Array.isArray(r.steps) ? (r.steps as unknown[]).map(String) : [],
    status: String(r.status || "pending") as ProcedureStatus,
    source: String(r.source || ""),
    successCount: Number(r.success_count || 0),
    failureCount: Number(r.failure_count || 0),
    approvedBy: String(r.approved_by || ""),
    createdAt: String(r.created_at || ""),
    updatedAt: String(r.updated_at || ""),
  }
}

const PROCEDURE_COLUMNS = `id, marketplace, error_signature, title, steps, status, source,
  success_count, failure_count, approved_by, created_at, updated_at`

export async function listProcedures(db: pg.Pool, filter: { status?: string; marketplace?: string } = {}): Promise<ProcedureRow[]> {
  const params: unknown[] = []
  const conditions: string[] = []
  if (filter.status) {
    params.push(String(filter.status))
    conditions.push(`status = $${params.length}`)
  }
  if (filter.marketplace) {
    params.push(String(filter.marketplace).trim().toLowerCase())
    conditions.push(`lower(marketplace) = $${params.length}`)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
  const res = await db.query(`SELECT ${PROCEDURE_COLUMNS} FROM ai_memory_procedures ${where} ORDER BY updated_at DESC LIMIT 200`, params)
  return res.rows.map(rowOf)
}

/**
 * Procedures synced to one automation agent: approved plus disabled, limited
 * to the marketplaces in its account scope. The worker matches approved
 * entries only; disabled entries let the local mirror drop procedures that
 * were switched off server-side. Pending suggestions never leave the server.
 * Steps carry operational text only — never credentials — but scope still
 * applies: a panel must never see another account's procedures.
 */
export async function listSyncedProceduresForAgent(db: pg.Pool, scope: AccountScope): Promise<ProcedureRow[]> {
  const params: unknown[] = []
  const scopeCondition = accountCondition(scope, "m.id", params)
  const res = await db.query(
    `SELECT p.${PROCEDURE_COLUMNS.replace(/, /g, ", p.")}
     FROM ai_memory_procedures p
     JOIN marketplaces m ON lower(m.name) = lower(p.marketplace)
     WHERE p.status IN ('approved', 'disabled') AND ${scopeCondition}
     ORDER BY p.updated_at DESC LIMIT 200`,
    params,
  )
  return res.rows.map(rowOf)
}

export async function createProcedure(
  db: pg.Pool,
  input: { marketplace: string; errorSignature: string; title: string; steps: string[]; source?: string; actor?: string },
): Promise<ProcedureRow> {
  const marketplace = String(input.marketplace || "").trim()
  const title = String(input.title || "").trim()
  const steps = (Array.isArray(input.steps) ? input.steps : []).map((s) => String(s || "").trim()).filter(Boolean)
  if (!marketplace) throw new ServiceError(400, "A marketplace is required.")
  if (!title) throw new ServiceError(400, "A title is required.")
  if (steps.length === 0) throw new ServiceError(400, "At least one recovery step is required.")
  const signature = normalizeErrorSignature(String(input.errorSignature || title))
  if (!signature || signature === "unknown-error") throw new ServiceError(400, "The error signature is empty.")
  const source = input.source === "ai-suggestion" || input.source === "worker" ? input.source : "operator"
  const res = await db.query(
    `INSERT INTO ai_memory_procedures (marketplace, error_signature, title, steps, status, source, approved_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, 'pending', $5, $6, now(), now())
     ON CONFLICT (marketplace, error_signature) DO UPDATE
       SET title = EXCLUDED.title, steps = EXCLUDED.steps, status = 'pending',
           source = EXCLUDED.source, approved_by = '', updated_at = now()
     RETURNING ${PROCEDURE_COLUMNS}`,
    [marketplace, signature, title, JSON.stringify(steps), source, String(input.actor || "")],
  )
  return rowOf(res.rows[0])
}

export async function transitionProcedure(
  db: pg.Pool,
  id: number,
  action: ProcedureTransition,
  actor: string,
): Promise<ProcedureRow> {
  if (!Number.isInteger(id) || id <= 0) throw new ServiceError(404, "Procedure not found.")
  const current = await db.query(`SELECT ${PROCEDURE_COLUMNS} FROM ai_memory_procedures WHERE id = $1`, [id])
  if (!current.rows[0]) throw new ServiceError(404, "Procedure not found.")
  const from = String(current.rows[0].status) as ProcedureStatus
  const next = procedureTransition(from, action)
  if (!next) throw new ServiceError(400, `Cannot ${action} a ${from} procedure.`)
  const approvedBy = next === "approved" ? String(actor || "") : next === "disabled" ? String(actor || "") : ""
  const res = await db.query(
    `UPDATE ai_memory_procedures SET status = $2, approved_by = $3, updated_at = now() WHERE id = $1
     RETURNING ${PROCEDURE_COLUMNS}`,
    [id, next, approvedBy],
  )
  return rowOf(res.rows[0])
}

/**
 * Correct a procedure's content. Any content change re-queues an approved
 * procedure to `pending` — the worker must not run an edited fix until a
 * human re-approves it. Corrections that change nothing keep the status.
 */
export async function correctProcedure(
  db: pg.Pool,
  id: number,
  patch: { title?: string; steps?: string[]; errorSignature?: string; marketplace?: string },
): Promise<ProcedureRow> {
  if (!Number.isInteger(id) || id <= 0) throw new ServiceError(404, "Procedure not found.")
  const current = await db.query(`SELECT ${PROCEDURE_COLUMNS} FROM ai_memory_procedures WHERE id = $1`, [id])
  const row = current.rows[0]
  if (!row) throw new ServiceError(404, "Procedure not found.")
  const existing = rowOf(row)
  const title = patch.title === undefined ? existing.title : String(patch.title).trim()
  const steps = patch.steps === undefined ? existing.steps : patch.steps.map((s) => String(s || "").trim()).filter(Boolean)
  const marketplace = patch.marketplace === undefined ? existing.marketplace : String(patch.marketplace).trim()
  const signature = patch.errorSignature === undefined ? existing.errorSignature : normalizeErrorSignature(patch.errorSignature)
  if (!title) throw new ServiceError(400, "A title is required.")
  if (steps.length === 0) throw new ServiceError(400, "At least one recovery step is required.")
  if (!marketplace) throw new ServiceError(400, "A marketplace is required.")
  if (!signature || signature === "unknown-error") throw new ServiceError(400, "The error signature is empty.")
  const changed =
    title !== existing.title ||
    JSON.stringify(steps) !== JSON.stringify(existing.steps) ||
    marketplace !== existing.marketplace ||
    signature !== existing.errorSignature
  const nextStatus: ProcedureStatus = changed && existing.status === "approved" ? "pending" : existing.status
  const res = await db.query(
    `UPDATE ai_memory_procedures
     SET marketplace = $2, error_signature = $3, title = $4, steps = $5::jsonb, status = $6, approved_by = CASE WHEN $6 = 'approved' THEN approved_by ELSE '' END, updated_at = now()
     WHERE id = $1 RETURNING ${PROCEDURE_COLUMNS}`,
    [id, marketplace, signature, title, JSON.stringify(steps), nextStatus],
  )
  return rowOf(res.rows[0])
}

export function toMemoryProcedure(row: ProcedureRow): MemoryProcedure {
  return {
    id: row.id,
    marketplace: row.marketplace,
    errorSignature: row.errorSignature,
    title: row.title,
    steps: row.steps,
    status: row.status,
    source: (row.source === "ai-suggestion" || row.source === "worker" ? row.source : "operator") as MemoryProcedure["source"],
  }
}

export { isUsableProcedure }
