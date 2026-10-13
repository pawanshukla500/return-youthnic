# Product SKU master upload

What was added on 2026-10-10 (second session), and what is verified.

## What it does

The VB EXPORT product master (`product_master`) maps a channel listing SKU to a VB EXPORT product SKU, with its
category and its channel image link. It is the first source used to resolve the product SKU of a return line, ahead of
the OMSGuru master (`resolveProductSkus` in `server/lookup-import.ts`).

It can be loaded two ways:

- `npm run load:master -- "<file>"` (`server/scripts/load-product-master.ts`).
- Admin, tab **Product SKU master**: preview a file, then replace the whole master (`server/product-master-routes.ts`).

Both replace the **whole** table in one transaction. The change is written to `register_audit_log`
(`product_master.replace`). Nothing in scan history is touched.

## Accepted layouts

Matched by header name, never by column letter (`parseProductMaster` in `server/sheets.ts`):

- **Product SKU Codes** (the file the user supplied, `Product SKU Codes.xlsx`): `Channel Listing SKU Code`,
  `Product SkuCode`, `Product Category`, `Channel Image URL`.
- **VB EXPORT product category workbook** (the older file): `Marketplace SKU`, `VB EXPORT SKU's`,
  `VB Export Product Category`, `COGS`, `Weight Slab`, and an optional `Marketplace` scope column.

## Marketplace scope

The same Channel Listing SKU can map to a different product SKU on different marketplaces, so each row has a
marketplace scope. The scope comes from, in order:

1. the account chosen for the load (the Admin selector, or `--marketplace` on the CLI);
2. a `Marketplace` column in the file;
3. `all`, which applies to every account.

A `Marketplace` column is **not required**, and nothing blocks on it. The supplied `Product SKU Codes.xlsx` has no such
column, so it loads as `all` (verified: all 34,795 rows stored under `all`).

The product SKU lookup then uses the account's own rows first and falls back to the `all` rows, so a specific mapping
is **never blocked** by the fallback. A row for a different account is never used. This is `marketplaceRank` in
`server/marketplace-rules.ts`:

| Rank | Scope vs the account being scanned | Example |
|---|---|---|
| 3 | exact account name | `myntra vb` for `Myntra VB` |
| 2 | a scope that names the account as a whole word | `myntra` for `Myntra VB` |
| 1 | `all`, or a blank scope | applies to every account |
| 0 | a different account | never used |

The match is whole-word only, so a short scope such as `ej` does not leak to `Myntra VB`.

## How a listing SKU is found after the file is loaded

`masterSkusForListings` (`server/lookup-import.ts`) reads the master for the rows on screen. It does not rewrite a saved scan.

The comparison ignores spaces, so `Bottle Green` and `BottleGreen` are the same key. A trailing token that is not a size is also tried without that token:

- `B126-kabira-Bottle Green_S_A` is also searched as `B126-kabira-Bottle Green_S`.
- `T86-Coffee-Rust_M_Al` is also searched as `T86-Coffee-Rust_M`.
- `_XL`, `_S`, `_M`, `_L` and the other size tokens are not removed.

An exact compact match beats the parent. A row for the account beats an `all` row. A row for another account is not used.

The scan lookup and the register use this when the stored product SKU is empty. When the stored image is empty, the scan also takes the master's image link and shows it through `GET /api/catalog-image`.

On 2026-10-11 the user had loaded the master from Admin. A read of `product_master` found `b126-kabira-bottlegreen_s` and `t86-coffee-rust_m`, and counted 34,574 https image links, 185 http links, and 36 empty links. Do not replace the table unless the user asks.

## Rules

- A row needs both a listing SKU and a product SKU. A row missing either is skipped and counted, never repaired.
- An image cell that is not an http(s) link is left blank and counted as `invalidImages`. It is never repaired.
- A repeated listing SKU on the same scope keeps the last row, and is counted as a **conflict** when the product SKUs
  disagree. The preview lists up to 20. A conflict is not a blocker; it is shown so a wrong mapping is never silent.
- The file's image link **wins** over the OMSGuru catalog image for the same listing SKU. The lookup collects the
  catalog image first, then overwrites it with the product master's link.

## Whitespace inside a SKU merges two SKUs (known issue)

A listing SKU and a product SKU are read with `cleanId`, which drops **all** whitespace. This is intended for numeric
identifiers (an AWB written `1234 5678`), but it is wrong for SKUs that contain a meaningful space.

The real `Product SKU Codes.xlsx` shows the effect: 35,064 rows hold 35,064 distinct listing SKUs, but only 34,795
distinct keys after the space is dropped. 269 keys collapse two rows into one, and for **9** of them the two rows give
**different** product SKUs. Examples:

| Listing SKU in the file | Product SKU in the file |
|---|---|
| `KD4- Bahara_M` | `KD4-Bahara-Navy_M` |
| `KD4-Bahara_M` | `KD4-Bahara-Grey_M` |

These are different products (Navy and Grey). With whitespace dropped, both become `KD4-Bahara_M`, and the last row
wins, so one of the two is mapped to the other's product SKU. The same happens for `KD4- Bahara_S/L/XL/XXL`.

The upload **reports** these 9 conflicts in the preview (`conflictCount`, `conflictSample`) and the CLI prints them, so
they are never silent. They are **not** fixed automatically.

**Not fixed here, and needs a decision.** A correct fix is to normalize a SKU the same way on both sides of the join
(the return file's listing SKU and `product_master.listing_sku`) while keeping a single internal space, for example by
trimming and collapsing runs of whitespace instead of deleting them. That changes matching for every marketplace and
for the scan lookup, and it changes the key stored on existing `expected_returns` rows, so it is a separate change.

## Verified

- `Product SKU Codes.xlsx` on the Desktop was read directly: 35,064 data rows, 10,496 distinct product SKUs, headers
  `Channel Listing SKU Code` / `Product SkuCode` / `Product Category` / `Channel Image URL`. 10,354 rows have the same
  listing SKU and product SKU. `Product Category` holds whole numbers (for example `28`) in some rows and text in
  others; both are kept as text.
- The real file was passed through `parseProductMaster`: 34,795 rows kept, 34,759 with an image link, 36 image links
  left blank (they are not http(s)), 0 skipped, and 9 conflicts reported. Every row's scope is `all`, because the file
  has no `Marketplace` column.
- `npm run typecheck` and `npm run build` pass with the new code.
- Fourteen new tests pass (`npm test`): the Product SKU Codes layout and its image link, a non-http link left blank and
  counted, the preview counts, the fatal when the listing and product SKU columns are the same, the two conflict cases
  (a repeated listing SKU with a different product SKU, and two SKUs that differ only by a space), the marketplace
  scope chosen for the load, the chosen marketplace overriding a file column, the preview's scope list, and
  `marketplaceRank` (exact account, scope that names the account, `all`, another account, and whole-word matching). All
  use synthetic `SYN-*` values.
- The `product_master.image_url` column was created on a real start (additive `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS`), verified by querying `information_schema.columns`.
- The whole load path was exercised against the real database with the real file, in a transaction that was then
  **rolled back**: 34,795 rows inserted, 34,759 with an image link, all scoped `all`, and `product_master` was empty
  again after the rollback. So the insert works without a marketplace column, and no data was changed by the test.

## Not verified

- The Admin "Product SKU master" tab has **not** been opened in a browser.
- The real file has **not** been committed to the database (the check above rolled back). Load it from Admin's
  "Product SKU master" tab, or with `npm run load:master -- "<file>"`.
- The effect of the file's image link on the scan screen's catalog image has not been seen in a browser.
- The 9 whitespace conflicts are reported but not resolved.
