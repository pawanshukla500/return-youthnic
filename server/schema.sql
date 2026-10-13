-- Relational model for the returns workspace.
-- initDatabase drops the prototype tables only when that old shape is still present
-- (or schema_migrations is behind). A normal restart does not drop these tables.
--
-- Access rule: users.has_all_marketplaces = true means no user_marketplaces rows
-- and the API formats the assignment as "All marketplaces". false means the
-- assignment is exactly the user_marketplaces set, formatted in marketplace sort order.
--
-- Figures on the dashboard, claims, reports and scan screens are computed from receipt_scans,
-- expected_returns, claim_tickets and marketplaces. Nothing is seeded or typed in.
--
-- The snapshot tables below (report_periods, daily_return_stats, return_reason_stats,
-- marketplace_issue_stats, sku_risk_stats, claim_marketplace_stats, claim_status_stats,
-- dashboard_headline, scan_shift, ui_settings) are no longer read or written by the app.
-- They stay so existing databases keep their rows. Drop them only with the user's approval.

CREATE TABLE IF NOT EXISTS marketplaces (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  status text NOT NULL,
  last_synced_label text NOT NULL,
  sort_order integer NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  initials text NOT NULL,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  login_alias text UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL,
  sidebar_label text NOT NULL,
  has_all_marketplaces boolean NOT NULL DEFAULT false,
  -- Not read by the app. Scans today and the last sign-in are computed from receipt_scans and sessions.
  scans_today text NOT NULL DEFAULT '—',
  status text NOT NULL DEFAULT 'Active',
  last_active_label text NOT NULL DEFAULT 'Now'
);

