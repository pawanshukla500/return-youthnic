# Phase 1 register: status and verification handoff

As of 2026-10-12. The typecheck, production build and non-database tests were run on 2026-10-11: 224 pass, 0 fail, 24 skipped. The skipped tests need `TEST_DATABASE_URL`. Read [Start here (2026-10-12)](agent-handoff.md#start-here-2026-10-12) before the older notes below. Two later facts override the bullets further down:

- The register has no card list under the table. Details opens a two-column record. Empty dates say Any day.
- The logistics screen shows courier names and the brand mark. It does not show tracking hosts. A tracking link does not name the partner.

For the full handoff, including how the work is organised and what each role should do next, read [agent-handoff.md](agent-handoff.md).

## What the code does now

- **Account access.** One rule (`server/access.ts`): an Admin sees every account; a user with `has_all_marketplaces` sees every account; any other user sees the accounts in `user_marketplaces`; a user with none sees nothing. It is applied in SQL on the dashboard, the claims, the uploads, the lookup, the scans, the register and its export, the tickets, and the account list. A named account the user cannot see is refused with 403. A single item the user cannot see is reported as not found.
- **Administration.** Every configuration route needs the Admin role: issue categories, sub-issues, logistics partners and their courier names and hosts, users, accounts and system status. The Admin page and its navigation item show only to an Admin.
- **Scan identifiers.** The scan screen sends the scanned AWB with every save. The server records it with the matched stored AWB and leg (return or forward), the original AWB from the file, the link AWB, the tracking source, the forward AWB, the return event, the source file, the import batch, the logistic partner and its detection method, and the return type as the file wrote it. These values are copied at scan time, so a later upload does not change them.
- **Upload activation.** Preview changes nothing. Only scannable rows enter active lookup data. Pending, rejected, duplicate and cancelled rows remain in upload history. Activation is refused on the server when the file is fatal, has no scannable row, or the account is not the user's. Partial activation and other confirmation items need `confirm: true`. The staged file is removed before its commit, so it cannot be activated twice.
- **Scanner-list validation.** `POST /api/uploads/scanner-list/preview` parses every non-empty cell of a multi-sheet workbook, preserves worksheet/row/column provenance, requires explicit verified account mapping per worksheet, and validates against active lookups without activating data or creating scans.
- **Logistics partner admin.** List, add, switch on and off partners; add courier names for all accounts or one account, and switch them off; add tracking hosts, and switch them off (a new route, with an audit row).
- **Register.** The default export is the approved 19 columns. An operational export adds the traceability columns. The screen has sort, filters, a column chooser, a record view with the traceability fields, mobile cards, and CSV and Excel export. Pages are capped at 200 rows, and an export of more than 50,000 rows is refused.
- **Dashboard figures.** Every count is limited to the accounts the user can see.

## Files changed on 2026-10-10

Server:

- `server/access.ts` (new): the account rule (pure).
- `server/http.ts` (new): the signed-in user, the scope, `requireAdmin`, `sendError`.
- `server/dashboard.ts` (new): the scoped dashboard, claims and recent-scan queries (moved from `server/index.ts`).
- `server/upload-policy.ts` (new): the preview counts, the blockers, the confirmations (pure).
- `server/upload-routes.ts` (new): upload history, template, preview, activation.
- `server/scanner-list.ts`, `server/scanner-list-routes.ts`: validation-only multi-sheet scanner-list parsing and matching.
- `server/register-service.ts` (rewritten): scope on every read and write, the snapshot fields, the lookup and scan rules, the register query and its export, the ticket changes.
- `server/register-routes.ts` (rewritten): the scope on every route, `requireAdmin` on configuration, `/api/accounts`, the export columns, the partner host switch-off.
- `server/index.ts` (rewritten): the scope on `requireUser`, the Admin routes, the audit row for sub-issue changes.
- `server/db.ts` (rewritten earlier): four schema files, `openPool` for reconnect checks.
- `server/schema-scan-history.sql` (new, additive): the snapshot columns on `receipt_scans`, and four indexes.
- `server/register-rules.ts` (rewritten earlier): the 19, 23 and 34 column sets.

Front end:

- `src/access.ts` (new): the Admin check for the screens.
- `src/types.ts` (rewritten): the new lookup, scan, register, account and upload types.
- `src/shell.tsx`, `src/App.tsx`: the Admin item and page for administrators only.
- `src/pages/ScanReturns.tsx`: the scanned AWB, the account list, the match, the partner and the source shown and saved; the evidence copy corrected; the `ReactNode` import.
- `src/pages/Uploads.tsx`: the account list, the two upload modes, grouped/searchable exceptions, scanner worksheet mapping, the confirmation, the activation rule, and history reloaded from the server.
- `src/pages/Reports.tsx`: the export choice, the record view with traceability fields, the `ReactNode` import.
- `src/pages/Admin.tsx`: the logistics partner section; the unbuilt parts are stated.

Tests:

- `server/tests/import.test.ts`: the malformed title is fixed.
- `server/tests/access.test.ts` (new, no database): the account rule, the register SQL shape, `requireAdmin`, the error mapping.
- `server/tests/upload-policy.test.ts` (new, no database): the blockers and the confirmations.
- `server/tests/scanner-list.test.ts` (new, no database): multi-sheet provenance, duplicate values, blank cells, numeric and scientific identifiers.
- `server/tests/access-db.test.ts` (new, needs `TEST_DATABASE_URL`): the account checks against PostgreSQL, the scan checks, and persistence across a reconnect.
- `package.json`: the `test` script includes the parser, upload-policy and scanner-list tests.

Documents (rewritten on 2026-10-10 from the code, not run): `README.md`, `AGENTS.md` (new), `CLAUDE.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `docs/DEVELOPMENT.md`, `docs/GETTING-STARTED.md`, `docs/TESTING.md`, `docs/REGISTER.md`, `docs/notes/agent-handoff.md` (new), `docs/notes/agent-roster.md`, `docs/notes/ui-controls-audit.md`, `docs/notes/marketplace-layouts.md`, `docs/notes/phase1-audit-matrix.md`, and this file.

## Verification handoff

Run these in order, from the project folder, in PowerShell. Report the first failure in full.

```bash
npm run typecheck
```

```bash
npm run build
```

```bash
npm test
```

For the database checks, set `TEST_DATABASE_URL` to a dedicated test database whose name contains "test". Never use the production database.

```bash
$env:TEST_DATABASE_URL = "<test database URL>"
```

```bash
npm test
```

The database checks create only `SYN-*` data. They run `applySchema` twice, so the schema changes are exercised on a database that already has them. Without `TEST_DATABASE_URL`, the two database files are reported as skipped. A skipped check has not passed.

Then, in a browser against the dev server (`npm run dev`), sign in as an Admin and as a user with one account, and check:

1. The Admin item is missing for the user with one account, and an administrator request from that user is refused.
2. The user with one account sees only that account on the scan, the upload and the register screens.
3. A scan records the scanned AWB. The register shows it, and so does the record view.
4. A return upload with pending/rejected rows shows grouped exceptions and activates only scannable rows after the confirmation box is ticked. A scanner workbook only validates against active lookups and never activates or creates scans.
5. The export is the 19 approved columns by default.

The step-by-step checks for each screen are in [ui-controls-audit.md](ui-controls-audit.md).

## Verified

- `npm run typecheck` passed on 2026-10-11 (exit 0).
- `npm run build` passed on 2026-10-11 (exit 0, Vite built `dist/` in 1.65s).
- `npm test` passed on 2026-10-11: 245 tests, 221 pass, 0 fail, 24 skipped because `TEST_DATABASE_URL` is not set.
- The dev server started: the web app at `http://localhost:5173/` and the API at `http://127.0.0.1:3001`. `GET /api/health` returned `ok: true`, `database: connected`, name `return-scan_youthnic`. The sign-in page rendered (email, password, Sign in). Signed-in screens were not checked.
- Synthetic parser tests cover pending/scannable rows, Excel precision, Ajio zero quantity, Amazon scientific/blank reverse AWBs, duplicates and scanner-list provenance.
- The real Amazon CSV, Ajio workbook and Meesho scanner workbook were read-only diagnosed. No real upload was activated.

## Not verified

- The database schema, its inserts and its constraints, on a real PostgreSQL database.
- The account rule and the scan persistence, on a database.
- Every screen in a browser.
- The Flipkart Excel sample through the importer.
- The Myntra EJ layout.
- The approved mapping CSV (not found on the Desktop, in Downloads, in the project, or in `docs\layouts`).
- The `Database Desine input.xlsx` workbook (binary; not read).
- The documents rewritten on 2026-10-10. They were checked against the source by reading, not by running the server.

## Blockers

- **No dedicated test database.** The compile, build and non-database tests ran on 2026-10-11, and the sign-in page loaded in a browser. `TEST_DATABASE_URL` is not set, so the 24 database checks stayed skipped. Signed-in screens were not checked.
- **Approved mapping CSV** (`Return_Scan_Approved_Mapping_Claude.csv`) not found. The 19 columns come from the specification. Copy the file to `docs\layouts\` and send it.
- **Myntra EJ and Ajio Excel files** cannot be read by the tools available. Run `npm run layout:inspect` on each and send the missing headers.
- **Seller IDs 10708 and 45833** are not confirmed as VB and EJ. The Myntra guard and the profile depend on this.

## Decisions the user still has to make

- Confirm the account access rule (CLAUDE.md, Pending). In particular: may an assigned user scan in an account, or only view it?
- The label for cancelled-before-dispatch Myntra rows, which still say `Courier Return`.
- Whether a repeated identical row is counted once (as now) or flagged for a person.
- Retention: 24 or 30 months, the archive location, the evidence media policy, and PII retention.
- Whether to approve removing the demo rows from the existing database. This changes production data.
- The activation rule for files that cover a date window: whether an activation should supersede open returns that are not in the file (as now), or leave them alone.

## Known limits

- The register service's scope parameters default to every account, so the older database test and the scripts keep working. Every route passes the signed-in scope. Making the parameter required is pending, with an update to `server/tests/register-db.test.ts`.
- Return type mapping management, header alias management and validation exceptions are not built. A return type is kept as the file wrote it. A header that is not recognised is reported as missing.
- The upload preview shows only the missing required columns, not the full list of headers found. The server returns the full list.
- The unboxing video stays on the workstation. It is not uploaded and not linked to the return.
- `server/scripts/fetch-oms-orders.ts` still reads `expected_returns` without filtering on `lookup_status`. It is an on-demand script and changes no data.
- `server/seed.ts` is an empty file and should be deleted. The workspace that made these changes could not delete files.
- Some code comments are out of date, and were not edited on 2026-10-10:
  - `server/schema-register.sql` and `server/admin-config.ts` name the verified hosts list `VERIFIED_TRACKING_LINKS`. The code's name is `LINK_RULES`, in `server/marketplace-rules.ts`.
  - A comment in `server/sheets.ts` refers to an `applyProductMaster` in `server/index.ts`. No such function exists.
  - A comment in `server/scripts/create-user.ts` says the app checks no role yet, so every user can reach every page. Both parts are out of date.
- The known security gaps and the other open risks are listed in [agent-handoff.md](agent-handoff.md#known-risks-and-gaps).

## Deferred integrations

- Sales Database: `Amount` and `sales_amount` stay empty until a verified source exists.
- Claims: `Claim Amount` and `claim_amount` stay empty. The claim management system is not built.
- OMSGuru: the daily job is not scheduled. The OMS listing screen is not built.
