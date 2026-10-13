-- Additive schema for Shopify real-time return and RTO ingestion.
-- Safe to re-run on every startup. Never drops tables or columns.

-- Tracking fields on expected_returns for Shopify orders and returns
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS shopify_order_id text;
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS shopify_return_id text;
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS shopify_order_name text;
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS customer_city text;
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS customer_phone text;
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS shopify_synced_at timestamptz;

-- Audit log for automated and manual Shopify sync runs
CREATE TABLE IF NOT EXISTS shopify_sync_runs (
  id serial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  returns_synced integer NOT NULL DEFAULT 0,
  rtos_synced integer NOT NULL DEFAULT 0,
  total_active integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shopify_sync_runs_created_idx ON shopify_sync_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS expected_returns_shopify_order_idx ON expected_returns (shopify_order_name);