CREATE TABLE IF NOT EXISTS user_marketplaces (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  marketplace_id integer NOT NULL REFERENCES marketplaces(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, marketplace_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS couriers (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS skus (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  color_name text NOT NULL,
  color_hex text NOT NULL,
  key_detail text NOT NULL,
  brand_label text NOT NULL,
  set_contents text NOT NULL,
  image_url text NOT NULL,
  -- Empty until a real badge is recorded. The scan screen hides an empty badge.
  brand_badge text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS upload_batches (
  id serial PRIMARY KEY,
  filename text NOT NULL,
  marketplace_id integer NOT NULL REFERENCES marketplaces(id),
  row_count integer NOT NULL CHECK (row_count >= 0),
  status text NOT NULL,
  uploaded_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expected_returns (
  id serial PRIMARY KEY,
  tracking_id text NOT NULL UNIQUE,
  marketplace_id integer NOT NULL REFERENCES marketplaces(id),
  order_number text NOT NULL,
  courier_id integer NOT NULL REFERENCES couriers(id),
  return_type text NOT NULL,
  matched_from text NOT NULL,
  -- Shipment title shown on the scan screen. Null falls back to the primary SKU name.
  product_title text,
  upload_batch_id integer REFERENCES upload_batches(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expected_return_items (
  id serial PRIMARY KEY,
  expected_return_id integer NOT NULL REFERENCES expected_returns(id) ON DELETE CASCADE,
  sku_id integer NOT NULL REFERENCES skus(id),
  qty integer NOT NULL CHECK (qty > 0),
  sort_order integer NOT NULL,
  -- Operator-facing line label. It can differ from skus.name (size suffix, free size).
  label text NOT NULL,
  UNIQUE (expected_return_id, sku_id)
);

CREATE TABLE IF NOT EXISTS receipt_scans (
  id serial PRIMARY KEY,
  expected_return_id integer NOT NULL UNIQUE REFERENCES expected_returns(id),
  scanned_by integer NOT NULL REFERENCES users(id),
  scanned_at timestamptz NOT NULL DEFAULT now(),
  scanned_time_label text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('clear', 'issue')),
  issue_label text NOT NULL,
  status text NOT NULL CHECK (status IN ('Clear', 'Draft', 'Raised', 'Approved', 'Review')),
  notes text
);

CREATE TABLE IF NOT EXISTS claim_tickets (
  id serial PRIMARY KEY,
  receipt_scan_id integer NOT NULL UNIQUE REFERENCES receipt_scans(id) ON DELETE CASCADE,
  ticket_code text NOT NULL UNIQUE,
  status text NOT NULL
);

CREATE TABLE IF NOT EXISTS missing_component_options (
  id serial PRIMARY KEY,
  label text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_events (
  id serial PRIMARY KEY,
  receipt_scan_id integer NOT NULL REFERENCES receipt_scans(id) ON DELETE CASCADE,
  photo_count integer NOT NULL DEFAULT 0 CHECK (photo_count >= 0),
  has_video boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Snapshot table. Not read or written by the app (see the note at the top).
CREATE TABLE IF NOT EXISTS daily_return_stats (
  stat_date date PRIMARY KEY,
  received_count integer NOT NULL CHECK (received_count >= 0),
  issue_count integer NOT NULL CHECK (issue_count >= 0)
);

-- Snapshot table. Not read or written by the app (see the note at the top).
CREATE TABLE IF NOT EXISTS return_reason_stats (
  id serial PRIMARY KEY,
  reason text NOT NULL UNIQUE,
  reason_count integer NOT NULL CHECK (reason_count >= 0),
  bar_width integer NOT NULL CHECK (bar_width BETWEEN 0 AND 100),
  sort_order integer NOT NULL
);

-- Snapshot table. Not read or written by the app (see the note at the top).
-- "Myntra" combined Myntra VB and Myntra EJ, so this name is intentionally not a foreign key to marketplaces.
CREATE TABLE IF NOT EXISTS marketplace_issue_stats (
  id serial PRIMARY KEY,
  marketplace_name text NOT NULL UNIQUE,
  issue_count integer NOT NULL CHECK (issue_count >= 0),
  pct_label text NOT NULL,
  sort_order integer NOT NULL
);

-- Snapshot table. Not read or written by the app (see the note at the top).
CREATE TABLE IF NOT EXISTS sku_risk_stats (
  sku_id integer PRIMARY KEY REFERENCES skus(id),
  issue_count integer NOT NULL CHECK (issue_count >= 0),
  rate_label text NOT NULL,
  sort_order integer NOT NULL
);

-- Snapshot table. Not read or written by the app (see the note at the top).
CREATE TABLE IF NOT EXISTS claim_marketplace_stats (
  marketplace_id integer PRIMARY KEY REFERENCES marketplaces(id),
  raised_count integer NOT NULL CHECK (raised_count >= 0),
  approved_count integer NOT NULL CHECK (approved_count >= 0),
  review_count integer NOT NULL CHECK (review_count >= 0),
  rejected_count integer NOT NULL CHECK (rejected_count >= 0),
  value_label text NOT NULL,
  approval_rate integer NOT NULL CHECK (approval_rate BETWEEN 0 AND 100)
);

-- Snapshot table. Not read or written by the app (see the note at the top).
CREATE TABLE IF NOT EXISTS claim_status_stats (
  status_name text PRIMARY KEY,
  claim_count integer NOT NULL CHECK (claim_count >= 0),
  pct_label text NOT NULL,
  tone text NOT NULL,
  sort_order integer NOT NULL
);

-- Snapshot table. Not read or written by the app (see the note at the top).
CREATE TABLE IF NOT EXISTS dashboard_headline (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  received_count integer NOT NULL,
  received_delta text NOT NULL,
  issue_delta text NOT NULL,
  claims_raised integer NOT NULL,
  claims_delta text NOT NULL,
  scan_accuracy_label text NOT NULL,
  scan_accuracy_note text NOT NULL,
  daily_avg integer NOT NULL
);

-- Snapshot table. Not read or written by the app (see the note at the top).
CREATE TABLE IF NOT EXISTS report_periods (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  range_label text NOT NULL,
  total_returns integer NOT NULL CHECK (total_returns >= 0),
  with_issues integer NOT NULL CHECK (with_issues >= 0),
  claim_value_label text NOT NULL,
  recovered_label text NOT NULL,
  month_label text NOT NULL,
  claims_week_delta text NOT NULL,
  claim_value_note text NOT NULL,
  recovered_amount_label text NOT NULL,
  recovered_delta text NOT NULL,
  approval_rate_label text NOT NULL,
  approval_note text NOT NULL
);

-- Snapshot table. Not read or written by the app (see the note at the top).
CREATE TABLE IF NOT EXISTS scan_shift (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  scanned integer NOT NULL CHECK (scanned >= 0),
  correct_count integer NOT NULL CHECK (correct_count >= 0),
  issue_count integer NOT NULL CHECK (issue_count >= 0),
  accuracy_label text NOT NULL,
  target_count integer NOT NULL CHECK (target_count > 0),
  progress integer NOT NULL CHECK (progress BETWEEN 0 AND 100)
);

-- Snapshot table. Not read or written by the app (see the note at the top).
CREATE TABLE IF NOT EXISTS ui_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  header_date text NOT NULL,
  claims_badge integer NOT NULL CHECK (claims_badge >= 0)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- tracking_id and receipt_scans.expected_return_id are the scan lookup keys.
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS receipt_scans_scanned_at_idx ON receipt_scans (scanned_at DESC);
CREATE INDEX IF NOT EXISTS expected_return_items_order_idx ON expected_return_items (expected_return_id, sort_order);
CREATE INDEX IF NOT EXISTS expected_returns_marketplace_idx ON expected_returns (marketplace_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_login_alias_lower_idx ON users (lower(login_alias)) WHERE login_alias IS NOT NULL;

COMMENT ON COLUMN users.has_all_marketplaces IS
  'True means no user_marketplaces rows and the API reports All marketplaces. False means access is the user_marketplaces set.';
COMMENT ON TABLE report_periods IS
  'Snapshot table. Not read or written by the app. Figures are computed from receipt_scans.';
COMMENT ON TABLE daily_return_stats IS
  'Snapshot table. Not read or written by the app. Dashboard volume is computed from receipt_scans.';
COMMENT ON COLUMN expected_returns.product_title IS
  'Scan-screen shipment title when it differs from the primary SKU name.';
COMMENT ON TABLE marketplace_issue_stats IS
  'Snapshot table. Not read or written by the app. Dashboard issue slices are computed from receipt_scans and marketplaces.';
