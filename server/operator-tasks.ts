import type pg from "pg"
import { accountCondition, type AccountScope } from "./access.js"
import { ServiceError } from "./register-service.js"

/**
 * Operator task center (`operator_tasks`, created in Milestone 3).
 *
 * Tasks are the human side of the worker loop: missing evidence, pending
 * approvals, claim rejections, tracking failures, expired panel sessions,
 * required operator actions, and overdue claim work. Every task has a
 * source claim (when there is one), an owner/status, and an action history
 * with a clear resolution note. Resolving flips the status; history is kept.
 *
 * Scoping: both listing and creation resolve the task to the account scope.
 * Creation verifies the claim (or the named marketplace) belongs to the
 * caller's scope before anything is written.
 */

export const TASK_KINDS = [
  "missing_evidence",
  "pending_approval",
  "claim_rejection",
  "tracking_failure",
  "expired_session",
  "operator_action",
  "overdue_work",
] as const

export type TaskKind = (typeof TASK_KINDS)[number]
export type TaskStatus = "open" | "resolved"

export type OperatorTaskRow = {
  id: number
  claimId: number
  marketplaceId: number
  marketplace: string
  kind: TaskKind
  title: string
  note: string
  status: TaskStatus
  owner: string
  source: string
  history: Array<{ at: string; by: string; note: string }>
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

function rowOf(r: Record<string, unknown>): OperatorTaskRow {
  const history = Array.isArray(r.history)
    ? (r.history as unknown[]).map((h) => {
        const entry = (h || {}) as Record<string, unknown>
        return { at: String(entry.at || ""), by: String(entry.by || ""), note: String(entry.note || "") }
      })
    : []
  return {
    id: Number(r.id),
    claimId: Number(r.claim_id || 0),
    marketplaceId: Number(r.marketplace_id || 0),
    marketplace: String(r.marketplace || ""),
    kind: String(r.kind || "operator_action") as TaskKind,
    title: String(r.title || ""),
    note: String(r.note || ""),
    status: String(r.status || "open") as TaskStatus,
    owner: String(r.owner || ""),
    source: String(r.source || ""),
    history,
    createdAt: String(r.created_at || ""),
    updatedAt: String(r.updated_at || ""),
    resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
  }
}

const TASK_COLUMNS = `id, claim_id, marketplace_id, marketplace, kind, title, note, status,
  owner, source, history, created_at, updated_at, resolved_at`

async function marketplaceIdFor(db: pg.Pool, marketplace: string): Promise<number> {
  const name = String(marketplace || "").trim()
  if (!name) return 0
  const res = await db.query(`SELECT id FROM marketplaces WHERE lower(name) = lower($1) LIMIT 1`, [name])
  return res.rows[0] ? Number(res.rows[0].id) : 0
}

/** Resolve a task's marketplace to an id the caller can see, or throw. */
async function scopedMarketplace(
  db: pg.Pool,
  scope: AccountScope,
  input: { claimId: number; marketplace: string },
): Promise<{ marketplaceId: number; marketplace: string }> {
  const claimId = Number(input.claimId) || 0
  const marketplace = String(input.marketplace || "").trim()
  const params: unknown[] = [claimId]
  const condition = accountCondition(scope, "c.marketplace_id", params)
  if (claimId > 0) {
    const res = await db.query(
      `SELECT c.marketplace_id AS id, COALESCE(m.name, '') AS name
       FROM claims c LEFT JOIN marketplaces m ON m.id = c.marketplace_id
       WHERE c.id = $1 AND ${condition} LIMIT 1`,
      params,
    )
    if (!res.rows[0]) throw new ServiceError(404, "Claim not found in scope.")
    return { marketplaceId: Number(res.rows[0].id || 0), marketplace: String(res.rows[0].name || marketplace) }
  }
  const marketplaceId = await marketplaceIdFor(db, marketplace)
  if (!marketplace) throw new ServiceError(400, "A marketplace or claim is required.")
  const checkParams: unknown[] = [marketplaceId]
  const checkCondition = accountCondition(scope, "m.id", checkParams)
  const check = await db.query(`SELECT 1 FROM marketplaces m WHERE m.id = $1 AND ${checkCondition} LIMIT 1`, checkParams)
  if (!check.rows[0]) throw new ServiceError(404, "Marketplace not found in scope.")
  return { marketplaceId, marketplace }
}

export async function createTask(
  db: pg.Pool,
  scope: AccountScope,
  input: { claimId?: number; marketplace?: string; kind: string; title: string; note?: string; owner?: string; source?: string },
): Promise<OperatorTaskRow> {
  const kind = String(input.kind || "") as TaskKind
  if (!(TASK_KINDS as readonly string[]).includes(kind)) {
    throw new ServiceError(400, `Unknown task kind. Expected one of: ${TASK_KINDS.join(", ")}.`)
  }
  const title = String(input.title || "").trim().slice(0, 300)
  if (!title) throw new ServiceError(400, "A title is required.")
  const scoped = await scopedMarketplace(db, scope, {
    claimId: Number(input.claimId) || 0,
    marketplace: String(input.marketplace || ""),
  })
  const note = String(input.note || "").trim().slice(0, 2000)
  const owner = String(input.owner || "").trim().slice(0, 120)
  const source = input.source === "operator" ? "operator" : "worker"
  const history = JSON.stringify([{ at: new Date().toISOString(), by: source, note: note || title }])
  const res = await db.query(
    `INSERT INTO operator_tasks (claim_id, marketplace_id, marketplace, kind, title, note, status, owner, source, history, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9::jsonb, now(), now())
     RETURNING ${TASK_COLUMNS}`,
    [Number(input.claimId) || 0, scoped.marketplaceId, scoped.marketplace, kind, title, note, owner, source, history],
  )
  return rowOf(res.rows[0])
}

export async function listTasks(
  db: pg.Pool,
  scope: AccountScope,
  filter: { status?: string } = {},
): Promise<OperatorTaskRow[]> {
  const params: unknown[] = []
  const condition = accountCondition(scope, "t.marketplace_id", params)
  const conditions = [condition]
  if (filter.status === "open" || filter.status === "resolved") {
    params.push(filter.status)
    conditions.push(`t.status = $${params.length}`)
  }
  const res = await db.query(
    `SELECT ${TASK_COLUMNS.replace(/, /g, ", t.")} FROM operator_tasks t
     WHERE ${conditions.join(" AND ")} ORDER BY t.created_at DESC LIMIT 200`,
    params,
  )
  return res.rows.map(rowOf)
}

export async function resolveTask(
  db: pg.Pool,
  scope: AccountScope,
  id: number,
  actor: string,
  resolution: string,
): Promise<OperatorTaskRow> {
  if (!Number.isInteger(id) || id <= 0) throw new ServiceError(404, "Task not found.")
  const note = String(resolution || "").trim().slice(0, 2000)
  if (!note) throw new ServiceError(400, "A resolution note is required.")
  const params: unknown[] = [id]
  const condition = accountCondition(scope, "t.marketplace_id", params)
  const current = await db.query(`SELECT ${TASK_COLUMNS.replace(/, /g, ", t.")} FROM operator_tasks t WHERE t.id = $1 AND ${condition}`, params)
  if (!current.rows[0]) throw new ServiceError(404, "Task not found in scope.")
  const task = rowOf(current.rows[0])
  if (task.status === "resolved") throw new ServiceError(400, "Task is already resolved.")
  const history = [...task.history, { at: new Date().toISOString(), by: String(actor || "operator"), note }]
  const res = await db.query(
    `UPDATE operator_tasks SET status = 'resolved', history = $2::jsonb, updated_at = now(), resolved_at = now()
     WHERE id = $1 RETURNING ${TASK_COLUMNS}`,
    [id, JSON.stringify(history)],
  )
  return rowOf(res.rows[0])
}
