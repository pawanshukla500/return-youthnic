-- Iron Send tracking. Runs on every start after the other schema files. Additive and safe to re-run.
--
-- Iron Send is an operational category, not a return issue. The Return Team records it at the scan bench: the units
-- were received and go out for ironing (pressing). They come back in about 2-3 days, and the Inward Team records what
-- came back, by hand. Nothing marks an Iron Send as received automatically.
--
--  - An operational category is never counted as a return issue: not in the issue figures, not in the claims, not in
--    the issue reports. Its rows stay in receipt_scan_issues, so the scan keeps the full record of what was tapped.
--  - Iron Send units are never sent to OMSGuru for an inventory update (server/omsguru-daily.ts excludes them).
--  - iron_send_records holds one open record per scanned line that was sent for ironing. iron_receive_events holds
--    every quantity the Inward Team received back. Both are only added to; a record is cancelled, never deleted.

ALTER TABLE receipt_issue_categories ADD COLUMN IF NOT EXISTS is_operational boolean NOT NULL DEFAULT false;
UPDATE receipt_issue_categories SET is_operational = true WHERE code = 'iron_send' AND is_operational = false;

CREATE TABLE IF NOT EXISTS iron_send_records (
  id serial PRIMARY KEY,
  receipt_scan_id integer NOT NULL REFERENCES receipt_scans(id) ON DELETE RESTRICT,
  receipt_scan_item_id integer NOT NULL REFERENCES receipt_scan_items(id) ON DELETE RESTRICT,
  marketplace_id integer REFERENCES marketplaces(id),
  qty_sent integer NOT NULL CHECK (qty_sent > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled')),
  notes text NOT NULL DEFAULT '',
  sent_by integer REFERENCES users(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  cancelled_by integer REFERENCES users(id),
  cancelled_at timestamptz,
  cancel_reason text NOT NULL DEFAULT ''
);
-- One open record per scanned line. A correction at the bench cancels the old record and opens a new one.
CREATE UNIQUE INDEX IF NOT EXISTS iron_send_records_open_item_uidx
  ON iron_send_records (receipt_scan_item_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS iron_send_records_scan_idx ON iron_send_records (receipt_scan_id);
CREATE INDEX IF NOT EXISTS iron_send_records_sent_idx ON iron_send_records (sent_at);
CREATE INDEX IF NOT EXISTS iron_send_records_account_idx ON iron_send_records (marketplace_id);

-- What the Inward Team received back. A row is one manual entry. client_key makes a retried entry count once.
CREATE TABLE IF NOT EXISTS iron_receive_events (
  id bigserial PRIMARY KEY,
  iron_send_record_id integer NOT NULL REFERENCES iron_send_records(id) ON DELETE RESTRICT,
  qty integer NOT NULL CHECK (qty > 0),
  notes text NOT NULL DEFAULT '',
  received_by integer NOT NULL REFERENCES users(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  client_key text
);
CREATE INDEX IF NOT EXISTS iron_receive_events_record_idx ON iron_receive_events (iron_send_record_id);
CREATE UNIQUE INDEX IF NOT EXISTS iron_receive_events_client_key_uidx
  ON iron_receive_events (client_key) WHERE client_key IS NOT NULL;

-- When an open Iron Send counts as overdue. The default is 3 days; Admin can change it.
CREATE TABLE IF NOT EXISTS iron_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  overdue_after_days integer NOT NULL DEFAULT 3 CHECK (overdue_after_days BETWEEN 1 AND 30),
  updated_by integer REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO iron_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Backfill: every Iron Send tapped before this table existed gets its open record, with the time it was tapped.
INSERT INTO iron_send_records (receipt_scan_id, receipt_scan_item_id, marketplace_id, qty_sent, notes, sent_by, sent_at)
SELECT rsi.receipt_scan_id,
       x.receipt_scan_item_id,
       er.marketplace_id,
       SUM(x.qty)::int,
       COALESCE(string_agg(NULLIF(x.notes, ''), '; '), ''),
       MIN(x.created_by),
       MIN(x.created_at)
FROM receipt_scan_issues x
JOIN receipt_issue_categories c ON c.code = x.category_code AND c.is_operational
JOIN receipt_scan_items rsi ON rsi.id = x.receipt_scan_item_id
JOIN receipt_scans rs ON rs.id = rsi.receipt_scan_id
JOIN expected_returns er ON er.id = rs.expected_return_id
WHERE NOT EXISTS (SELECT 1 FROM iron_send_records r WHERE r.receipt_scan_item_id = x.receipt_scan_item_id)
GROUP BY rsi.receipt_scan_id, x.receipt_scan_item_id, er.marketplace_id;

-- A scan whose only issues are operational (Iron Send) is a clear return, not an issue return. Scans saved before
-- this rule were stored as 'issue' / 'Draft', which counted them in the issue figures and the claims. They are
-- corrected here, once, and each correction is written to the audit log with the values it replaced. The issue rows
-- themselves are kept.
INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
SELECT NULL, 'scan.reclassify_operational', 'receipt_scan', rs.id::text,
       jsonb_build_object(
         'fromOutcome', rs.outcome, 'fromStatus', rs.status, 'fromIssueLabel', rs.issue_label,
         'toOutcome', 'clear', 'toStatus', 'Clear',
         'reason', 'Iron Send is an operational category and is not a return issue'
       )
FROM receipt_scans rs
WHERE rs.outcome = 'issue'
  AND EXISTS (
    SELECT 1 FROM receipt_scan_items i
    JOIN receipt_scan_issues x ON x.receipt_scan_item_id = i.id
    JOIN receipt_issue_categories c ON c.code = x.category_code AND c.is_operational
    WHERE i.receipt_scan_id = rs.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM receipt_scan_items i
    JOIN receipt_scan_issues x ON x.receipt_scan_item_id = i.id
    JOIN receipt_issue_categories c ON c.code = x.category_code AND NOT c.is_operational
    WHERE i.receipt_scan_id = rs.id
  )
  AND NOT EXISTS (SELECT 1 FROM claim_tickets ct WHERE ct.receipt_scan_id = rs.id);

UPDATE receipt_scans rs
SET outcome = 'clear', status = 'Clear'
WHERE rs.outcome = 'issue'
  AND EXISTS (
    SELECT 1 FROM receipt_scan_items i
    JOIN receipt_scan_issues x ON x.receipt_scan_item_id = i.id
    JOIN receipt_issue_categories c ON c.code = x.category_code AND c.is_operational
    WHERE i.receipt_scan_id = rs.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM receipt_scan_items i
    JOIN receipt_scan_issues x ON x.receipt_scan_item_id = i.id
    JOIN receipt_issue_categories c ON c.code = x.category_code AND NOT c.is_operational
    WHERE i.receipt_scan_id = rs.id
  )
  AND NOT EXISTS (SELECT 1 FROM claim_tickets ct WHERE ct.receipt_scan_id = rs.id);

-- ---------------------------------------------------------------------------------------------------------------
-- Iron batches (2026-10-14). The Return Team groups pending Iron Send lines into a numbered batch (IRN-YYMMDD-NNN)
-- and writes the batch number on the khaata challan that goes with the goods. Ironing takes 2-3 days, sometimes 4-5,
-- so each batch has its own expected return date; a line in a batch is overdue after that date. The outward and inward
-- teams track by batch. A batch is never deleted, and a line, once in a batch, stays in it.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS iron_batches (
  id serial PRIMARY KEY,
  batch_no text NOT NULL UNIQUE,
  khaata_name text NOT NULL DEFAULT '',
  challan_no text NOT NULL DEFAULT '',
  expected_days integer NOT NULL DEFAULT 3 CHECK (expected_days BETWEEN 1 AND 30),
  expected_return_at timestamptz NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  client_key text
);
CREATE UNIQUE INDEX IF NOT EXISTS iron_batches_client_key_uidx ON iron_batches (client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS iron_batches_created_idx ON iron_batches (created_at DESC);
ALTER TABLE iron_send_records ADD COLUMN IF NOT EXISTS batch_id integer REFERENCES iron_batches(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS iron_send_records_batch_idx ON iron_send_records (batch_id);

-- Where a batch is ironed (2026-10-16): 'khaata' (sent out on a challan) or 'in_house' (high-running pieces ironed at
-- the return desk). Receiving stays the same manual Inward Team step for both, and neither touches OMSGuru.
ALTER TABLE iron_batches ADD COLUMN IF NOT EXISTS iron_location text NOT NULL DEFAULT 'khaata'
  CHECK (iron_location IN ('khaata', 'in_house'));
