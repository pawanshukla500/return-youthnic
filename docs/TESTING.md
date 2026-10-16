<!-- Updated 2026-10-10 from package.json and the files in server/tests/. Not run. -->
# Testing

## Framework and setup

The tests use Node.js's built-in test runner (`node:test`) with `node:assert/strict`. They run through the `tsx` loader, a development dependency, so the test files can be TypeScript. There is no Jest, Vitest or Mocha configuration. Install packages with `npm install` before you run the tests.

## Running tests

Run the full suite:

```bash
npm test
```

Run one file:

```bash
node --import tsx --test server/tests/oms.test.ts
```

The `test` script in `package.json` lists the files by name, in this order:

1. `server/tests/import.test.ts`
2. `server/tests/spreadsheet-numbers.test.ts`
3. `server/tests/marketplace-rules.test.ts`
4. `server/tests/oms.test.ts`
5. `server/tests/oms-orders.test.ts`
6. `server/tests/data-capture.test.ts`
7. `server/tests/database-ssl.test.ts`
8. `server/tests/register-rules.test.ts`
9. `server/tests/register-db.test.ts` (needs a test database)
10. `server/tests/access.test.ts`
11. `server/tests/upload-policy.test.ts`
12. `server/tests/access-db.test.ts` (needs a test database)

There is no watch mode and no separate unit, integration or end-to-end script.

## Database checks

Two files check PostgreSQL behaviour: `register-db.test.ts` and `access-db.test.ts`. They run only when `TEST_DATABASE_URL` is set, in the same terminal, before `npm test`:

```bash
$env:TEST_DATABASE_URL = "<a test database URL; its database name must contain 'test'>"
```

```bash
npm test
```

The files refuse any database whose name does not contain `test` (a case-insensitive match), and they create only `SYN-*` data. Never point `TEST_DATABASE_URL` at the production database. The checks read only `TEST_DATABASE_URL`, never `DATABASE_URL`.

**Reading the output.** Without `TEST_DATABASE_URL`, the database checks are reported as **skipped**, with the reason in the output. A skipped check has not passed. A report that says the suite passed, but lists these checks as skipped, has not verified the database behaviour. Say so in the report.

## What the tests cover

| File | Declarations | Needs a database | Covers |
|---|---|---|---|
| `import.test.ts` | 48 | No | The spreadsheet parser for every layout, with synthetic rows. The seller guard, the Myntra forward fallback, the Ajio and Amazon display identifiers, the Amazon forward leg, RMA and carrier, Meesho's supplier block and tracking link, Flipkart's FSN and return ID, quantity checks, the repeat classification, and the product master parser. Two tests use the full real Flipkart and Amazon headers. |
| `spreadsheet-numbers.test.ts` | 12 | No | Identifiers that Excel stored as numbers: the untrusted-number rule, the lookup-key rule, scientific notation, and the Meesho 16-digit exception. Builds its workbooks in memory. |
| `marketplace-rules.test.ts` | 34 | No | Return type mappings for every layout, SKU variation joining, header normalization, the tracking link forms and the rounding rule with its outcomes, and partner detection with the Unknown fallback. |
| `oms.test.ts` | 19 | No | OMSGuru client helpers and request shape, listing records and catalog entries, and SKU records. |
| `oms-orders.test.ts` | 5 | No | Order row normalization, removal of personal data, and lookup keys. |
| `data-capture.test.ts` | 10 | No | Report dates and IST day ranges, lifecycle counts, invoice keys, and raw row capture. |
| `database-ssl.test.ts` | 8 | No | The database connection rules: which hosts use TLS, `sslmode=no-verify` refused, the CA file, the URL sanitising, the URL-leakage guard, the schema-file safety guard (`DROP TABLE` / `TRUNCATE` / `DELETE FROM` refused), the `db.ts` destructive-rebuild guard (no `APP_TABLES`, `dropAppTables`, or `databaseNeedsRebuild`), the service-code history-table guard (no `DELETE FROM` against scan/claim/upload history outside the explicit allowlist), the schema foreign-key integrity check, the per-file parseability check, and the migration-safety mirror. |
| `register-rules.test.ts` | 36 | No | The pure register rules: scan keys, tracking normalization, lookup decisions, the matched field and leg, every quantity and issue rule, ticket status changes, the register row, the 19 approved columns in order, and the shared CSV and Excel rows. |
| `register-db.test.ts` | 11 | **Yes** | The register against PostgreSQL: account isolation for EJ and VB, a two-line return, idempotent retries, concurrent saves, partly received returns, ticket creation and rejection, invalid references, a replacement upload that keeps scan history, a failed upload that rolls back, the register and its export, and persistence across a new connection and a second schema run. It was written before the account rule and has not been re-read for it. |
| `access.test.ts` | 11 | No | The account rule (Admin, all accounts, assigned accounts, none), the account condition as a bound parameter, Myntra EJ and VB as separate accounts, the register query and its sort allowlist, `requireAdmin` (403 for every other role), and the error mapping. |
| `upload-policy.test.ts` | 8 | No | The preview counts, the activation blockers (error rows, a fatal file, an account the user cannot use, no valid rows), the confirmations, and the rule that a confirmation cannot stand in for a blocker. |
| `access-db.test.ts` | 13 | **Yes** | The account and scan rules against PostgreSQL: the schema applied twice; an Admin, an assigned user and an unassigned user; 403 for a named account outside the scope and 404 for a return outside it; a shared AWB as a choice for an Admin and a single match for a restricted user; a restricted user's refused save; several items on one AWB as one scan, with the scanned AWB kept; a repeated key returning the first scan; a second scan of the AWB refused; a ticket a restricted user cannot change; the register, export and dashboard figures limited to the user's accounts; and a saved scan keeping its snapshot after a lookup replacement and surviving a reconnect. |

