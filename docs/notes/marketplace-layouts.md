# Marketplace return layouts: Flipkart, Meesho, Myntra, Ajio

Last updated: 2026-10-10. The Flipkart, Meesho and Myntra file facts below were checked on 2026-10-08. The Ajio file was parsed read-only on 2026-10-10. The activation section was corrected on 2026-10-10 to match the code.

## What this covers

The three return reports on the Desktop:

- `Flipkart.csv`
- `Meesho.csv`
- `mBIaRl6b_2026-10-08_Seller_Returns_Report_10708_2026-09-10_2026-10-07.csv` (the Myntra file you called "Myntra EJ .xlsx"; the Excel workbook itself could not be read from here, so the CSV is what was checked)
- `Ajio return .xlsx`

How it was checked:

1. Exact counts on each file, by text search. These are counts of lines, not a full parse. Counts were confirmed on the files directly.
2. A reading of `server/sheets.ts` (the row mapping, the seller guard, and the warnings) and `server/import-profiles.ts` (the header maps).

Nothing has been run through the importer yet. Run `npm run typecheck`, `npm run build` and `npm test` first, then upload each file and check the preview.

## Summary

- All three are return lists exported from the marketplace seller portals. Each row is one returned item line.
- The scanner reads the return AWB on the parcel, so the AWB is the lookup key. The other columns are for checking the item and for reporting.
- **Flipkart** (1,152 rows): every row is a completed return (return status "delivered", completion "Closed"). The IDs are clean: no scientific notation, no blank tracking IDs.
- **Meesho** (1,708 rows): the AWB format depends on the courier, and there are five named couriers. The supplier ID sits in a block above the header. The IDs are quoted text and clean.
- **Myntra** (6,573 rows): `order_id` is in scientific notation on every row, so the preview will warn on every row. 2,127 rows have no return AWB, and 2,116 of those are RTO rows. Forward AWBs come in several prefixes.
- **Ajio** (246 rows): the workbook matches the profile. 208 rows are valid; 38 are refused because 24 have no `Return AWB No` and 20 have a quantity that is not a whole number of 1 or more (six rows have both problems). The return types are `RVP` (140), `RTO` (76) and `REPL` (30).
- **Two things need a decision before the next upload:** (1) which Myntra seller ID is VB and which is EJ, and (2) whether the activation rule is right for reports that cover a date window.

## Account and seller guard

| Marketplace | Account ID in the file | Guard in code | Status |
|---|---|---|---|
| Myntra VB | `seller_id` 10708 on every row | 10708 = Myntra VB | Mapping unconfirmed (see below) |
| Myntra EJ | `seller_id` 45833 | 45833 = Myntra EJ | No 45833 rows in this file |
| Meesho | `Supplier ID` 10874 in the block above the header | 10874 = Meesho | Matches |
| Flipkart | none in the file | none | No guard. Accepts any Flipkart file |

A file whose seller ID does not match the chosen account is refused before any row is saved. The preview returns it as `fatal`, with the reason and the account IDs.

**Myntra mapping conflict.** The app maps 10708 to Myntra VB. This file's rows are:

- brand "Ethnic Junction": 2,362 rows
- brand "Sangria": 2,566 rows
- brand "KALINI": present (not counted)

You called the file "Myntra EJ", so the name, the brands, and the app's mapping don't agree. Check the seller ID for this export in the Myntra seller portal. Until that's confirmed, don't rely on the Myntra guard. Uploading this file as "Myntra EJ" will be refused by the guard, with nothing saved.

## Activation: the risk in these three files

The rule in the code (see CLAUDE.md, "Activation, not replacement"): when a file is activated for an account, the account's previous active lookup rows become `superseded`. They are kept, because scans refer to them. But a superseded row is no longer scannable. Scanned rows stay in the register. Cancelled-before-dispatch rows for the account are replaced in full.

So an activated file defines the account's open returns. Any open return that is not in the file stops being scannable after the activation, even though its row is kept.

That rule assumes each file is the complete list of open returns. These files don't look like that:

- **Myntra:** the filename gives the window 2026-09-10 to 2026-10-07. Returns created before 10 September are not in the file. If any of them are still open, activating this file makes them unscannable.
- **Flipkart:** all 1,152 rows are completed returns (5 to 8 October in the sample). It is not an open list. Activating it makes every other open Flipkart return unscannable.
- **Meesho:** a snapshot downloaded on 7 October. Open returns not in it would become unscannable.

