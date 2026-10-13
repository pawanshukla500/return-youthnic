-- Phase 1 return register: additive schema, applied on every start after schema.sql and schema-import.sql (see
-- applySchema in server/db.ts). Safe to re-run. Every statement is ADD COLUMN IF NOT EXISTS, CREATE ... IF NOT EXISTS,
-- or INSERT ... ON CONFLICT DO NOTHING. Nothing is dropped, deleted, or rewritten.
--
-- Existing rows keep their values. New columns take their default. Old Ajio and Amazon rows that stored a display
-- identifier in expected_return_items.order_line_id keep it there; the register reads display_order_item_id first and
-- falls back to order_line_id, so old rows still show their value.

-- Import batches: the detected layout of the file.
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS detected_format text NOT NULL DEFAULT '';
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS scannable_row_count integer NOT NULL DEFAULT 0;
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS pending_row_count integer NOT NULL DEFAULT 0;
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS rejected_row_count integer NOT NULL DEFAULT 0;

-- Raw rows: warnings (non-blocking), exact-duplicate classification, the row fingerprint and the 1-based data line.
ALTER TABLE upload_rows ADD COLUMN IF NOT EXISTS warnings text NOT NULL DEFAULT '';
ALTER TABLE upload_rows ADD COLUMN IF NOT EXISTS duplicate_kind text NOT NULL DEFAULT '';
ALTER TABLE upload_rows ADD COLUMN IF NOT EXISTS row_fingerprint text NOT NULL DEFAULT '';
ALTER TABLE upload_rows ADD COLUMN IF NOT EXISTS source_line_no integer;
ALTER TABLE upload_rows ADD COLUMN IF NOT EXISTS source_tracking_id text NOT NULL DEFAULT '';
ALTER TABLE upload_rows ADD COLUMN IF NOT EXISTS row_status text NOT NULL DEFAULT 'rejected';

