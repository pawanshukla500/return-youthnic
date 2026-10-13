# Myntra EJ / VB: header notes, product join, rules, and audit

Last updated: 2026-10-08.

## Sources

| What | Where | Used for |
|---|---|---|
| Myntra seller returns report (the file called "Myntra EJ .xlsx") | `Desktop\mBIaRl6b_2026-10-08_Seller_Returns_Report_10708_2026-09-10_2026-10-07.csv` (same headers as the workbook) | Header names, sample values |
| Product master | `Desktop\VB EXPORT Product Category.xlsx` (not opened in this session) | Column names come from the DashBorad sync script, upload template, and test fixtures |
| Project rules | `Desktop\DashBorad Project\AGENTS.md` (invariant 1: seller accounts, invariant 5: VB EXPORT master) | Seller guard, blank-tracking rule |
| Myntra layout reference | `Desktop\DashBorad Project\backend\routes\myntraUpload.js` and `backend\tests\myntraLayoutMapping.test.js`, `docs\MYNTRA_HANDOFF.md` | Confirms the Return layout headers and rules below |
| OMSGuru | Not a file. The Forward Scan project reads it live over an API (`list_channel_listings`: SKU name, title, image) | Product title and photo. Not wired in this app yet (see open questions) |

## Account: the "Myntra EJ" file is the VB account

Seller ID 10708 is Myntra **VB**. Seller ID 45833 is Myntra **EJ**. The DashBorad handoff document says the same for its supplied files, which are rejected under EJ and accepted under VB.
This app enforces the rule: a file whose seller_id doesn't match the chosen marketplace is rejected with nothing saved.
So this sample is a VB file. The DashBorad project parses EJ and VB with the same return header list. That is evidence the layouts match, but a real EJ file has not been checked here.

## Your mapping, checked against the header row

| You said | Column | Header text | Used for |
|---|---|---|---|
| Tracking ID | AG (primary), AF | `return_tracking_number`, `forward_tracking_number` | Lookup key. Scanning either one finds the return |
| Order ID | S | `order_id` | Display. Digits are lost in the export |
| Order item ID | U | `order_line_id` | Stored per item. Also the key for cancelled rows |
| Channel listing ID | F | `seller_sku_code` | Matched to the product master |
| Qty | AA | `quantity` | `qty` |
| Return reason | AD | `return_reason` | Stored on the return |
| Product listing | VB EXPORT master, matched on `seller_sku_code` | | Item code becomes the master SKU |

Myntra header spellings vary between exports (`Seller_Id`, `seller id`, `seller_id`). Headers are normalized (case, spaces, and hyphens become underscores), so all of them match.

## All 40 headers in the seller returns report

| Col | Header | Used | Notes |
|---|---|---|---|
| A | seller_id | **guard** | 10708 = VB, 45833 = EJ. Every row must match the chosen account |
| B | warehouse_id | no | |
| C | partner_warehouse_code | no | |
| D | model | no | e.g. PPMP |
| E | myntra_sku_code | no | Myntra internal SKU |
| F | seller_sku_code | **yes** | Channel listing ID |
| G | style_id | no | |
| H | sku_id | no | Full digits in sample |
| I | brand | no | |
| J | order_created_date | no | M/D/YYYY text |
| K | inscanned_on | no | |
| L | fmpu_date | no | Often blank |
| M | order_delivered_date | no | |
| N | return_created_date | no | |
| O | refunded_date | no | |
| P | order_rto_date | no | |
| Q | is_refunded | no | 1 / blank |
| R | exchange_id | no | **Scientific notation in sample** |
| S | order_id | **yes** | **Scientific notation in sample**. Not a key |
| T | order_group_id | no | **Scientific notation in sample** |
| U | order_line_id | **yes** | Full digits in sample |
| V | seller_order_id | no | UUID |
| W | type | **yes** | "Return" |
| X | status | no | e.g. "Ret Delivered" |
| Y | store_packet_id | no | **Scientific notation in sample** |
| Z | seller_packet_id_fk | no | Often blank |
| AA | quantity | **yes** | |
| AB | return_id | no | **Scientific notation in sample** |
| AC | return_mode | no | e.g. OPEN_BOX_PICKUP |
| AD | return_reason | **yes** | Free text |
| AE | return_status | no | e.g. DLS |
| AF | forward_tracking_number | **yes** | Text, e.g. MYSP1470222521 |
| AG | return_tracking_number | **yes** | Text, e.g. MYSR1251334186 |
| AH | master_bag_id | no | |
| AI | lmdo_status | no | |
| AJ | lmdo_last_modified_on | no | Time-only values such as "09:07.0" |
| AK | gatepass_id | no | |
| AL | gatepass_status | no | |
| AM | gatepass_type | no | |
| AN | gatepass_lastmodified | no | |

