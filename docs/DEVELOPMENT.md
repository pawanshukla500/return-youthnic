<!-- Updated 2026-10-10. Commands were checked against package.json and the scripts; rules against the code. Not run. -->
# Development

## Local setup

1. Get the project folder. The working copy has no git metadata, so copy the folder or clone the repository if you have one.
2. Install packages with `npm install`. Use `npm install`, not `npm ci`, during development.
3. Copy `.env.example` to `.env` and set `DATABASE_URL`. See [CONFIGURATION.md](CONFIGURATION.md).
4. Start the app with `npm run dev`, or double-click `RUN.bat` on Windows. TypeScript runs directly through `tsx` and Vite, so no build step is needed before the dev server starts.
5. Create the first sign-in user. See [GETTING-STARTED.md](GETTING-STARTED.md#create-the-first-user).
6. Before you rely on any change, run `npm run typecheck`, then `npm run build`, then `npm test`. See [TESTING.md](TESTING.md).

Agents starting new work should read [AGENTS.md](../AGENTS.md) and [notes/agent-handoff.md](notes/agent-handoff.md) first.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the API (`tsx watch server/index.ts`) and the Vite dev server together, with `concurrently`. |
| `npm run dev:web` | Starts the Vite dev server only, on port 5173. |
| `npm run dev:api` | Starts the API only, with reload on change. |
| `npm start` | Runs the API without reload (`tsx server/index.ts`). |
| `npm run build` | Builds the web app into `dist/` with `vite build`. Run it before you change anything that affects the built app. |
| `npm run typecheck` | Type-checks three projects: `src/` and `vite.config.ts` with `tsconfig.json`, `server/` (including the tests) with `tsconfig.server.json`, then `desktop/` and `desktop-agent/` with `tsconfig.desktop.json`. |
| `npm run engine` | Runs the automation engine headless on this machine (`desktop-agent/src/desktop-app-server.ts --no-window`). Binds `127.0.0.1:3005` unless `ENGINE_HOST`/`ENGINE_PORT` say otherwise; a non-loopback bind requires `ENGINE_TOKEN`. |
| `npm run engine:docker` | Builds and starts the headless engine from `deploy/engine/docker-compose.yml`. See [LINUX-SERVER.md](LINUX-SERVER.md). |
| `npm test` | Runs the test files named in the `test` script in `package.json`. The database checks run only when `TEST_DATABASE_URL` is set. See [TESTING.md](TESTING.md). |
| `npm run user:create -- --name "<name>" --email <email> --role <role> --all-marketplaces` | Creates a sign-in user (`server/scripts/create-user.ts`). The password is read from `NEW_USER_PASSWORD` and is never printed. Use `--marketplaces "<name>,<name>"` instead of `--all-marketplaces` to limit access, `--alias <login alias>` for a login name, and role `Admin` for an administrator. The role is free text and is not checked. |
| `npm run load:master -- "<file>" [--marketplace "<account>"]` | Loads the VB EXPORT product master (channel listing SKU to product SKU, with category and image link) into `product_master` (`server/scripts/load-product-master.ts`). Accepts the "Product SKU Codes" layout and the older VB EXPORT product category workbook. `--marketplace` stores the rows for one account; without it the file's `Marketplace` column is used, and without that the rows apply to every account. The same load is available to an administrator from the Admin "Product SKU master" tab, where the marketplace is chosen in a selector. |
| `npm run layout:inspect -- "<file>" "<marketplace>"` | Prints a file's headers and whether its required headers are present. The first row's buyer fields are masked. Saves nothing, and does not check numbers (`server/scripts/inspect-layout.ts`). |
| `npx tsx server/scripts/diagnose-file.ts "<file>" "<marketplace>"` | Read-only diagnostic: runs the full preview parser and prints the same row counts the upload preview would show (rows, validRows, scannableRows, pendingRows, errorRows, duplicateRows, cancelledRows, blank-tracking, zero-quantity, unverified-tracking, untrusted identifiers, warnings). Nothing is stored. Nothing is activated. Use this when an agent or user wants to verify a real file's counts without uploading it. |
| `npm run sync:oms -- --list` | Lists the OMSGuru channels without writing to the database. |
| `npm run sync:oms` | Syncs channel listings and master SKUs from OMSGuru, and runs the nightly listing-to-product-master bridge. Flags: `--channel <id>` for one channel, `--skip-skus` to skip the SKU list, `--skip-master-bridge` to skip master bridge. |
| `npm run sync:vms` | Syncs product catalog images from read-only VMS database into `product_master.image_url`. |
| `npm run desktop` | Launches the cross-platform Electron desktop app in local development (Windows, Linux, macOS). |
| `npm run desktop:build` | Bundles `desktop/main.ts` into CommonJS (`desktop/dist/main.cjs`) using esbuild. |
| `npm run desktop:pack` | Builds an unpacked directory of the Electron app in `dist-electron/win-unpacked` for rapid testing. |
| `npm run desktop:pack:linux` | Same unpacked build for Linux (`dist-electron/linux-unpacked`). |
| `npm run desktop:dist` | Packages the machine-wide Windows NSIS installer (`Return.App.Setup.<version>.exe`) into `dist-electron/` with `perMachine: true`. Runs the custom steps in `build/installer.nsh` (browser check, `ReturnAppClaimBot` scheduled task). The installer output is local and is not committed. |
| `npm run desktop:dist:linux` | Packages Linux AppImage + `.deb` (`Return.App.Setup.<version>.AppImage/.deb`). |
| `npm run desktop:dist:mac` | Packages macOS DMG + ZIP. |
| `npm run desktop:dist:all` | All OS installers (used by CI per-runner instead). |
| `npm run build:desktop` | Runs the complete distributable desktop build, including the Electron bundle and versioned NSIS installer. |
| `npm run bot` | Runs the claim-bot dashboard in this terminal. The warehouse app is `npm run desktop`, which opens the same bot after sign-in and keeps it in the tray. |
| `npm run oms:orders` | Looks up OMSGuru order details for the uploaded return rows. Flags: `--sample` (20 returns, and only the field names of the first response is printed), `--limit <n>`, `--marketplace <name>`, `--refresh` (fetch again when a snapshot exists), `--delay <ms>` (default 1500), `--csv`. Run by hand. |
| `npm run oms:daily` | Pulls OMSGuru invoices. Flags: `--date YYYY-MM-DD` for one day, or `--from` and `--to` for an inclusive range. With no flags it uses yesterday (IST). Run by hand. |
| `npm run report:returns` | Prints a report that reads only the database. Flags: `--date YYYY-MM-DD` for one IST day, and `--csv`, which also writes CSV files to `exports\`. |


## Rules for every change

These rules protect the business logic. They apply to people and to agents. The full list of invariants, and how each one is checked, is in [notes/agent-handoff.md](notes/agent-handoff.md#invariants).

1. **Account scope on every data route.** A route that reads or changes account data takes `scopeOf(req)` and passes it to the service. The service builds its SQL with `accountCondition()` from `server/access.ts`, which binds the account list as a parameter. Never build the account list into SQL text.
2. **Administrator routes.** A route that changes configuration, or lists other users, uses `requireAdmin` from `server/http.ts`.
3. **Errors.** A service throws `ServiceError(status, message, { details })`, and the route calls `sendError(res, error, next)`. Do not pick a status code by matching the text of an error message.
4. **Transactions.** A write runs on a client from `pool.connect()`, with `BEGIN`, `COMMIT` and `ROLLBACK`. Service functions take the pool or client they need, so tests can run the same code against a test database.
5. **Schema changes are additive.** Use `ADD COLUMN IF NOT EXISTS`, `CREATE ... IF NOT EXISTS`, constraints added as `NOT VALID`, and inserts with `ON CONFLICT DO NOTHING`. Never drop a table or column, and never delete scan, upload or audit history. A new schema file must be listed in `SCHEMA_FILES` in `server/db.ts`, in the order it must run. Never bump `SCHEMA_VERSION`, because a bump drops the app tables.
6. **Rules live in pure modules.** Business rules belong in `server/register-rules.ts`, `server/upload-policy.ts`, `server/access.ts` and `server/marketplace-rules.ts`, and in the row mappers in `server/sheets.ts`. Pure rules can be tested without a database.
7. **Headers are read by their own layout.** A layout's header map is in `server/import-profiles.ts`. Header names are normalized by `normalizeHeader` in `server/marketplace-rules.ts`. Never read a header by name for another marketplace, so one identifier is never saved as another.
8. **Screens.** Every button, toggle and select does what its label says, or it is disabled with a title that says why. The Admin page and its navigation item are shown to administrators only, and the server enforces the same rule.
9. **Test data is synthetic.** Every test value starts with `SYN-`. No real names, emails, AWBs or account data go into code, tests, templates or docs. Do not add demo data.
10. **Secrets.** Never print, log or commit `DATABASE_URL`, `TEST_DATABASE_URL`, the OMSGuru token or client ID, or `NEW_USER_PASSWORD`. Never write a password to a file, a doc or a command saved in the repository.
11. **Database TLS.** Never add `rejectUnauthorized: false`, a `sslmode=no-verify` path, or any other way to skip the certificate check. See [CONFIGURATION.md](CONFIGURATION.md#database-ssl).
12. **Rules change, rules are updated.** If a business rule changes, update `CLAUDE.md` in the same change. If a fact about the work changes, update the note in `docs/notes/` that records it, and say what was and was not run.

## Code style

- Strict TypeScript. The repository has no ESLint or Prettier configuration in its dependencies, so the typecheck is the style gate.
- Server files import with a `.js` extension, for example `from "./client.js"`. Client files import without an extension.
- Import types with `import type` where the module exports types only. The client is built with `isolatedModules`.
- Spreadsheet headers are normalized to lowercase with underscores by `normalizeHeader`. Look at `server/marketplace-rules.ts` and `server/import-profiles.ts` before you add a column.
- The app holds no demo data. Do not add sample people, returns, images or figures to the code, the templates or the database.
- A new test file must be added to the `test` script in `package.json` by name. It is not picked up automatically.

## Where to change what

| To change | Look at |
|---|---|
| An account rule, or who can see what | `server/access.ts`, `server/http.ts`, and the queries that call `accountCondition` |
| A route | `server/index.ts`, `server/upload-routes.ts`, `server/register-routes.ts`. Its contract is in [API.md](API.md) |
| A scan or ticket rule | `server/register-rules.ts` (pure), `server/register-service.ts` (database) |
| The register's columns | `REGISTER_APPROVED_HEADERS`, `REGISTER_CSV_HEADERS` and `REGISTER_OPERATIONAL_HEADERS` in `server/register-rules.ts`. The approved 19 come from the mapping specification. See [REGISTER.md](REGISTER.md) |
| Upload activation | `server/upload-policy.ts` (rules), `server/upload-routes.ts` (checks), `server/lookup-import.ts` (commit) |
| A marketplace layout | `server/import-profiles.ts`, the row mappers in `server/sheets.ts`, `server/marketplace-rules.ts`, and the test `server/tests/import.test.ts` |
| A logistics partner | `server/admin-config.ts`, `server/marketplace-rules.ts` (verified links), `server/logistics.ts` |
| The schema | the five `server/schema*.sql` files, and `SCHEMA_FILES` in `server/db.ts` |
| A screen | `src/pages/*.tsx`, `src/shell.tsx`, `src/types.ts`, `src/api.ts`. Check every control against the UI audit |
| Claims & evidence | `server/claims-routes.ts`, `server/claims-service.ts`, `server/claim-automation-routes.ts`, `server/claim-automation-service.ts` |
| Batched product master | `server/product-master.ts`, `server/product-master-routes.ts` |
| Cross-platform Desktop claim bot | `desktop/` (`main.ts`, `preload.cjs`), `desktop-agent/src/` (`agent-client.ts`, `browser-runner.ts`, `panel-queue.ts`, `local-secrets.ts`, `update-check.ts`, `desktop-app-server.ts`, `marketplaces/`) |
| Native Android scanner | `android/app/src/main/java/shop/youthnic/returnscan/` (`ClaimCaptureActivity.kt`, `ScanActivity.kt`, `AppUpdater.kt`) |
| OMSGuru & catalog bridge | `server/oms/*`, `server/oms/master-bridge.ts`, and `server/scripts/sync-oms-*.ts`. The API is in [notes/omsguru-api.md](notes/omsguru-api.md) |


## Adding a route, a schema change, a layout or a test

The full steps, with the checks each one must pass, are in [notes/agent-handoff.md](notes/agent-handoff.md#recipes).

## Branch and pull request conventions

No branch naming convention is documented in the repository. The repository has no pull request template and no contributing guide. Run `npm run typecheck`, `npm run build` and `npm test` before you open a pull request.

## Project memory and agent guides

- [AGENTS.md](../AGENTS.md): the entry point for any agent.
- [CLAUDE.md](../CLAUDE.md): the business and technical rules the code depends on. Update it when a rule changes.
- [notes/agent-handoff.md](notes/agent-handoff.md): how the work is organised, what is written and what is verified, how to verify, and how to hand over.
- [notes/agent-roster.md](notes/agent-roster.md): the project's role agents and which one to use for which work.
