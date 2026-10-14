-- Meesho flyer ID capture for issue returns (claim evidence).
--
-- When a Meesho return is saved with a return issue (Wrong, Missing, Damaged, etc.),
-- the bench scans the Meesho flyer barcode and stores it against the return tracking
-- ID. The flyer ID stays on the scan permanently for future Meesho claim submissions.
-- Iron Send never uses a flyer: it is operational, not a return issue.
--
-- Additive only. Safe to re-run. Never drop a column here.
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS flyer_id text NOT NULL DEFAULT '';
ALTER TABLE receipt_scans ADD COLUMN IF NOT EXISTS flyer_state text NOT NULL DEFAULT 'not_required';

-- flyer_state is one of: 'scanned' (a flyer barcode was captured),
-- 'unavailable' (the flyer was missing at the bench; no ID is stored),
-- 'not_required' (not a Meesho issue return, or an Iron-only/clear scan).
CREATE INDEX IF NOT EXISTS receipt_scans_flyer_id_idx ON receipt_scans (flyer_id) WHERE flyer_id <> '';
