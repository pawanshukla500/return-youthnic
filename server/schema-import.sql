-- Additive schema for the marketplace export layouts and the return scan register (see server/import-profiles.ts
-- and docs/REGISTER.md). Runs on every start after schema.sql. Safe to re-run. It never drops or rewrites scan
-- history, and SCHEMA_VERSION in db.ts is intentionally not bumped, because a bump drops every app table,
-- including receipt_scans history.

-- Second tracking column (Myntra forward_tracking_number when return_tracking_number is primary).
-- Scans match tracking_id OR alt_tracking_id.
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS alt_tracking_id text;
-- Buyer or channel return reason from the upload (Myntra return_reason).
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS return_reason text;
-- Channel order item id (Myntra order_line_id). Several lines for one SKU are comma-joined.
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS order_line_id text;
-- Channel listing id (Myntra seller_sku_code).
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS channel_listing_id text;

CREATE INDEX IF NOT EXISTS expected_returns_alt_tracking_idx ON expected_returns (alt_tracking_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Lookup activation. A lookup row is 'staging' while an upload is being written, 'active' once it is the
-- account's current lookup data, and 'superseded' after a newer upload replaces it. Superseded rows are kept,
-- because scans refer to them. An upload activates its rows and supersedes the old ones in one transaction.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS lookup_status text NOT NULL DEFAULT 'active';
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'expected_returns'::regclass AND conname = 'expected_returns_lookup_status_check'
  ) THEN
    ALTER TABLE expected_returns ADD CONSTRAINT expected_returns_lookup_status_check
      CHECK (lookup_status IN ('staging', 'active', 'superseded'));
  END IF;
END $$;

-- A tracking ID was globally unique. It is now unique per account (marketplace) among active lookup rows, so
-- Myntra EJ and Myntra VB can hold the same AWB without touching each other.
ALTER TABLE expected_returns DROP CONSTRAINT IF EXISTS expected_returns_tracking_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS expected_returns_active_tracking_uidx
  ON expected_returns (marketplace_id, tracking_id) WHERE lookup_status = 'active';