-- ---------------------------------------------------------------------------------------------------------------
-- Logistics partners. The reference rows are seeded from the real samples: the carrier names in the Meesho
-- "Courier Partner" column, and the Flipkart "vendor_name" values. Domains are only the tracking hosts verified in a
-- real file (see LINK_RULES in server/marketplace-rules.ts; the two must agree).
-- Amazon's carrier "ATSPL" is in Amazon.csv but is NOT seeded: its name is not verified. Add it in Admin once confirmed.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics_partners (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- scope: marketplace_id NULL applies to every marketplace. A marketplace-scoped alias is a marketplace mapping.
CREATE TABLE IF NOT EXISTS logistics_partner_aliases (
  id serial PRIMARY KEY,
  partner_id integer NOT NULL REFERENCES logistics_partners(id) ON DELETE CASCADE,
  alias_key text NOT NULL CHECK (alias_key ~ '^[a-z0-9]+$'),
  marketplace_id integer REFERENCES marketplaces(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS logistics_partner_aliases_uidx
  ON logistics_partner_aliases (alias_key, COALESCE(marketplace_id, 0));

CREATE TABLE IF NOT EXISTS logistics_partner_domains (
  id serial PRIMARY KEY,
  partner_id integer NOT NULL REFERENCES logistics_partners(id) ON DELETE CASCADE,
  host text NOT NULL UNIQUE CHECK (host <> '' AND host = lower(host)),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO logistics_partners (name) VALUES
  ('Delhivery'), ('Shadowfax'), ('Valmo'), ('PocketShip'), ('Xpress Bees'), ('Flipkart Logistics')
ON CONFLICT (name) DO NOTHING;

INSERT INTO logistics_partner_aliases (partner_id, alias_key)
SELECT p.id, v.alias_key
FROM (VALUES
  ('Delhivery', 'delhivery'),
  ('Delhivery', 'delhiverycod'),
  ('Delhivery', 'delhiveryexpress'),
  ('Delhivery', 'delhiversurface'),
  ('Shadowfax', 'shadowfax'),
  ('Valmo', 'valmo'),
  ('PocketShip', 'pocketship'),
  ('Xpress Bees', 'xpressbees'),
  ('Xpress Bees', 'expressbees'),
  ('Flipkart Logistics', 'flipkartlogistics'),
  ('Flipkart Logistics', 'flipkartlogisticscod')
) AS v(partner_name, alias_key)
JOIN logistics_partners p ON p.name = v.partner_name
ON CONFLICT DO NOTHING;

INSERT INTO logistics_partner_domains (partner_id, host)
SELECT p.id, v.host
FROM (VALUES
  ('Delhivery', 'track.delhivery.com'),
  ('Delhivery', 'www.delhivery.com'),
  ('Shadowfax', 'track.shadowfax.in'),
  ('Shadowfax', 'tracker.shadowfax.in'),
  ('Valmo', 'meesho.portal.shipsy.io'),
  ('Valmo', 'www.valmo.in'),
  ('Xpress Bees', 'www.xpressbees.com')
) AS v(partner_name, host)
JOIN logistics_partners p ON p.name = v.partner_name
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------
-- Lookup rows (expected_returns). Partner, tracking and return type evidence, kept as the upload gave it.
--  tracking_id            the resolved lookup AWB (the one scans match)
--  csv_tracking_id        the AWB exactly as the file wrote it
--  tracking_url           the carrier link from the file (Meesho)
--  url_tracking_id        the AWB read from a verified link, or ''
--  tracking_validation    how the AWB was decided (see TrackingValidation in server/marketplace-rules.ts)
--  tracking_source        where the lookup AWB came from
--  identifier_source      csv_awb or tracking_link
--  forward_tracking_id    the outbound AWB, kept for audit (Myntra AF, Amazon Forward Leg)
--  alt_tracking_id        the other AWB that scans also match (Myntra forward only; unchanged)
--  return_event_id        the return event (Myntra return_id, Flipkart Return ID, Amazon RMA ID)
--  return_type            normalized; return_type_raw is the code as the file wrote it
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS return_type_raw text NOT NULL DEFAULT '';
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS tracking_source text NOT NULL DEFAULT 'tracking_id';
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS csv_tracking_id text;
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS tracking_url text NOT NULL DEFAULT '';
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS url_tracking_id text NOT NULL DEFAULT '';
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS tracking_validation text NOT NULL DEFAULT 'not_applicable';
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS identifier_source text NOT NULL DEFAULT 'csv_awb';
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS forward_tracking_id text NOT NULL DEFAULT '';
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS return_event_id text NOT NULL DEFAULT '';
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS carrier_from_link text NOT NULL DEFAULT '';
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS logistics_partner_id integer REFERENCES logistics_partners(id);
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS logistic_partner_name text NOT NULL DEFAULT 'Unknown / Pending Verification';
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS partner_detection_method text NOT NULL DEFAULT 'none';
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS partner_confidence text NOT NULL DEFAULT 'none';
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS partner_source_value text NOT NULL DEFAULT '';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'expected_returns'::regclass AND conname = 'expected_returns_tracking_source_check') THEN
    ALTER TABLE expected_returns ADD CONSTRAINT expected_returns_tracking_source_check
      CHECK (tracking_source IN ('return_tracking', 'forward_tracking', 'tracking_id', 'tracking_url')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'expected_returns'::regclass AND conname = 'expected_returns_tracking_validation_check') THEN
    ALTER TABLE expected_returns ADD CONSTRAINT expected_returns_tracking_validation_check
      CHECK (tracking_validation IN ('not_applicable', 'blank_awb', 'damaged_awb', 'no_link', 'invalid_link',
        'unverified_host', 'match', 'mismatch_resolved', 'mismatch_kept')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'expected_returns'::regclass AND conname = 'expected_returns_identifier_source_check') THEN
    ALTER TABLE expected_returns ADD CONSTRAINT expected_returns_identifier_source_check
      CHECK (identifier_source IN ('csv_awb', 'tracking_link')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'expected_returns'::regclass AND conname = 'expected_returns_partner_method_check') THEN
    ALTER TABLE expected_returns ADD CONSTRAINT expected_returns_partner_method_check
      CHECK (partner_detection_method IN ('explicit_carrier', 'marketplace_mapping', 'tracking_domain', 'manual', 'none')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'expected_returns'::regclass AND conname = 'expected_returns_partner_confidence_check') THEN
    ALTER TABLE expected_returns ADD CONSTRAINT expected_returns_partner_confidence_check
      CHECK (partner_confidence IN ('verified', 'manual', 'none')) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS expected_returns_partner_idx ON expected_returns (logistics_partner_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Lookup lines (expected_return_items).
--  order_line_id                 a real channel order line only (never an Ajio or Amazon display identifier)
--  display_order_item_id         what the register shows as Order Item ID
--  display_identifier_kind       what display_order_item_id is: order_line, ajio_return_order_number, amazon_shipment_id
--  marketplace_sku_identifier    FNSKU/ASIN/FSN/JioCode/Myntra SKU code, from the layout's own column
--  marketplace_sku_identifier_kind  which kind that value is
--  source_line_no, row_fingerprint  the composite identity of the source row (for audit and for repeats)
--  sales_amount                  reserved for the Sales Database integration. Nothing writes it yet.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS display_order_item_id text;
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS display_identifier_kind text NOT NULL DEFAULT '';
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS marketplace_sku_identifier_kind text NOT NULL DEFAULT '';
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS source_line_no integer;
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS row_fingerprint text;
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS sales_amount numeric(14,2);
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS shipment_id text NOT NULL DEFAULT '';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'expected_return_items'::regclass AND conname = 'expected_return_items_display_kind_check') THEN
    ALTER TABLE expected_return_items ADD CONSTRAINT expected_return_items_display_kind_check
      CHECK (display_identifier_kind IN ('', 'order_line', 'ajio_return_order_number', 'amazon_shipment_id')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'expected_return_items'::regclass AND conname = 'expected_return_items_sku_identifier_kind_check') THEN
    ALTER TABLE expected_return_items ADD CONSTRAINT expected_return_items_sku_identifier_kind_check
      CHECK (marketplace_sku_identifier_kind IN ('', 'fsn', 'asin', 'jiocode', 'myntra_sku_code')) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Scans (receipt_scans): what was scanned, how it matched, and the partner and tracking evidence at the time.
--  matched_tracking_field   which stored AWB matched the scan: tracking_id or alt_tracking_id ('' if not known)
--  matched_leg              return, forward, or unknown: the leg the matched AWB belongs to
--  scanned_tracking         the AWB the employee scanned (normalized)
--  source_batch_id          the import batch the lookup row came from
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS matched_tracking_field text NOT NULL DEFAULT '';
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS matched_leg text NOT NULL DEFAULT 'unknown';
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS scanned_tracking text NOT NULL DEFAULT '';
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS source_batch_id integer REFERENCES upload_batches(id) ON DELETE SET NULL;
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS logistic_partner_snapshot text NOT NULL DEFAULT 'Unknown / Pending Verification';
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS partner_method_snapshot text NOT NULL DEFAULT 'none';
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS partner_source_snapshot text NOT NULL DEFAULT '';
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS tracking_validation_snapshot text NOT NULL DEFAULT 'not_applicable';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'receipt_scans'::regclass AND conname = 'receipt_scans_matched_field_check') THEN
    ALTER TABLE receipt_scans DROP CONSTRAINT receipt_scans_matched_field_check;
  END IF;
  ALTER TABLE receipt_scans ADD CONSTRAINT receipt_scans_matched_field_check
    CHECK (matched_tracking_field IN ('', 'tracking_id', 'alt_tracking_id', 'order_number')) NOT VALID;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'receipt_scans'::regclass AND conname = 'receipt_scans_matched_leg_check') THEN
    ALTER TABLE receipt_scans ADD CONSTRAINT receipt_scans_matched_leg_check
      CHECK (matched_leg IN ('return', 'forward', 'unknown')) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Scanned return items (receipt_scan_items): the real order line, the display identifier and its kind, the SKU
