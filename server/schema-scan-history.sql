-- Scan history snapshots. Additive, safe to re-run, and applied on every start after schema-register.sql (see
-- applySchema in server/db.ts). Nothing is dropped or rewritten. A scan copies these values from its lookup row at the
-- moment it is saved, so a later upload cannot change what the scan recorded.
--
--  csv_tracking_snapshot     the AWB exactly as the upload file wrote it (the original tracking ID)
--  url_tracking_snapshot     the AWB read from a verified tracking link ('' when there is none)
--  tracking_source_snapshot  where the lookup AWB came from: return_tracking, forward_tracking, tracking_id, tracking_url
--  forward_tracking_snapshot the outbound AWB (Myntra AF, Amazon Forward Leg), kept for audit
--  return_event_snapshot     the return event id (Myntra return_id, Flipkart Return ID, Amazon RMA ID)
--  source_filename_snapshot  the file name of the upload that supplied the lookup row (the original marketplace source)
--  return_type_raw_snapshot  the return type as the file wrote it, before normalization
--
-- source_batch_id (receipt_scans) already references the import batch. scanned_tracking, matched_tracking_field,
-- matched_leg and the partner snapshots are in schema-register.sql.

ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS csv_tracking_snapshot text NOT NULL DEFAULT '';
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS url_tracking_snapshot text NOT NULL DEFAULT '';
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS tracking_source_snapshot text NOT NULL DEFAULT 'tracking_id';
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS forward_tracking_snapshot text NOT NULL DEFAULT '';
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS return_event_snapshot text NOT NULL DEFAULT '';
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS source_filename_snapshot text NOT NULL DEFAULT '';
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS return_type_raw_snapshot text NOT NULL DEFAULT '';

-- Indexes for the account filter and the per-scanner filter. receipt_scans (scanned_at) is already indexed in
-- schema.sql. Plain columns only: an expression index on the IST day would need an immutable function, and the
-- time-zone conversion is not immutable.
CREATE INDEX IF NOT EXISTS receipt_scans_scanned_by_idx ON receipt_scans (scanned_by);
CREATE INDEX IF NOT EXISTS receipt_scans_source_batch_idx ON receipt_scans (source_batch_id);
CREATE INDEX IF NOT EXISTS expected_returns_marketplace_status_idx ON expected_returns (marketplace_id, lookup_status);
CREATE INDEX IF NOT EXISTS upload_batches_marketplace_created_idx ON upload_batches (marketplace_id, created_at DESC);
