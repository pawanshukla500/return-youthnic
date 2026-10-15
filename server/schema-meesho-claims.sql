-- Meesho claim capture configuration and immutable marketplace submission snapshots.
-- Additive and idempotent. No scan, claim, evidence, or configuration history is deleted.

ALTER TABLE missing_component_options
  ADD COLUMN IF NOT EXISTS claim_amount numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE claims ADD COLUMN IF NOT EXISTS marketplace_issue_code text NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS marketplace_issue_label text NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS sub_order_id_snapshot text NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS awb_snapshot text NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS packet_state_snapshot text NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS packet_id_snapshot text NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS return_type_snapshot text NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS received_date date;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_due_date date;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS missing_item_amount numeric(12,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS claims_due_date_idx
  ON claims (claim_due_date) WHERE status <> 'submitted';

-- The original configurable Meesho template is upgraded only while it still has the foundation defaults.
UPDATE claim_template_fields f
SET field_label = 'Image of product received'
FROM claim_templates t
JOIN marketplaces m ON m.id = t.marketplace_id
WHERE f.template_id = t.id
  AND m.name = 'Meesho'
  AND f.field_key = 'product_images'
  AND f.field_label = 'Product images';

UPDATE claim_template_fields f
SET max_file_size_mb = 25
FROM claim_templates t
JOIN marketplaces m ON m.id = t.marketplace_id
WHERE f.template_id = t.id
  AND m.name = 'Meesho'
  AND f.field_key = 'unboxing_video'
  AND f.max_file_size_mb = 100;

INSERT INTO claim_template_fields
  (template_id, field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order)
SELECT t.id, v.field_key, v.field_label, v.field_type, v.required, v.min_count, v.max_count, v.max_file_size_mb, v.sort_order
FROM claim_templates t
JOIN marketplaces m ON m.id = t.marketplace_id
CROSS JOIN (VALUES
  ('barcode_image', 'Barcode image', 'image', false, 0, 1, 25, 1),
  ('reverse_waybill', 'Reverse waybill', 'image', true, 1, 1, 25, 3),
  ('attachments', 'Additional attachments', 'document', false, 0, 5, 25, 5)
) AS v(field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order)
WHERE m.name = 'Meesho'
  AND t.name = 'Default claim template'
ON CONFLICT (template_id, field_key) DO NOTHING;