-- identifier kind, the return type as the file wrote it, and the source row. sales_amount is reserved, not written.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE receipt_scan_items ADD COLUMN IF NOT EXISTS order_line_id text NOT NULL DEFAULT '';
ALTER TABLE receipt_scan_items ADD COLUMN IF NOT EXISTS display_identifier_kind text NOT NULL DEFAULT '';
ALTER TABLE receipt_scan_items ADD COLUMN IF NOT EXISTS marketplace_sku_identifier_kind text NOT NULL DEFAULT '';
ALTER TABLE receipt_scan_items ADD COLUMN IF NOT EXISTS return_type_raw text NOT NULL DEFAULT '';
ALTER TABLE receipt_scan_items ADD COLUMN IF NOT EXISTS source_line_no integer;
ALTER TABLE receipt_scan_items ADD COLUMN IF NOT EXISTS row_fingerprint text;
ALTER TABLE receipt_scan_items ADD COLUMN IF NOT EXISTS sales_amount numeric(14,2);
ALTER TABLE receipt_scan_items ADD COLUMN IF NOT EXISTS shipment_id text NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------------------------------------------
-- Claim tickets. The claim amount is reserved for the claims integration. Nothing writes it yet, so it stays NULL.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE claim_tickets ADD COLUMN IF NOT EXISTS claim_amount numeric(14,2);

