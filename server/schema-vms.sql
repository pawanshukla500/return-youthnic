-- VMS catalogue sync run log (read-only VMS source, local product_master target).
--
-- Each daily catalogue sync writes one row here: what was read from VMS and
-- what was filled locally. No user reference: the script runs unattended.
-- Additive only. Safe to re-run. Never drop this table.
CREATE TABLE IF NOT EXISTS vms_catalog_sync_runs (
  id serial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  vms_rows integer NOT NULL DEFAULT 0,
  matched_listings integer NOT NULL DEFAULT 0,
  images_filled integer NOT NULL DEFAULT 0,
  vms_only integer NOT NULL DEFAULT 0,
  error text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS vms_catalog_sync_runs_started_idx
  ON vms_catalog_sync_runs (started_at DESC);
