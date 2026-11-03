-- AI Center additive tables (M6). Additive only: IF NOT EXISTS, no drops.
-- Existing ai_memory_procedures / ai_memory_events / operator_tasks untouched.

CREATE TABLE IF NOT EXISTS ai_provider_usage (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL DEFAULT '',
  ok BOOLEAN NOT NULL DEFAULT TRUE,
  error_category TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  estimated_usd NUMERIC,
  pricing_provenance TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_provider_usage_created_idx
  ON ai_provider_usage (created_at);

CREATE INDEX IF NOT EXISTS ai_provider_usage_provider_idx
  ON ai_provider_usage (provider);

CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id SERIAL PRIMARY KEY,
  claim_id INTEGER NOT NULL DEFAULT 0,
  marketplace TEXT NOT NULL DEFAULT '',
  agent_function TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '',
  memory_hit BOOLEAN NOT NULL DEFAULT FALSE,
  result TEXT NOT NULL DEFAULT '',
  error_category TEXT NOT NULL DEFAULT '',
  fallback BOOLEAN NOT NULL DEFAULT FALSE,
  approval TEXT NOT NULL DEFAULT 'none-required',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_runs_approval_check
    CHECK (approval IN ('none-required', 'pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS ai_agent_runs_claim_idx
  ON ai_agent_runs (claim_id);

CREATE INDEX IF NOT EXISTS ai_agent_runs_created_idx
  ON ai_agent_runs (created_at);

-- Procedure versioning + learning confidence (additive columns only).
ALTER TABLE ai_memory_procedures
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_memory_procedures
  ADD COLUMN IF NOT EXISTS confidence NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE ai_memory_procedures
  ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
