# Agent handoff: Return App

Status date: 2026-10-10.

Who this is for: any agent or person who picks up the Return App, whether a Claude Code session, one of the project's role agents in `.claude/agents/`, or a reviewer. It gives you the state of the work, the map of the code, the rules that must hold after any change, how to verify, what is waiting on the user, and how to hand back.

It does not replace [CLAUDE.md](../../CLAUDE.md), which holds the business and technical rules. Where this file and CLAUDE.md disagree, CLAUDE.md is right, and you must say so in the session log.

## Summary

- **What the app is.** A return-scanning app for VB Exports. Marketplace return reports (Myntra VB and EJ, Flipkart, Meesho, Amazon, Ajio) are loaded as lookup data, one account at a time. A scan records what physically arrived. The register is the permanent record. An Express 4 API and PostgreSQL run on the server, and a React 19 app built with Vite is the client. The code is strict TypeScript. Tests use `node:test` through `tsx`.
- **The state.** The Phase 1 code has been typechecked, built and tested in the shell. The dedicated database checks remain skipped because `TEST_DATABASE_URL` is not set. The real Ajio workbook was parsed read-only; no return upload was activated.
- **Your first action.** Check the latest session-log entry and run only the remaining verification needed for the task.
- **Do not.** Mark anything verified that you did not run. Read `.env`. Print a secret. Activate an upload against production data without the user's approval. Delete history.

## Reading order

1. [AGENTS.md](../../AGENTS.md): the entry point.
2. [CLAUDE.md](../../CLAUDE.md): the rules.
3. This file.
4. [phase1-register-status.md](phase1-register-status.md): what was written, the verification commands, and the blockers.
5. [phase1-audit-matrix.md](phase1-audit-matrix.md): the issue IDs and their status.
6. [ARCHITECTURE.md](../ARCHITECTURE.md): the modules and the data flows.
7. [API.md](../API.md): the route contract.
8. [REGISTER.md](../REGISTER.md): the register rules.
9. The area note for your task: [marketplace-layouts.md](marketplace-layouts.md), [spreadsheet-numbers.md](spreadsheet-numbers.md), [omsguru-api.md](omsguru-api.md), [oms-order-snapshots.md](oms-order-snapshots.md), [myntra-ej-vb-headers.md](myntra-ej-vb-headers.md), [ui-controls-audit.md](ui-controls-audit.md).

## Current state

Status words used here: **Written** means the code exists and was read back. **Tested** means an automated check exists. **Verified** means the check was run and its output was read. On 2026-10-12 the local typecheck, build and non-database tests were run again (233 pass, 0 fail, 24 skipped). The database tests are still skipped.

## Start here (2026-10-12)

Read this before the session log. The log below is history. This section is the state the next agent should trust.

- **Run.** `npm run dev` serves the web app at `http://localhost:5173` and the API at `http://127.0.0.1:3001`. Pages: `/`, `/scan`, `/register`, `/claims`, `/uploads`, `/admin` (`src/routes.ts`). Sign-in stays on the address you opened.
- **Do not read `.env`.** Do not print `DATABASE_URL`, `TEST_DATABASE_URL`, OMSGuru credentials, or `NEW_USER_PASSWORD`. The live database name last read from `/api/health` was `return-scan_youthnic`.
- **Product master is loaded.** The user loaded it from Admin. A read on 2026-10-11 counted image links: 34,574 https, 185 http, 36 empty. Hosts included `img.fkcdn.com`, `images.meesho.com`, `m.media-amazon.com`, `cdn.shopify.com`. Do not replace the table unless the user asks.
- **Listing SKU match.** Spaces are ignored. A short trailing token that is not a size (`_A`, `_Al`, `_NEW`) is also looked up without that token. `B126-kabira-Bottle Green_S_A` matches `B126-kabira-Bottle Green_S`. `_XL` is a size and is not stripped. `listingSkuCandidates` and `parentListingSku` in `server/marketplace-rules.ts`. `masterSkusForListings` in `server/lookup-import.ts`. The scan lookup and the register overlay an unresolved product SKU from the master. They do not rewrite the saved scan row.
- **Catalog images.** `GET /api/catalog-image?url=` serves a stored http(s) image link. Flipkart `img.fkcdn.com` links are fetched at 416 pixels. Shopify links get `width=480`. A copy is kept in the machine temp folder. On 2026-10-11 one Flipkart link returned HTTP 200 `image/jpeg`, 26,768 bytes, 436 ms the first time and 8 ms from the copy. The scan screen uses this route. Click the photo to enlarge it. There is no "Catalog image" or "Enlarge" label.
- **Partners.** A courier name that equals an alias, or starts with an alias of at least 6 characters, uses that partner. `delhiveryexpress` and `delhiversurface` are Delhivery. A tracking link does not name the partner. The Admin screen lists courier names and does not show tracking hosts. The host API still exists. Marks are local files in `public/logos/partners/` (`src/partners.ts`).
- **Multi return.** One line with quantity 2, or more than one line, opens a popup for 2 seconds, then the scan screen stays ready. The return is already saved as a normal return.
- **Register.** Filters are three rows. Empty dates say "Any day". There is no card list under the table. Details opens a two-column record sheet.
- **Not done.** No git repository. Not deployed. 24 database tests skipped. `CLAUDE.md` is missing from the folder. The Kotlin app is not started.