**Decision needed:** either every activation must be the full open list for that marketplace, or activation must leave rows outside the file's date window alone. The current rule can make valid expected returns unscannable. This decision is also listed in CLAUDE.md under Pending.

---

## Flipkart (verified on the file)

- **Rows:** 1,152 data rows.
- **Columns:** 43. The earlier note and the comment in `import-profiles.ts` said 42. That is wrong.
- **Physical lines:** 1,185. The extra 32 are line breaks inside the `Comments` field. The CSV reader keeps each record whole, so the row count stays at 1,152.
- **Return type** (`Return Type` column):
  - `customer_return`: 651 rows. Tracking IDs start `FMPR`.
  - `courier_return`: 501 rows. Tracking IDs start `FMPC` (405) or `FMPP` (96).
  - The counts add up exactly.
- **Status:** `Return Status` is "delivered" and `Completion Status` is "Closed" on all 1,152 rows. The file lists returns that have already come back to the seller, not returns still in transit.
- **Return reasons** (counted): `order_cancelled` 299, `mind_changed` 99, `shield_cancellation` 6. The other reasons were not counted.
  - "Order cancelled" appears on courier returns that have a tracking ID. These are real returns, not cancellations before dispatch.
  - The Myntra cancelled-before-dispatch rule must not apply to Flipkart. The code does not apply it to Flipkart.
- **Courier (`Vendor Name`):** `flipkartlogistics` including `-cod` 1,105; `shadowfax` 30; `delhivery-cod` and `expressbees` (cod and prepaid) 17 in total.
- **Location:** one location on every row, "SURAT : 395017".
- **Scientific notation:** none. **Blank tracking IDs:** none.
- **Dates:** text, such as "6 October, 2026". Invoice dates are DD-MM-YYYY, such as "08-10-2026".
- **Redacted at import:** `Customer GSTIN` and `Customer Company Name`. Two rows contain a GSTIN-shaped value. The values are not printed here.
- **Kept:** `Comments`. This is free text written by the buyer, and it may contain personal details.
- **What the code does** (`flipkartRow` in `server/sheets.ts`):
  - tracking ID = `Tracking ID`, uppercased
  - order line ID = `Order Item ID`
  - item SKU = `SKU`
  - return type: `courier_return` becomes "RTO", `customer_return` becomes "Customer Return"
  - reason = the reason code made readable, plus " · " and the sub-reason

## Meesho (verified on the file)

- **Rows:** 1,708 data rows, 22 columns.
- **Preamble:** 8 lines before the header. Line 2 is the panel title. Line 3 is `Supplier ID` 10874, which is the seller check. Line 4 is the supplier's registered name (a person's name). Line 5 is a business email address. Line 6 is the download time, as epoch milliseconds: 1791373407000 is 7 October 2026 at 17:13 IST. Lines 1 and 7 are blank. The header is on line 8.
  - Only the supplier ID is used. The name and email are read in memory and not stored. That is correct.
- **Return type** (`Type of Return`) and sub-type (`Sub Type`):
  - `Customer Return`: 1,369 rows. Sub-types `FIRST_RET` 1,353 and `SECOND_RET` 16.
  - `Courier Return (RTO)`: 339 rows. Sub-type `forward_RTO` 337, and 2 others. The label is written in full, so an exact-match search for "Courier Return" finds nothing. The earlier note was right about this.
- **Courier and AWB format** (`Courier Partner`, `AWB Number`):

  | Courier | Rows | AWB format in the sample |
  |---|---|---|
  | Shadowfax | 559 | `R` or `SF` prefix, then digits, ending `FPL` (485) or `MEO` (74) |
  | Valmo | 508 | `VLR` followed by letters and digits |
  | PocketShip | 221 | `VL` followed by 13 digits |
  | Delhivery | 269 | 16 digits |
  | Xpress Bees | 145 | 13 or 14 digits |
  | Not identified | 6 | not checked |

- **Scientific notation:** none. **Blank AWBs** on Shadowfax and Valmo rows: none.
- **16-digit AWBs:** 269 (the Delhivery rows). The importer warns on each one ("more than 15 digits; confirm stored as text"). In the file these are quoted text, so the digits are intact. The warning is a false alarm for this file.
- **Other IDs:** `Order Number` and `Suborder Number` (`<order>_1`) are quoted text.
- **Not used:** `Meesho PID` (blank in the sample), `Category`, `Variation`, `Dispatch Date`, `OTP verified at`, and `Return Price Type` ("Meesho Price").
- **Kept in raw data:** `Tracking Link` (it contains the AWB) and `Proof of Delivery` (a PDF link on a storage bucket). Meesho has no redaction list, so these are stored in `upload_rows`. Whether to keep them is an open decision.
- **What the code does** (`meeshoRow`): tracking ID = `AWB Number`, order line ID = `Suborder Number`, reason = `Return Reason` plus " · " plus `Detailed Return Reason`. In the sample, the return reason is "Don't need the product anymore" and the detailed reason is "Changed my mind". The earlier example in the notes had the two in a different form.

