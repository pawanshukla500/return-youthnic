# Phase 1 audit matrix

Status of each issue from the independent review and the Phase 1 requirements, as of 2026-10-10. This session had no shell, so **nothing in this matrix has been compiled, built or run.** "Code done" means the change is written and was read back, not tested. "Test written" means an automated check exists and has not been run. Read [phase1-register-status.md](phase1-register-status.md) for the verification handoff.

The matrix replaces the earlier version, whose statuses were written before the code existed.

## Priority 0: blockers

| ID | Issue | Status | Where | Evidence in this environment |
|---|---|---|---|---|
| P0-1 | Malformed test title in `server/tests/import.test.ts` (an unescaped `"..."` inside a double-quoted title, a syntax error that stops the whole file) | Code done | `server/tests/import.test.ts` | Read back. Not run |
| P0-2 | `React.ReactNode` used without an import (typecheck error) | Code done | `src/pages/ScanReturns.tsx`, `src/pages/Reports.tsx` (now `import type ReactNode`) | Read back. Typecheck not run |
| P0-3 | The scanned AWB is not sent or stored | Code done, test written | Screen sends `scannedTracking`; server `submissionFrom` and `recordScan`; `receipt_scans` snapshots; register columns | `server/tests/access-db.test.ts` checks it. Not run |
| P0-4 | Backend routes do not enforce account access (`user_marketplaces`, Admin) | Code done, test written | `server/access.ts`; `requireUser` sets the scope; every dashboard, claims, upload, register, lookup, scan, ticket and export query is scoped in SQL | `server/tests/access.test.ts` (pure), `server/tests/access-db.test.ts` (database). Not run |
| P0-5 | No automated authorization tests | Test written | `server/tests/access.test.ts`, `server/tests/access-db.test.ts`, both in the `test` script | Not run |
| P0-6 | `/api/admin/users` returns every user's email to any signed-in user | Code done | `requireAdmin` on the route (`server/index.ts`, `server/http.ts`) | Read back. Not run |
| P0-7 | Admin routes without a role check: sub-issue options (read and write), accounts, system | Code done | `requireAdmin` on each; the Admin page is hidden for other roles (`src/shell.tsx`, `src/App.tsx`) | Read back. Not run |
| P0-8 | Upload import commits valid rows even when other rows have errors | Code done, test written | `server/upload-policy.ts`, enforced in `server/upload-routes.ts`; the staged file is removed before its commit | `server/tests/upload-policy.test.ts`. Not run |
| P0-9 | Stale upload copy ("Re-uploading replaces unscanned rows... Scanned returns are kept.") | Code done | `src/pages/Uploads.tsx` | Read back |
| P0-10 | PostgreSQL verification in a dedicated test database (schema twice, uniqueness, rollback, persistence, history after replacement, several items per AWB, duplicate scans) | Test written, **not run** | `server/tests/access-db.test.ts`, `server/tests/register-db.test.ts` | Needs `TEST_DATABASE_URL`. Not run |

## Priority 1: screens and register

| ID | Requirement | Status | Notes |
|---|---|---|---|
| P1-1 | Scan Returns: account, scanned AWB, matched leg, logistic partner, order and item details, product SKU, return type and reason, expected and received quantity, received issue, sub-issue, keyboard-friendly input | Code done, not browser-checked | Autofocus, Enter to search, focus back after each save. The sub-issue list is read from `/api/scan/session`. The evidence panel now says it records on the workstation only |
| P1-2 | Uploads: account selection, format detection, header preview, missing columns, duplicate counts, tracking corrections and discrepancies, partner detection, activation confirmation, upload history, never activate a failed upload | Code done, not browser-checked | Return-master mode supports partial activation with explicit confirmation and grouped/searchable exceptions. Scanner-list mode is separate, maps each worksheet to a verified account, and never activates or creates scans. Not built: the full list of found headers and the per-column count of blanked identifiers |
| P1-3 | Admin: logistics partners, courier names, verified tracking hosts, return type mappings, header aliases, issue and sub-issue configuration; writes only for Admin | Partly built | Built: partners, courier names (all accounts or one), hosts (add and switch off), sub-issues, categories, Admin-only routes. **Not built: return type mappings, header aliases, validation exceptions** (no tables, no screens; stated on the Admin page) |
| P1-4 | Register: the 19 approved columns, sort, filter, column choice, record view, CSV and Excel export, mobile layout, large datasets, default export exactly the 19 | Code done, not browser-checked | Default export is `columns=approved`. The operational set is optional. Page size is capped at 200. The export is capped at 50,000 rows. **The approved mapping CSV was not available, so the 19 columns are checked against the specification only** |
| P1-5 | Return type mapping and header alias management | Not built | Needs reference tables and a screen |
| P1-6 | Validation exceptions | Not built | Needs a design decision first |
| P1-7 | Unboxing evidence: videos are not uploaded and not linked to the return | Known limit | The screen says so. Only counts are saved. Upload is a later task |

## Priority 2: real samples

| ID | Requirement | Status | Notes |
|---|---|---|---|
| P2-1 | Myntra EJ and Ajio layouts checked against their real files | Partly done | Ajio was parsed read-only from `C:\Users\Pawan Shukla\Desktop\Ajio return .xlsx`; 51 headers were present and 246 rows parsed. Myntra EJ still needs `npm run layout:inspect` |
| P2-2 | Flipkart, Meesho and Amazon samples run through the importer | Partly done | Amazon and Ajio were run read-only through the parser. The Meesho workbook is a scanner list and is covered by `scanner-list.test.ts`; no real upload was activated |
| P2-3 | Meesho tracking URL extraction and retained values | Tested | `server/tests/import.test.ts` and `server/tests/marketplace-rules.test.ts` pass |
| P2-4 | Large numeric identifiers and scientific notation | Tested | `server/tests/spreadsheet-numbers.test.ts`, `import.test.ts` and `scanner-list.test.ts` pass |
| P2-5 | Myntra seller 10708 and 45833: which is VB and which is EJ | Open | Confirm in the Myntra seller portal (see CLAUDE.md, Pending) |
| P2-6 | Duplicate records: exact duplicates are not counted, repeats are kept as lines | Tested | `server/tests/import.test.ts` passes |

## Scope limits, as required

| Requirement | Status |
|---|---|
| Claim Management System not built; ticket ID, ticket status, claim amount and rejection reason kept nullable | Kept. `claim_amount` is reserved, empty |
| Sales Amount and the OMSGuru integration left pending | Kept. `sales_amount` is reserved, empty |
| No demo data added | Kept. Nothing was seeded or added |
| No credentials hardcoded; TLS verification not bypassed | Kept. `connectionSettingsFor()` is unchanged |
| No historical scans or users deleted | Kept. Removing demo rows still needs the user's approval |
| No destructive migration against production | Kept. The schema changes are additive, and `SCHEMA_VERSION` is not bumped |

## Open decisions (not code)

- The account access rule as built (see CLAUDE.md, Pending).
- Whether an assigned user may scan in an account, or only view it.
- The Myntra 10708 and 45833 mapping.
- The cancelled-before-dispatch return type label.
- Retention, archive location, evidence media policy and PII retention.
- The approved mapping CSV, the Ajio and Myntra EJ headers, and the ATSPL carrier name.