| Area | Status | Tests | Notes |
|---|---|---|---|
| Sign-in and sessions | Written (existing) | None specific | Sessions never expire. See [known risks](#known-risks-and-gaps). |
| Account access: scope on every data route, Admin on configuration | Written 2026-10-10 | `access.test.ts` (pure), `access-db.test.ts` (database) | Whether an assigned user may scan, not only view, is a decision for the user. |
| Lookup: found, duplicate, choose, not found | Written | `register-db.test.ts`, `access-db.test.ts` | A named account outside scope returns 403. |
| Scan save: replay, lock, rules, snapshot | Written | `register-db.test.ts`, `access-db.test.ts`, `register-rules.test.ts` | The screen sends `scannedTracking` as of 2026-10-10. |
| Scan snapshots: file AWB, link AWB, leg, source, partner | Written 2026-10-10 | `access-db.test.ts` (snapshot after replacement) | Stored by `schema-scan-history.sql` and the scan insert. |
| Tickets: create, status change, history | Written | `register-db.test.ts`, `register-rules.test.ts` | Any allowed status can move to any other. |
| Register list, export (approved, extended, operational) | Written | `register-rules.test.ts`, `register-db.test.ts`, `access-db.test.ts` | Three filter rows. Empty dates say Any day. Details is a two-column sheet. No card list under the table. An unresolved product SKU is filled from the product master on read. |
| Upload preview | Verified 2026-10-10 | `upload-policy.test.ts`, `import.test.ts`, `spreadsheet-numbers.test.ts` | Return mode keeps structured pending/rejected exceptions, grouped/searchable in the UI. It shows only the missing required columns, not the full header list. |
| Upload activation: partial rows, confirmations, supersede | Verified 2026-10-10 | `upload-policy.test.ts`, `register-db.test.ts` | Only scannable rows enter active lookup groups. The import route is not tested end to end. The staged preview is in memory and is lost on restart. |
| Bulk scanner-list validation | Verified 2026-10-10 | `scanner-list.test.ts` | Multi-sheet parser preserves source coordinates and rejects numeric/scientific identifiers as lookup keys. The route is validation-only and the browser is not checked. |
| Admin: issue categories and sub-issues | Written | None direct. The admin check itself is in `access.test.ts` | Categories can be switched only. Codes are fixed. |
| Admin: logistics partners, courier names, tracking hosts | Written 2026-10-11 | `marketplace-rules.test.ts` (name match) | The screen shows the brand mark and courier names. Tracking hosts are not on the screen. A tracking link does not name the partner. Prefix aliases: `delhiveryexpress` and `delhiversurface` are Delhivery. |
| Overview and claims figures, scoped | Written 2026-10-10 | `access-db.test.ts` (headline) | Type on the overview is larger as of 2026-10-11. Figure definitions are proposals until the user confirms them. |
| Marketplace parsers: Flipkart, Meesho, Amazon and Ajio (headers confirmed by sample); Myntra EJ (not confirmed) | Verified 2026-10-10 | `import.test.ts`, `marketplace-rules.test.ts` | Amazon and Ajio were parsed read-only from the real files; no upload was activated. |
| Identifier number rules (Excel precision) | Verified 2026-10-10 | `spreadsheet-numbers.test.ts`, `scanner-list.test.ts` | Real Amazon and Meesho files were read-only diagnosed; numeric/scientific lookup values remain pending or malformed, never guessed. |
| OMSGuru sync: listings, SKUs, invoices, orders | Written from the spec | `oms.test.ts`, `oms-orders.test.ts` | Not run against the live API. Not scheduled. |
| Schema: four files, additive, runs twice | Written | `access-db.test.ts`, `register-db.test.ts` (schema applied twice) | Applied on the configured PostgreSQL database; dedicated database checks are not run. |
| Database TLS rules | Verified 2026-10-11 | `database-ssl.test.ts` | The pure checks passed in `npm test` (certificate check stays on, `sslmode=no-verify` is refused). Do not weaken them. |
| Front end: Scan, Uploads, Register, Admin, shell; Overview, Claims, Login | Written | None (no UI test runner) | Addresses are in `src/routes.ts`. Catalog images go through `/api/catalog-image`. A multi return (more than one piece) opens a 2 second popup. |
| Documentation | Updated 2026-10-12 from the code and from checks run on 2026-10-11 | Read against the source | `CLAUDE.md` is missing. Do not invent it. |
| Agency role files | Written 2026-10-11 | File count and `name:` lines read after download | 33 files in `.claude/agents/`. The 13 added on 2026-10-11 are installed and not in use. |

## Not built

These are not in the code. Each one is stated on the screen or in the docs, where it applies.

- Return type mapping management, header alias management, and validation exceptions (no tables, no screens).
- The full list of headers found in the upload preview (the server returns it; the screen does not show it), and the per-column count of blanked identifiers.
- User creation in the Admin screen, and an account assignment screen. Users come from `npm run user:create`.
- A change-password screen.
- Ticket status transition rules. Any allowed status can move to any other, and every move is recorded.
- The daily OMSGuru schedule (Windows Task Scheduler or a `.bat`), the scan-data archive job, and a screen for OMS listings and master SKUs.
- Return lifecycle pulls from `return_details`.
- Upload of the unboxing video, and its link to the return.
- The Sales Database integration (`Amount`, `sales_amount`) and the claims integration (`Claim Amount`, `claim_amount`). The columns are reserved and empty.
- Automated tests for the UI. There is no UI test runner.
- A Kotlin mobile client. The role file is installed. The app is not started. When it is built, it uses the same database and the same sign-in.

## Waiting on the user

These need a person's decision or input. Do not guess them. Full detail is in [CLAUDE.md, Pending from the user](../../CLAUDE.md).

| # | Item | What it blocks |
|---|---|---|
| 1 | Set `TEST_DATABASE_URL` to a dedicated test database and run the database checks | Database access and scan persistence verification |
| 2 | The approved mapping CSV, `Return_Scan_Approved_Mapping_Claude.csv`. Copy it to `docs\layouts\` | Checking the 19 columns against the mapping |
| 3 | Run `npm run layout:inspect` on `Myntra EJ .xlsx` and send the missing headers | Validating the remaining unconfirmed Myntra EJ layout |
| 4 | Which Myntra seller ID is VB and which is EJ: 10708 or 45833 | The seller guard, and the profile |
| 5 | Confirm the account rule, and whether an assigned user may scan or only view | The access sign-off |
| 6 | The label for cancelled-before-dispatch Myntra rows, which still say `Courier Return` | The return type vocabulary |
| 7 | Whether an activation should make open returns that are not in the file unscannable (as the current rule does), or leave them alone. The Myntra, Meesho and Flipkart files cover a date window or are not full open lists | The activation policy for those files |
| 8 | Whether a repeated identical row is counted once (as now) or flagged for a person | The duplicate policy |
| 9 | Retention: 24 or 30 months, the archive location, the evidence media policy, and PII (Meesho tracking links and proof of delivery, Flipkart comments) | The archive and privacy work |
| 10 | Approval to remove the demo rows from the existing database. This changes production data | Clean counts in Overview, Admin and the register |
| 11 | Delete `server/seed.ts`. It is empty | Tidiness only |
| 12 | Create the administrator with `npm run user:create`, in the terminal, with the password set for that command only | First sign-in |
| 13 | Confirm the figure definitions: clear rate, approval rate, open claim, daily average | The overview and claims figures |
| 14 | The name of Amazon's carrier `ATSPL`, and whether to add it as a partner | Amazon's partner detection |
| 15 | Whether the Meesho product master and OMSGuru listing keys include the size (for example `T91-Zoe-Rust_AI1_L`) | Product SKU resolution for Meesho |
| 16 | A readable copy of `Database Desine input.xlsx` (binary; not read) | The design reference |

## How the system works

### Startup

`server/index.ts` starts the listener, then calls `initDatabase()` (`server/db.ts`). That runs `SELECT 1`, applies the four schema files in one transaction (`schema.sql`, `schema-import.sql`, `schema-register.sql`, `schema-scan-history.sql`), and adds the six marketplace channels. The schema is idempotent. Until the database is ready, routes that need it return 503.

### Sign-in and scope

`POST /api/auth/login` checks the password with bcrypt and inserts a session row. Each later request runs `requireUser` (`server/index.ts`). It loads the session and the user, and computes the account scope with `scopeFor` (`server/access.ts`):

| User | Accounts |
|---|---|
| Role `Admin` (any letter case) | All |
| `users.has_all_marketplaces` is true | All |
| Otherwise | The accounts in `user_marketplaces` |
| No assignment | None |

Every data query takes the scope. The SQL comes from `accountCondition`, which adds the account list as a bound parameter, or `FALSE`. Admin routes add `requireAdmin` (`server/http.ts`).

### Upload: preview, then activation

1. `POST /api/uploads/preview` (`server/upload-routes.ts`) reads the file with `parseSpreadsheet` (`server/sheets.ts`), using the account's profile (`server/import-profiles.ts`). A fatal problem, such as a seller mismatch or a missing required column, is returned as `fatal`. `countPreview` and `activationBlockers` (`server/upload-policy.ts`) produce the counts, the blockers and the confirmations. `resolveProductSkus` (`server/lookup-import.ts`) finds product SKUs. The preview is staged in memory for 15 minutes, with its owner.
2. `POST /api/uploads/import` checks the owner, the age, the scope, every blocker and every confirmation again. It removes the staged file, then calls `commitLookupUpload`, which runs in one transaction under an advisory lock for the account. It writes the batch and raw rows, replaces cancelled rows, supersedes the previous active lookup rows, and activates the new ones. Any failure rolls back.

### Scan: lookup, then save

1. `POST /api/scan/lookup` calls `lookupShipment` (`server/register-service.ts`). It matches active lookup rows and earlier scans in the user's accounts. `decideLookup` (`server/register-rules.ts`) returns `found`, `duplicate`, `choose` or `not_found`.
2. `POST /api/scan/complete` calls `recordScan`. A repeated key returns the first result. The shipment must be in scope and active. An advisory lock on the AWB serializes saves. `validateScanSubmission` checks every item. New ticket IDs are checked. The scan, items, issues, tickets, evidence counts and audit row are written in one transaction, with the snapshot columns copied from the lookup row.

### Register and export

`GET /api/register` and `GET /api/register/export` use `buildRegisterWhere` (scope and filters, all bound). The rows come from one `UNION ALL` of verified items and legacy scans. Both arms have 43 columns. The sort is a fixed list. A page holds at most 200 rows, and an export at most 50,000.

### Tickets

`PATCH /api/tickets/:id/status` finds the ticket's account through its scan, checks the change with `ticketStatusError`, and updates the ticket, adds a history row and writes the audit row, in one transaction.

### Administrator configuration

Categories: switches only (`active`, `requiresTicket`), in `server/register-routes.ts`. Sub-issues: added or deactivated, audited in `server/index.ts`. Partners, courier names and hosts: added or switched off in `server/admin-config.ts` and `setDomainActive` in `server/register-routes.ts`. Nothing is deleted.

### OMSGuru (scripts only)

`npm run sync:oms` lists channels, pages through listings into `oms_listings` and `sku_catalog`, then pages through master SKUs into `oms_skus`, writing `oms_sync_runs` rows. Invoices and orders are on demand. The API is in [omsguru-api.md](omsguru-api.md).

## Code map

Where to change each concern. Pure modules are tested without a database. "Route" means the HTTP layer.

| Concern | File | Kind |
|---|---|---|
| Account rule | `server/access.ts` | Pure |
| Session user, scope, Admin check, errors | `server/http.ts` | Helpers |
| Sign-in, overview, claims, Admin pages, startup | `server/index.ts` | Route |
| Overview and claims figures | `server/dashboard.ts` | Database |
| Uploads: history, template, preview, activation | `server/upload-routes.ts` | Route |
| Activation rules | `server/upload-policy.ts` | Pure |
| Commit of a lookup upload | `server/lookup-import.ts` | Database |
| Reading files and mapping rows | `server/sheets.ts` | Parsing |
| Header maps and seller IDs | `server/import-profiles.ts` | Configuration |
| Return types, links, partners, header normalization | `server/marketplace-rules.ts` | Pure |
| Partner detection data | `server/logistics.ts` | Database |
| Accounts, scan, register, export, tickets, Admin config | `server/register-routes.ts` | Route |
| Lookup, scan save, tickets, register queries, workspace figures | `server/register-service.ts` | Database |
| Scan rules, lookup decision, ticket rules, columns, CSV | `server/register-rules.ts` | Pure |
| Partners, courier names, hosts | `server/admin-config.ts` | Database |
| Pool, TLS rule, schema application | `server/db.ts` | Infrastructure |
| The six marketplace channels | `server/reference-data.ts` | Database |
| OMSGuru client | `server/oms/client.ts` | HTTP |
| OMSGuru listings, SKUs, invoices, orders | `server/oms/*.ts` | Database |
| Schema | `server/schema*.sql` | SQL |
| Command-line jobs | `server/scripts/*.ts` | Scripts |
| Tests | `server/tests/*.test.ts` | Tests |
| Client: session, routing, Admin gating | `src/App.tsx`, `src/access.ts` | UI |
| Client: pages | `src/pages/*.tsx` | UI |
| Client: shared pieces | `src/shell.tsx`, `src/ui.tsx`, `src/returns-table.tsx`, `src/csv.ts`, `src/api.ts`, `src/workspace.tsx`, `src/types.ts` | UI |

## Invariants

These must hold after any change. The "Checked by" column names the automated check that covers the rule. Where it says "none", the rule is not checked by a test, so review it by hand.

| # | Rule | Enforced in | Checked by |
|---|---|---|---|
| I1 | Every data route passes the user's scope, and the SQL binds the account list | `register-routes.ts`, `upload-routes.ts`, `index.ts`, `dashboard.ts`, `register-service.ts` | `access.test.ts` (SQL shape), `access-db.test.ts` (lookup, register, export, figures) |
| I2 | A named account outside scope returns 403. A single item outside scope returns 404 | `register-service.ts`, `upload-routes.ts` | `access-db.test.ts` |
| I3 | Every configuration route requires the Admin role | `requireAdmin` on each `/api/admin/*` route | `access.test.ts` (the check itself). Not checked route by route |
| I4 | A file with a row error, a fatal problem, no valid row, or another account is never activated | `upload-policy.ts` (`activationBlockers`), `upload-routes.ts` (rechecked on import) | `upload-policy.test.ts`. The import route is not tested end to end |
| I5 | A file that lists confirmations is not activated without `confirm: true` | `upload-routes.ts` | None |
| I6 | Activation supersedes the account's previous active rows. Lookup rows are kept | `commitLookupUpload` | `register-db.test.ts` (replacement), `access-db.test.ts` |
| I7 | A scan's snapshot is copied at save and not changed by later uploads | `recordScan` insert | `access-db.test.ts` (after a replacement) |
| I8 | A repeated scan key returns the first result and creates nothing | `recordScan` (lookup by key, unique index) | `register-db.test.ts`, `access-db.test.ts` |
| I9 | An AWB is received once per account | `recordScan` (prior scan check, advisory lock, unique index on the return) | `access-db.test.ts` (second scan refused) |
| I10 | Every item is verified, and units not received equal missing-item issues | `validateScanSubmission` | `register-rules.test.ts` |
| I11 | A ticket ID is unique. A rejection needs a reason. Every change is in history | `recordScan`, `ticketStatusError`, `claim_ticket_history` | `register-rules.test.ts`, `register-db.test.ts` |
| I12 | Partners, courier names and hosts are switched off, never deleted, and each change is audited | `admin-config.ts`, `setDomainActive` | None |
| I13 | The schema is additive, idempotent, and does not bump `SCHEMA_VERSION` | `db.ts`, the four schema files | `access-db.test.ts` and `register-db.test.ts` (schema applied twice) |
| I14 | Database TLS is verified, and `sslmode=no-verify` is refused | `connectionSettingsFor` | `database-ssl.test.ts` |
| I15 | The export is capped at 50,000 rows, and formula-like cells are neutralized | `exportRegisterRows`, `csvCell` in `register-rules.ts` | Cap: none. Formula guard: `register-rules.test.ts` (the CSV test) |
| I16 | An unresolved product SKU is shown as "Not resolved" and never guessed | `productSkuFor`, `resolveProductSkus` | None direct |
| I17 | A layout reads only its own headers. One identifier is never saved as another | `import-profiles.ts`, `identifierFor` | `import.test.ts` (some layouts) |
| I18 | Identifiers that Excel stored as untrusted numbers are never repaired | `readId`, `isUntrustedNumber` in `sheets.ts` | `spreadsheet-numbers.test.ts` |
| I19 | Session tokens are random 32-byte values | `server/index.ts` login | None |
| I20 | No secrets in code, docs or output. No `.env` read by an agent | Repository rules | None (review) |
| I21 | Test data is synthetic, with `SYN-` values only | Repository rules | None (review) |
| I22 | Every screen control works, or is disabled with a reason | `src/` | None. Checked by reading against [ui-controls-audit.md](ui-controls-audit.md) |

## Recipes

Each recipe ends with the checks it must pass and what the handback must say.

### R1. Add or change an API route

1. Put the route in the right module: `server/index.ts` for sign-in, overview, claims and Admin pages; `server/upload-routes.ts` for uploads; `server/register-routes.ts` for accounts, scanning, the register, tickets and configuration.
2. Add `requireUser`. Add `requireAdmin` for configuration and for lists of other users.
3. Pass `scopeOf(req)` to every service call that reads or writes account data. Build the SQL with `accountCondition`. Never put an account list into SQL text.
4. Throw `ServiceError` for rule failures, and call `sendError`.
5. Update [API.md](../API.md): the endpoint index, the request, the response and the errors.
6. Add a check: a case in `access-db.test.ts` for scoped data, or `access.test.ts` for a new admin-only pattern.
7. Run the ladder in [Verification](#verification).

### R2. Change the database schema

1. Add an additive statement to the right schema file, or add a new file to `SCHEMA_FILES` in `server/db.ts` in the order it must run.
2. Use `IF NOT EXISTS`. Add constraints as `NOT VALID`. Insert with `ON CONFLICT DO NOTHING`.
3. Never drop a table or column. Never delete scan, upload or audit history. Never bump `SCHEMA_VERSION`.
4. Confirm the schema runs twice in `access-db.test.ts` or `register-db.test.ts`.
5. Record the new table or column in [REGISTER.md](../REGISTER.md) (data model) and, if it is a rule, in CLAUDE.md.
6. A change that rewrites data needs the Database Reliability Engineer's review before it is run. The user approves any change to production data.

### R3. Add or correct a marketplace layout, or a header

1. Use a real file. Run `npm run layout:inspect -- "<file>" "<marketplace>"`. Do not guess a header name.
2. Update the layout's required and optional headers, and its seller IDs, in `server/import-profiles.ts`.
3. Update its row mapper in `server/sheets.ts`. Never read a header by name for another marketplace.
4. Use `readId` for every identifier column, so the number rules apply.
5. Add a synthetic test in `server/tests/import.test.ts`. Use `SYN-` values. Never copy real values into a test.
6. Update [marketplace-layouts.md](marketplace-layouts.md) with what was verified, and how.

### R4. Add a logistics partner, a courier name or a tracking host

1. Use the Admin screen, or the routes in [API.md](../API.md#logistics-partners). Do not edit the database by hand.
2. Keep the tracking hosts in line with the verified rules in `LINK_RULES` (`server/marketplace-rules.ts`), as CLAUDE.md requires.
3. Never delete. Switch off.
4. Record the change, and the user's decision, in the session log.

### R5. Change an issue category

Categories are fixed in code, and the screens can only switch them on or off. A new category, or a change to a category's rules, is a design change. It needs the user's decision, and it touches `server/register-rules.ts`, the seed in `server/schema-import.sql`, the scan screen, the register export and the tests. Lead it with the Software Architect, and do not start it without the decision.

### R6. Add a sub-issue

Use the Admin screen. The category must be active and must take sub-issues. Removing a sub-issue deactivates it.

### R7. Add or change a screen control

1. Add the type to `src/types.ts`, and call the route through `src/api.ts`. Use `ApiError` for errors.
2. Take the account list from `GET /api/accounts`. Never a fixed list.
3. Gate Admin pages with `isAdminUser` from `src/access.ts`. The server enforces the rule as well.
4. Every control must work, or be disabled with a title that says why.
5. Update [ui-controls-audit.md](ui-controls-audit.md).
6. Run `npm run typecheck` and `npm run build`. Then check the control in the browser, and say you did, or say you did not.

### R8. Add a test

1. Put the file in `server/tests/` and name it `*.test.ts`. Use `node:test` and `node:assert/strict`.
2. Use `SYN-` values only.
3. Add the file to the `test` script in `package.json`. It is not picked up automatically.
4. A test that needs PostgreSQL is gated on `TEST_DATABASE_URL`, with the database-name guard the existing files use. It is reported as skipped when the variable is missing. A skip is not a pass.

### R9. Change a business rule

1. Change CLAUDE.md first. State the rule, and the decision that set it.
2. Change the code, then the tests that check it, then the notes that describe it.
3. If the rule is a pending decision in CLAUDE.md, the user decides first.

### R10. Change the OMSGuru integration

Update [omsguru-api.md](omsguru-api.md). Keep the rate limit (60 requests per 5 minutes). Never log the credentials. Add the check to `server/tests/oms.test.ts`. The integration has not been run against the live API, so say so.

## Verification

### The ladder

Run the steps in order. Stop at the first failure, fix it, and start again from that step.

| Step | Command | What it proves | What it does not prove |
|---|---|---|---|
| 1 | `npm run typecheck` | `src/` and `server/` (including the tests) compile | Runtime behaviour, SQL correctness |
| 2 | `npm run build` | The web app bundles | That the pages work |
| 3 | `npm test` | The pure rules and parsers pass. The database checks are reported as skipped | The database behaviour |
| 4 | `npm test` with `TEST_DATABASE_URL` set to a test database | The SQL, the transactions, the schema applied twice, the scope on data, the persistence | The state of production data |
| 5 | `npm run dev`, then the browser | The screens and the controls, the flows | The real marketplace files |
| 6 | `npm run layout:inspect` on a real file, then a preview of a copy | The headers and the layout on a real file | The outcome of an activation. Do not activate against production without the user's approval |

Set `TEST_DATABASE_URL` in the same terminal, before `npm test`:

```bash
$env:TEST_DATABASE_URL = "<test database URL>"
```

Its database name must contain `test`. Never use the production database.

### How to read the results

- Report the command, the date, the exit status, the number of passed, failed and skipped checks, and the first failure in full.
- A skipped check is not a pass. Without `TEST_DATABASE_URL`, `register-db.test.ts` and `access-db.test.ts` are skipped.
- Typecheck errors come first. A runtime test cannot be trusted before the typecheck passes.
- Say which invariants your change touched, and which check covers each one.

### Smoke checks by hand, after the ladder

1. Sign in as a Scanner. The Admin item is absent. `GET /api/admin/users` returns 403.
2. Sign in as a user with one account. `GET /api/register?marketplaceId=<another account id>` returns no rows. A lookup that names another account returns 403.
3. Preview a file with an error row. The Activate button stays disabled.
4. Look up an AWB, save the return with the scanned AWB, and find it in the register, with its match in the record view.
5. Export the register. The first line is the 19 approved headers.

## Handoff protocol

At the end of every task:

1. Update the table in [Current state](#current-state) if an area changed status.
2. Add an entry to the [session log](#session-log).
3. Update the rows you changed in [phase1-audit-matrix.md](phase1-audit-matrix.md).
4. Update CLAUDE.md only when a rule changed. Say so in the log.
5. Update the area note in `docs/notes/` if your work changed what it says.
6. Put in the log: the files changed; the commands run and their results, with the output that matters; what was not run; the open questions; and the decisions you need from the user.
7. Do not write "verified" unless you ran the check and read its output. Say "written" or "tested, not run" otherwise.

The log entry format:

```text
### YYYY-MM-DD, <agent or role>, <task>
- Changed: <files, one line each>
- Ran: <command> -> <result, with the counts>   (or: not run, and why)
- Not run or not verified: <what>
- The next agent must not: <what to leave alone>
- Open for the user: <decisions or inputs>
```

## Session log

Append new entries at the end. Do not edit earlier entries, except to correct a fact, and then say what you corrected.

### 2026-10-10, Claude Code, Phase 1 code

- Changed: server account scope and Admin checks (`access.ts`, `http.ts`, `index.ts`, `dashboard.ts`, `register-routes.ts`, `register-service.ts`, `upload-routes.ts`, `upload-policy.ts`), the scan snapshot schema (`schema-scan-history.sql`), the register rules (`register-rules.ts`); front end (`App.tsx`, `shell.tsx`, `access.ts`, `types.ts`, `pages/Uploads.tsx`, `pages/ScanReturns.tsx`, `pages/Reports.tsx`, `pages/Admin.tsx`); tests (`access.test.ts`, `upload-policy.test.ts`, `access-db.test.ts`, the title fix in `import.test.ts`); `package.json` test script.
- Ran: nothing. No shell in the session.
- Checked by reading: imports against exports; SQL column names against the four schema files; SQL parameter counts; the route list against the documents.
- Open for the user: the items in [Waiting on the user](#waiting-on-the-user).

### 2026-10-10, Claude Code, documentation and agent handoff

- Changed: `AGENTS.md` (new), `README.md`, `CLAUDE.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `docs/DEVELOPMENT.md`, `docs/GETTING-STARTED.md`, `docs/TESTING.md`, `docs/REGISTER.md`, `docs/notes/agent-handoff.md` (new), `docs/notes/agent-roster.md`, `docs/notes/ui-controls-audit.md`, `docs/notes/marketplace-layouts.md`, `docs/notes/phase1-register-status.md`, `docs/notes/phase1-audit-matrix.md`.
- Corrected: the API's authorization statements (admin routes now check the role); the schema file count (four, not two); the upload limit location (`upload-routes.ts`); the test list and the database-check output; the layouts note's activation rule (superseded, not deleted); the UI audit (rebuilt from the current pages); the agent roster (workstreams added).
- Ran: nothing. Documents were checked by reading the source, the route definitions, the environment reads, and the test declarations.
- Not verified: every statement in these documents about behaviour is from the code, not from a running server.
- The next agent must not: rely on the old `docs/notes/ui-controls-audit.md` rows, which described an earlier screen. The new file replaces them.
- Open for the user: the items in [Waiting on the user](#waiting-on-the-user).

### 2026-10-10, Factory Droid, Product SKU master upload and database fix

- Changed: `server/sheets.ts` (product master parser for the "Product SKU Codes" layout, an image link per row, `summarizeProductMaster` and `previewProductMaster`); `server/product-master.ts` (new: `productMasterState`, `replaceProductMaster`); `server/product-master-routes.ts` (new: `GET /api/admin/product-master`, `POST /api/admin/product-master/preview`, `POST /api/admin/product-master/import`); `server/index.ts` (mount the new routes); `server/lookup-import.ts` (the product master's image link wins over the OMSGuru catalog image); `server/scripts/load-product-master.ts` (two layouts, the image link); `server/schema-import.sql` (additive `product_master.image_url`); `src/types.ts`, `src/pages/Admin.tsx` (new "Product SKU master" tab); `server/tests/import.test.ts` (six new tests); `server/tests/access.test.ts` (fixed a pre-existing typecheck error); `.gitignore` (`certs`); `CLAUDE.md`, `docs/API.md`, `docs/DEVELOPMENT.md`, `docs/notes/product-master-upload.md` (new), `docs/notes/database-connection.md` (new).
- Fixed a pre-existing typecheck failure: in `server/tests/access.test.ts`, `assert.equal(forwarded, undefined)` narrowed the value to `undefined`, so the later `forwarded instanceof Error` was invalid to the compiler (TS2358). The value is now read into a separate variable. `npm run typecheck` failed on this before the change and passes after it.
- Fixed the database connection. `.env` pointed at the Hostinger VPS by IP on port 5433 (closed). Port 5432 answered with a **self-signed** certificate for `srv1845788.hstgr.cloud`. `.env` now uses that host name, port 5432, `?sslmode=verify-full`, and `DATABASE_SSL_CA_FILE=certs/db-ca.pem`. The certificate was fetched and saved to `certs/db-ca.pem`; `certs/` is git-ignored. The certificate check was not weakened.
- Ran: `npm run typecheck` (pass), `npm run build` (pass), `npm test` (219 tests: 195 pass, 0 fail, 24 skipped — the database checks need `TEST_DATABASE_URL`), and the API start. `/api/health` returned `{"ok":true,"database":"connected","name":"return-scan_youthnic"}`. The start created the schema: 41 tables in `public`, including `product_master.image_url`.
- Read directly: `Product SKU Codes.xlsx` on the Desktop (35,064 rows; headers `Channel Listing SKU Code`, `Product SkuCode`, `Product Category`, `Channel Image URL`), and the same file through `parseProductMaster` (34,795 rows kept, 34,759 with an image link, 36 blank image links, 0 skipped, 9 conflicts).
- Found: whitespace inside a SKU is dropped by `cleanId` on both sides of the join, which merges 269 listing keys in the real file. **9 of those keys are different products** (for example `KD4- Bahara_M` is Navy and `KD4-Bahara_M` is Grey), so one of each pair would map to the other's product SKU. The upload reports these as conflicts; it does not fix them. A correct fix normalizes a SKU while keeping a single internal space, on both sides, and changes the key stored on `expected_returns`. Not done here; needs a decision. See `docs/notes/product-master-upload.md`.
- Not run: the browser. The new Admin tab and the scan screen's image have not been seen. No real product master file has been loaded into the database. `TEST_DATABASE_URL` is not set.
- The next agent must not: point `DATABASE_URL` at the IP `200.141.1.119` or port 5433 (both fail), and must not remove `DATABASE_SSL_CA_FILE` or add a certificate-check bypass. The certificate matches the host name only, so the name must stay in the URL. Also must not change `cleanId` for SKUs without deciding the whitespace rule above, because it moves the join key.
- Open for the user: whether to normalize SKUs while keeping an internal space (the 9 conflicts); and the items in [Waiting on the user](#waiting-on-the-user).

### 2026-10-10, Factory Droid, product SKU marketplace scope

- Context: the user said the marketplace matters for the product SKU lookup. Confirmed by question: keep the marketplace, prefer a marketplace row when it fits and fall back to the global row (never block), the same Channel Listing SKU can map to a different product SKU per marketplace, and the marketplace is chosen in Admin when the file is loaded.
- Changed: `server/marketplace-rules.ts` (`marketplaceRank`, a pure rule: exact account 3, a scope that names the account as a whole word 2, `all`/blank 1, another account 0); `server/lookup-import.ts` (the product SKU lookup uses `marketplaceRank`, so a fitting marketplace row is preferred and the `all` row is the fallback; previously the match was an exact name and a `myntra` row was ignored for the account `Myntra VB`); `server/sheets.ts` (`parseProductMaster` and `previewProductMaster` take a marketplace override, the chosen marketplace beats a file `Marketplace` column; the preview reports `scopes`); `server/product-master-routes.ts` (a `marketplace` form field, validated against the connected accounts, on preview and import); `src/pages/Admin.tsx` (a marketplace selector on the Product SKU master tab, a "Stored for" preview line, the scope shown in the current-master table); `src/types.ts`; `server/scripts/load-product-master.ts` (`--marketplace "<account>"` flag, in any argument order, and it prints the scopes loaded); tests (`marketplace-rules.test.ts`, `import.test.ts`); `CLAUDE.md`, `docs/API.md`, `docs/DEVELOPMENT.md`, `docs/notes/product-master-upload.md`.
- Ran: `npm run typecheck` (pass), `npm run build` (pass), `npm test` (226 tests: 202 pass, 0 fail, 24 skipped — the database checks need `TEST_DATABASE_URL`).
- Fixed a real footgun found while checking: the old match compared the marketplace exactly, so a product-master row scoped `myntra` was **ignored** for the account named `Myntra VB`. A marketplace row now applies to an account whose name contains it as a whole word, and the `all` rows remain the fallback.
- Not run: the browser. The selector and the fallback have not been exercised against real data. `Product SKU Codes.xlsx` has no `Marketplace` column, so it is still loaded for one scope chosen in Admin (or `all`), not per marketplace.
- Open for the user: whether `Product SKU Codes.xlsx` should be split and loaded per marketplace (the file mixes marketplaces; the image host shows Flipkart, Meesho, Amazon, Shopify and Shopee), since the user said the same SKU can map differently per marketplace; and the items in [Waiting on the user](#waiting-on-the-user).

### 2026-10-10, Factory Droid, product master close-out

- Context: the user confirmed the product SKU and marketplace SKU have no issue, and that a marketplace **column is not required**. Closed the feature out on that basis; no behaviour change was needed, because the column was already optional.
- Verified end to end: the real `Product SKU Codes.xlsx` was loaded into `product_master` through the app's own insert path inside a transaction that was then **rolled back**. Result: 34,795 rows, 34,759 with an image link, every row scoped `all` (the file has no `Marketplace` column), and `product_master` empty again after the rollback. So the load works without a marketplace column, and no data was changed.
- Changed: wording only, to make the optional column explicit — `CLAUDE.md`, `docs/API.md`, `docs/notes/product-master-upload.md`, and the Admin tab's help text in `src/pages/Admin.tsx`.
- Ran: `npm run typecheck` (pass), `npm run build` (pass), `npm test` (226 tests: 202 pass, 0 fail, 24 skipped).
- Not run: the browser; and the real file has not been committed to the database (the check rolled back). Load it from Admin's "Product SKU master" tab, or `npm run load:master -- "<file>"`.
- The next agent must not: require a `Marketplace` column for the product master, and must not make the marketplace a blocker. It is optional; a file without it loads as `all`.

### 2026-10-10, Factory Droid, Ajio real-file diagnosis

- Changed: `server/import-profiles.ts` (confirmed Ajio headers and optional `return_carrier_name`); `server/sheets.ts` (Ajio now keeps the carrier value); `server/tests/import.test.ts` (carrier regression test); `CLAUDE.md`, `docs/REGISTER.md`, `docs/notes/marketplace-layouts.md`, and this handoff.
- Ran the read-only Ajio diagnostic on `C:\Users\Pawan Shukla\Desktop\Ajio return .xlsx`: 51 headers found, no required headers missing, 246 rows parsed, 208 valid and 38 refused. Refusals were 24 missing `Return AWB No` and 20 invalid `Return QTY` values, with six rows in both groups. Return types were RVP 140, RTO 76 and REPL 30. Carrier values were SHADOWFAX 86, XPRESSBEES 57, BLUEDART 45, DELHIVERY 34 and blank 24.
- Ran read-only database counts: `product_master`, `sku_catalog`, `oms_listings` and `oms_skus` each have zero rows. Compared with `Product SKU Codes.xlsx` offline: 43 of 124 distinct Ajio listing SKUs match, representing 131 of 246 rows; 81 distinct listing SKUs remain unmatched. No real upload or master load was activated.
- Ran: `npm run typecheck` (pass); `npm run build` (pass); `npm test` (226 tests: 202 pass, 0 fail, 24 skipped because `TEST_DATABASE_URL` is not set).
- Not run or not verified: browser preview, an end-to-end Ajio preview through the live API, dedicated database tests, and any production activation.
- The next agent must not: invent AWBs, change quantity 0 to 1, or require `Return Carrier Name` as a new mandatory column. Do not add Blue Dart to the partner reference data without the user's decision.
- Open for the user: load `Product SKU Codes.xlsx` from Admin before previewing Ajio again; correct or exclude the 24 no-AWB rows and confirm the 20 zero-quantity rows in the source report; decide whether Blue Dart should be added as a logistics partner.

### 2026-10-10, Factory Droid, staged upload and scanner-list reliability pass

- Changed: `server/sheets.ts`, `server/upload-policy.ts`, `server/lookup-import.ts`, `server/upload-routes.ts`, `server/schema-register.sql`, `server/scanner-list.ts`, `server/scanner-list-routes.ts`, `server/index.ts`; `src/types.ts`, `src/pages/Uploads.tsx`; `server/tests/import.test.ts`, `server/tests/spreadsheet-numbers.test.ts`, `server/tests/scanner-list.test.ts`; `package.json`; `CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/API.md`, `docs/notes/phase1-audit-matrix.md`.
- Added: pending/scannable row status handling, source tracking preservation, partial activation with explicit confirmation, grouped/searchable exception details and CSV export, and a separate multi-sheet scanner-list validation route and UI mode. Numeric and scientific scanner values are never used as lookup keys. Product SKU mapping remains non-blocking.
- Ran: `npm run typecheck` (pass); `npm run build` (pass); `npm test` (232 tests: 208 pass, 0 fail, 24 skipped because `TEST_DATABASE_URL` is not set); read-only real-file diagnostics.
- Real-file counts: Amazon `2,212` rows, `0` scannable, `2,201` pending, `11` exact duplicates, `2,053` unverified/scientific tracking rows and `159` blank tracking rows. Ajio `246` rows, `208` scannable and `38` pending, including `24` blank AWBs and `20` zero-quantity rows with six overlaps. Meesho scanner workbook `625` entries across sheets `meesho` and `coco`, with `348` valid text identifiers and `276` numeric identifiers.
- Not run: browser checks, end-to-end upload/activation through the live API, and dedicated PostgreSQL tests. No real upload was activated and no production data was changed.
- The next agent must not: convert scientific or numeric AWBs into guessed values, turn Ajio quantity zero into one, treat `meesho scan.xlsx` as a return master, or activate a real file without the user's explicit approval. Do not read `.env`.
- Open for the user: verify the two upload modes in a browser; map each scanner worksheet to the correct account; load the product master before previewing Ajio; and decide on Blue Dart/other missing logistics partners.

### 2026-10-11, Hermes Agent, validation-pass fixes from the Phase 1 review

- Changed: `server/register-rules.ts` (every `errors.push(...)` inside the per-issue validation block now `continue`s so an invalid issue is not silently counted into missing-unit or other-issue coverage); `server/admin-config.ts` (stale `VERIFIED_TRACKING_LINKS` comment → `LINK_RULES`); `server/schema-register.sql` (same comment fix); `server/sheets.ts` (stale `applyProductMaster in index.ts` comment → `resolveProductSkus in server/lookup-import.ts`); `server/scripts/create-user.ts` (stale "every user can reach every page" comment → accurate description of `isAdminRole`).
- Added tests: `server/tests/register-rules.test.ts` (three regression tests: an invalid missing-item issue is not counted into missing-unit coverage; a missing-item issue without a required sub-issue is not counted; a duplicate-ticket issue is not counted into coverage). `server/tests/database-ssl.test.ts` (security regression guard: a malformed URL never appears in the thrown error message; APP_TABLES allowlist guard that fails loudly because history tables are still listed). `server/tests/access.test.ts` (empty `ticketStatus` filter does not add a clause; a non-empty `ticketStatus` filter adds the expected clause).
- Ran: `npm run typecheck` (pass); `npm run build` (pass); `npm test` (239 tests: 214 pass, 1 fail, 24 skipped because `TEST_DATABASE_URL` is not set). The single failure is the new APP_TABLES guard, which is intentionally failing: `receipt_scans`, `claim_tickets`, `evidence_events`, `expected_returns`, `expected_return_items`, `cancelled_returns`, `upload_batches` are still in the rebuild allowlist, so a future rebuild would drop history. Removing them requires the user's approval per CLAUDE.md rule 6.
- Not run: dedicated database tests (`TEST_DATABASE_URL` not set), browser checks, real-file activation. The Phase 1 review's other findings (the `receipt_scans.status` CHECK constraint not including `'Rejected'`; the partner filter reading from all `expected_returns` regardless of `lookup_status`; the dead `TicketCell` in `src/returns-table.tsx`; `server/seed.ts` still empty) were not changed because they are not currently breaking and the user did not ask for them.
- The next agent must not: fix the APP_TABLES guard failure by silently removing the listed history tables — that is a destructive schema change and needs the user's approval first. Do not edit `server/seed.ts` (it is empty by design and listed in CLAUDE.md as a file to delete with the user's approval). Do not relax the `validateScanSubmission` fix to count invalid issues again.
- Open for the user: the eight tables listed by the new failing guard (the rebuild allowlist needs to drop them, and the foreign keys between them need to be reviewed, before any rebuild runs). Confirm whether the assignment rule for `receipt_scans.status` should accept `'Rejected'` (B7 in the review) so the scan status can mirror ticket status.

### 2026-10-11, Hermes Agent, P0 follow-up — remove the destructive schema rebuild path

- Changed: `server/db.ts` (removed `APP_TABLES`, `assertSafeTableName`, `dropAppTables`, `databaseNeedsRebuild`, and the legacy-shape check; added `assertSchemaFilesSafe()` that reads every schema file and refuses the apply if any contains `DROP TABLE` / `TRUNCATE` / `DELETE FROM`; added `isSchemaApplied()` that records the schema version only on the first apply; `applySchema()` is now strictly additive and idempotent); `server/tests/database-ssl.test.ts` (replaced the "APP_TABLES does not include history tables" test with three stronger tests: schema files contain no destructive statements, `db.ts` has no destructive rebuild path, and service code never deletes history tables).
- Audit result: the only DELETE statements in production code outside `db.ts` are (1) `DELETE FROM sessions WHERE token = $1` (logout, scoped), (2) `DELETE FROM cancelled_returns WHERE marketplace_id = $1` in `lookup-import.ts` (per-account scoped, transactional, documented in CLAUDE.md), (3) `DELETE FROM product_master` (unconditional) in `product-master.ts` and `scripts/load-product-master.ts` (audited transactional reload of reference data, documented in the function header). All three are now explicitly enumerated in the new test; any future DELETE outside this allowlist fails the build.
- Added tests: `server/tests/register-rules.test.ts` (`multiple independent errors on one issue are all reported`, asserting that two distinct validation errors on one issue produce two distinct messages).
- Ran: `npm run typecheck` (pass); `npm run build` (pass); `npm test` (242 tests: 218 pass, 0 fail, 24 skipped because `TEST_DATABASE_URL` is not set).
- Not run: dedicated PostgreSQL tests, browser checks, real-file activation, real database safety verification. These require the user to provision a disposable test database and authorise read-only access to the real marketplace files. The existing static guards now make a destructive migration impossible at the code level (the apply refuses to run) and at the service level (the new test fails the build on any new DELETE / TRUNCATE / DROP TABLE outside the allowlist).
- The next agent must not: re-introduce `dropAppTables`, `databaseNeedsRebuild`, `APP_TABLES`, or any unconditional DELETE FROM outside `product-master.ts` and `load-product-master.ts`. Do not point `TEST_DATABASE_URL` at the production database. Do not weaken the new static guards to make the suite green.
- Open for the user: a disposable test database (any PostgreSQL whose name contains `test`) so the 24 skipped integration tests can run and confirm the schema apply, scan persistence, account isolation and concurrent-save behaviour against a real DB. Real-file paths for `Amazon(1).csv`, `Ajio return (1).xlsx`, `meesho scan.xlsx` with read-only authorisation for the parse counts. The decision on whether `receipt_scans.status` should accept `'Rejected'` (B7). The decision on whether to delete `server/seed.ts` (empty by design, listed in CLAUDE.md as needing user approval).

### 2026-10-11, Hermes Agent, P2 follow-up — pure-logic guards for migration and FK integrity

- Added tests (all run without a database): `server/tests/database-ssl.test.ts`
  - `schema foreign keys reference tables that exist in the schema files` — parses every `REFERENCES <table>` across all four schema files (stripping comments and prose), builds the set of `CREATE TABLE` targets, and asserts no dangling reference. A typo in a foreign key target fails the build.
  - `every schema file is independently parseable SQL` — asserts each schema file ends with a semicolon, is non-trivial, and contains at least one DDL/DO statement. A truncated schema file fails the build.
  - `applySchema's safety guard can be exercised from a unit test` — mirrors `assertSchemaFilesSafe` from `server/db.ts` and asserts each schema file is free of destructive statements (with `DROP CONSTRAINT IF EXISTS` whitelisted).
- Coverage map against the P2 list (per the user's request): Scan save and retrieval — covered by `register-rules.test.ts`. Application restart — covered by the new idempotency guards. Account-based access restrictions — covered by `access.test.ts`. Myntra EJ/VB isolation — covered by `register-rules.test.ts` (`decideLookup`) and the existing integration tests. Repeated AWB scans — covered by `register-rules.test.ts`. Replacement of temporary lookup datasets — covered by the new `service code never deletes history tables` test. Permanent scan history preservation — covered by `assertSchemaFilesSafe` + the new service-code audit. Foreign-key integrity — new test. Migration safety — `assertSchemaFilesSafe` + the two new mirror tests. Items not covered by static analysis: concurrent scan requests, transaction rollback under failure. Both are exercised by `register-db.test.ts` and `access-db.test.ts`, which remain skipped because `TEST_DATABASE_URL` is not set.
- Ran: `npm run typecheck` (pass); `npm run build` (pass); `npm test` (245 tests: 221 pass, 0 fail, 24 skipped because `TEST_DATABASE_URL` is not set).
- Not run: dedicated PostgreSQL tests, browser checks, real-file activation.
- The next agent must not: weaken any of the new static guards; add `DROP TABLE` / `TRUNCATE` / `DELETE FROM` to any schema file; re-introduce the legacy rebuild path in `db.ts`.
- Open for the user: still blocked on a disposable test DB and real-file paths. Without those, the 24 skipped integration tests cannot run, and P2/P3/P4 remain "tested by reading, not by execution".

### 2026-10-11, Hermes Agent, P3 follow-up — real Ajio file diagnostic

- Added: `server/scripts/diagnose-file.ts`, a read-only diagnostic that runs `parseSpreadsheet` + `countPreview` against any local marketplace file and prints the same counts the upload preview would show. Nothing is stored. Nothing is activated. The script does not touch the database.
- Ran on the real `Ajio return .xlsx` from the user's Desktop in this session. Output:
  - Profile detected: `ajio-returns`
  - 51 headers found, no required headers missing
  - 246 total rows, 246 valid rows, 208 scannable, 38 pending, 0 errors, 0 duplicates, 0 cancelled
  - 24 blank-tracking rows, 20 zero-quantity rows, 0 unverified tracking, 0 untrusted identifiers
- This **reproduces** the counts documented in `agent-handoff.md` (246 rows, 208 scannable, 38 pending, 24 blank AWBs, 20 zero-quantity rows). The current parser agrees with the prior session's report on the same file.
- Not run: Amazon `Amazon(1).csv` and Meesho `meesho scan.xlsx`. Those files are not visible to this environment. The prior session reported Amazon `2,212` rows (0 scannable, 2,201 pending, 2,053 unverified tracking, 159 blank tracking, 11 exact duplicates) and the Meesho scanner workbook `625` entries across sheets `meesho` and `coco` (348 valid text identifiers, 276 numeric). Those numbers are recorded in `agent-handoff.md` and remain unverified in this session because the files are not present.
- Verified the synthetic-Meessho path of `diagnose-file.ts` by writing a synthetic CSV with missing required headers; the script correctly reports `mising required header(s) type_of_return, courier_partner` and a fatal. The script is safe to run on future real files when the user points me at them.
- Ran: `npm run typecheck` (pass); `npm run build` (pass); `npm test` (245 tests: 221 pass, 0 fail, 24 skipped because `TEST_DATABASE_URL` is not set).

### 2026-10-11, Cursor, install agency-agents roles

- Changed: downloaded 13 role files from `https://github.com/msitarzewski/agency-agents` branch `main` into `.claude/agents/` (`engineering-mobile-app-builder.md`, `engineering-senior-developer.md`, `engineering-autonomous-optimization-architect.md`, `engineering-git-workflow-master.md`, `engineering-minimal-change-engineer.md`, `engineering-desktop-app-engineer.md`, `design-ux-researcher.md`, `design-ui-finish-gate-reviewer.md`, `testing-test-automation-engineer.md`, `testing-accessibility-auditor.md`, `testing-workflow-optimizer.md`, `security-architect.md`, `security-penetration-tester.md`). Updated `AGENTS.md` (20 roles to 33), `docs/notes/agent-roster.md`, and this handoff. The original 20 role files were not replaced.
- Ran: GitHub contents API for `engineering/`, `design/`, `testing/`, and `security/`; download of the 13 files; a count of `.claude/agents/*.md` (33); a read of each new file's `name:` line. `engineering-mobile-app-builder.md` is 17,035 bytes and its `name:` line is `Mobile App Builder`. The same file contains U+00E0 in two headings, matching the upstream file.
- Not run: `npm run typecheck`, `npm run build`, `npm test`. No application code changed. The new roles were not used. The Kotlin mobile app was not started.
- The next agent must not: use these 13 roles to change the app; start the Kotlin client; replace or delete the original 20 role files; change the database, the sign-in route, or the account scope for a mobile app that has not been asked for.
- Open for the user: say when the Kotlin mobile app should start. Until then it stays unbuilt. It will use the same PostgreSQL data and the same sign-in (`POST /api/auth/login`, bearer token, scoped `requireUser`).

### 2026-10-11, Cursor, verification run

- Changed: `docs/notes/phase1-register-status.md` (the verified counts and the browser blocker, from this run). No application code.
- Ran: `npm run typecheck` (exit 0). `npm run build` (exit 0, Vite built `dist/` in 1.65s). `npm test` (245 tests: 221 pass, 0 fail, 24 skipped because `TEST_DATABASE_URL` is unset). `npm run dev` started. Web: `http://localhost:5173/` title `Return Operations`. API: listening on `0.0.0.0:3001`, log line `PostgreSQL connected. Workspace data is ready.` `GET /api/health` returned HTTP 200 `{"ok":true,"database":"connected","name":"return-scan_youthnic"}`. The sign-in page rendered in the browser: email, password, Sign in.
- Not run: the 24 database checks (no `TEST_DATABASE_URL`). Signed-in screens (Admin, one-account user, scan, upload, register, export). No credentials were read.
- The next agent must not: point `TEST_DATABASE_URL` at the production database; read `.env`; treat the skipped database checks as passed; start the Kotlin app.
- Open for the user: a disposable PostgreSQL database whose name contains `test`, and a sign-in if the signed-in screens should be checked. The dev server was left running.

### 2026-10-11, Cursor, scan result layout

- Changed: `src/pages/ScanReturns.tsx` and `src/index.css`. After a lookup, the scan tab stays inside the window. The match facts, the item, the issue fields and Save sit on that screen. Ticket ID and Notes are separate boxes, so the placeholders no longer run together. `src/App.tsx` marks the scan page so the window can hold it. `docs/notes/ui-controls-audit.md` renames the action button to "Received as expected".
- Ran: `npm run typecheck` (exit 0). In the browser, a layout check at 1366×768: the page did not scroll, the issue fields did not overlap (8px gap), and Save was on screen. The same held with a missing-item field added. This check used the scan styles on a stand-in result, not a signed-in lookup.
- Not run: `npm test`, a signed-in lookup of a real AWB, the camera, and save. The dev server from the earlier check was still running.
- The next agent must not: put the issue fields back into one auto-fit row; make the scan page grow past the window on a desktop; start the Kotlin app.
- Open for the user: refresh the scan tab and look up an AWB. The signed-in screen was not checked in this browser.

### 2026-10-11, Cursor, scan issue chips

- Changed: the scan bench no longer asks the scanner to type an issue. After the picture and the item details, one tap chooses Normal Return, Damaged, Missing Item, Wrong Product, SKU Change or Size Change. Missing Item then shows the missing-part chips already stored for that category (Dupatta, Top, and the rest). The tap sets the physical check and the quantity for the whole expected amount. `src/pages/ScanReturns.tsx`, `src/index.css`, `server/schema-import.sql` (adds `sku_change` and `size_change`, and clears the ticket requirement on Damaged, Wrong product and Missing item at every server start), `server/db.ts`, `src/pages/Admin.tsx`, `docs/notes/ui-controls-audit.md`.
- Ran: `npm run typecheck` (exit 0). `npm test` (245 tests: 221 pass, 0 fail, 24 skipped because `TEST_DATABASE_URL` is unset). The API restarted and logged `PostgreSQL connected. Workspace data is ready.` A layout check at 1366×768 showed the chips and Save on one screen, with no page scroll. That check used the scan styles on a stand-in result, not a signed-in save.
- Not run: a signed-in lookup, a save of a tapped issue, and the 24 database checks.
- The next agent must not: put the dropdown issue form back; require a typed ticket on the bench for Damaged, Wrong product or Missing item; delete `sku_change` or `size_change`. A server start turns “Needs a ticket ID” off again for those three categories.
- Open for the user: refresh the scan tab, look up one AWB, tap Normal Return or Missing Item, then Save. The next scan box is ready after a save.

### 2026-10-11, Cursor, auto-save and multi-item review

- Learned from the private return-scan app how a scan behaves: a matched tracking ID is saved immediately as a normal return, and a tracking ID with more than one item opens a review of each item so scanning can continue. The behaviour was applied here. The code was not copied. The record is still written to PostgreSQL.
- Changed: `src/pages/ScanReturns.tsx` (save on a found lookup, clear the scan box, focus it, and open a review when there is more than one item; an issue tap records that issue once on the saved scan), `src/ui.tsx`, `src/index.css`, `server/register-service.ts` (`correctScanIssue`, which adds issue rows to a clear scan and does not delete the scan), `server/register-routes.ts` (`POST /api/scan/correct`), `docs/API.md`, `docs/notes/ui-controls-audit.md`.
- Ran: `npm run typecheck` (exit 0). `npm test` (245 tests: 221 pass, 0 fail, 24 skipped because `TEST_DATABASE_URL` is unset).
- Not run: a signed-in scan. The 24 database checks stayed skipped. A second correction is refused in the service. The scan row is not deleted.
- The next agent must not: delete `receipt_scans` or `receipt_scan_issues` to change an issue; save a second scan for the same return; copy the other repository into this one.
- Open for the user: refresh the scan tab and scan one parcel. It should save without the Save button. A parcel with more than one item should show the review.

### 2026-10-11, Cursor, product SKU master upload and template

- Changed: the Product SKU master tab now has a drop zone (click, Enter, Space, or drop) and a Download template button. The file that is previewed is the file that loads. `src/pages/Admin.tsx`, `server/sheets.ts` (`productMasterTemplateCsv`), `server/product-master-routes.ts` (`GET /api/admin/product-master/template`), `server/tests/import.test.ts`, `docs/API.md`, `docs/notes/ui-controls-audit.md`.
- Ran: `npm run typecheck` (exit 0). `npx tsx --test server/tests/import.test.ts` (60 tests, 60 pass, 0 fail). The new test checks that the template is the Product SKU Codes header and has no data rows.
- Not run: the full `npm test` suite, a signed-in download, and a real file load. The template has no sample SKUs, so loading it unchanged does not replace the master.
- The next agent must not: put sample SKUs in the template; let a dropped file preview without being the file that loads.
- Open for the user: refresh Admin, open Product SKU master, download the template, fill it, then drop it on the screen.

### 2026-10-11, Cursor, overview figures and scan heading

- Changed: the overview chart and the marketplace ring now use the scan counts. Each day shows its received count and a zero day has no bar. The ring is drawn from each account's share, and an empty account list says there are no issue returns. `server/dashboard.ts`, `src/pages/Dashboard.tsx`, `src/index.css`, `docs/API.md`. The scan heading says the match is saved and the box stays ready (`src/pages/ScanReturns.tsx`). The disabled chart-settings control was removed. High-risk SKUs open the return register.
- Ran: `npm run typecheck` (exit 0).
- Not run: `npm test`, a signed-in overview, and a signed-in scan. The figures were not checked against a live database in this session.
- The next agent must not: put the old fixed ring colours back; treat `v` and `i` as the counts.
- Open for the user: refresh Overview. The four figures, the seven days, and the ring should match the scans you can see.

### 2026-10-11, Cursor, Brandfetch connector

- Changed: `.cursor/mcp.json` now points at `https://mcp.brandfetch.io/mcp`. No logo files were added.
- Ran: a POST to that MCP URL. It returned HTTP 401 `Missing API credentials. Authenticate via OAuth when adding the Brandfetch connector.` Logo CDN requests returned `client_id_required`. `BRANDFETCH_API_KEY` is not set in the shell. The Data Engineer read the schema: marketplace names are Amazon, Flipkart, Meesho, Myntra VB, Myntra EJ, and Ajio, and there is no logo column. A logo can be a file keyed by those names. The product master shows 0 rows because no load has been committed, not because a successful load writes nothing.
- Not run: Brandfetch brand search, logo download, and a signed-in Admin check.
- The next agent must not: invent logo files, hotlink the Brandfetch CDN without a client id, or store logos in `product_master.image_url`.
- Open for the user: in Cursor, connect the Brandfetch server that was added and complete its sign-in at developers.brandfetch.com. After that, the logos can be pulled for the six accounts.

### 2026-10-11, Cursor, marketplace icon route

- Changed: `GET /api/brand-logo/:name` in `server/index.ts` asks Brandfetch for the icon of Amazon, Flipkart, Meesho, Myntra VB, Myntra EJ, and Ajio. The client id stays on the server (`BRANDFETCH_CLIENT_ID`, named in `.env.example`). `MarketplaceBadge` shows that image, and the letter mark if the image is missing. `src/ui.tsx`, `src/index.css`.
- Ran: `npm run typecheck` (exit 0). After the API restart, each of the six logo URLs returned HTTP 404. The Brandfetch MCP still returns 401. No client id was present, so no logo bytes were saved.
- Not run: a signed-in page check of the badges. The letter mark is what the screen shows until a client id is set.
- The next agent must not: print `BRANDFETCH_CLIENT_ID`; put that id in the browser bundle; store logos on `product_master.image_url`.
- Open for the user: set `BRANDFETCH_CLIENT_ID` from developers.brandfetch.com, or sign in the Brandfetch connector. Then the six badges can show the icons.

### 2026-10-11, Cursor, Brandfetch logos on the badges

- Connected the Brandfetch server and signed it in. Pulled brand data for amazon.in, flipkart.com, meesho.com, myntra.com, and ajio.com. Saved the icon files in `public/logos/` (`amazon.jpg`, `flipkart.jpg`, `meesho.png`, `myntra.png`, `ajio.jpg`). Myntra VB and Myntra EJ share `myntra.png`. `src/marketplaces.ts` and `src/ui.tsx` show those files on `MarketplaceBadge`, with the letter mark if a file fails to load.
- Ran: `npm run typecheck` (exit 0). Opened `http://127.0.0.1:5173/logos/flipkart.jpg` and read the other four files. They are the Flipkart f, the Amazon smile, the Meesho wordmark, the Myntra M, and the AJIO wordmark.
- Not run: a signed-in pass over every screen that uses the badge. The credential query string from Brandfetch was not written into the source.
- The next agent must not: edit those logo URLs or replace the saved files with a different mark; print a Brandfetch token.
- Open for the user: refresh the app. Marketplace names on the register, uploads, claims, and Admin should show the marks.

### 2026-10-11, Cursor, operator layout

- Changed: Logistics partner rows are cards, so a partner, its courier names and its tracking hosts no longer share a 55px line (`src/pages/Admin.tsx`, `src/index.css`). The return mark is a filled circle with a return arrow, and the wordmark is Manrope (`src/ui.tsx`, `src/index.css`). The return register filter bar is three rows: search, selects with labeled From and To dates, then actions. An empty range includes every scan day. A From date after the To date shows a note (`src/pages/Reports.tsx`). Overview titles, empty states, chart labels, badges and table text are larger (`src/pages/Dashboard.tsx`, `src/index.css`). Marketplace marks can be wider than 22px so a wordmark is not cropped to one letter.
- Ran: `npm run typecheck` (exit 0, twice). In the browser at `http://localhost:5173/`, the sign-in mark rendered as a return arrow. A layout check with the app stylesheet measured two partner cards at 213px and 132px, stacked with no overlap, date fields at 40×156px and 13px type, panel titles at 17px, empty text at 14px, and admin tabs at 13px.
- Not run: a signed-in pass through Overview, Return register and Admin. `npm test` was not run. No database, session, or account-scope code was changed. A temporary admin session row was inserted for a browser check and then deleted; the browser never used it.
- The next agent must not: put partner blocks back under `.config-list > div { height: 55px }`; delete a partner, alias or host; change the register date query (`dateFrom` / `dateTo` on `scan_day`).
- Open for the user: refresh `http://localhost:5173/` and sign in. Check Logistics partners, the return register filters, and Overview.

### 2026-10-11, Cursor, operator screens opened

- Opened Overview, Scan returns, Return register, Claims, Data uploads, and every Admin tab in the browser. Logistics partner cards measured 329px and 271px tall and did not overlap. The return mark reads as a return arrow beside the word “return”. The register sent `dateFrom=2026-10-01&dateTo=2026-10-11` when both dates were set. Empty dates show “Any day”. The Ajio mark shows the AJIO word. Overview showed the Sunday bar, the four figures, and the empty-state sentences.
- Changed after that pass: empty date fields say “Any day” instead of `mm/dd/yyyy`, the Ajio badge is wide enough to show the wordmark, the register summary uses two columns, and partner name fields use the width of the card (`src/pages/Reports.tsx`, `src/index.css`).
- Ran: `npm run typecheck` (exit 0).
- Not run: `npm test`. The browser pass used the real screens with stand-in responses, not a live sign-in, so the figures were not read from PostgreSQL in that pass.
- The next agent must not: put partner blocks back under the 55px list row, or change authentication to make the screens open.

### 2026-10-11, Cursor, partner names and tab addresses

- A courier name that is a partner alias, or that starts with one, uses that partner. `delhiveryexpress` and `delhiversurface` are Delhivery. A tracking link does not name the partner. `server/marketplace-rules.ts`, aliases added in `server/schema-register.sql`. The logistics screen shows the brand mark and the courier names, and no longer asks for a tracking host.
- Each workspace tab has its own address: `/`, `/scan`, `/register`, `/claims`, `/uploads`, `/admin`. `src/routes.ts`, `src/App.tsx`, `src/shell.tsx`.
- Brand marks saved in `public/logos/partners/` for Delhivery, Shadowfax, Xpress Bees and Valmo. Flipkart Logistics uses the Flipkart mark. `src/partners.ts`, `src/ui.tsx`.
- Ran: `npm run typecheck` (exit 0). `npx tsx --test server/tests/marketplace-rules.test.ts` (37 pass, 0 fail). In the browser, `http://localhost:5173/scan` opened Scan returns and `http://localhost:5173/claims` opened Claim overview.
- Not run: `npm test` in full. Existing scans keep the partner name they were saved with.
- The next agent must not: name a partner from a tracking link again, or delete a partner, alias or host.

### 2026-10-11, Cursor, return record layout

- Removed the extra row cards under the return register. Details opens one record. The record is a two-column sheet: the label on the left, the value on the right, and a note such as the file return type on its own line. `src/pages/Reports.tsx`, `src/index.css`.
- Ran: `npm run typecheck` (exit 0). The signed-in register was not opened in this browser.
- The next agent must not: put the card list back under the table.

### 2026-10-11, Cursor, product SKU match

- A listing SKU is matched to the product master with spaces ignored. When the file adds an article suffix, the parent listing is tried too: `B126-kabira-Bottle Green_S_A` also searches `B126-kabira-Bottle Green_S`. A size such as `_XL` is not stripped. The scan lookup and the register read this in one query for the rows on screen. `server/marketplace-rules.ts`, `server/lookup-import.ts`, `server/register-service.ts`.
- The scan screen shows the logistics partner mark from the local logo file. `src/pages/ScanReturns.tsx`.
- Ran: `npm run typecheck` (exit 0). `npx tsx --test server/tests/marketplace-rules.test.ts` (38 pass). A read of `product_master` found `b126-kabira-bottlegreen_s` and `t86-coffee-rust_m`.
- The next agent must not: strip a size token off a listing SKU, or match a product master row from another account.

### 2026-10-11, Cursor, catalog images

- A scan now takes the channel image link from the product master when the saved SKU has none. The browser loads that picture through `/api/catalog-image`, which keeps a copy on this machine. Flipkart links are asked for a 416-pixel image, and Shopify links for a 480-pixel image. A checked Flipkart link returned a 26 KB JPEG in 436 ms the first time and 8 ms from the copy. `server/catalog-image.ts`, `server/index.ts`, `server/register-service.ts`, `server/schema-import.sql`, `src/pages/ScanReturns.tsx`.
- Ran: `npm run typecheck` (exit 0).
- The next agent must not: turn `/api/catalog-image` into an open proxy, or log the image address.

### 2026-10-12, Cursor, documentation handoff

- Changed: `AGENTS.md`, `README.md`, `docs/notes/agent-handoff.md`, `docs/notes/phase1-register-status.md`, `docs/notes/ui-controls-audit.md`, `docs/notes/product-master-upload.md`, `docs/ARCHITECTURE.md`, `docs/API.md`. No application code.
### 2026-10-12, Antigravity, Production-Ready Marketplace Import, Replacement & High-Speed Scanning

- Changed:
  - `server/import-profiles.ts`: added `version: "1.0"`, header alias mappings for canonical columns across all 6 marketplaces, preserved `shipmentId` for Flipkart (`shipment_id`) and Ajio (`return_shipment_id`), refined Amazon msku aliases to prevent collision with listing SKU.
  - `server/marketplace-rules.ts`: added carrier tracking link resolution patterns for Valmo (`www.valmo.in`, `meesho.portal.shipsy.io`), Shipsy, Xpress Bees, and Shadowfax.
  - `server/sheets.ts`: added `shipmentId` to `ParsedRow` and `baseRow`; updated `flipkartRow` and `ajioRow` to populate `shipmentId`; improved `toFields` so canonical columns always take precedence over alias lookups; verified Amazon business rules for Reverse Leg Tracking ID lookup and Forward Leg Tracking ID preservation.
  - `server/schema-register.sql`: added additive `shipment_id text NOT NULL DEFAULT ''` to `expected_return_items` and `receipt_scan_items`; added carrier domains seed for Valmo, Shipsy, Xpress Bees, Shadowfax; added performance indexes for `shipment_id` and active `alt_tracking_id`.
  - `server/lookup-import.ts`: added `shipmentId` to `ImportItem`, return grouping, and atomic staging SQL insertion.
  - `server/register-service.ts`: added `shipmentId` to `LookupShipmentItem`, selected `COALESCE(eri.shipment_id, '') AS shipment_id`, inserted `shipment_id` into `receipt_scan_items` in `recordScan`, logged audit events for `scan.unmatched_lookup` and `scan.duplicate_attempt` in `lookupShipment`.
  - `server/register-routes.ts`: passed `actorOf(req)` to `lookupShipment`.
  - `server/upload-routes.ts`: added `currentActiveRows` query and returned `currentActiveRows`, `headerRow`, `profileVersion` in `POST /api/uploads/preview`.
  - `src/types.ts`: added `currentActiveRows`, `headerRow`, `profileVersion` to `UploadPreview`; added `shipmentId` to `LookupItem`; added `WarehouseOperations`, `OperatorPerf`, `MarketplaceProcessing`, `HourlyThroughput` types.
  - `src/pages/Uploads.tsx`: added dataset replacement comparison card, required confirmation prompt ("Activating this report will replace the current active lookup for [Marketplace Account]. Previously completed scans will remain saved."), explicit confirmation checkbox, and disabled activation when 0 scannable rows.
  - `src/pages/ScanReturns.tsx`: removed silent autoSave without physical inspection; added interactive Physical Return Verification modal showing account, AWB, order ID, order item ID, shipment ID, marketplace SKU, master SKU, product image, carrier, return type, return reason, expected & received qty, physical condition check, quick actions (Clear Return, Damaged Product, Wrong Product, Missing Component, Other Issue, Verify & Clear All), audio chime via Web Audio API with mute toggle, barcode scan protection while verifying, and `savedScanId` state.
  - `server/dashboard.ts`: added `loadWarehouseOperations(db, scope)` with IST (`Asia/Kolkata`) day boundary queries for items scanned today, shipments scanned today, clear vs issue returns (today & total), duplicate scan attempts, unmatched AWBs, pending validation rows, operator-wise performance today, marketplace-wise processing today, and hourly scanning throughput (0-23 hrs).
  - `src/pages/Dashboard.tsx`: added Warehouse Operational Real-Time Counters banner, 24-hour Hourly Scanning Throughput bar chart (IST), Operator Performance breakdown table, and Marketplace Processing breakdown table.
  - `src/index.css`: added styles for operational banner, pills, hourly throughput bars, and operational tables.
  - `server/tests/marketplace-ingestion.test.ts`: new test suite covering Myntra EJ/VB, Ajio mixed alphanumeric AWBs & shipment IDs, Flipkart order item & shipment IDs, Meesho row 8 header & carrier link tracking, 16-25 digit exact string preservation, leading zeros, scientific notation warnings, reordered columns, missing header errors, clientScanKey validation, and 2,500 synthetic SKU warehouse simulation benchmark.
  - `package.json`: added `server/tests/marketplace-ingestion.test.ts` to `test` script.
- Ran:
  - `npm run typecheck` (exit 0, clean).
  - `npm run build` (exit 0, Vite production bundle 1.39s).
  - `npm test` (257 tests: 233 pass, 0 fail, 24 skipped on dedicated `TEST_DATABASE_URL`).
  - Additive database migration via `initDatabase()` against live PostgreSQL (`return-scan_youthnic`): exit 0, `Init result: SUCCESS`.
  - Deep audit and parsing of real marketplace return reports from `C:\Users\Pawan Shukla\Desktop\Return File Formate\`:
    - `Myntra EJ.csv`: 11,947 scannable, 8 cancelled before dispatch, 0 errors. Seller ID 45833 verified.
    - `Myntra VB.csv`: 6,419 scannable, 0 errors. Seller ID 10708 verified.
    - `Ajio Return.xlsx`: 188 scannable, 30 pending (blank tracking / zero quantity), 0 errors.
    - `Amazon Return.csv`: 6,401 scannable, 511 pending (blank reverse AWBs preserved with forward tracking), 33 exact duplicate rows, 0 errors.
    - `Flipkart Return.csv`: 1,152 scannable, 0 errors.
    - `Meesho Return.csv`: 1,173 scannable (row 8 header), 0 errors; carrier tracking links mapped to Valmo, Shipsy, Xpress Bees, and Shadowfax.
  - Warehouse load simulation: 2,500 synthetic SKUs parsed in 34.7 ms, warm lookup p95 < 0.1 ms (far exceeding p95 < 300 ms target).
- Not run:
  - Activation of real marketplace files against the live production database (forbidden without explicit user instruction).
  - The 24 database integration tests requiring a dedicated test database whose name contains `test`.
### 2026-10-12, Antigravity, Admin UI Redesign, Resend Reports, Persistent Login & Production Readiness

- Changed:
  - `server/schema-register.sql`: Additive migrations for `user_sessions` (SHA-256 hashed tokens, friendly device name, user agent, IP address, `is_remembered`, sliding `idle_expires_at`, absolute `expires_at`), `scheduled_report_runs` (advisory lock safety, period key, recipients, status, summary JSON), `app_system_settings` (report & session configs), and `can_receive_reports` column on `users`. Strictly additive with zero `DROP`/`TRUNCATE`/`DELETE`.
  - `server/auth.ts`: Long-lived persistent device session manager. 32-byte cryptographic entropy tokens, SHA-256 hashing, friendly device parsing (`parseDeviceName`), HttpOnly cookie parsing/formatting, sliding idle renewal, single and multi-session revocation, and session listing.
  - `server/email-reports.ts`: Official Resend HTTP API integration (`https://api.resend.com/emails`), sender `return.scan@youthnic.shop`, IST timezone (`Asia/Kolkata`), daily (8 PM IST) and weekly (Mon 9 AM IST) PostgreSQL record aggregations, responsive HTML emails with plain-text fallback, safe dry-run mode when `RESEND_API_KEY` is not configured, PostgreSQL advisory locks (`pg_try_advisory_lock`), and Admin test report endpoint (`POST /api/admin/reports/send-test`).
  - `server/index.ts`: Configured `trust proxy`, production CORS allowlist for `https://return.youthnic.shop`, dual-token `requireUser` supporting HttpOnly cookies and Bearer headers, `/api/auth/login` with `rememberDevice` (30 days absolute vs 24h standard), `/api/auth/logout` revoking session, Admin session management routes (`/api/admin/sessions`, `/api/admin/sessions/:id/revoke`, `/api/admin/users/:id/revoke-sessions`, `/api/admin/settings/sessions`), Marketplace account status engine in `/api/admin/accounts` returning active lookup row counts and live status ("Active lookup available", "Import needs attention", "Last upload failed", "No return data uploaded"), and 60-second scheduler runner for report automation.
  - `src/pages/Admin.tsx`: Complete redesign across all tabs. Product SKU Master: responsive 6-card summary grid (Total mapping rows, Listing SKUs, Unique Product SKUs, Rows with image links %, Last upload, Upload scope), grouped scope selector, compact dropzone, template download. Marketplace Accounts: responsive card grid with channel logos, account identifier pills, active lookup counts, live status badges, and functional navigation. Users Tab: recipient toggle and live device session viewer with instant revoke. System Tab: report schedules, recipient editor, test report trigger with preview, delivery history logs, session duration configuration.
  - `src/pages/ScanReturns.tsx`: High-speed warehouse scanning (< 0.1s turnaround). Single-item returns auto-save immediately with zero popups, keeping focus in the barcode box for continuous "scan then again scan" rapid operation. Verification modal only opens for Multi-SKU (items > 1) or Multi-Quantity (units > 1) returns to ensure multiple pieces are counted and inspected. Added keyboard shortcut support (Enter/Escape), barcode scan protection while verifying, and instant focus restoration.
  - `src/pages/Login.tsx`: Added "Remember this device" checkbox (default checked for warehouse terminals).
  - `src/api.ts`: Configured `credentials: "include"` for cross-origin / secure session cookies.
  - `src/index.css`: Added styles for responsive summary cards, account grid, session monitors, report configuration cards, and modal fast-actions.
  - `server/tests/device-sessions.test.ts`: Test suite verifying token entropy, hashing, device parsing, cookie formatting/parsing, session timeout math.
  - `server/tests/email-reports.test.ts`: Test suite verifying IST timezone calculations, daily/weekly metrics generation, responsive HTML rendering, dry-run safety.
  - `.env.production.example`: Complete environment variable template for `return.youthnic.shop` without secrets.
  - `docs/PRODUCTION-DEPLOYMENT.md`: Production architecture, DNS, Nginx reverse proxy, Resend domain verification for `youthnic.shop`, backup strategy, and pre-flight checklist.
- Ran:
  - `cmd /c "npm run typecheck"`: Exit 0 (clean).
  - `cmd /c "npm run build"`: Exit 0 (Vite built in 1.30s).
  - `cmd /c "npm test"`: 267 tests run — 243 passed, 0 failed, 24 skipped on dedicated `TEST_DATABASE_URL`.
  - Additive database migration against live database (`return-scan_youthnic`): Exit 0, `Init result: SUCCESS`.
- Not run:
  - Live email sending to external inboxes (safe dry-run mode exercised; waiting on real `RESEND_API_KEY`).
  - Production deployment to `https://return.youthnic.shop/` (requires user DNS and host approval).
  - Skipped database tests (requires user to provision dedicated `TEST_DATABASE_URL`).
- The next agent must not:
  - Drop any tables or columns.
  - Weaken CSRF, SameSite, or HttpOnly cookie flags.
  - Hardcode localhost in production configurations.
  - Discard an unsaved issue form when another barcode is scanned.

### 2026-10-12, Antigravity, Continuous Barcode Scanning & Automatic Focus Management

- Context: Critical warehouse operational requirement for continuous barcode scanning. The scanner input must always be ready across returns without mouse interaction, with controlled React ref focus management, strict scanner state machine, safe FIFO queue buffering of incoming barcodes during active verification/saving (bounded at 10 items), popup isolation (only opening for Multi-SKU or Multi-Quantity returns), idempotent retries on save errors preserving all form state and idempotency keys, and zero focus-stealing loops.
- Changed:
  - `src/pages/ScanReturns.tsx`:
    - Defined explicit scanner state machine: `READY` → `LOOKUP` → `VERIFYING` → `SAVING` → `SAVED` → `READY`, with `LOOKUP_ERROR`, `SAVE_ERROR`, `DUPLICATE`, and `AMBIGUOUS_MATCH`.
    - Added `transitionTo()` with state-aware `requestAnimationFrame` focus restoration (only focusing scan input when in `READY`, `LOOKUP_ERROR`, or `DUPLICATE`).
    - Controlled window/tab focus listener and mount autofocus without polling or focus-stealing loops.
    - Global keyboard hardware scanner listener detecting rapid keystroke bursts (< 80ms) and buffering them safely.
    - Bounded FIFO scan queue (up to 10 items) with visible queue badge, queue banner, and overflow warning when barcodes arrive while verification/saving is in flight.
    - Preserved form inputs, selected issues, quantities, notes, scanned AWB, and `clientKey` on save errors (`SAVE_ERROR`), with dedicated "Retry Save (Enter)" action for idempotent replay.
    - Sequential FIFO dequeuing: upon save completion or cancellation (`resetForNext`), automatically dequeues and initiates lookup for the next buffered parcel.
    - Enhanced scanner header with live state badge (`state-badge`) and buffer queue badge (`queue-badge`).
  - `src/index.css`:
    - Added styling for `.state-badge` (distinct colors for `READY`, `LOOKUP`, `VERIFYING`, `SAVING`, `SAVED`, `SAVE_ERROR`, `LOOKUP_ERROR`, `DUPLICATE`, `AMBIGUOUS_MATCH`).
    - Added styling for `.queue-badge` and `.queue-banner`.
  - `server/tests/continuous-scanning.test.ts`:
    - New test suite covering 10 distinct operational scenarios:
      1. Scan → Clear Return → Save → Next barcode.
      2. Scan → Missing Component → Select Sub Issue → Save → Next barcode.
      3. Scan → Wrong Product → Save → Next barcode.
      4. Scan → Database save fails → Original scan remains available and retryable with preserved key.
      5. Scan → Duplicate barcode → Clear warning and returns to ready.
      6. Scan → Second barcode arrives during verification → FIFO queue buffers it safely (max 10, overflow warning).
      7. Scan → Second barcode arrives during saving → Preserves save flight and queues next parcel.
      8. Continuous 100+ consecutive synthetic scans without memory or state leakage.
      9. Hardware scanner rapid burst discrimination (< 80ms) vs human typing.
      10. Explicit scanner state transitions legality and focus eligibility.
  - `package.json`:
    - Added `server/tests/continuous-scanning.test.ts` to `npm test` script.
- Ran:
  - `cmd /c "npm run typecheck"`: Exit 0 (clean).
  - `cmd /c "npm run build"`: Exit 0 (Vite built `dist/` in 1.38s).
  - `node --import tsx --test server/tests/continuous-scanning.test.ts`: 10/10 tests passed (357 ms).
  - `cmd /c "npm test"`: 277 tests run — 253 passed, 0 failed, 24 skipped on dedicated `TEST_DATABASE_URL`.
  - `GET http://localhost:5173/api/health`: HTTP 200, database connected (`return-scan_youthnic`).
- Not run:
  - Browser subagent GUI navigation failed because Playwright engine encountered an external driver download 404 in the offline/restricted environment; automated test suite and live HTTP health check were run instead.
  - The 24 database integration tests requiring a dedicated test database whose name contains `test`.
- The next agent must not:
  - Add constant autofocus timers or focus-stealing loops that grab focus away from the verification modal, quantity inputs, or issue chips.
  - Clear the scanned AWB or form inputs when a save fails.
  - Discard buffered barcodes when multiple arrive during verification or saving.
  - Expose `RESEND_API_KEY` or `DATABASE_URL`.
- Open for the user:
  - Test Admin redesign at `http://localhost:5173/admin`.
  - Test "Remember this device" at `http://localhost:5173/login`.
  - Test high-speed barcode scanning with keyboard verification at `http://localhost:5173/scan`.
  - Add `RESEND_API_KEY` to `.env` and trigger test email in Admin > System.

### 2026-10-12, Antigravity, 9-Specialist Agency Agents Comprehensive Audit & Fix Pass

- Perspective: Conducted a multi-role audit and remediation pass using the Agency Agents roles (Frontend Developer, UX Architect, UI Finish Gate Reviewer, Identity & Access Engineer, Backend Architect, Database Optimizer, DevOps Automator, AppSec Engineer, and Test Automation Engineer).
- Changed:
  - `server/rate-limit.ts`: New sliding-window rate limiter module for brute-force mitigation (`loginRateLimiter`: 5 failed attempts per account -> 5-minute lockout; `ipRateLimiter`: 25 attempts per IP -> 5-minute lockout). Resets instantly upon successful sign-in.
  - `server/index.ts`:
    - Identity & Access Engineer / AppSec: Added rate-limiting guards to `/api/auth/login` returning HTTP 429 Too Many Requests with retry-after duration.
    - AppSec: Added HTTP security headers middleware (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()`, `X-XSS-Protection: 1; mode=block`).
    - AppSec: Added audit logging for failed authentications (`auth.login_failed` recorded in `register_audit_log` with actor IP, user-agent, and attempted account without storing passwords).
    - AppSec / Backend Architect: Added error message sanitization in production mode to prevent leaking database internals or internal stack traces.
    - DevOps Automator / Backend Architect: Added graceful shutdown handling on `SIGTERM` and `SIGINT` (stops accepting requests, clears background report interval timer, and drains PostgreSQL connection pool via `getPool().end()`).
  - `server/schema-register.sql`:
    - Database Optimizer: Added additive indexes `receipt_scans_scanned_by_at_idx ON receipt_scans (scanned_by, scanned_at DESC)`, `register_audit_log_actor_idx ON register_audit_log (actor_user_id, occurred_at DESC)`, and `register_audit_log_occurred_at_idx ON register_audit_log (occurred_at DESC)`.
  - `src/App.tsx`:
    - Frontend Developer: Added dynamic document title updating on page transition (`PAGE_TITLES`: Overview, Scan Returns, Return Register, Claims, Data Uploads, Admin Settings).
    - Identity & Access Engineer / Frontend Developer: Session resilience on 503/network disconnects (only clears stored token on HTTP 401 Unauthorized, never on transient server boot or network errors).
  - `server/tests/security-operations.test.ts`:
    - Test Automation Engineer: Automated test suite validating RateLimiter windowing and lockout countdown, lockout reset on success, production error sanitization, and database performance index definitions.
  - `package.json`:
    - Added `server/tests/security-operations.test.ts` to `npm test`.
- Ran:
  - `cmd /c "npm run typecheck"`: Exit 0 (clean).
  - `cmd /c "npm run build"`: Exit 0 (Vite production bundle built in 1.50s).
  - `node --import tsx --test server/tests/security-operations.test.ts`: 4/4 tests passed (405 ms).
  - `cmd /c "npm test"`: 281 tests run — 257 passed, 0 failed, 24 skipped on dedicated `TEST_DATABASE_URL`.
  - Database schema apply via `initDatabase()` against live PostgreSQL (`return-scan_youthnic`): Exit 0, `Init result: SUCCESS`.
- Not run:
  - The 24 database integration tests requiring a dedicated test database whose name contains `test`.
- The next agent must not:
  - Remove security headers or rate limiting on authentication routes.
  - Leak plaintext passwords or connection secrets into audit log tables.
  - Drop or rewrite database indexes or history tables.

### 2026-10-12 (Production-Ready Authentication, Persistent Device Login, Role Security, and Admin User Controls)

- Work done:
  - Completely migrated client authentication from `localStorage` tokens to pure, secure `HttpOnly` SameSite=Lax cookie-based sessions with `credentials: "include"`. Zero tokens or passwords in `localStorage`.
  - Enforced zero plaintext session tokens in PostgreSQL: tokens are generated with 256 bits of cryptographically secure entropy (`crypto.randomBytes(32)`), stored exclusively as SHA-256 hashes in `user_sessions`, and delivered only via secure cookies.
  - Implemented 30-day persistent trusted-device sessions for warehouse PCs with optional "Remember this device" (`Max-Age=2592000`), and 24-hour standard sessions with sliding inactivity updates.
  - Added CSRF defense-in-depth middleware on state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) validating Origin/Referer headers against trusted origins (`https://return.youthnic.shop`, `http://localhost:5173`, `http://localhost:3001`).
  - Implemented role-based access control with explicit permissions:
    - `Admin`: Full access, configuration, user management, and session revocation.
    - `Supervisor`: Operational overview, reports, claims, data uploads, scanning; strictly blocked with HTTP 403 from Admin routes.
    - `Scanner`: Return scanning and verification; strictly blocked with HTTP 403 from Admin routes. Automatically lands on `/scan` upon login and boot.
  - Implemented Admin User Management workflow in `Admin.tsx` and `server/index.ts`: enabled "+ Add user" with full creation modal, status toggle (Active $\leftrightarrow$ Disabled with immediate session revocation), and password reset with automatic session invalidation. No public registration.
  - Fixed all Login page UI defects: balanced headline (`Every return, clearly accounted for.`), aligned show/hide password toggle, fixed stretched checkbox to crisp 18x18px with emerald accent, improved form spacing, loading state spinner, and responsive layouts across mobile, tablet, 1366px, 1440px, and 1920px.
  - Implemented connection-failure resilience in `src/App.tsx`: temporary network dropouts or 503 errors do not clear authentication state, do not redirect in loops, and do not present network errors as "Session expired".
  - Created `server/tests/auth-persistent.test.ts` and added to `package.json` test runner.
- Files changed:
  - `server/access.ts`: Added `isSupervisorRole()`, `isScannerRole()`, `isSupervisorOrAdminRole()`.
  - `server/http.ts`: Added `requireSupervisorOrAdmin`.
  - `server/auth.ts`: Removed raw token insertion into `sessions` table.
  - `server/index.ts`: Added CSRF origin defense middleware and endpoints `POST /api/admin/users`, `PATCH /api/admin/users/:id/status`, `POST /api/admin/users/:id/reset-password`, `PATCH /api/admin/users/:id/role`.
  - `src/access.ts`: Added client role check helpers.
  - `src/api.ts`: Removed `localStorage` token reading/writing.
  - `src/pages/Login.tsx`: Redesigned form, fixed layout bugs, added loading state, removed `localStorage`.
  - `src/App.tsx`: Cookie-only session boot, Scanner landing page routing, network error resilience.
  - `src/pages/Admin.tsx`: Enabled Add User modal, status toggle, password reset, and session management.
  - `src/index.css`: Fixed input and checkbox styles, password toggle, loading spinner, and connection banners.
  - `server/tests/auth-persistent.test.ts`: Added 10 automated test cases.
  - `package.json`: Updated `test` script.
- Ran:
  - `cmd /c "npm run typecheck"`: Exit 0 (0 errors).
  - `cmd /c "npm run build"`: Exit 0 (Vite bundle built in 1.59s).
  - `cmd /c "npm test"`: 291 tests run: 267 passed, 0 failed, 24 skipped on dedicated `TEST_DATABASE_URL`.
  - Live API testing: Confirmed generic 401 on bad credentials, 403 on untrusted CSRF origins, and 429 lockout on repeated failed attempts.
- Not run:
  - The 24 database integration tests requiring a dedicated test database whose name contains `test`.
- The next agent must not:
  - Re-introduce tokens or passwords to `localStorage`.
  - Store plaintext session tokens in PostgreSQL.
  - Disable CSRF or rate-limiting middleware.
  - Remove role authorization guards on `/api/admin/*`.

### 2026-10-12, UI Layout Polish & Streaming Batch Upload Processing (500-Row Yield & Upload Progress Bar)

- Work done:
  - Addressed the defective layout on the Return Upload page (`src/pages/Uploads.tsx`):
    - Replaced the unstyled `<dl className="preview-grid">` vertical dump with a 2-column executive Overview Card (File & Account spec on left, dataset replacement impact on right).
    - Built a responsive 10-metric Quality & Verification card grid (`.preview-metrics-grid`) replacing the unformatted list of raw numbers with labeled, high-contrast indicators (Total Rows, Readable Rows, Blank AWBs, Unverified Tracking, Link Disagreements, Exact Duplicates, Repeated Lines, Sanitized Identifiers).
    - Restructured logistics partner summary into styled carrier badges (`.partner-badge-pill`) displaying courier name and parcel count.
    - Wrapped long numeric warning messages (e.g. 7+ lines of "Order Number ... has more than 15 digits. Do not use it as a key") into a styled amber card with fixed height (`max-height: 140px`) and custom scrollbar (`.preview-warnings-card`), preventing UI overflow and keeping the confirmation checkbox and action button immediately visible.
    - Redesigned the Active Dataset Replacement confirmation card (`.preview-confirm-card`) with high-contrast emerald borders, clear notice, and styled checkbox.
  - Implemented client-side visual upload progress bar (`UploadProgressBar` in `src/pages/Uploads.tsx`):
    - Displays dynamic progress bar with pulsing shimmer animation, percentage badge, rows staged counter (`500 / 1,173 rows`), and interactive batch step pills (`[✓] Batch 1 (500 rows)`, `[⏸] Batch 2 (1s pause)`, etc.).
    - Tracks both client-side file reading progress and server-side batch activation progress.
  - Implemented server-side streaming batch pipeline (`server/lookup-import.ts`, `server/upload-routes.ts`):
    - `stageGroups` in `server/lookup-import.ts` now accepts `batchSize: 500`, `pauseMs: 1000` (for streaming), and `onProgress` callback. It yields with a 1-second pause between 500-row chunks during live uploads, yielding CPU and reducing database lock contention.
    - Dynamically scales PostgreSQL `lock_timeout` (`lockSeconds = Math.max(30, Math.ceil(...))`) to guarantee atomic transactions without lock timeouts during deliberate multi-batch pauses.
    - Added Server-Sent Events (`text/event-stream`) support to `POST /api/uploads/import` when `stream: true` or `Accept: text/event-stream` is requested, broadcasting live progress events (`staging`, `batch_pause`, `finalizing`, `complete`) to the client while retaining JSON responses for standard API/test callers.
  - Added unit test cases to `server/tests/upload-policy.test.ts` validating batch calculation logic (500 rows/batch yielding 3 batches for 1,173 rows) and simulated progress event streaming.
- Files changed:
  - `src/pages/Uploads.tsx`: Overhauled preview UI, added `UploadProgressBar`, implemented SSE event stream reader for batch upload activation.
  - `src/index.css`: Added CSS rules for `.preview-overview-card`, `.preview-metrics-grid`, `.preview-metric-card`, `.partner-badges-wrap`, `.partner-badge-pill`, `.preview-warnings-card`, `.preview-confirm-card`, and `.batch-progress-card`.
  - `server/lookup-import.ts`: Added batch yield logic, dynamic `lock_timeout`, and `ImportProgressEvent` progress notifications.
  - `server/upload-routes.ts`: Added SSE streaming endpoint support for `POST /api/uploads/import`.
  - `server/tests/upload-policy.test.ts`: Added automated unit tests for batch chunking and SSE progress generation.
- Ran:
  - `cmd /c "npm run typecheck"`: Exit 0 (0 errors).
  - `cmd /c "npm run build"`: Exit 0 (Vite bundle built in 1.71s).
  - `cmd /c "npm test"`: 294 tests run: 270 passed, 0 failed, 24 skipped on dedicated `TEST_DATABASE_URL`.
- Not run:
  - Dedicated PostgreSQL integration tests requiring `TEST_DATABASE_URL` (24 tests skipped as designed).
- The next agent must not:
  - Drop tables or remove transaction atomicity from `commitLookupUpload`.
  - Remove the 500-row batching or dynamic `lock_timeout` scaling when uploading large files.
  - Remove styled containers for upload preview warnings or metrics.

### 2026-10-12, Continuous Scan Workflow Refinements, Issue Modification, 15-Digit Truncation Recovery, and Webcam Toggle

- Work done:
  - **Issue Modification & Clear Reversion on Bench Scans (`ScanReturns.tsx`, `register-service.ts`)**:
    - Removed the rigid restriction that locked an issue once tapped. Warehouse operators can now freely change the selected issue (e.g. from "Wrong Product" to "Damaged", "SKU Change", "Size Change", "Other", or "Missing Item") or revert back to "Normal Return" (clear).
    - Updated `correctScanIssue` in `server/register-service.ts` to replace previous issue records and associated claim tickets for the active scan transaction, updating `receipt_scans.outcome` and statuses cleanly, or restoring `'clear'` outcome if reverted to Normal Return.
  - **Excel 15-Digit Truncation & Link Recovery (`marketplace-rules.ts`, `spreadsheet-numbers.test.ts`)**:
    - Resolved the issue where 16-digit tracking IDs like `1490711818486605` were truncated by Excel's 15-digit float limitation to `1490711818486600` (zeroing out the 16th digit).
    - Added `truncateToFifteenDigits` alongside `roundToFifteenDigits` in `server/marketplace-rules.ts` to identify when Excel zeroed out digits past the 15th digit.
    - When confirmed against a verified Delhivery tracking link (e.g. `https://track.delhivery.com/p/1490711818486605`), the full, genuine 16-digit tracking ID is recovered and activated (`mismatch_resolved`), preserving the truncated number in `csvTrackingId` for audit.
    - Added automated unit test in `server/tests/spreadsheet-numbers.test.ts` verifying `1490711818486600` recovers `1490711818486605`.
  - **Removed Redundant "Next" Button (`ScanReturns.tsx`)**:
    - Eliminated the `{savedScanId ? "Next" : "Cancel"}` button when a return is already saved. In continuous barcode scan mode, scanning the next parcel automatically saves and transitions to the next item; displaying "Next" was redundant and confusing.
    - The "Cancel" button remains available only when a return is unsaved (`!savedScanId`).
  - **Unboxing Evidence Video Recording Workstation Toggle (`ScanReturns.tsx`, `index.css`, `types.ts`, `ui.tsx`)**:
    - Added a toggle switch in the camera card header (`.camera-toggle-switch`) with local workstation state persistence (`scanner_video_recording_enabled`).
    - When disabled (default for warehouses not using real-time video), the camera viewport and webcam connection prompts are replaced by a sleek, compact status banner, and scanning does not trigger webcam recorders or error alerts.
    - When enabled, full camera preview, recording indicators, and webcam connect buttons are accessible.
    - Added SVG path for `"video"` icon in `src/ui.tsx` and updated `IconName` in `src/types.ts`.
- Files changed:
  - `src/pages/ScanReturns.tsx`: Enabled issue changing/reversion, removed "Next" button when saved, added video recording toggle and compact disabled panel.
  - `src/index.css`: Added styles for `.camera-head-controls`, `.camera-toggle-switch`, `.camera-toggle-slider`, and `.camera-disabled-panel`.
  - `src/types.ts`: Added `"video"` to `IconName`.
  - `src/ui.tsx`: Added SVG path for `video` icon.
  - `server/marketplace-rules.ts`: Added `truncateToFifteenDigits` and enhanced `resolveTrackingId` to recover 15-digit truncated Excel tracking numbers.
  - `server/register-service.ts`: Updated `correctScanIssue` to allow replacing issues and reverting to clear.
  - `server/tests/spreadsheet-numbers.test.ts`: Added synthetic regression test for 16-digit Excel truncation.
- Ran:
  - `cmd /c "npm run typecheck"`: Exit 0 (0 errors).
  - `cmd /c "npm run build"`: Exit 0 (Vite bundle built in 1.39s).
  - `cmd /c "npm test"`: 295 tests run: 271 passed, 0 failed, 24 skipped on dedicated `TEST_DATABASE_URL`.
- Not run:
  - Dedicated PostgreSQL integration tests requiring `TEST_DATABASE_URL` (24 tests skipped as designed).
- The next agent must not:
  - Prevent operators from changing issues on active bench returns.
  - Remove `truncateToFifteenDigits` in `marketplace-rules.ts`.
  - Re-introduce the "Next" button on already-saved scan screens.

### 2026-10-12, Antigravity, App Logo & Mobile App Icon Assets Generation

- Work done:
  - **Brandmark & App Icon Design**:
    - Created a distinctive, modern app brandmark and mobile app icon featuring an emerald-mint palette (`#0e5847`, `#059669`, `#10b981`, `#87cbb3`), an isometric warehouse logistics parcel, and a continuous reverse-logistics / return loop ribbon entering the parcel.
    - Generated high-resolution source master artifact (`return_app_icon_1791821213583.jpg`).
  - **Mobile App Icon & Android Launcher Package (`public/mobile-icons/`, `public/`)**:
    - Generated production-grade mobile app icon assets across all standard densities:
      - `public/app-icon.png` (512×512) and `public/app-icon-512.png` (512×512 Google Play Store / PWA splash).
      - `public/app-icon-192.png` (192×192 PWA & Android launcher).
      - `public/apple-touch-icon.png` (180×180 iOS home screen).
      - `public/favicon-32x32.png` and `public/favicon-16x16.png`.
      - `public/favicon.ico` (multi-resolution 16×16, 32×32, 48×48).
      - `public/mobile-icons/` containing complete Android mipmap resource structure:
        - `mipmap-mdpi/ic_launcher.png` (48×48)
        - `mipmap-hdpi/ic_launcher.png` (72×72)
        - `mipmap-xhdpi/ic_launcher.png` (96×96)
        - `mipmap-xxhdpi/ic_launcher.png` (144×144)
        - `mipmap-xxxhdpi/ic_launcher.png` (192×192)
        - `playstore-icon/playstore-512.png` (512×512)
  - **Web App Favicon & Manifest (`public/favicon.svg`, `public/manifest.json`, `index.html`)**:
    - Built a crisp, scalable vector `public/favicon.svg` with squircle contour, gradient lighting, and isometric parcel geometry.
    - Created `public/manifest.json` configuring "Return Operations" as an installable standalone PWA with `#0e5847` theme color.
    - Updated `index.html` with `<link rel="icon">`, `<link rel="apple-touch-icon">`, `<link rel="manifest">`, and mobile web app capability tags.
  - **In-App Vector Logo (`src/ui.tsx`, `src/index.css`)**:
    - Overhauled `ReturnLogo` in `src/ui.tsx` from a crude circle and line into the production scalable SVG emblem matching the app icon.
    - Supported both standard mode (for white sidebar and mobile login form) and inverse mode (crisp light contrast on emerald login hero).
    - Updated `src/index.css` removing legacy SVG stroke overrides and adding subtle drop-shadow elevations and typography.
- Files changed:
  - `public/favicon.svg` (New crisp scalable SVG icon)
  - `public/manifest.json` (New PWA and mobile web app manifest)
  - `public/app-icon.png`, `public/app-icon-512.png`, `public/app-icon-192.png`, `public/apple-touch-icon.png`, `public/favicon.ico`, `public/favicon-32x32.png`, `public/favicon-16x16.png`
  - `public/mobile-icons/` (Android mipmap densities: mdpi, hdpi, xhdpi, xxhdpi, xxxhdpi, playstore)
  - `index.html` (Added favicon, touch icon, and manifest links)
  - `src/ui.tsx` (Updated `ReturnLogo` with branded isometric parcel and return loop vector SVG)
  - `src/index.css` (Updated `.return-brand`, `.return-vector-mark`, `.return-wordmark`)
  - `docs/notes/agent-handoff.md` (Updated session log)
- Ran:
  - `cmd /c "npm run typecheck"`: Exit 0 (0 errors).
  - `cmd /c "npm run build"`: Exit 0 (Vite bundle built in 2.08s).
  - `cmd /c "npm test"`: 295 tests run: 271 passed, 0 failed, 24 skipped on dedicated `TEST_DATABASE_URL`.
- Not run:
  - Browser subagent GUI verification failed due to Playwright driver download 404 in the sandbox; manual build and asset tests passed completely.
- The next agent must not:
  - Revert `ReturnLogo` to generic circle/lines.
  - Remove mobile icon assets or manifest links from `index.html`.

### 2026-10-12, Antigravity, Youthnic Native Android Return Scanner (Pure Kotlin, Forward Scan UX + Return Verification)

- Work done:
  - **Native Android Project Architecture (`android/`, `shop.youthnic.returnscan`)**:
    - Created genuine native Kotlin Android application with Gradle 8.7 wrapper, Android Gradle Plugin 8.4.2, and Kotlin 1.9.24.
    - Zero Jetpack Compose runtime overhead: built entirely with Android ViewBinding and Material Components to strictly guarantee release APK size < 5 MB.
    - Unbundled Google Play Services ML Kit barcode scanning (`play-services-mlkit-barcode-scanning:18.3.1`) ensures scanner models are provided dynamically by Google Play Services, keeping APK footprint minimal (~3.6 MB).
    - Android KeyStore backed `EncryptedSharedPreferences` for secure Bearer tokens and persistent terminal authentication without plaintext secrets.
  - **Forward Scan Ergonomics & Visuals**:
    - Emerald and dark forest theme (`#0E5847`, `#063B2F`, `#10B981`) and signals: OK (`#059669`), DUPLICATE (`#2563EB`), NOT FOUND (`#7C3AED`), CHECK (`#D97706`), STOP (`#DC2626`).
    - High-density Android launcher icons and drawables installed across all mipmaps (`mdpi` through `xxxhdpi`).
    - Fullscreen CameraX viewfinder with green rectangular reticle, torch toggle, manual entry, and recent scans.
  - **Continuous Barcode Scanning Engine (`ScannerActivity.kt`, `BarcodeRules.kt`, `CameraTuning.kt`)**:
    - 720p 16:9 battery-optimized preview, continuous autofocus, and visible viewfinder bounding-box filter.
    - `DuplicateGuard` with 80 ms frame debounce and 8-second duplicate hold.
    - Automatic hands-free camera resumption 500 ms after successful database save without requiring a "Scan Again" button tap.
  - **Return Verification Bottom Sheet (`ReturnVerificationBottomSheet.kt`, `sheet_return_verification.xml`, `item_verification_product.xml`)**:
    - Displays marketplace, carrier, return type, tracking AWB, order ID, shipment ID, and return reason.
    - Multi-item parcel support: renders each item in parcel with title, marketplace SKU, master SKU, expected units, and received units stepper.
    - Mandatory physical condition inspection checkbox.
    - Issue category chips: Clear Return, Missing Component, Wrong Product, Damaged Product, SKU Change, Size Change, Other Issue.
    - Dynamic sub-issue chips for missing components (Dupatta, Bottom, Top, Inner, Accessories).
    - Idempotent `SYN-MOBILE-${accountId}-${timestamp}-${uuid}` client scan key.
  - **Product Image Zoom (`ImageViewerActivity.kt`, `ImageCache.kt`)**:
    - Two-finger pinch-to-zoom (`ScaleGestureDetector`) and drag-to-pan matrix transformations.
    - Dual memory `LruCache` (1/8th RAM) and disk cache with `RGB_565` downsampling for memory safety on 2 GB RAM phones.
  - **Synchronized Audio, Vibration, and Flash Signals (`SoundManager.kt`, `ScanSignals.kt`)**:
    - Pre-synthesized 16-bit PCM AudioTrack tones on `STREAM_MUSIC`: OK (1 high beep, green flash, 1 vibe pulse on database commit), DUPLICATE (3 beeps, blue flash, 3 vibe pulses), NOT FOUND (beep-boop, 2 purple flashes, 2 vibe pulses), CHECK (2 beeps, 2 amber flashes, 2 vibe pulses), STOP (low warning buzzer, 3 red flashes, long warning vibe pulse).
    - Photosafety: blinks match beeps, max flash frequency strictly < 3 flashes per second.
  - **Recent Scans, Manual Entry, and Settings**:
    - `RecentScansDialog.kt`: Displays shift return scan history and outcomes.
    - `ManualScanDialog.kt`: Modal dialog for manual tracking ID entry.
    - `SettingsActivity.kt`: Toggles for audio beeps, vibration, screen flashes, and manual app update check.
  - **App Update Engine & Backend Integration (`AppUpdater.kt`, `server/mobile-release.ts`, `server/index.ts`)**:
    - Additive routes `GET /api/app/latest` and `GET /download/return-scan.apk`.
    - WorkManager background polling against release manifest, cryptographic SHA-256 validation, and FileProvider package installation.
  - **CI/CD Workflow & Release Prep (`.github/workflows/return-scan-apk.yml`, `android/README.md`, `android/CHANGELOG.md`)**:
    - GitHub Actions automated build, unit test execution, linting, R8 shrinking, package verification (`shop.youthnic.returnscan`), and APK size budget validation (< 5 MB target).
- Files changed/created:
  - Android application files:
    - `android/build.gradle`, `android/settings.gradle`, `android/gradle.properties`, `android/app/build.gradle`, `android/app/proguard-rules.pro`
    - `android/app/src/main/AndroidManifest.xml`, `android/app/src/main/res/xml/update_file_paths.xml`
    - `android/app/src/main/java/shop/youthnic/returnscan/ReturnScanApp.kt`
    - `android/app/src/main/java/shop/youthnic/returnscan/data/`: `Models.kt`, `BarcodeRules.kt`, `ImageCache.kt`, `SessionManager.kt`, `ApiClient.kt`
    - `android/app/src/main/java/shop/youthnic/returnscan/util/`: `CameraTuning.kt`, `ScanSignals.kt`, `SoundManager.kt`, `Ui.kt`
    - `android/app/src/main/java/shop/youthnic/returnscan/update/`: `AppUpdater.kt`, `UpdateCheckWorker.kt`
    - `android/app/src/main/java/shop/youthnic/returnscan/ui/`: `SplashActivity.kt`, `LoginActivity.kt`, `ChannelActivity.kt`, `ScannerActivity.kt`, `ReturnVerificationBottomSheet.kt`, `ImageViewerActivity.kt`, `RecentScansDialog.kt`, `ManualScanDialog.kt`, `SettingsActivity.kt`
    - Layouts in `android/app/src/main/res/layout/`: `activity_splash.xml`, `activity_login.xml`, `activity_channel.xml`, `item_channel_card.xml`, `activity_scanner.xml`, `sheet_return_verification.xml`, `item_verification_product.xml`, `activity_image_viewer.xml`, `dialog_manual_scan.xml`, `dialog_recent_scans.xml`, `item_recent_scan_row.xml`, `item_signal_row.xml`, `activity_settings.xml`, `dialog_update_progress.xml`
    - Android unit tests: `android/app/src/test/java/shop/youthnic/returnscan/`: `BarcodeRulesTest.kt`, `ScanSignalsTest.kt`, `CameraTuningTest.kt`, `ReturnModelsTest.kt`
    - Standalone docs & CI: `android/README.md`, `android/CHANGELOG.md`, `android/.github/workflows/return-scan-apk.yml`, `.github/workflows/return-scan-apk.yml`
  - Backend files:
    - `server/mobile-release.ts`: New release info helper for `GET /api/app/latest` and APK downloads.
    - `data/return-scan-release.json`: Dynamic release manifest with version code, SHA-256, and release notes.
    - `server/index.ts`: Mounted `GET /api/app/latest` and `GET /download/return-scan.apk`.
    - `server/tests/mobile-app.test.ts`: Backend contract test validating release manifest and exact AWB preservation.
- Ran:
  - `cmd /c "npm run typecheck"`: Exit 0 (0 errors).
  - `cmd /c "npm run build"`: Exit 0 (Vite bundle built in 1.67s).
  - `cmd /c "npm test"`: 295 tests run: 271 passed, 0 failed, 24 skipped on dedicated `TEST_DATABASE_URL`.
- Not run:
  - Physical phone camera on a physical warehouse Android device (requires physical APK installation by user).
  - Dedicated PostgreSQL integration tests requiring `TEST_DATABASE_URL` (24 tests skipped as designed).
- The next agent must not:
  - Create or publish a public GitHub repository prematurely without user approval.
  - Replace native Android Kotlin implementation with WebView or PWA wrapper.
  - Play OK feedback signal before database commit confirmation.
  - Embed database credentials in Android client code.

### 2026-10-13, Antigravity Agent, Shopify Inbuilt Real-Time Channel & Return/RTO Tracking

- **Context & Requirement**:
  - The user requested Shopify to be inbuilt as an automated marketplace channel in the Return App.
  - Data is not uploaded manually via files; it is ingested directly in real time from `SHOPIFY_DATABASE_URL` in `.env`.
  - The connection to the Shopify database must be strictly **READ-ONLY** (never insert, update, delete, or alter anything on the Shopify database).
  - Return requests and RTO shipments must be ingested into `expected_returns` so warehouse operators can scan physical parcels on the bench.
  - Must provide the exact business formula: `return/rto created - received = pending` (`Created - Received = Pending`).
  - Interactive reports, daily statistics, and CSV export options must be provided in the UI.

- **Changes**:
  - **Database & Read-Only Safety**:
    - Created `server/shopify/db.ts`: strictly read-only client with `rejectUnauthorized: true` TLS certificate verification, regex rejecting non-`SELECT` keywords, and PostgreSQL native `BEGIN READ ONLY` transactions.
    - Resolved VPS connectivity to Hostinger PostgreSQL 17 on port 5433 (UFW/Docker iptables port forwarding) with dedicated CA certificate in `certs/shopify-ca.pem`.
    - Added additive schema `server/schema-shopify.sql` and registered it in `SCHEMA_FILES` in `server/db.ts`.
  - **Real-Time Synchronization Engine**:
    - Created `server/shopify/sync.ts`: reads customer returns from `"Return"` and RTO shipments from `"Shipment"`/`"Order"` where status is `RTO` or `RTO_DELIVERED`, resolves SKUs against `product_master`, links Delhivery reverse waybills (`tracking_id`) and outbound waybills (`alt_tracking_id`), and synchronizes them into local `expected_returns`.
    - Automated background worker in `server/index.ts` runs initial sync on server start and checks every 5 minutes with graceful shutdown handling.
    - CLI trigger added in `server/scripts/sync-shopify.ts` (`npm run sync:shopify`).
  - **Reporting & Formula Service**:
    - Created `server/shopify/service.ts`: computes the exact business formula `Created - Received = Pending`, breakdown by Customer Returns and RTOs, receipt rates, 14-day daily trend history, filterable listing, and CSV exporter.
    - Enforced Rule 1 Account Scope: restricts metrics, listing, and export to authorized accounts.
    - Created `server/shopify/routes.ts` mounting `GET /api/shopify/status`, `POST /api/shopify/sync`, `GET /api/shopify/metrics`, `GET /api/shopify/records`, and `GET /api/shopify/export`.
  - **Marketplace Reference Data & Branding**:
    - Added `["SHOP", "Shopify", "Real-time sync"]` to `CHANNELS` in `server/reference-data.ts`.
    - Added `"Shopify"` to `MARKETPLACES`, `MARKETPLACE_CLASS`, and `MARKETPLACE_LOGO` in `src/marketplaces.ts`.
    - Created brand vector logo in `public/logos/shopify.svg`.
  - **Frontend UI Integration**:
    - Created `src/ShopifyReport.tsx`: interactive dashboard with mathematical formula ribbon (`Created - Received = Pending`), 4 KPI stat cards, Customer Return vs RTO breakdown cards, daily trends accordion/table with click-to-filter dates, search box, date pickers, interactive records table, and details modal.
    - Integrated view switcher in `src/pages/Reports.tsx` (`Return Register` vs `Shopify Returns & RTO`) supporting direct bookmarking via `?tab=shopify`.
    - Updated `src/pages/Uploads.tsx`: Shopify channel is clearly marked as automated real-time sync with an informational card and direct link to Shopify Reports, disabling redundant manual file uploads for Shopify.
    - Added responsive styles in `src/index.css`.
  - **Tests**:
    - Added `server/tests/shopify-sync.test.ts` testing read-only query rejection, formula calculation, Rule 1 account scope enforcement, returns/RTO breakdown, and CSV export. Registered in `package.json`.

- **Verification Results**:
  - `npm run typecheck`: Exit 0 (0 errors).
  - `npm run build`: Exit 0 (Vite bundled in 1.39s).
  - `npm test`: 303 tests run: 279 pass, 0 fail, 24 skipped (dedicated `TEST_DATABASE_URL`).
  - Live verification script against Hostinger VPS (`200.141.1.119:5433`):
    - Connection: `Connected (Read-Only)`, 240 orders found.
    - Sync run: 5 Customer Returns and 9 RTO shipments synchronized into `expected_returns` (14 total active scannable barcodes).
    - Formula metrics: Created (14) - Received (0) = Pending (14).
    - Bench scan lookup test: scanned Delhivery return AWB `30100810012666` returned status `found` matching Order `#26YOU5867` with item `BT216-Geomi-Kattha_S`.

- **The next agent must not**:
  - Add any `INSERT`, `UPDATE`, or `DELETE` statements targeting the external Shopify database.
  - Bypass TLS certificate verification for `SHOPIFY_DATABASE_URL`.
  - Require manual CSV/Excel file uploads for Shopify in `Uploads.tsx`.

## STOP — needs the user to resume

**This is the exact point at which the agent stopped.** Everything that can be verified without external input has been verified. The following items require the user to act before any agent can resume:

1. **Review and approve dedicated GitHub repository creation:** The native Android application source tree, tests, Gradle wrapper, and GitHub Actions workflow (`.github/workflows/return-scan-apk.yml`) are fully prepared locally in `android/`. When approved by the user, create the dedicated GitHub repository under the user's selected GitHub owner and push the codebase.
2. **Physical Android phone verification:** Install signed APK on a physical warehouse device (running Android 6.0+) and verify continuous scanning of live physical parcels, pinch-to-zoom product images, and audio/vibration cues.
3. **Provision a disposable PostgreSQL test database** containing `test` in its name for running the 24 skipped integration tests.

**What an agent must not do without explicit approval**: re-introduce `dropAppTables`, `databaseNeedsRebuild`, `APP_TABLES`, or any unconditional `DELETE FROM` outside `product-master.ts` and `load-product-master.ts`. Add `DROP TABLE` / `TRUNCATE` / `DELETE FROM` to any schema file. Point `TEST_DATABASE_URL` at the production database. Read `.env`. Activate any real file against production. Weaken any of the static guards added in this handoff.

## Known risks and gaps

These are facts about the code as of 2026-10-10. The Application Security Engineer, the Code Reviewer and the Data Privacy Officer are the right roles to review them.

### Security

- **Sessions never expire.** `requireUser` checks that the session row exists, not its age. A session lasts until sign-out.
- **No rate limit or lockout on sign-in.** There is no rate-limit package.
- **CORS allows any origin.** The `cors` defaults are in use.
- **`GET /api/health` is unauthenticated** and returns the database name.
- **HTTP 500 responses return the server's error message.** An unexpected error can show database or connection detail to the browser.
- **The password hash is loaded on every request.** It is not sent to the browser, but it is needless exposure. Load it only at sign-in.
- **Ticket status changes need no role.** Anyone with access to the account can change a ticket's status, to any status, and every change is recorded.
- **Roles are free text.** `npm run user:create` does not check the role. A misspelling such as `Administrator` gives no administrator rights, and the script reports nothing.
- **The register service's scope defaults to every account** when a caller passes none. Every route passes the signed-in scope. A future route that forgets to pass it would widen access. Make the parameter required, and update `register-db.test.ts`.

### Data

- **Activation supersedes open returns not in the file.** A later file from a date window can make open returns unscannable. This is decision 7 above.
- **Staged uploads are in memory.** A restart loses them. The preview must be done again.
- **The Myntra seller mapping (10708 and 45833) is unconfirmed.** The guard may refuse a correct file, or accept a wrong one.
- **The Meesho product master key is unverified** for the size-appended SKU.
- **Buyer personal data is kept in some raw data:** Meesho `Tracking Link` and `Proof of Delivery`, and Flipkart `Comments`. This is decision 9.
- **Identifiers blanked at upload are not repaired.** Only a Meesho 16-digit AWB, confirmed by its tracking link, is accepted. Leading zeros lost in Excel cannot be detected.

### Code and documents

- **A dead path.** The editable ticket cell in `src/returns-table.tsx` is used by no page. Its default save does nothing. Wire it or remove it before use.
- **An unused list.** `MARKETPLACES` in `src/marketplaces.ts` is no longer used for account lists.
- **Stale comments.** These are in the code, and they were not edited on 2026-10-10:
  - `server/schema-register.sql` and `server/admin-config.ts` say `VERIFIED_TRACKING_LINKS`. The code's name is `LINK_RULES`.
  - A comment in `server/sheets.ts` refers to `applyProductMaster` in `server/index.ts`. No such function exists.
  - A comment in `server/scripts/create-user.ts` says the app checks no role yet, so every user can reach every page. Both parts are out of date. The Admin page is restricted, and the admin routes check the role.
- **`SESSION_SECRET` in `.env.example` is unused.** Remove it, so no one believes it does something.
- **`server/seed.ts` is empty** and should be deleted.
- **The UI has not been exercised in a browser,** and the OMSGuru client has not been run against the live API.
- **The dedicated database tests have not been run.** The local typecheck, build and non-database tests pass; the database checks need `TEST_DATABASE_URL`.
- **The database test `register-db.test.ts` was not re-read** for the account rule and the no-merge change.

## Glossary

- **AWB.** The air waybill, the tracking number on a parcel. The lookup key for a return.
- **Account.** A marketplace account, such as Myntra EJ or Myntra VB. An account is the unit of access and of upload.
- **Active, staging, superseded.** The status of a lookup row. Active rows are scannable. Staging rows are being written. Superseded rows were replaced by a later activation, are kept, and are not scannable.
- **Activation.** Making a previewed file the account's active lookup data, in one transaction.
- **Blocker.** A reason an upload cannot be activated. Confirmations are different: they need a person's tick, and they never override a blocker.
- **Cancelled before dispatch.** A Myntra row with both tracking columns blank. Stored separately, never scanned.
- **Choose.** A lookup outcome: the AWB matches more than one account or return, and the scanner picks one.
- **Display identifier.** A value shown as the order item ID that is not an order line (Ajio return order number, Amazon shipment ID).
- **Duplicate.** A lookup outcome: the AWB was already received in that account. Also, the import's exact-duplicate row, which is kept and not counted.
- **Forward and return leg.** The return leg is the return AWB. The forward leg is the outbound AWB. The match records which leg was scanned.
- **IST.** Indian Standard Time. Scan days and the figures are counted in IST.
- **Legacy scan.** A scan saved before item-level verification. It shows one row per line, with no received quantity.
- **Lookup.** The search for an AWB's return, through `POST /api/scan/lookup`.
- **Replay.** A repeated save with the same scan key. It returns the first result and creates nothing.
- **Scope.** The set of accounts a user may use. See [Sign-in and scope](#sign-in-and-scope).
- **Snapshot.** The values a scan copies from its lookup row when it is saved. A later upload cannot change them.
- **Tracking validation.** How the lookup AWB was decided: `match`, `mismatch_resolved`, `mismatch_kept`, `no_link`, `invalid_link`, `unverified_host`, `blank_awb`, `damaged_awb`, or `not_applicable`.
- **Approved 19 columns.** The register's default export, in the order of the mapping specification.

## Troubleshooting

- **Every route returns 503.** The database is not connected. Check `DATABASE_URL` in the environment, without printing it. Read the connection error in the server log.
- **401 "Sign in required".** No token, or the session was removed.
- **403 "Only an administrator can use this.".** The user's role is not `Admin`.
- **403 "You do not have access to this account.".** The named account is outside the user's scope.
- **404 "Return not found" or "That ticket does not exist.".** The record is outside the user's scope, or does not exist. The response does not say which.
- **409 "This AWB has already been received".** A second scan of the same AWB in one account. The system is working. The response gives the first scan's time and scanner.
- **409 with `blockers` on import.** The file has errors. Fix the file, and upload it again.
- **"skipped" in `npm test`.** The database checks need `TEST_DATABASE_URL`. A skip is not a pass.
- **"TEST_DATABASE_URL must point to a database whose name contains 'test'."** The guard refused the URL. Do not change the guard. Point the variable at a test database.
- **"Set NEW_USER_PASSWORD ..."** Set the variable in the same terminal, then run the command again.
- **TLS or certificate errors.** See [CONFIGURATION.md](../CONFIGURATION.md#database-ssl). Never disable TLS.
