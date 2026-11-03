-- Additive schema for Return Tracking & Marketplace SPF Claim Aging (Myntra EJ/VB, Flipkart, etc.)
-- Safe to re-run. Nothing is dropped or deleted. SCHEMA_VERSION in db.ts is not bumped.

CREATE TABLE IF NOT EXISTS return_tracking_records (
  id serial PRIMARY KEY,
  marketplace_id integer NOT NULL REFERENCES marketplaces(id) ON DELETE RESTRICT,
  seller_id text NOT NULL DEFAULT '',
  order_id text NOT NULL,
  order_line_id text NOT NULL DEFAULT '',
  seller_order_id text NOT NULL DEFAULT '',
  return_id text NOT NULL DEFAULT '',
  tracking_id text NOT NULL,
  forward_tracking_number text NOT NULL DEFAULT '',
  return_tracking_number text NOT NULL DEFAULT '',
  return_type text NOT NULL DEFAULT 'Return',
  portal_status text NOT NULL DEFAULT '',
  portal_sub_status text NOT NULL DEFAULT '',
  return_reason text NOT NULL DEFAULT '',
  order_created_date date,
  return_created_date date,
  order_rto_date date,
  effective_return_date date NOT NULL,
  portal_delivery_date date,
  sku text NOT NULL DEFAULT '',
  myntra_sku_code text NOT NULL DEFAULT '',
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  model text NOT NULL DEFAULT 'PPMP',
  warehouse_id text NOT NULL DEFAULT '',
  upload_batch_id integer REFERENCES upload_batches(id) ON DELETE SET NULL,

  -- Physical Warehouse Inward Reconciliation
  is_physically_received boolean NOT NULL DEFAULT false,
  physical_scan_id integer REFERENCES receipt_scans(id) ON DELETE SET NULL,
  physical_scanned_at timestamptz,
  physical_scanned_by integer REFERENCES users(id) ON DELETE SET NULL,
  physical_outcome text NOT NULL DEFAULT '',

  -- SPF Claim Policy Lifecycle & Aging
  claim_eligibility_status text NOT NULL DEFAULT 'transit',
  claim_filing_deadline date,
  claim_id integer REFERENCES claims(id) ON DELETE SET NULL,
  claim_ticket_code text NOT NULL DEFAULT '',

  raw_data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for high-performance dashboard filtering and lookup
CREATE INDEX IF NOT EXISTS return_tracking_mkt_idx ON return_tracking_records (marketplace_id);
CREATE INDEX IF NOT EXISTS return_tracking_mkt_status_idx ON return_tracking_records (marketplace_id, claim_eligibility_status);
CREATE INDEX IF NOT EXISTS return_tracking_trk_idx ON return_tracking_records (tracking_id);
CREATE INDEX IF NOT EXISTS return_tracking_fwd_idx ON return_tracking_records (forward_tracking_number);
CREATE INDEX IF NOT EXISTS return_tracking_ret_idx ON return_tracking_records (return_tracking_number);
CREATE INDEX IF NOT EXISTS return_tracking_order_idx ON return_tracking_records (order_id);
CREATE INDEX IF NOT EXISTS return_tracking_effective_date_idx ON return_tracking_records (effective_return_date);
CREATE INDEX IF NOT EXISTS return_tracking_batch_idx ON return_tracking_records (upload_batch_id);

-- Unique index to prevent duplicates across multiple uploads while allowing graceful UPSERT
CREATE UNIQUE INDEX IF NOT EXISTS return_tracking_record_uidx
  ON return_tracking_records (marketplace_id, order_id, order_line_id, tracking_id);

-- Connect return tracking records to claims system (nullable receipt_scan_id for Return Not Received / RNR claims)
ALTER TABLE claims ALTER COLUMN receipt_scan_id DROP NOT NULL;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS return_tracking_id integer REFERENCES return_tracking_records(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS claims_return_tracking_idx ON claims (return_tracking_id);