CREATE INDEX IF NOT EXISTS expected_returns_account_tracking_idx ON expected_returns (marketplace_id, tracking_id);
CREATE INDEX IF NOT EXISTS expected_returns_batch_idx ON expected_returns (upload_batch_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Lookup lines. One line per channel listing and order line. The same product can appear on two lines of one
-- return, so the old one-line-per-product-per-return rule is removed.
-- product_sku_source records how the product SKU was found: VB EXPORT product master, OMSGuru master, or unresolved.
-- NULL means the line was saved before this was recorded.
-- marketplace_sku_identifier holds an FNSKU, ASIN or Myntra FSN only when the file has that column.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE expected_return_items DROP CONSTRAINT IF EXISTS expected_return_items_expected_return_id_sku_id_key;
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS product_sku_source text;
ALTER TABLE expected_return_items ADD COLUMN IF NOT EXISTS marketplace_sku_identifier text;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'expected_return_items'::regclass AND conname = 'expected_return_items_product_sku_source_check'
  ) THEN
    ALTER TABLE expected_return_items ADD CONSTRAINT expected_return_items_product_sku_source_check
      CHECK (product_sku_source IN ('product_master', 'omsguru_master', 'unresolved'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Claim tickets. A scan can open several tickets (one per issue), so the one-ticket-per-scan rule is removed.
-- Ticket statuses and the rejection reason are checked for new and changed rows. NOT VALID leaves existing rows
-- as they are, so older data is not rejected.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE claim_tickets DROP CONSTRAINT IF EXISTS claim_tickets_receipt_scan_id_key;
CREATE INDEX IF NOT EXISTS claim_tickets_receipt_scan_idx ON claim_tickets (receipt_scan_id);
ALTER TABLE claim_tickets ADD COLUMN IF NOT EXISTS rejection_reason text NOT NULL DEFAULT '';
ALTER TABLE claim_tickets ADD COLUMN IF NOT EXISTS created_by integer REFERENCES users(id);
ALTER TABLE claim_tickets ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE claim_tickets ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'claim_tickets'::regclass AND conname = 'claim_tickets_status_check'
  ) THEN
    ALTER TABLE claim_tickets ADD CONSTRAINT claim_tickets_status_check
      CHECK (status IN ('Draft', 'Raised', 'Review', 'Approved', 'Rejected')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'claim_tickets'::regclass AND conname = 'claim_tickets_rejection_reason_check'
  ) THEN
    ALTER TABLE claim_tickets ADD CONSTRAINT claim_tickets_rejection_reason_check
      CHECK (status <> 'Rejected' OR btrim(rejection_reason) <> '') NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Received issue categories. Configurable in Admin (active and requires-ticket switches). The codes are fixed,
-- because the rules in server/register-rules.ts refer to them. Seeded once per start with ON CONFLICT DO NOTHING,
-- so changes made in Admin are kept.
--   is_clear:    not an issue (No issue)
--   is_missing:  counts toward units that were not received
--   requires_ticket / allows_sub_issue / requires_sub_issue: what a submission must include
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receipt_issue_categories (
  code text PRIMARY KEY CHECK (code ~ '^[a-z_]+$'),
  label text NOT NULL,
  is_clear boolean NOT NULL DEFAULT false,
  is_missing boolean NOT NULL DEFAULT false,
  requires_ticket boolean NOT NULL DEFAULT false,
  allows_sub_issue boolean NOT NULL DEFAULT false,
  requires_sub_issue boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);
INSERT INTO receipt_issue_categories
  (code, label, is_clear, is_missing, requires_ticket, allows_sub_issue, requires_sub_issue, active, sort_order)
VALUES
  ('no_issue', 'No issue', true, false, false, false, false, true, 1),
  ('missing_component', 'Missing product or component', false, true, true, true, true, true, 2),
  ('wrong_product', 'Wrong product', false, false, true, false, false, true, 3),
  ('damaged_product', 'Damaged product', false, false, true, false, false, true, 4),
  ('other_issue', 'Other issue', false, false, false, false, false, true, 5),
  ('sku_change', 'SKU Change', false, false, false, false, false, true, 6),
  ('size_change', 'Size Change', false, false, false, false, false, true, 7)
ON CONFLICT (code) DO NOTHING;

-- Scan bench, 2026-10-11: the scanner taps the issue. A ticket ID is not typed during the scan.
-- A server start applies this. Turning "Needs a ticket ID" back on in Admin lasts until the next start.
UPDATE receipt_issue_categories
SET requires_ticket = false
WHERE code IN ('missing_component', 'wrong_product', 'damaged_product');

-- Missing-item sub-issues (Dupatta, Bottom, and so on) are the existing missing_component_options table. Each row
-- now belongs to a category. Existing rows are missing-item options, so they get that category.
ALTER TABLE missing_component_options ADD COLUMN IF NOT EXISTS category_code text NOT NULL DEFAULT 'missing_component';
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'missing_component_options'::regclass AND conname = 'missing_component_options_category_fk'
  ) THEN
    ALTER TABLE missing_component_options ADD CONSTRAINT missing_component_options_category_fk
      FOREIGN KEY (category_code) REFERENCES receipt_issue_categories(code);
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Scan events. receipt_scans stays the scan event (one per return). The snapshot columns keep the AWB and order
-- at the time of the scan, so the record stays correct after a lookup dataset is superseded.
-- client_scan_key makes a retry return the first result instead of a second scan.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS client_scan_key text;
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS tracking_id_snapshot text;
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS order_number_snapshot text;
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS marketplace_snapshot text;
CREATE UNIQUE INDEX IF NOT EXISTS receipt_scans_client_scan_key_uidx
  ON receipt_scans (client_scan_key) WHERE client_scan_key IS NOT NULL;

