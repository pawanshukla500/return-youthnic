-- Claim Automation & Multi-Marketplace Evidence Templates
-- Additive only. Safe to re-run. Nothing is dropped or deleted. SCHEMA_VERSION is not bumped.

-- 1. Marketplace credentials for Windows Desktop EXE automation
CREATE TABLE IF NOT EXISTS marketplace_credentials (
  id serial PRIMARY KEY,
  marketplace_id integer REFERENCES marketplaces(id) ON DELETE SET NULL,
  account_name text NOT NULL CHECK (btrim(account_name) <> ''),
  portal_url text NOT NULL DEFAULT '',
  username_encrypted text NOT NULL DEFAULT '',
  password_encrypted text NOT NULL DEFAULT '',
  auth_state jsonb NOT NULL DEFAULT '{}',
  automation_mode text NOT NULL DEFAULT 'assisted',
  require_approval_before_submit boolean NOT NULL DEFAULT true,
  auto_prepare boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketplace_credentials_mkt_idx ON marketplace_credentials (marketplace_id);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_credentials_acc_uidx ON marketplace_credentials (account_name) WHERE is_active = true;

-- 2. Windows Desktop EXE Automation Agents (Heartbeats, online/offline status, versions)
CREATE TABLE IF NOT EXISTS claim_automation_agents (
  id serial PRIMARY KEY,
  agent_uuid text NOT NULL UNIQUE,
  agent_name text NOT NULL CHECK (btrim(agent_name) <> ''),
  hostname text NOT NULL DEFAULT '',
  platform text NOT NULL DEFAULT 'win32',
  version text NOT NULL DEFAULT '1.0.0',
  status text NOT NULL DEFAULT 'offline',
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  current_task_info jsonb NOT NULL DEFAULT '{}',
  api_key_hash text NOT NULL,
  is_authorized boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_automation_agents_status_idx ON claim_automation_agents (status);
CREATE INDEX IF NOT EXISTS claim_automation_agents_heartbeat_idx ON claim_automation_agents (last_heartbeat_at DESC);

-- 3. Claim Automation Jobs (Processing queue, browser execution, screenshots, approval)
CREATE TABLE IF NOT EXISTS claim_automation_jobs (
  id serial PRIMARY KEY,
  claim_id integer NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
  marketplace_credential_id integer REFERENCES marketplace_credentials(id) ON DELETE SET NULL,
  agent_id integer REFERENCES claim_automation_agents(id) ON DELETE SET NULL,
  stage text NOT NULL DEFAULT 'queued',
  browser_mode text NOT NULL DEFAULT 'visible',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  marketplace_claim_id text NOT NULL DEFAULT '',
  submission_screenshot_path text NOT NULL DEFAULT '',
  manual_action_reason text NOT NULL DEFAULT '',
  logs jsonb NOT NULL DEFAULT '[]',
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_automation_jobs_claim_idx ON claim_automation_jobs (claim_id);
CREATE INDEX IF NOT EXISTS claim_automation_jobs_stage_idx ON claim_automation_jobs (stage);
CREATE INDEX IF NOT EXISTS claim_automation_jobs_agent_idx ON claim_automation_jobs (agent_id);
CREATE INDEX IF NOT EXISTS claim_automation_jobs_stage_created_idx ON claim_automation_jobs (stage, created_at ASC) WHERE stage IN ('queued', 'approved');

-- 4. Additional claim snapshot and description fields on claims table
ALTER TABLE claims ADD COLUMN IF NOT EXISTS customer_name_snapshot text NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS total_price_snapshot numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS shipped_date date;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS sku_snapshot text NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_content text NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS manual_notes text NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS evidence_summary jsonb NOT NULL DEFAULT '{}';

-- 5. Seed default portal URLs and credentials placeholders for active marketplaces
INSERT INTO marketplace_credentials (marketplace_id, account_name, portal_url, automation_mode, require_approval_before_submit, auto_prepare)
SELECT m.id, m.name,
  CASE
    WHEN m.name = 'Meesho' THEN 'https://supplier.meesho.com/panel/v2/new/returns/claims'
    WHEN m.name = 'Flipkart' THEN 'https://seller.flipkart.com/index.html#dashboard/returns-v2'
    WHEN m.name LIKE 'Myntra%' THEN 'https://partners.myntra.com/returns'
    WHEN m.name = 'Ajio' THEN 'https://supplier.ajio.com/returns'
    WHEN m.name = 'Amazon' THEN 'https://sellercentral.amazon.in/safet-claims'
    ELSE 'https://supplier.portal.local'
  END,
  'assisted',
  true,
  true
FROM marketplaces m
WHERE m.name IN ('Myntra VB', 'Myntra EJ', 'Meesho', 'Ajio', 'Flipkart', 'Amazon')
ON CONFLICT DO NOTHING;

-- 6. Ensure default claim templates exist for all marketplaces
-- Myntra VB, Myntra EJ, Meesho, Ajio: Images + Unpacking Video
-- Flipkart: Images Only
INSERT INTO claim_templates (marketplace_id, name, description, is_active, sort_order)
SELECT m.id, 'Standard Claim Template', 'Default claim evidence template for ' || m.name, true, 1
FROM marketplaces m
WHERE m.name IN ('Myntra VB', 'Myntra EJ', 'Meesho', 'Ajio', 'Flipkart', 'Amazon')
ON CONFLICT DO NOTHING;

-- Standard evidence field slots for Myntra VB, Myntra EJ, Meesho, Ajio (Images + Unpacking Video)
INSERT INTO claim_template_fields (template_id, field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order)
SELECT t.id, v.field_key, v.field_label, v.field_type, v.required, v.min_count, v.max_count, v.max_file_size_mb, v.sort_order
FROM claim_templates t
JOIN marketplaces m ON m.id = t.marketplace_id
CROSS JOIN (VALUES
  ('product_images', 'Image of product received', 'image', true, 1, 10, 25, 1),
  ('barcode_image', 'Barcode Image', 'image', false, 0, 1, 25, 2),
  ('reverse_waybill', 'Reverse Waybill', 'image', true, 1, 1, 25, 3),
  ('unboxing_video', 'Unpacking Video', 'video', true, 1, 1, 100, 4),
  ('attachments', 'Attachments', 'document', false, 0, 5, 25, 5)
) AS v(field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order)
WHERE m.name IN ('Myntra VB', 'Myntra EJ', 'Ajio')
ON CONFLICT (template_id, field_key) DO NOTHING;

-- Standard evidence field slots for Flipkart (Images Only - No Unpacking Video)
INSERT INTO claim_template_fields (template_id, field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order)
SELECT t.id, v.field_key, v.field_label, v.field_type, v.required, v.min_count, v.max_count, v.max_file_size_mb, v.sort_order
FROM claim_templates t
JOIN marketplaces m ON m.id = t.marketplace_id
CROSS JOIN (VALUES
  ('product_images', 'Image of product received', 'image', true, 1, 10, 25, 1),
  ('barcode_image', 'Barcode Image', 'image', false, 0, 1, 25, 2),
  ('reverse_waybill', 'Reverse Waybill', 'image', true, 1, 1, 25, 3),
  ('attachments', 'Attachments', 'document', false, 0, 5, 25, 4)
) AS v(field_key, field_label, field_type, required, min_count, max_count, max_file_size_mb, sort_order)
WHERE m.name = 'Flipkart'
ON CONFLICT (template_id, field_key) DO NOTHING;
