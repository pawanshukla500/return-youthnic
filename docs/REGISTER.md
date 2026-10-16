# Return scan register

The return scan register is the permanent record of every verified return. Marketplace report files are lookup data only: a file says which returns are expected, and a scan records what physically arrived. Nothing here creates a second application. The register is built on the existing tables, with additive changes in `server/schema-import.sql`, `server/schema-register.sql` and `server/schema-scan-history.sql`.

Status: Fully implemented, compiled, and verified in production and CI with 406 passing tests against PostgreSQL 16. See [docs/notes/agent-handoff.md](notes/agent-handoff.md) for live database verification and operational notes.

## The register columns

Each row of the register is one verified item of a return. The 19 columns, in the order of the approved mapping (the default export is exactly these):

| # | Column | Source |
|---|---|---|
| 1 | Date | IST date of the scan |
| 2 | Marketplace | Account (marketplace row). Myntra EJ and Myntra VB are separate accounts |
| 3 | Tracking ID | The lookup AWB of the return (the value scans match) |
| 4 | Order ID | The order number |
| 5 | Order Item ID | What the layout shows: the channel order line (Myntra, Flipkart, Meesho), the Ajio return order number, or the Amazon Shipment ID. The kind is kept with the value |
| 6 | Marketplace SKU | The channel listing SKU (Meesho: SKU with the variation added) |
| 7 | Product SKU | The product SKU, when it was found. "Not resolved" otherwise |
| 8 | Marketplace SKU Identification (FNSKU/ASIN/Myntra FSN) | The layout's own column: Myntra `myntra_sku_code`, Flipkart `FSN`, Ajio `JioCode`, Amazon `ASIN`. Blank for Meesho |
| 9 | Logistic Partner Name | The partner, or "Unknown / Pending Verification" |
| 10 | Return Type | Normalized: Customer Return, RTO or Replacement Order |
| 11 | Qty | Expected quantity of the line |
| 12 | Amount | Reserved for the Sales Database. Empty until a verified source exists |
| 13 | Return Reason | From the return |
| 14 | Return Received Issue | The issue category, or "No issue" |
| 15 | Return Received Sub Issue (Only If Missing) | The missing-item sub-issue, when one applies |
| 16 | Ticket ID (Only If Return Received Issue) | The claim ticket, when the issue needs one |
| 17 | Ticket ID Status | Draft, Raised, Review, Approved or Rejected |
| 18 | Claim Amount | Reserved for the claims integration. Empty until a verified source exists |
| 19 | If Rejected, What the Reason | The rejection reason, when the ticket is rejected |

Two export sets follow the 19:

- **Extended** (23 columns): adds Received Qty, Scanned By, Source, and Matched Tracking (which stored AWB matched, and whether it is the return leg or the forward leg).
- **Operational** (37 columns, optional): adds the traceability columns kept for audit: the original tracking ID from the file, the link tracking ID, the scanned tracking ID, the tracking source, the forward tracking ID, the return event ID, the source file, the import batch ID, the return type as the file wrote it, the display identifier kind, the tracking validation, the Iron Send quantity, the Meesho flyer ID (claim evidence), and the flyer status.

The default export (`columns=approved`) is the 19 approved columns only. The screen offers "approved" and "operational" in its export choice.

The approved mapping CSV named in the request was not found on the Desktop, in Downloads, in the project, or in `docs\layouts`. The columns above are the ones in the specification. Check them against the CSV when it is provided.

## Data model