-- One verified line of a scan. Every expected line of the return has exactly one, and every line is verified.
-- The snapshot columns copy the lookup values at the time of the scan. Lines saved before the register have none.
CREATE TABLE IF NOT EXISTS receipt_scan_items (
  id serial PRIMARY KEY,
  receipt_scan_id integer NOT NULL REFERENCES receipt_scans(id) ON DELETE RESTRICT,
  expected_return_item_id integer REFERENCES expected_return_items(id) ON DELETE SET NULL,
  line_no integer NOT NULL,
  order_item_id text NOT NULL DEFAULT '',
  marketplace_sku text NOT NULL DEFAULT '',
  product_sku text NOT NULL DEFAULT '',
  product_sku_source text NOT NULL,
  marketplace_sku_identifier text NOT NULL DEFAULT '',
  product_name text NOT NULL DEFAULT '',
  return_type text NOT NULL DEFAULT '',
  return_reason text NOT NULL DEFAULT '',
  expected_qty integer NOT NULL CHECK (expected_qty > 0),
  received_qty integer NOT NULL,
  verified boolean NOT NULL CHECK (verified),
  CHECK (received_qty BETWEEN 0 AND expected_qty),
  CHECK (product_sku_source IN ('product_master', 'omsguru_master', 'unresolved', 'unrecorded')),
  UNIQUE (receipt_scan_id, line_no),
  UNIQUE (receipt_scan_id, expected_return_item_id)
);
CREATE INDEX IF NOT EXISTS receipt_scan_items_scan_idx ON receipt_scan_items (receipt_scan_id);
CREATE INDEX IF NOT EXISTS receipt_scan_items_marketplace_sku_idx ON receipt_scan_items (marketplace_sku);

