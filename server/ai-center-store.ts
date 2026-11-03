import type pg from "pg"

/**
 * AI Center PostgreSQL store (M6, additive).
 *
 * New tables only (`ai_provider_usage`, `ai_agent_runs`); the authoritative
 * memory tables (`ai_memory_procedures`, `ai_memory_events`,
 * `operator_tasks`) are untouched here. Version/confidence columns on
 * `ai_memory_procedures` are filled by the additive migration
 * `schema-ai-center.sql`; the two helpers below are the only writers, and
 * both keep the pending → approved workflow intact (verification only ever
 * raises confidence on approved rows, never flips status).
 */

export type UsageInsert = {
  provider: string
  model: string
  task: string
  ok: boolean
  errorCategory: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
  latencyMs: number
  estimatedUsd: number | null
  pricingProvenance: string
}

export type AgentRunInsert = {
  claimId: number
  marketplace: string
  agentFunction: string
  provider: string
  model: string
  stage: string
  memoryHit: boolean
  result: string
  errorCategory: string
  fallback: boolean
  approval: string
}

const USAGE_COLUMNS = `provider, model, task, ok, error_category, input_tokens, output_tokens,
  cached_tokens, reasoning_tokens, latency_ms, estimated_usd, pricing_provenance`

export async function recordProviderUsage(db: pg.Pool, row: UsageInsert): Promise<void> {
  await db.query(
    `INSERT INTO ai_provider_usage (${USAGE_COLUMNS}) VALUES
     ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      row.provider.slice(0, 40),
      row.model.slice(0, 120),
      row.task.slice(0, 40),
      row.ok,
      row.errorCategory.slice(0, 40),
      Math.max(0, Math.floor(row.inputTokens) || 0),
      Math.max(0, Math.floor(row.outputTokens) || 0),
      Math.max(0, Math.floor(row.cachedTokens) || 0),
      Math.max(0, Math.floor(row.reasoningTokens) || 0),
      Math.max(0, Math.floor(row.latencyMs) || 0),
      row.estimatedUsd,
      row.pricingProvenance.slice(0, 300),
    ],
  )
}

export async function listProviderUsage(
  db: pg.Pool,
  filter: { provider?: string; from?: string; to?: string; limit?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const params: unknown[] = []
  const conditions: string[] = []
  if (filter.provider) {
    params.push(String(filter.provider))
    conditions.push(`provider = $${params.length}`)
  }
  if (filter.from) {
    params.push(String(filter.from))
    conditions.push(`created_at >= $${params.length}::timestamptz`)
  }
  if (filter.to) {
    params.push(String(filter.to))
    conditions.push(`created_at < $${params.length}::timestamptz`)
  }
  const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 200) || 200))
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
  const res = await db.query(`SELECT * FROM ai_provider_usage ${where} ORDER BY created_at DESC LIMIT ${limit}`, params)
  return res.rows
}

export async function recordAgentRun(db: pg.Pool, row: AgentRunInsert): Promise<void> {
  const approval = ["none-required", "pending", "approved", "rejected"].includes(row.approval) ? row.approval : "none-required"
  await db.query(
    `INSERT INTO ai_agent_runs (claim_id, marketplace, agent_function, provider, model, stage,
      memory_hit, result, error_category, fallback, approval)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      Math.floor(row.claimId) || 0,
      row.marketplace.slice(0, 80),
      row.agentFunction.slice(0, 80),
      row.provider.slice(0, 40),
      row.model.slice(0, 120),
      row.stage.slice(0, 40),
      row.memoryHit,
      row.result.slice(0, 500),
      row.errorCategory.slice(0, 40),
      row.fallback,
      approval,
    ],
  )
}

export async function listAgentRuns(db: pg.Pool, limit = 100): Promise<Array<Record<string, unknown>>> {
  const capped = Math.max(1, Math.min(200, Math.floor(limit) || 100))
  const res = await db.query(`SELECT * FROM ai_agent_runs ORDER BY created_at DESC LIMIT ${capped}`)
  return res.rows
}

/** Operational learning: verified success/failure only adjusts confidence on approved rows. */
export async function recordProcedureOutcome(db: pg.Pool, procedureId: number, success: boolean): Promise<void> {
  const id = Math.floor(procedureId)
  if (!id) return
  await db.query(
    `UPDATE ai_memory_procedures
     SET success_count = success_count + CASE WHEN $2 THEN 1 ELSE 0 END,
         failure_count = failure_count + CASE WHEN $2 THEN 0 ELSE 1 END,
         confidence = LEAST(1, GREATEST(0, confidence + CASE WHEN $2 THEN 0.05 ELSE -0.1 END)),
         last_verified_at = now(),
         version = version + 1,
         updated_at = now()
     WHERE id = $1 AND status = 'approved'`,
    [id, success],
  )
}