-- ---------------------------------------------------------------------------------------------------------------
-- Performance indexes for high-speed active lookups and shipment ID queries.
-- ---------------------------------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS expected_returns_active_alt_tracking_idx
  ON expected_returns (marketplace_id, alt_tracking_id)
  WHERE lookup_status = 'active' AND alt_tracking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expected_returns_active_order_number_idx
  ON expected_returns (marketplace_id, order_number)
  WHERE lookup_status = 'active' AND order_number IS NOT NULL AND order_number <> '';
CREATE INDEX IF NOT EXISTS expected_return_items_display_order_item_idx
  ON expected_return_items (display_order_item_id)
  WHERE display_order_item_id <> '';
CREATE INDEX IF NOT EXISTS expected_return_items_shipment_idx
  ON expected_return_items (shipment_id)
  WHERE shipment_id <> '';
CREATE INDEX IF NOT EXISTS receipt_scan_items_shipment_idx
  ON receipt_scan_items (shipment_id)
  WHERE shipment_id <> '';
CREATE INDEX IF NOT EXISTS receipt_scans_scanned_by_at_idx
  ON receipt_scans (scanned_by, scanned_at DESC);
CREATE INDEX IF NOT EXISTS register_audit_log_actor_idx
  ON register_audit_log (actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS register_audit_log_occurred_at_idx
  ON register_audit_log (occurred_at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- Persistent device sessions: long-lived remembered warehouse devices, idle/absolute expiry, and revocation.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_sessions (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  device_name text NOT NULL DEFAULT 'Warehouse Device',
  user_agent text NOT NULL DEFAULT '',
  ip_address text NOT NULL DEFAULT '',
  is_remembered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by integer REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_lookup
  ON user_sessions (token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_sessions_user
  ON user_sessions (user_id, last_active_at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- Scheduled report runs: idempotent Resend email report logging and execution locks.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduled_report_runs (
  id bigserial PRIMARY KEY,
  report_type text NOT NULL,
  period_key text NOT NULL UNIQUE,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  recipients text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_report_runs_type_created
  ON scheduled_report_runs (report_type, created_at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- App system settings: persisted configuration for email reports, session timeouts, and notification rules.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_system_settings (
  setting_key text PRIMARY KEY,
  setting_value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES users(id)
);

INSERT INTO app_system_settings (setting_key, setting_value)
VALUES
  ('reports_config', jsonb_build_object(
    'dailyEnabled', true,
    'dailyTime', '20:00',
    'weeklyEnabled', true,
    'weeklyDay', 1,
    'weeklyTime', '09:00',
    'timezone', 'Asia/Kolkata',
    'sender', 'return.scan@youthnic.shop',
    'recipientEmails', jsonb_build_array()
  )),
  ('session_config', jsonb_build_object(
    'rememberDurationDays', 30,
    'rememberIdleDays', 7,
    'standardDurationHours', 24,
    'standardIdleHours', 4
  ))
ON CONFLICT (setting_key) DO NOTHING;

-- User report preference column
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_receive_reports boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------------------------------------------
-- OMSGuru daily inventory updates: daily aggregation of good-condition returns across all marketplaces,
-- formatted for bulk inventory addition (ADD) at dropship warehouse (default 6688), stored in Firebase Storage
-- for 180-day retention and automated Resend email delivery with CSV attachment.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS omsguru_daily_inventory_updates (
  id serial PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  update_date date NOT NULL,
  dropship_warehouse_id text NOT NULL DEFAULT '6688',
  total_skus integer NOT NULL DEFAULT 0,
  total_qty integer NOT NULL DEFAULT 0,
  csv_content text NOT NULL,
  file_name text NOT NULL DEFAULT 'UpdateInStockQtyAnd_orLastPurchasePrice.csv',
  storage_path text NOT NULL DEFAULT '',
  storage_url text NOT NULL DEFAULT '',
  email_sent boolean NOT NULL DEFAULT false,
  email_sent_at timestamptz,
  email_recipients text[] NOT NULL DEFAULT '{}',
  email_cc text[] NOT NULL DEFAULT '{}',
  sku_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS omsguru_daily_updates_date_idx ON omsguru_daily_inventory_updates (update_date DESC);
CREATE INDEX IF NOT EXISTS omsguru_daily_updates_request_id_idx ON omsguru_daily_inventory_updates (request_id);

INSERT INTO app_system_settings (setting_key, setting_value)
VALUES
  ('omsguru_config', jsonb_build_object(
    'dailyEnabled', true,
    'dailyTime', '19:45',
    'dropshipWarehouseId', '6688',
    'retentionDays', 180,
    'storageFolder', 'inventory-update-file',
    'ccEmails', jsonb_build_array()
  ))
ON CONFLICT (setting_key) DO NOTHING;