## Problems found in the export

1. **Long IDs were already in scientific notation in the file.** Examples: `order_id` `1.00346E+11`, `1.00345E+11`; `exchange_id` `1.00354E+11`; `store_packet_id` `1.00016E+12`; `return_id` `1.0021E+11`. Only about 6 significant digits remain, so these can't be recovered. Two different orders have order IDs that look alike. **Don't key on `order_id`.** Scanning uses the text tracking columns.
   **Fix at source:** re-download with IDs as text, or request a text export from Myntra seller support.
2. **The old importer could not read this file.** It looked for `tracking_id` and `product_sku`. Neither exists.
3. **Display text vs stored value.** The old parser read Excel's display text, which produced `1.00346E+11` for long IDs. The new parser reads stored values and writes integers out in full. CSVs are read as raw text, so leading zeros survive.
4. **Excel and CSV wrappers.** IDs written as `="0012345"` or with a leading apostrophe are cleaned before matching.
5. One row per order line. A return tracking number can repeat across lines, so lines are grouped by tracking ID. The same SKU on one tracking ID is summed, and its order line IDs are joined with ", ".
6. `lmdo_last_modified_on` holds time-only values. Nothing depends on it.

## Rules applied

**Seller guard.** Every `seller_id` in the file must equal the chosen account's ID. One wrong row rejects the whole file, with zero rows saved.

**Blank tracking = cancelled before dispatch.** From the DashBorad project's rule (AGENTS.md invariant 1, and the Myntra layout code): a row with no tracking number is an order cancelled before dispatch. It is recorded as return type `Courier Return` with reason `Cancel Before Dispached` (that spelling is the one the project uses). It is stored in `cancelled_returns` for reporting. It has no AWB, so it is never scannable.
The DashBorad rule is written for order rows. This app applies it to return-report rows where both tracking columns are blank. That mapping is my reading of the rule. Check it against a real example.

**Product join (VB EXPORT master).**
- `seller_sku_code` is matched to `product_master` (listing SKU to master SKU).
- A listing matches only a row for the same marketplace, or an `all` row. One account's listing never resolves through another account's master.
- Matched rows use the master SKU as the item code. Unmatched rows keep the seller SKU code, and the preview lists them.
- Master columns read: `Marketplace SKU`, `VB EXPORT SKU's`, `VB Export Product Category`, `COGS (₹)`, `Weight Slab (kg)`, `Marketplace` (optional, defaults to `all`).
- Load it with the command below. Each run replaces the whole table.

```bash
npx tsx server/scripts/load-product-master.ts "C:\Users\Pawan Shukla\Desktop\VB EXPORT Product Category.xlsx"
```

**Replace on upload.** When you import a file for a marketplace, that upload becomes the only source for it:
- Unscanned `expected_returns` rows for that marketplace are deleted, with their items.
- Rows that already have a scan are **kept**, so scan history is never deleted. If the new file contains them, they are updated.
- Cancelled rows for that marketplace are replaced in full (they have no scans).
- Older upload batches for that marketplace are marked `Replaced`.
- Other marketplaces are not touched.

## Code changes (all unverified: see the bottom)

- `server/import-profiles.ts`: Myntra header map by name, seller IDs per account, one layout per marketplace.
- `server/sheets.ts`: reads CSV as text and XLSX as stored values. Normalizes headers. Rejects missing headers. Applies the seller guard. Flags digits already lost. Cleans `="..."` wrappers. Marks cancelled rows. Reads the product master.
- `server/schema-import.sql` (additive, runs every start): `alt_tracking_id`, `return_reason`, `order_line_id`, `channel_listing_id`, `product_master`, `cancelled_returns`.
- `server/db.ts`: runs `schema-import.sql` after `schema.sql`. Lists the new tables in the rebuild allowlist. `SCHEMA_VERSION` is deliberately **not** bumped, because a bump drops every app table.
- `server/index.ts`: preview joins the product master, reports unmatched listings, and counts cancelled rows. Import replaces returns and cancelled rows. Scan lookup and complete match either tracking column.
- `server/scripts/load-product-master.ts`: loads the VB EXPORT master.
- `src/marketplaces.ts`: one marketplace list (was typed out in three places).
- `src/ui.tsx`: shared `DataTable`, which takes column definitions.
- `src/App.tsx` split into `src/shell.tsx` (sidebar, header, loading and error states), `src/workspace.tsx` (shared context), `src/returns-table.tsx`, and one file per page in `src/pages/`:
  Login, Dashboard, ScanReturns, Reports, Claims, Uploads, Admin.