## Myntra seller returns (verified on the CSV)

- **File:** `mBIaRl6b_2026-10-08_Seller_Returns_Report_10708_2026-09-10_2026-10-07.csv`.
- **Rows:** 6,573. **Columns:** 40, matching `docs/notes/myntra-ej-vb-headers.md`. The file has no quoted fields, so every comma separates two columns.
- **Account:** `seller_id` is 10708 on all 6,573 rows. There are no 45833 rows. See the mapping conflict above.
- **Type** (`type`): `Return` 4,457; `RTO` 2,116.
- **Status** (`status`): `Ret Delivered` 3,395; `Ret Dispatched` 36. Other values (for example `Ret Created` and `RTO Created`) were not counted. `status` is the column the lifecycle counts use.
- **Return status** (`return_status`): `DLS` on 2,972 rows.
- **Return tracking** (`return_tracking_number`, column AG):
  - non-blank on 4,446 rows. Most begin `MYSR`, and 4,144 rows contain `MYSR`. The rest were not characterised.
  - blank on 2,127 rows: the 2,116 RTO rows, plus 11 others.
  - Every `Ret Delivered` row has a return tracking number.
- **Forward tracking** (`forward_tracking_number`, column AF): never blank. Prefixes, by row:
  - `MYSP` or `MYSC`: 5,184
  - `MYE` followed by a letter (sample `MYEC…`): 1,151
  - `SF` and ending in `F` (sample `SF…F`): 58
  - `MYS` followed by a character other than P or C: 151 (not checked further)
  - anything else: 29
  - The earlier note named only `MYSP` and `MYSC`. That was incomplete.
- **Scientific notation:** `order_id` is in scientific notation on all 6,573 rows, for example `1.00346E+11`. Only about six significant digits remain, so it is not usable as a key. `exchange_id`, `order_group_id`, `store_packet_id`, and `return_id` are also affected on many rows.
- **Cancelled-before-dispatch rule:** zero rows have both tracking columns blank. The rule as coded (both blank, and an order line ID present) matches nothing in this file. The blank return-tracking rows are RTO returns. They have a forward AWB, so they are kept as expected returns and matched on that AWB. The notes and CLAUDE.md described blank tracking as "cancelled", which is wrong for these rows.
- **What the code does** (`myntraRow`):
  - tracking ID = return tracking (AG), or forward tracking (AF) if AG is blank
  - the other column is kept as `altTrackingId` when both are present and differ
  - cancelled = both blank and an order line ID present. A row with both blank and no order line is an error.
  - item SKU = `seller_sku_code` until the product master is joined
  - the preview shows one warning per row for `order_id`, which is 6,573 warnings for this file.

## Ajio returns (verified on the real workbook)

- **File:** `Ajio return .xlsx`; 246 data rows and 51 columns.
- **Headers:** the required headers are present. The return type column is `return_type` (`Return Type`), and the carrier column is `return_carrier_name` (`Return Carrier Name`).
- **Lookup:** `Return AWB No` is the lookup key. Rows with a blank AWB cannot be activated and must not be repaired with a guessed value.
- **Quantity:** `Return QTY` must be a whole number of 1 or more. The file has 20 rows with `0`; those rows are refused. Do not change `0` to `1` unless the source report confirms one unit.
- **Return types:** `RVP` becomes Customer Return, `RTO` becomes RTO, and `REPL` becomes Replacement Order.
- **Carriers:** `SHADOWFAX` 86, `XPRESSBEES` 57, `BLUEDART` 45, `DELHIVERY` 34, and blank 24. The mapper now reads `Return Carrier Name`. Shadowfax, Xpress Bees and Delhivery match the seeded aliases; Blue Dart still needs an administrator to add/alias it if it should be treated as a verified partner.
- **Product mapping:** before the product master is loaded, all 124 distinct Ajio listing SKUs are unresolved because the current `product_master`, `sku_catalog`, `oms_listings` and `oms_skus` tables are empty. Comparing the file offline with `Product SKU Codes.xlsx` finds 43 of those 124 listing SKUs (131 of 246 rows); the remaining 81 need a master or OMSGuru mapping.
- **No reformat is needed:** keep the Ajio workbook's original table and column names. Load the product master separately in Admin before previewing the return file again.

