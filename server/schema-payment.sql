-- Additive schema for Payment/Sales Database integration.
-- Safe to re-run on every startup. Never drops tables or columns.
-- Conforms to AGENTS.md Invariants 3, 6, 8.

-- Ensure sales_amount and audit tracking columns exist on return lines
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS sales_amount numeric(14,2);
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS payment_synced_at timestamptz;
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS payment_source text NOT NULL DEFAULT '';

ALTER TABLE receipt_scan_items ADD COLUMN IF NOT EXISTS sales_amount numeric(14,2);
ALTER TABLE receipt_scan_items ADD COLUMN IF NOT EXISTS payment_synced_at timestamptz;
ALTER TABLE receipt_scan_items ADD COLUMN IF NOT EXISTS payment_source text NOT NULL DEFAULT '';

-- Audit log for automated cron and manual payment/sales sync runs
CREATE TABLE IF NOT EXISTS payment_sync_runs (
  id serial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  trigger_type text NOT NULL DEFAULT 'cron' CHECK (trigger_type IN ('cron', 'manual', 'script', 'interval')),
  scans_checked integer NOT NULL DEFAULT 0,
  scans_matched integer NOT NULL DEFAULT 0,
  scans_updated integer NOT NULL DEFAULT 0,
  total_amount_synced numeric(14,2) NOT NULL DEFAULT 0,
  error_message text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for performance: quick queries for unsynced scans and recent runs
CREATE INDEX IF NOT EXISTS payment_sync_runs_created_idx ON payment_sync_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS receipt_scan_items_unpaid_idx ON receipt_scan_items (id) WHERE sales_amount IS NULL;
CREATE INDEX IF NOT EXISTS expected_return_items_unpaid_idx ON expected_return_items (id) WHERE sales_amount IS NULL;