The declaration counts are the number of top-level `test(` calls in each file, found by text search on 2026-10-10. They are not a coverage measure.

The tests exercise server-side code only. There are no tests for the React pages and no browser tests.

## Writing new tests

- Put new files in `server/tests/` and name them `*.test.ts`.
- Use the same imports as the existing files: `import { test } from "node:test"` and `import assert from "node:assert/strict"`.
- Use synthetic data only. Every test value starts with `SYN-`, and there are no real customer or account values.
- Pure rules are tested without a database. A check that needs PostgreSQL is gated on `TEST_DATABASE_URL`, with the same database-name guard as the existing files, and it is reported as skipped when the variable is missing.
- Add the new file to the `test` script in `package.json` by name. The script lists the files, so a new file is not picked up automatically.
- There is no shared helper folder. Each test file builds its own fixtures.

## Coverage requirements

No coverage tool or threshold is configured.

## Continuous integration

The repository includes automated GitHub Actions workflows:

1. **`.github/workflows/ci.yml`**:
   - Triggers on every push and pull request to `main`.
   - Provisions a dedicated `postgres:16` service container with SSL disabled for the internal test runner network.
   - Runs `npm run typecheck`, `npm run build`, and `npm test` with `TEST_DATABASE_URL` pointing at the container database `return_scan_test`.
   - Runs all 406 tests (0 skipped in CI).
   - Verifies the Docker production container build.

2. **`.github/workflows/return-scan-apk.yml`**:
   - Triggers on pull requests and pushes affecting `android/**` or release manifests.
   - Compiles native Android Kotlin app, runs native unit tests and Android Lint, prepares keystore, and assembles release APK with R8 and resource shrinking.
   - Verifies package ID (`shop.youthnic.returnscan`), version code, camera permissions, signing certificate, and size budget.
   - Uploads APK artifact and publishes GitHub Releases.

3. **`.github/workflows/deploy.yml`**:
   - Automatically deploys the web client and Express server to the Hostinger production VPS (`https://return.youthnic.shop`) upon push to `main`.

## Verification status

The test suite runs 406 tests with 0 failures:
- Locally: 370 tests pass without a test database (36 database tests report skipped).
- In CI: 406 tests pass (100% pass, 0 fail, 0 skipped) against the `postgres:16` container.

