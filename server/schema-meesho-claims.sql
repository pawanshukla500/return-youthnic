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

-- Ensure all Meesho templates have the exact 5 portal fields configured with 25MB limit
INSERT INTO claim_template_fields
  (template_id, field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order)
SELECT t.id, v.field_key, v.field_label, v.field_type, v.required, v.min_count, v.max_count, v.max_file_size_mb, v.sort_order
FROM claim_templates t
JOIN marketplaces m ON m.id = t.marketplace_id
CROSS JOIN (VALUES
  ('barcode_image', 'Barcode Image', 'image', false, 0, 1, 25, 1),
  ('product_images', 'Image of product received', 'image', true, 1, 10, 25, 2),
  ('reverse_waybill', 'Reverse Waybill', 'image', true, 1, 1, 25, 3),
  ('unboxing_video', 'Unpacking Video', 'video', true, 1, 1, 25, 4),
  ('attachments', 'Attachments', 'document', false, 0, 5, 25, 5)
) AS v(field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order)
WHERE m.name = 'Meesho'
ON CONFLICT (template_id, field_key) DO UPDATE SET
  field_label = EXCLUDED.field_label,
  max_file_size_mb = EXCLUDED.max_file_size_mb,
  required = EXCLUDED.required,
  min_count = EXCLUDED.min_count,
  max_count = EXCLUDED.max_count,
  sort_order = EXCLUDED.sort_order;
