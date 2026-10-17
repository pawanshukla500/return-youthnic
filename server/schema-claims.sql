-- Claims foundation: configurable marketplace claim templates, claim lifecycle records with immutable
-- scanned-return snapshot linkage, secure Firebase-backed evidence media metadata, and audit history.
--
-- Additive only. Safe to re-run. Nothing is dropped, deleted, or rewritten. SCHEMA_VERSION is not bumped.
-- Account scope is enforced through the claim's marketplace_id (copied from the scan's expected_return).
-- Every status change is kept in claim_status_history. Media is marked active/inactive, never deleted.

-- ---------------------------------------------------------------------------------------------------------------
-- Claim templates: configurable per-marketplace, defining the evidence fields a claim needs.
-- Seeded once with editable defaults for the explicitly provided baseline. Admin can edit or create more.
-- marketplace_id NULL means the template applies to every marketplace (a fallback). A specific marketplace row
-- wins over the fallback.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim_templates (
  id serial PRIMARY KEY,
  marketplace_id integer REFERENCES marketplaces(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (btrim(name) <> ''),
  description text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_templates_marketplace_idx ON claim_templates (marketplace_id);
CREATE UNIQUE INDEX IF NOT EXISTS claim_templates_name_marketplace_uidx
  ON claim_templates (COALESCE(marketplace_id, 0), name);

-- Configurable field slots per template. Each field defines an evidence type the claim needs
-- (product images, unboxing video, AWB photo, etc.). Admin edits these; no code-level rules.
CREATE TABLE IF NOT EXISTS claim_template_fields (
  id serial PRIMARY KEY,
  template_id integer NOT NULL REFERENCES claim_templates(id) ON DELETE RESTRICT,
  field_key text NOT NULL CHECK (field_key ~ '^[a-z0-9_]+$'),
  field_label text NOT NULL CHECK (btrim(field_label) <> ''),
  field_type text NOT NULL DEFAULT 'image',
  required boolean NOT NULL DEFAULT true,
  min_count integer NOT NULL DEFAULT 1 CHECK (min_count >= 0),
  max_count integer NOT NULL DEFAULT 10 CHECK (max_count >= 1),
  max_file_size_mb integer NOT NULL DEFAULT 25 CHECK (max_file_size_mb BETWEEN 1 AND 100),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, field_key)
);
CREATE INDEX IF NOT EXISTS claim_template_fields_template_idx ON claim_template_fields (template_id, sort_order);
ALTER TABLE claim_template_fields ADD COLUMN IF NOT EXISTS max_file_size_mb integer NOT NULL DEFAULT 25;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'claim_template_fields'::regclass AND conname = 'claim_template_fields_type_check'
  ) THEN
    ALTER TABLE claim_template_fields ADD CONSTRAINT claim_template_fields_type_check
      CHECK (field_type IN ('image', 'video', 'document'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Claims: the lifecycle record. Each claim links immutably to one scanned return (receipt_scans.id).
-- The marketplace_id is copied from the scan's expected_return at creation time, so the claim stays scoped
-- even if the lookup data changes later. One claim per scan (unique index prevents duplicates).
-- Status lifecycle continues after marketplace submission through review, decision, reconciliation, and payout.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claims (
  id serial PRIMARY KEY,
  receipt_scan_id integer NOT NULL REFERENCES receipt_scans(id) ON DELETE RESTRICT,
  marketplace_id integer NOT NULL REFERENCES marketplaces(id) ON DELETE RESTRICT,
  claim_template_id integer REFERENCES claim_templates(id) ON DELETE SET NULL,
  claim_reason text NOT NULL CHECK (btrim(claim_reason) <> ''),
  claim_title text NOT NULL DEFAULT '',
  claim_description text NOT NULL DEFAULT '',
  remarks text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending_evidence',
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS claims_receipt_scan_uidx ON claims (receipt_scan_id);
CREATE INDEX IF NOT EXISTS claims_marketplace_idx ON claims (marketplace_id);
CREATE INDEX IF NOT EXISTS claims_status_idx ON claims (status);
CREATE INDEX IF NOT EXISTS claims_created_at_idx ON claims (created_at DESC);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_title text NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS approved_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS paid_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS payout_reference text NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS payout_date date;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'claims'::regclass
      AND conname = 'claims_status_check'
      AND pg_get_constraintdef(oid) NOT ILIKE '%paid%'
  ) THEN
    ALTER TABLE claims DROP CONSTRAINT claims_status_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'claims'::regclass AND conname = 'claims_status_check'
  ) THEN
    ALTER TABLE claims ADD CONSTRAINT claims_status_check
      CHECK (status IN (
        'pending_evidence',
        'ready_for_claim',
        'waiting_for_approval',
        'processing',
        'submitted',
        'under_review',
        'approved',
        'rejected',
        'reconciled',
        'paid',
        'reclaim',
        'escalated',
        'failed',
        'manual_action_required'
      )) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Claim media metadata: one row per evidence file. Stores the Firebase/GCS storage object path, content hash,
-- file size, MIME type, capture and upload times, the user who uploaded it, an active marker (soft delete),
-- and a retention date (24 months from upload). No direct public links are stored or returned.
-- The actual file bytes live in Firebase Storage; this table holds only metadata for scoped retrieval.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim_media (
  id serial PRIMARY KEY,
  claim_id integer NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
  field_key text NOT NULL,
  storage_object_path text NOT NULL CHECK (btrim(storage_object_path) <> ''),
  content_hash text NOT NULL DEFAULT '',
  size_bytes bigint NOT NULL DEFAULT 0,
  mime_type text NOT NULL DEFAULT '',
  original_filename text NOT NULL DEFAULT '',
  captured_at timestamptz,
  uploaded_by integer NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  retention_until date NOT NULL DEFAULT (current_date + INTERVAL '24 months'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_media_claim_idx ON claim_media (claim_id);
CREATE INDEX IF NOT EXISTS claim_media_field_idx ON claim_media (claim_id, field_key);
CREATE INDEX IF NOT EXISTS claim_media_active_idx ON claim_media (claim_id) WHERE is_active = true;
CREATE UNIQUE INDEX IF NOT EXISTS claim_media_active_hash_uidx
  ON claim_media (claim_id, content_hash) WHERE is_active = true AND content_hash <> '';

-- ---------------------------------------------------------------------------------------------------------------
-- Claim status history: every status change is kept, oldest first. The first row has an empty from_status.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim_status_history (
  id bigserial PRIMARY KEY,
  claim_id integer NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL DEFAULT '',
  changed_by integer REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_status_history_claim_idx ON claim_status_history (claim_id, changed_at);

-- ---------------------------------------------------------------------------------------------------------------
-- Seed editable marketplace defaults for the explicitly provided baseline only.
-- Myntra VB/EJ, Meesho, Ajio: images + unpacking video.
-- Flipkart: images only.
-- These are seeds with ON CONFLICT DO NOTHING, so Admin edits are kept. No code-level rules.
-- ---------------------------------------------------------------------------------------------------------------
INSERT INTO claim_templates (marketplace_id, name, description, is_active, sort_order)
SELECT m.id, 'Default claim template', 'Standard claim evidence for this marketplace.', true, 1
FROM marketplaces m
WHERE m.name IN ('Myntra VB', 'Myntra EJ', 'Meesho', 'Ajio', 'Flipkart')
ON CONFLICT DO NOTHING;

-- Fields for Myntra VB, Myntra EJ, Meesho, Ajio: product images + unboxing video.
INSERT INTO claim_template_fields (template_id, field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order)
SELECT t.id, v.field_key, v.field_label, v.field_type, v.required, v.min_count, v.max_count, v.max_file_size_mb, v.sort_order
FROM claim_templates t
JOIN marketplaces m ON m.id = t.marketplace_id
CROSS JOIN (VALUES
  ('product_images', 'Product images', 'image', true, 1, 10, 25, 1),
  ('unboxing_video', 'Unboxing video', 'video', true, 1, 1, 100, 2)
) AS v(field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order)
WHERE m.name IN ('Myntra VB', 'Myntra EJ', 'Meesho', 'Ajio')
ON CONFLICT (template_id, field_key) DO NOTHING;

-- Fields for Flipkart: product images only.
INSERT INTO claim_template_fields (template_id, field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order)
SELECT t.id, 'product_images', 'Product images', 'image', true, 1, 10, 25, 1
FROM claim_templates t
JOIN marketplaces m ON m.id = t.marketplace_id
WHERE m.name = 'Flipkart'
ON CONFLICT (template_id, field_key) DO NOTHING;
