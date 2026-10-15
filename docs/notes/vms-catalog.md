# VMS catalogue sync (read-only source)

Status: written 2026-10-14 (OpenCode). Probed read-only against the live VMS
database (`sku_photos`: 3,387 rows, all with an image, scopes Shopify /
Flipkart / Meesho / Amazon Flex / Amazon Direct Fulfillment). Not yet run with
`--apply` against production data — that needs the user's approval.

## What it does

`npm run sync:vms-catalog` copies channel listing SKUs + image links from the
VMS `sku_photos` table into the local `product_master.image_url`, so scan
screens show catalogue photos without manual file uploads.

- **VMS is strictly read-only.** Every query goes through `queryVmsReadOnly`
  (`server/vms/db.ts`): a keyword guard refuses write-shaped SQL and each
  query runs inside `BEGIN READ ONLY`, so Postgres rejects writes natively.
  This module cannot edit or delete VMS data by construction.
- **Merge-only locally.** `--apply` fills *blank* `product_master.image_url`
  values matched by listing SKU (case-insensitive). It never creates rows
  (a VMS SKU without a stored listing still needs the listing→product mapping
  from the product master file or OMSGuru), never deletes, and never touches
  stored product SKUs, categories or existing images.
- **TLS stays verified.** `sslmode=no-verify` is refused. Pin the self-signed
  server certificate once with `--fetch-ca` (stored git-ignored at
  `certs/vms-ca.pem`, same precedent as `db-ca.pem`); the chain is verified
  against it on every connection.

## Commands

```bash
npm run sync:vms-catalog -- --help      # usage (connects to nothing)
npm run sync:vms-catalog -- --probe     # schema + masked catalogue sample (read-only, safe)
npm run sync:vms-catalog -- --dry-run   # counts of what would be filled (writes nothing)
npm run sync:vms-catalog -- --apply     # fill blank image links + write a run row
```

Schedule `--apply` daily (Windows Task Scheduler, like the OMSGuru jobs).
Each run writes one row to `vms_catalog_sync_runs` (`server/schema-vms.sql`).

## Measured 2026-10-14 (local database, read-only)

Local `product_master`: 4,363 rows, 2 without an image. VMS overlap: 46 exact
listing matches (0 blanks to fill locally). ~3,340 VMS SKUs are not in the
local master — the local master looks like a partial load next to production's
~34.8k rows, so the meaningful dry-run is against production data. The sync is
idempotent and safe to re-run daily.

## Limits (by design)

- VMS `sku_photos` has **no product/master SKU column**, so this sync cannot
  create listing→product mappings — only images. Unmapped listings still come
  from the product master file / OMSGuru flow.
- Image links that are not http(s) are left blank, never repaired.