- All list views now use `DataTable`: overview and reports (returns), claims, admin users, and upload history.

## Panel and table audit

Before: six pages with six list patterns (returns table in two modes, a claims table, an admin users table, upload history as divs, admin cards, and admin lists).
After: one table component (`DataTable`) for all tables, one marketplace list, and one page per file.

Still not changed:
- Hardcoded demo data: login stats, claims recovery chart, reports pagination ("425"), chart month labels ("Jun").
- Dead buttons: overview "Last 7 days" and "View all", reports date and marketplace filters, admin "Add user", "Connect account", "Manage".
- Claims "Export" downloads returns, not claims.
- Issue types in the modal ("Used product", "Wrong product") are hardcoded. The server only special-cases two of the four.
- Several CSS classes are referenced (`upload-warnings`, `table-empty`) but not styled. The text still shows.

## Meesho

- The DashBorad Meesho upload handles **settlement** XLSX files ("Order Payments" sheet). That is not the returns CSV you described, and no Meesho returns sample exists in the files I could open.
- What the importer does for any CSV: reads every cell as text, so scientific notation and leading zeros aren't coerced. Warns when an ID has more than 15 digits. Rejects a tracking ID already in scientific notation, because its digits are gone.
- Digits already lost in a file **cannot be recovered**. The fix is a text re-export.

## Database URL

- `DATABASE_URL` is read from `.env` at the project root. I can't open `.env` (the secret guard blocks it), and `.env.example` leaves it blank.
- **Check it yourself:** run `npm run dev`. The console prints "PostgreSQL connected" or the connection error. Then open `http://localhost:3001/api/health`. It returns `{"ok":true,"database":"connected","name":"<database name>"}` and never includes the URL.
- The DashBorad project already has tables `sku_master`, `vb_sku_master`, `orders`, and `upload_log`. This app uses its own database. If both should share one, the product master could be read from there. Tell me which.

## Open questions

1. **Which account is this file?** It is seller 10708 (VB). Confirm, and rename the file to match.
2. **Blank-tracking rule.** I applied the DashBorad rule to return rows with no tracking number. Confirm that's the case you want, using one real example.
3. **Replace scope.** Scanned rows are kept. Should they be removed too?
4. **OMSGuru product title and photo.** The Forward Scan project fetches listing title and image from OMSGuru's API. This app doesn't have those yet. It needs OMSGuru API credentials for its own `.env`, or an export of the listing data. Which do you want?
5. **Samples needed:** a real Myntra EJ file (seller 45833), and a Meesho returns CSV (header row plus one sample).

## Data store structure (proposal, not built)

- **Raw upload layer.** `upload_batches` holds file metadata. Next: a header list per batch, so a header change is visible.
- **Reference masters.** `skus`, `marketplaces`, `product_master`. Next: move the header profiles from code into a table.
- **Operational.** `expected_returns`, `expected_return_items`, `receipt_scans`, `claim_tickets`, `evidence_events`, `cancelled_returns`.
- **Dashboard aggregates.** Most dashboard numbers are still seed values, not computed from data.

Risks:
- `expected_returns.tracking_id` is globally unique. If an AWB appears under both accounts, the later upload moves it silently.
- The import overwrites `skus.name` with the item label on every upload.

## Skills (agency-agents, installed locally)

Local copy: `C:\Users\Pawan Shukla\.claude\agents\`. I read the descriptions only.
Useful here: `engineering-data-engineer` (import design), `engineering-database-optimizer` (schema and indexes), `engineering-codebase-onboarding-engineer` (audit), `engineering-code-reviewer` (review of these changes), `design-ui-designer` (table system).

## Verification status

**Not run and not compiled.** This session had no shell, so the TypeScript build, the server, and the database have not been exercised. What was done instead: every import was checked against its export, and the new code was reviewed by hand. Run these:

```bash
npm run typecheck
```

```bash
npm run dev
```

Then:
1. Load the product master with the command above.
2. Upload the Myntra file as **Myntra VB**. Expect the preview to show the profile, how many listings mapped to the master, warnings for scientific-notation order IDs, and a count of cancelled rows (if any).
3. Upload it as **Myntra EJ**. Expect a rejection that names the seller mismatch, with nothing saved.
4. Scan an AG tracking number from the file, then an AF one. Both should find the same return.
5. Re-upload the same file. The earlier batch should show as Replaced, and unscanned rows should be replaced without duplicates.