-- The issues recorded against one scanned line. A ticket belongs to at most one issue.
CREATE TABLE IF NOT EXISTS receipt_scan_issues (
  id serial PRIMARY KEY,
  receipt_scan_item_id integer NOT NULL REFERENCES receipt_scan_items(id) ON DELETE RESTRICT,
  category_code text NOT NULL REFERENCES receipt_issue_categories(code),
  category_label text NOT NULL,
  sub_issue_id integer REFERENCES missing_component_options(id) ON DELETE SET NULL,
  sub_issue_label text NOT NULL DEFAULT '',
  qty integer NOT NULL CHECK (qty > 0),
  claim_ticket_id integer REFERENCES claim_tickets(id) ON DELETE SET NULL,
  notes text NOT NULL DEFAULT '',
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receipt_scan_issues_item_idx ON receipt_scan_issues (receipt_scan_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS receipt_scan_issues_ticket_uidx
  ON receipt_scan_issues (claim_ticket_id) WHERE claim_ticket_id IS NOT NULL;

-- Every status change of a claim ticket. Rows are added, never edited, so the history is complete.
CREATE TABLE IF NOT EXISTS claim_ticket_history (
  id bigserial PRIMARY KEY,
  claim_ticket_id integer NOT NULL REFERENCES claim_tickets(id) ON DELETE RESTRICT,
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL DEFAULT '',
  changed_by integer REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_ticket_history_ticket_idx ON claim_ticket_history (claim_ticket_id, changed_at);

-- Who changed what, when. Lookup activations, scans, ticket changes and category changes are recorded here.
-- Details never hold passwords, tokens or connection strings.
CREATE TABLE IF NOT EXISTS register_audit_log (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id integer REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS register_audit_log_entity_idx ON register_audit_log (entity_type, entity_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Existing tables below.
-- ---------------------------------------------------------------------------------------------------------------

-- VB EXPORT product master: marketplace listing SKU to master product key, with the channel image link.
-- Loaded from "Product SKU Codes.xlsx" (or the older "VB EXPORT Product Category.xlsx") by
-- server/scripts/load-product-master.ts, and from the Admin "Product SKU master" tab.
-- Same meaning as sku_master / vb_sku_master in the DashBorad project (vb_export_sku is the master key).
CREATE TABLE IF NOT EXISTS product_master (
  marketplace text NOT NULL,
  listing_sku text NOT NULL,
  master_sku text NOT NULL,
  category text,
  cogs numeric(14,2),
  weight_slab numeric(6,2),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marketplace, listing_sku)
);
-- The channel image link for the listing SKU. Added after the table so a database created before this column gets it.
ALTER TABLE product_master ADD COLUMN IF NOT EXISTS image_url text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS product_master_listing_idx ON product_master (listing_sku);
CREATE INDEX IF NOT EXISTS product_master_image_url_idx ON product_master (image_url) WHERE image_url <> '';

-- Orders cancelled before dispatch (Myntra rows with a blank tracking number).
-- Project rule (AGENTS.md): recorded as return_type 'Courier Return' with reason 'Cancel Before Dispached'.
-- They have no AWB, so they are never scanned. They are kept for reporting.
CREATE TABLE IF NOT EXISTS cancelled_returns (
  id serial PRIMARY KEY,
  marketplace_id integer NOT NULL REFERENCES marketplaces(id) ON DELETE CASCADE,
  order_number text NOT NULL,
  order_line_id text NOT NULL,
  channel_listing_id text,
  qty integer NOT NULL CHECK (qty > 0),
  return_type text NOT NULL,
  reason text NOT NULL,
  upload_batch_id integer REFERENCES upload_batches(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace_id, order_line_id)
);

-- OMSGuru channel listings: normalized listing SKU, product title and image.
-- Filled by server/scripts/sync-oms-catalog.ts from the OMSGuru list_channel_listings endpoint.
-- The key is the normalized SKU (uppercase, single spaces), the same key used for every join.
CREATE TABLE IF NOT EXISTS sku_catalog (
  sku text PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT '',
  channel_company_id integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- OMSGuru order details for return rows. One row per order OMSGuru returned for a lookup.
-- lookup_type/lookup_key: what the return app asked for (the order line as sub_order_id, or the order number).
-- last_error: 'NOT_FOUND' or 'ERROR: ...' when a lookup returned nothing. raw_json has buyer fields removed.
CREATE TABLE IF NOT EXISTS oms_order_snapshots (
  id serial PRIMARY KEY,
  lookup_type text NOT NULL CHECK (lookup_type IN ('sub_order_id', 'order_id')),
  lookup_key text NOT NULL,
  marketplace text NOT NULL DEFAULT '',
  channel_order_id text NOT NULL DEFAULT '',
  sub_order_ids text NOT NULL DEFAULT '',
  item_statuses text NOT NULL DEFAULT '',
  shipment_tracker text NOT NULL DEFAULT '',
  invoice_id text NOT NULL DEFAULT '',
  invoice_date timestamptz,
  warehouse text NOT NULL DEFAULT '',
  channel_label text NOT NULL DEFAULT '',
  skus text NOT NULL DEFAULT '',
  raw_json jsonb,
  last_error text NOT NULL DEFAULT '',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lookup_type, lookup_key, channel_order_id, sub_order_ids)
);
CREATE INDEX IF NOT EXISTS oms_order_snapshots_shipment_idx ON oms_order_snapshots (shipment_tracker);
CREATE INDEX IF NOT EXISTS oms_order_snapshots_lookup_key_idx ON oms_order_snapshots (lookup_key);

-- Every column of every uploaded report row (valid or not), kept as row_data.
-- Normalized header names are the keys, so a renamed header in a later file is still one column.
-- Buyer tax and company columns are removed before storage (see redactColumns in import-profiles.ts).
CREATE TABLE IF NOT EXISTS upload_rows (
  id bigserial PRIMARY KEY,
  upload_batch_id integer NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  marketplace_id integer NOT NULL REFERENCES marketplaces(id) ON DELETE CASCADE,
  line_no integer NOT NULL,
  tracking_id text NOT NULL DEFAULT '',
  order_id text NOT NULL DEFAULT '',
  valid boolean NOT NULL,
  error text NOT NULL DEFAULT '',
  row_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS upload_rows_batch_idx ON upload_rows (upload_batch_id);
CREATE INDEX IF NOT EXISTS upload_rows_tracking_idx ON upload_rows (tracking_id);

-- OMSGuru invoices (dispatched shipments with their AWB), pulled one IST day at a time for every channel.
-- oms_key follows the Forward Scan key: channel | channel order id | invoice id (or sub-order ids) | AWB.
-- payload is the full response row with buyer fields removed.
CREATE TABLE IF NOT EXISTS oms_invoices (
  id bigserial PRIMARY KEY,
  oms_key text NOT NULL UNIQUE,
  oms_invoice_id text NOT NULL DEFAULT '',
  channel_label text NOT NULL DEFAULT '',
  warehouse text NOT NULL DEFAULT '',
  company text NOT NULL DEFAULT '',
  invoice_date timestamptz,
  invoice_day date,
  channel_order_id text NOT NULL DEFAULT '',
  sub_order_ids text NOT NULL DEFAULT '',
  shipment_tracker text NOT NULL DEFAULT '',
  item_statuses text NOT NULL DEFAULT '',
  skus text NOT NULL DEFAULT '',
  last_oms_id bigint,
  payload jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oms_invoices_day_channel_idx ON oms_invoices (invoice_day, channel_label);
CREATE INDEX IF NOT EXISTS oms_invoices_tracker_idx ON oms_invoices (shipment_tracker);

-- One row per OMSGuru sync run, so a failed or throttled step can be seen and re-run.
-- kind: 'listings' or 'skus' (sync-oms-catalog.ts), or the invoice pull (sync-oms-daily.ts).
CREATE TABLE IF NOT EXISTS oms_sync_runs (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  run_day date,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  pages integer NOT NULL DEFAULT 0,
  rows_stored integer NOT NULL DEFAULT 0,
  error text NOT NULL DEFAULT ''
);
-- New listings or master SKUs seen in the run. Added after the table existed, so ALTER.
ALTER TABLE oms_sync_runs ADD COLUMN IF NOT EXISTS new_rows integer NOT NULL DEFAULT 0;

-- Every OMSGuru channel listing record (list_channel_listings), one row per record, refreshed on each daily run.
-- oms_sku_id is the OMSGuru master SKU the listing is mapped to. 0 or NULL means not mapped.
-- first_seen_at marks listings that appeared for the first time, which gives the "new mapped listing" count.
-- payload is the full record, kept so fields the code does not use yet are not lost.
CREATE TABLE IF NOT EXISTS oms_listings (
  channel_company_id integer NOT NULL,
  oms_listing_id bigint NOT NULL,
  listing_id text NOT NULL DEFAULT '',
  channel_sku text NOT NULL DEFAULT '',
  oms_sku_id bigint,
  retail_price numeric(14,2),
  title text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT '',
  payload jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_company_id, oms_listing_id)
);
CREATE INDEX IF NOT EXISTS oms_listings_channel_sku_idx ON oms_listings (channel_sku);
CREATE INDEX IF NOT EXISTS oms_listings_oms_sku_idx ON oms_listings (oms_sku_id);
CREATE INDEX IF NOT EXISTS oms_listings_first_seen_idx ON oms_listings (first_seen_at);

-- OMSGuru master SKUs (the SKU record from GET /order_api/skus). The record has no image field.
-- Images come from oms_listings.image_url. Joins: oms_listings.oms_sku_id = oms_skus.oms_sku_id.
CREATE TABLE IF NOT EXISTS oms_skus (
  oms_sku_id bigint PRIMARY KEY,
  sku_code text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  selling_price numeric(14,2),
  mrp_price numeric(14,2),
  last_purchase_price numeric(14,2),
  size_code text NOT NULL DEFAULT '',
  style_code text NOT NULL DEFAULT '',
  model_code text NOT NULL DEFAULT '',
  color_code text NOT NULL DEFAULT '',
  upc text NOT NULL DEFAULT '',
  payload jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oms_skus_code_idx ON oms_skus (sku_code);
