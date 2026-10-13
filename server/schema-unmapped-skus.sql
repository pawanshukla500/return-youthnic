-- schema-unmapped-skus.sql: Additive registry for unmapped listing SKUs
-- Stores marketplace listing SKUs found in returns or scans that lack a Product Master mapping.
-- Allows downloading a pre-filled CSV template for easy mapping and upload back to Product Master.

CREATE TABLE IF NOT EXISTS unmapped_listing_skus (
  id serial PRIMARY KEY,
  marketplace text NOT NULL,
  listing_sku text NOT NULL,
  sample_order_number text NOT NULL DEFAULT '',
  sample_tracking_id text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'unmapped', -- 'unmapped' | 'mapped' | 'ignored'
  UNIQUE(marketplace, listing_sku)
);

CREATE INDEX IF NOT EXISTS unmapped_listing_skus_lookup_idx
  ON unmapped_listing_skus (marketplace, listing_sku);

CREATE INDEX IF NOT EXISTS unmapped_listing_skus_status_idx
  ON unmapped_listing_skus (status);
