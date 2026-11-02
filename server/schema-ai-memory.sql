-- AI operational memory (Milestone 1: approved recovery procedures + execution history).
--
-- Authoritative shared memory lives here in PostgreSQL. The desktop engine keeps
-- only execution state, safe cache data, and crash-recovery state locally
-- (AGENT_DATA_DIR/ai-memory.json); it never treats local cache as truth.
--
-- Rules:
-- - Only `approved` procedures may drive the worker without a new AI call.
-- - AI suggestions land as `pending` and need operator approval first.
-- - A `disabled` procedure is never matched; history is kept, never deleted.
-- - All statements are additive and idempotent (IF NOT EXISTS / ON CONFLICT).

CREATE TABLE IF NOT EXISTS ai_memory_procedures (
  id SERIAL PRIMARY KEY,
  marketplace TEXT NOT NULL DEFAULT '',
  error_signature TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'operator',
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_memory_procedures_status_check CHECK (status IN ('pending', 'approved', 'disabled')),
  CONSTRAINT ai_memory_procedures_source_check CHECK (source IN ('operator', 'ai-suggestion', 'worker'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_memory_procedures_marketplace_signature_idx
  ON ai_memory_procedures (marketplace, error_signature);

CREATE INDEX IF NOT EXISTS ai_memory_procedures_status_idx
  ON ai_memory_procedures (status);

CREATE TABLE IF NOT EXISTS ai_memory_events (
  id SERIAL PRIMARY KEY,
  claim_id INTEGER NOT NULL DEFAULT 0,
  marketplace TEXT NOT NULL DEFAULT '',
  step TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  procedure_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_memory_events_outcome_check
    CHECK (outcome IN ('success', 'failure', 'ai_proposal', 'human_review', 'memory_hit'))
);

CREATE INDEX IF NOT EXISTS ai_memory_events_claim_idx
  ON ai_memory_events (claim_id);

CREATE INDEX IF NOT EXISTS ai_memory_events_created_idx
  ON ai_memory_events (created_at);