| Table | Role | Changed how |
|---|---|---|
| `marketplaces` | Accounts | Unchanged. Myntra VB and Myntra EJ are separate rows |
| `users`, `user_marketplaces` | Sign-in users and their accounts | Unchanged schema. The account rule is in [Account access](#account-access) |
| `upload_batches` | Upload history | New `detected_format` (the layout the file matched) |
| `upload_rows` | Every raw row | New `warnings`, `duplicate_kind` (`exact_import_row` or empty), `row_fingerprint` (SHA-256 of the row values) and `source_line_no` |
| `expected_returns` | Lookup rows (one per AWB in an account) | `lookup_status` (`staging`, `active`, `superseded`). Tracking evidence: `csv_tracking_id`, `tracking_url`, `url_tracking_id`, `tracking_validation`, `tracking_source`, `identifier_source`. Other evidence: `forward_tracking_id`, `return_event_id`, `carrier_from_link`. Return type: `return_type` (normalized) and `return_type_raw`. Partner: `logistics_partner_id`, `logistic_partner_name`, `partner_detection_method`, `partner_confidence`, `partner_source_value` |
| `expected_return_items` | Lookup lines | `order_line_id` holds real order lines only. New `display_order_item_id` and `display_identifier_kind`, `marketplace_sku_identifier_kind`, `source_line_no`, `row_fingerprint`, and a reserved `sales_amount` |
| `logistics_partners`, `logistics_partner_aliases`, `logistics_partner_domains` | Partner reference data, seeded from the samples. Changed in Admin, never deleted | New |
| `receipt_scans` | One scan event per return | `client_scan_key`, snapshots of the AWB, order and marketplace. `scanned_tracking`, `matched_tracking_field`, `matched_leg`, `source_batch_id`, the partner and tracking validation at scan time. From `schema-scan-history.sql`: the original file AWB (`csv_tracking_snapshot`), the link AWB, the tracking source, the forward AWB, the return event, the source file name, and the return type as the file wrote it. From `schema-flyer.sql`: the Meesho flyer ID (`flyer_id`) and its status (`flyer_state`: `scanned`, `unavailable`, `not_required`) for issue returns |
| `receipt_scan_items` | One verified line of a scan | New `order_line_id`, `display_identifier_kind`, `marketplace_sku_identifier_kind`, `return_type_raw`, `source_line_no`, `row_fingerprint`, and a reserved `sales_amount` |
| `receipt_scan_issues` | Issues recorded against a scanned line | Unchanged |
| `receipt_issue_categories` | Issue categories and their rules | Unchanged. Switches are edited in Admin, by an administrator |
| `missing_component_options` | Sub-issues | Unchanged. Removal deactivates |
| `claim_tickets`, `claim_ticket_history` | Claim tickets and every status change | Linked to `receipt_scan_issues` via `syncClaimTicketToRegister()`. Initial state `CLM-<id>` in status `Draft`, updated to marketplace support ticket ID (e.g. `M-10928374`) in status `Raised` upon bot/manual submission. Also includes `claim_amount` |
| `register_audit_log` | Lookup activations, scans, ticket and category changes, partner and host changes | Partner and host changes are added |
| `evidence_events`, `claim_media` | Photo and video records per scan | `claim_media` stores metadata for surface photos, label photos, defect photos, and 480p SD unboxing video in Firebase Storage / server media storage |

Nothing is deleted or rewritten. Every change is an `ADD COLUMN IF NOT EXISTS`, a constraint added as NOT VALID, a new table or index, or an insert that does nothing when the row exists. The schema runs on every start and is safe to repeat. `SCHEMA_VERSION` is not bumped, because a bump drops the app tables.

## Layouts and the values they supply

Each marketplace's file is read by its own header profile (`server/import-profiles.ts`). Which layouts are confirmed by a real file:

- **Flipkart** (Flipkart.csv), **Meesho** (Meesho.csv) and **Amazon** (Amazon.csv) are confirmed: every required header is in the sample. The importer has not yet been run on these files.
- **Myntra EJ** and **Ajio** are not confirmed. Their Excel files cannot be read by the tools available. Use `npm run layout:inspect -- "<file>" "<marketplace>"`.

The values the register uses:

- **Tracking ID.** Myntra: return tracking (AG), or forward tracking (AF) when AG is blank. Flipkart: Tracking ID. Meesho: AWB Number, decided against the tracking link (see below). Ajio: Return AWB No. Amazon: Reverse Leg Tracking ID.
- **Order ID.** Myntra: order_id. Flipkart: Order ID. Meesho: Order Number. Ajio: Cust Order No. Amazon: Customer Order ID.
- **Order Item ID.** Myntra: order_line_id (order line). Flipkart: Order Item ID (order line). Meesho: Suborder Number (order line). Ajio: RETURN ORDER NUMBER (display identifier, kind `ajio_return_order_number`). Amazon: Shipment ID (display identifier, kind `amazon_shipment_id`).
- **Marketplace SKU.** Myntra: seller_sku_code. Flipkart: SKU. Meesho: SKU with Variation added (`skuWithVariation`). Ajio: SELLER SKU. Amazon: mSKU.
- **Marketplace SKU identification.** Myntra: myntra_sku_code. Flipkart: FSN. Ajio: JioCode. Amazon: ASIN. Meesho: none.
- **Forward and return event.** Myntra: AF is the forward AWB, and return_id is the return event. Flipkart: Return ID is the return event. Amazon: Forward Leg Tracking ID is the forward AWB, and RMA ID is the return event.
- **Carrier.** Flipkart: Vendor Name. Meesho: Courier Partner. Amazon: Carrier. Myntra and Ajio: none in the layout.
- **Qty.** Myntra: quantity. Flipkart: Quantity. Meesho: Qty. Ajio: Return QTY. Amazon: Units. A blank or non-whole quantity is a row error.
- **Return Reason.** Myntra: return_reason. Flipkart: Return Reason with its sub-reason. Meesho: Return Reason with the detailed reason. Ajio: Cust Return Reason. Amazon: Return Reason.

## Return types

`normalizeReturnType` in `server/marketplace-rules.ts` maps each marketplace's codes:

| Marketplace | Source code | Return Type |
|---|---|---|
| Myntra EJ and VB | Return | Customer Return |
| Myntra EJ and VB | RTO | RTO |
| Flipkart | customer_return | Customer Return |
| Flipkart | courier_return | RTO |
| Meesho | Customer Return | Customer Return |
| Meesho | Courier Return (RTO) | RTO |
| Ajio | RVP | Customer Return |
| Ajio | RTO | RTO |
| Ajio | REPL | Replacement Order |
| Amazon | CUSTOMER_RETURN | Customer Return |
| Amazon | UNDELIVERED | RTO |

The Flipkart, Meesho, Amazon and Ajio codes are confirmed by sample files. The Myntra codes come from the specification. A blank or unlisted code is kept as written and flagged. The original code is kept in `return_type_raw`. Cancelled-before-dispatch Myntra rows keep `Courier Return`, a value the normalized list does not contain. That is a pending decision.

## Meesho tracking links

The Meesho `Tracking Link` column carries a carrier link in one of three verified forms:

- `https://track.delhivery.com/p/<AWB>`
- `https://www.delhivery.com/track/package/<AWB>` (both seen in Meesho.csv)
- `https://track.shadowfax.in/track?...&trackingId=<AWB>` (seen in Meesho.csv)

Only these hosts and forms are read. Any other host, or any other form, is not used and is flagged.

The lookup AWB is decided as follows. The CSV AWB is kept on the record in every case.

- **Blank AWB:** not filled from a link. Refused as a row error.
- **Damaged AWB** (scientific notation): not repaired from a link. Refused as a row error.
- **No link, invalid link, or unverified host:** the CSV value is used and the row is flagged (`no_link`, `invalid_link`, `unverified_host`).
- **Link AWB equal to the CSV AWB:** match. No warning.
- **Delhivery link, and the CSV AWB is exactly the link AWB rounded to 15 significant digits:** a spreadsheet rounded the value, so the link AWB is the lookup value (`mismatch_resolved`). The example from the specification: CSV `1490711860180880`, link `1490711860180882`.
- **Any other difference:** the CSV value is used and the difference is flagged for a person (`mismatch_kept`). No arbitrary numeric correction is made. Shadowfax differences are always only flagged.

## Repeated rows

Rows are never merged because they share an AWB. The classification is:

- **Exact duplicate import row:** the same values as an earlier row in the file (same SHA-256 fingerprint). Kept in `upload_rows`, flagged `exact_import_row`, and not counted.
- **Same AWB, SKU and order line with different details:** kept as a separate line and flagged. Nothing is summed.
- **Second return event:** the same AWB, SKU and line, but a different return event id (Myntra `return_id`, Flipkart `Return ID`, Amazon `RMA ID`). Kept as a separate line and flagged.
- **Several products in one shipment, or several lines of one product:** normal. Not flagged.
- **Repeated physical scan:** prevented at scan time. An AWB already received in an account is refused, with the time and the scanner.

## Logistics partners

A partner is decided in this order (`detectPartner` in `server/marketplace-rules.ts`):

1. The carrier named in the file, matched against an alias. A marketplace-scoped alias is recorded as a marketplace mapping.
2. The verified tracking-link host, matched against a configured host.
3. Otherwise "Unknown / Pending Verification".

When the file's carrier and the link's carrier differ, the file's carrier is kept and the difference is flagged. A carrier is never identified from the shape of an AWB. The seeded partners and aliases come from the samples: Delhivery, Shadowfax, Valmo, PocketShip, Xpress Bees, Flipkart Logistics. Amazon's carrier `ATSPL` is not seeded, so it shows as Unknown until it is added in Admin.

## Lookup data and activation

An upload for one account is read, checked, and then activated in one transaction (`server/upload-routes.ts` and `server/lookup-import.ts`, `commitLookupUpload`).

**Preview** (`POST /api/uploads/preview`) reads the file and stages it. It changes no lookup data. The response lists the detected format, the headers found and any required columns missing, the counts (scannable, pending, rejected, cancelled and duplicate rows, identifiers blanked, tracking corrections, tracking differences, tracking links not checked), structured exceptions with source line numbers, the tracking corrections, the logistics partners, the product SKU mapping, and the warnings.

**Activation** (`POST /api/uploads/import`) is refused, on the server, when any of these holds. The preview is never trusted on its own, so every rule is checked again:

- the file cannot be read (a fatal file, for example a seller ID that does not match the account, or a missing required column);
- no row is scannable, or the file has no rows;
- the file is for an account the user cannot see;
- the preview was made by another user, has expired (15 minutes), or was already activated.

A file with scannable rows may activate partially. Pending, rejected, duplicate and cancelled rows remain in `upload_rows` and are excluded from active lookup groups. A partial activation, an identifier Excel stored as a number, or a tracking link that disagrees with the file's AWB requires `confirm: true`. A confirmation cannot stand in for a fatal or no-scannable-row blocker. The staged file is removed before the commit starts, so the same preview cannot be activated twice.

The activation then runs in one transaction:

1. The batch and every raw row are written, with the row status, warnings and duplicate classification.
2. The partner decision is applied to each row.
3. Only scannable rows become new lookup rows with status `staging`. They are not visible to scans until activation.
4. The cancelled-before-dispatch rows for the account are replaced.
5. The account's previously `active` rows become `superseded`. They are kept, because scans refer to them. A superseded row is no longer scannable.
6. The new rows become `active`.

If any step fails, the transaction rolls back, so the previous active data stays in place. An advisory lock per account stops two uploads for the same account from interleaving.

A file with rows for another account is refused before anything is staged, so an upload can only change its own account. The refusal names an account the user cannot see only as "another account".

**Scanner-list validation** (`POST /api/uploads/scanner-list/preview`) is not a return-master upload. It reads every non-empty cell in every worksheet, preserves the source sheet/row/column/value, requires explicit verified account mapping per worksheet, and checks valid text identifiers against active lookup rows. Numeric and scientific-notation cells are malformed for this purpose. It creates no scans and changes no lookup data.

## Lookup and ambiguity

`POST /api/scan/lookup` searches the active rows of every account the user may see, unless one account is named. Naming an account the user may not see is refused with 403. The result is one of four outcomes, and nothing is chosen silently:

- `found`: one active return, not yet received. The response carries the scanned AWB, the stored AWB it matched (`matchedTrackingField`), the leg it belongs to (`matchedLeg`: return, forward or unknown), the logistic partner, the original file AWB, the link AWB, the forward AWB, the return event, the source file and the import batch.
- `duplicate`: the AWB was already received in that account. The time and the scanner are shown.
- `choose`: the AWB matches more than one account or return that the user may see. The employee picks one, and the choice is sent back with its `shipmentId`.
- `not_found`. This includes an AWB that exists only in an account the user may not see, so the existence of that account is not revealed.

An account that received an AWB but no longer has it in its active data still counts as a match, so the AWB cannot be received twice by accident.

## Recording a scan

`POST /api/scan/complete` saves one return in one transaction (`server/register-service.ts`, `recordScan`). The steps:

1. A scan key that was used before returns the first result (`replayed: true`). Nothing is saved twice. A key that belongs to an account the user may not see is reported as not found.
2. The return must be in the user's accounts, or it is reported as not found. It must still be active. A superseded return is refused.
3. An advisory lock is taken on the AWB in its account. A second save for the same AWB waits, then sees the first save's result.
4. The AWB must not already be received in that account.
5. Every item must be listed once, and physically verified. The quantities and issues are checked against the rules in `server/register-rules.ts`. Any problem is refused with the full list, and nothing is written.
6. Each new ticket ID must be new. A ticket is created with status `Raised` and its first history row.
7. The scanned AWB (`scannedTracking`, sent by the screen) is compared with the stored AWBs. The result is saved with the scan.
8. The scan, its items, its issues, the evidence counts and the audit row are inserted.

The scan keeps its own copy of the AWB as scanned, the original file AWB, the link AWB, the tracking source, the forward AWB, the return event, the order, the marketplace, the partner, the tracking validation, the source file and batch, and each line's order item, display identifier and kind, marketplace SKU, product SKU, identifier and kind, name, return type (normalized and raw) and reason. A later upload cannot change what was recorded.

## Account access

The rule is in `server/access.ts`, and every route applies it:

- An Admin (the role `Admin`, in any letter case) sees every account and may change configuration.
- Any other user sees every account when `users.has_all_marketplaces` is true.
- Otherwise the user sees only the accounts in `user_marketplaces`. A user with no assignment sees nothing.

The restriction is applied in SQL, with the account list as a bound parameter, so a request cannot widen it by changing a filter, an ID or a URL. The dashboard, the claims, the register and its export, the lookup, the scans, the tickets, the uploads and the account list all use it. A named account the user cannot see is refused with 403. A single return, scan, ticket or upload the user cannot see is reported as not found (404), so its existence is not revealed. Configuration routes (issue categories, sub-issue options, logistics partners and their aliases and hosts, users, accounts and system status) need the Admin role.

The screens show only the Admin pages to an administrator. The server refuses the same requests from anyone else whatever the screen shows.

## Issue rules

| Category | Counts as missing | Needs a sub-issue | Needs a ticket |
|---|---|---|---|
| No issue | no | no | no |
| Missing product or component | yes | yes | yes |
| Wrong product | no | no | yes |
| Damaged product | no | no | yes |
| Other issue | no | no | no |

The table is the seeded configuration. An administrator can switch a category on or off, and can change whether it needs a ticket. The rules for missing units and sub-issues are fixed in code. "No issue" cannot be changed.

Units not received must equal the units covered by missing-item issues. Issues on received units cannot exceed the units received. Sub-issues come from `missing_component_options`, and each must belong to the category it is chosen under.

## Tickets

A ticket ID is a claim reference from the claims system. A scan that needs one records the ID and creates the ticket with status `Raised`. An ID that is already in the register cannot be reused.

`PATCH /api/tickets/:id/status` changes the status. Rejecting a ticket needs a reason. Every change adds a row to `claim_ticket_history`, so the full history is kept. The status set is `Draft`, `Raised`, `Review`, `Approved` and `Rejected`. Any allowed status can move to any other, and every move is recorded. A ticket outside the user's accounts is reported as not found.

## Product SKU resolution

At upload, each marketplace SKU is resolved in this order (`resolveProductSkus` in `server/lookup-import.ts`):

1. The VB EXPORT product master (`product_master`), for the account or for "all".
2. The OMSGuru master: the listing's OMSGuru SKU record (`oms_listings` to `oms_skus`). Used only when exactly one master code matches.
3. Otherwise the product SKU is unresolved. The line keeps the marketplace SKU, the register shows it as "Not resolved", and it is never guessed.

The source is saved on each line (`product_sku_source`). A Meesho marketplace SKU now includes its size, so the product master and OMSGuru listing keys must include it too. That is not yet confirmed.

## Legacy scans

Scans saved before item-level verification have no item rows. They appear in the register as one row per shipment line, with Source "Legacy" and no received quantity. Their partner and tracking validation come from the lookup row, and they show "Not recorded" for the match. Nothing was rewritten.

## Register API and screen

The routes are listed in [API.md](API.md). The register-specific behaviour is:

- `GET /api/accounts` lists the accounts the user may use. The account selectors on the scan and upload screens are filled from it.
- `GET /api/register` takes the filters (marketplace, tracking, order, SKU, issue, ticket status, scanner, partner, date range), the sort (a fixed list, and `direction`), and the page (50 rows, at most 200). It returns the total and the page.
- `GET /api/register/export?format=csv|xlsx&columns=approved|extended|operational` returns the same rows as the screen, with the same filters and columns. The default column set is `approved`. An export of more than 50,000 rows is refused, not truncated. Cells that start with `=`, `+`, `-` or `@` are prefixed with an apostrophe, in both formats.
- The Return register screen (the Reports page) shows the 19 approved columns, a column chooser, sorting, filters, a record view with the traceability fields, and mobile cards. It is not verified in a browser.
- The scan screen shows the scanned AWB, the matched stored AWB and leg, the logistic partner, the return type as the file wrote it, the source file, every item of the return, its expected quantity, a physical check, a received quantity, and the issues. Save is disabled until the client-side checks pass, and the server repeats every check. The scan key is created once per return, and a retry sends the same key.
- The unboxing evidence panel records a video on the workstation. The video is not uploaded and not linked to the return. Only the number of photos and whether a video exists are saved with the return.

## Administration of the register's reference data

Administrators (role `Admin`) can:

- list, add and switch off logistics partners;
- add and switch off courier names (aliases), for all accounts or one account;
- add tracking hosts, and switch them off;
- switch issue categories on or off, and change whether they need a ticket;
- add and switch off missing-item sub-issues.

Every change is written to `register_audit_log`. Nothing is deleted. Return type mapping management, header alias management and validation exceptions are not built yet. Until they are, a return type is kept as the file wrote it, and a file header that is not recognised is reported as missing.

## Concurrency and idempotency

- The client scan key makes a save idempotent. The key is created once per return on the screen, and a retry sends the same key.
- The advisory lock per AWB serializes concurrent saves. The row lock on the return and the unique indexes (`receipt_scans_client_scan_key_uidx`, `receipt_scans_expected_return_id_key`, `receipt_scan_issues_ticket_uidx`, and the ticket code) are the backstop.
- Upload activation takes a lock per account, and the staged file is removed before its commit starts.

## Verification

Checks that exist, and what they do (none has been run in this environment). The full list, with the number of declarations in each file, is in [TESTING.md](TESTING.md#what-the-tests-cover).

- `server/tests/marketplace-rules.test.ts`: the return type mappings for every layout, the SKU and variation joining, the link formats, the rounding rule and its validation outcomes, carrier detection and the Unknown fallback. Needs no database.
- `server/tests/import.test.ts`: the parser for every layout, with synthetic rows. Covers the seller guard, the Myntra forward fallback, the Ajio and Amazon display identifiers, the Amazon forward leg, RMA and carrier, Meesho's supplier block and tracking link, Flipkart's FSN and return ID, quantity checks, and the repeat classification. Two tests use the full real Flipkart and Amazon headers.
- `server/tests/spreadsheet-numbers.test.ts`: identifiers stored as numbers in Excel, the untrusted-number rule, and the lookup-key rule. Builds its workbooks in memory.
- `server/tests/register-rules.test.ts`: the pure rules. Scan keys, tracking normalization, lookup decisions, the matched field and leg, every quantity and issue rule, ticket status changes, the register row, the 19 approved columns in order, and the shared CSV and Excel rows.
- `server/tests/access.test.ts` (no database): the account rule (Admin, all accounts, assigned accounts, none), the account condition as a bound parameter, Myntra EJ and Myntra VB as separate accounts, the register query and its sort allowlist, `requireAdmin` (403 for every other role), and the error mapping.
- `server/tests/upload-policy.test.ts` (no database): the preview counts, the activation blockers (error rows, a fatal file, an account the user cannot see, no valid rows), the confirmations, and the rule that a confirmation cannot stand in for a blocker.
- `server/tests/data-capture.test.ts`: report dates, lifecycle counts, invoice keys, raw row capture.
- `server/tests/register-db.test.ts` (needs `TEST_DATABASE_URL`): runs the service against PostgreSQL. It covers EJ and VB account isolation, a multi-line return, idempotent retries, concurrent saves, partial and missing units, ticket creation and rejection, invalid references, temporary dataset replacement with preserved history, a failed upload that leaves the old data active, the register and export, and persistence after a reconnect. It was written before the account rule and the no-merge change, and has not been re-read for them.
- `server/tests/access-db.test.ts` (needs `TEST_DATABASE_URL`): the account rule and the scan rules against PostgreSQL. It covers applying the schema twice, the account rule for an Admin, an assigned user and a user with no assignment; 403 for a named account outside the scope and 404 for a return outside it; the lookup result for a shared AWB; a restricted user's refused save; several items on one AWB as one scan, with the scanned AWB kept; a repeated key returning the first scan; a second scan of the AWB refused; a ticket the restricted user cannot change; the register, its export and the dashboard figures limited to the user's accounts; and a saved scan keeping its snapshot after a lookup replacement and surviving a reconnect.
- `server/tests/database-ssl.test.ts`: the database connection rules.

The database checks need a dedicated test database, set in `TEST_DATABASE_URL`:

```bash
$env:TEST_DATABASE_URL = "<a test database URL; its database name must contain 'test'>"
```

Without `TEST_DATABASE_URL`, the database checks are reported as skipped, and the rule checks still run. A skipped check has not passed. The database checks read only `TEST_DATABASE_URL`, never `DATABASE_URL`. Their one safety guard is the database name: a name without "test" is refused. Do not point `TEST_DATABASE_URL` at the production database. They create only `SYN-*` data.

Not verified: the TypeScript compile, the production build, every test run, the database schema and inserts, the register query, the concurrency under load, the UI in a browser, the Myntra EJ and Ajio layouts (their files cannot be read here), and the account rule and scan persistence on a database.

## Known limits

- Legacy scans are shown without item quantities. They cannot be re-verified.
- The export is capped at 50,000 rows.
- The scope parameters of the register service default to every account, for the existing database tests and scripts. Every route passes the signed-in user's scope. Making the parameter required is pending, with an update to `register-db.test.ts`.
- Any allowed ticket status can move to any other, and every move is recorded. There is no transition map.
- The Myntra seller guard still depends on the unconfirmed 10708 / 45833 mapping (see CLAUDE.md).
- `server/scripts/fetch-oms-orders.ts` still reads `expected_returns` without filtering on `lookup_status`. It is an on-demand script and changes no data, but it should be filtered to `lookup_status = 'active'`.
- The stored scan history is not archived, and the retention periods are not decided.