## Problems and risks across the four files

1. **Return type vocabulary is inconsistent.**
   - Myntra: `Return`, `RTO`
   - Flipkart: `Customer Return`, `Courier Return`
   - Meesho: `Customer Return`, `Courier Return (RTO)`
   - Myntra cancelled rows: stored as `Courier Return`

   So "Courier Return" means both a courier return and a cancellation before dispatch. Reports that group by return type will mix them. The normalized vocabulary is Customer Return, RTO and Replacement Order. Decide the label for cancelled-before-dispatch rows (see CLAUDE.md, Pending).
2. **Warnings are noisy.** Myntra gives 6,573 warnings, one per row, for `order_id`. Meesho gives 269, for the 16-digit AWBs. Both are correct statements, but they hide any real problem. Suggested: one summary per file, and no warning for Meesho quoted AWBs.
3. **Stages differ by file.** Flipkart rows are all delivered and closed. Myntra rows run from created to dispatched to delivered, and RTO rows have a different path. Meesho has a delivered date but no status column. The scan screen should show whether an item is expected or has arrived.
4. **Duplicate tracking IDs within a file were not counted.** The notes say Myntra tracking numbers repeat across lines, and the code groups them. Check the duplicate count on the preview.
5. **Tracking uniqueness is per account.** The lookup treats a tracking ID as unique within an account among active rows, and the same AWB can exist in two accounts. If an AWB is in two accounts, a scanner is asked to choose. A later upload to one account does not change the other.

## PII and sensitive data

- **Meesho preamble:** a registered name and an email address. Not stored. Correct.
- **Meesho `Tracking Link` and `Proof of Delivery`:** stored in `upload_rows` raw data. Open decision.
- **Flipkart `Customer GSTIN` and `Customer Company Name`:** removed at import. Correct.
- **Flipkart `Comments`:** buyer free text, kept. Open decision.
- **Myntra:** no buyer fields in the file.

## Corrections to the earlier notes

| Earlier note said | Verified |
|---|---|
| Flipkart: 42 columns | 43 columns (also in the comment in `import-profiles.ts`) |
| Meesho: courier partners Shadowfax and Valmo | Five named couriers, plus 6 rows not identified |
| Meesho: Shadowfax AWBs `R…FPL` and `SF…FPL` | Shadowfax AWBs also end in `MEO` (74 rows) |
| Meesho: type "Courier Return, RTO (339)" | Correct: the label is "Courier Return (RTO)", sub-type `forward_RTO` |
| Myntra: forward AWBs `MYSP` and `MYSC` | Also `MYE…`, `SF…F`, and other prefixes |
| Myntra: blank tracking means cancelled before dispatch | Blank return tracking means RTO here. Cancelled (both blank) matches zero rows |
| Myntra: some order IDs in scientific notation | All 6,573 rows |
| Myntra file is VB (10708) | Unconfirmed. Brands and file name conflict with the mapping |
| Flipkart: one tracking format | `FMPR` for customer returns; `FMPC` and `FMPP` for courier returns |
| Replace on upload deletes unscanned rows | Activation supersedes them. They are kept, but they are no longer scannable (2026-10-10) |

## Open decisions

1. Which Myntra seller ID is VB, and which is EJ. Check in the Myntra seller portal.
2. Activation: the full open list every time, or activation that leaves rows outside the file's date window alone.
3. The Myntra cancelled rule. Confirm it with a real example, because this file has no row that matches it.
4. Whether to keep Meesho `Tracking Link` and `Proof of Delivery` in stored data.
5. Whether to keep Flipkart `Comments` (buyer free text).
6. Whether to suppress the 16-digit warning for Meesho quoted AWBs.
7. The return type vocabulary (see Problems, item 1).
8. Flipkart seller or vendor ID. The file has none, so Flipkart files are not checked against an account.
9. Which courier the 6 unidentified Meesho rows belong to. This is low priority.

## Not verified

- The local typecheck, build and automated tests have run. The Ajio workbook was parsed read-only; no marketplace return file was activated. The other real files have not been run through the importer.
- Duplicate tracking IDs within each file were not counted.
- The Myntra Excel workbook was not read. Only the CSV was checked.
- The Myntra EJ header note (`myntra-ej-vb-headers.md`) still says this sample is a VB file. This note supersedes it on that point.
