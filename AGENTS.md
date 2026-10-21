# AGENTS.md: start here

This file is for any agent, human or AI, that starts work on the Return App. Read it, then the documents below in the order given. Do not change code until you know the current state.

## What the project is

A return-scanning app for VB Exports. Marketplace return reports (Myntra VB and EJ, Flipkart, Meesho, Amazon, Ajio) are loaded as lookup data, one account at a time. A scan records what physically arrived in the return scan register, which is the permanent record. The stack is Express 4 and PostgreSQL on the server, React 19 with Vite on the client, strict TypeScript, and `node:test` through `tsx`. It runs on Windows, and PowerShell is the primary shell.

## Current state (2026-10-17)

- The app runs locally and in production on Hostinger VPS (`https://return.youthnic.shop`). On 2026-10-20 local checks passed: `npm run typecheck` (0 errors), `npm run build`, and `npm test` (463 tests: 426 pass, 0 fail, 37 skipped because local `TEST_DATABASE_URL` is unset).
- `GET /api/health` returns HTTP 200, database connected, name `return-scan_youthnic`.
- Native Kotlin Android client is active in `android/` at release `v1.0.58` (`versionCode: 10058`), featuring CameraX barcode scanning, runtime camera permission flow, photo & 480p SD unboxing video evidence capture, visual upload progress dialog, instant form reset ("Start Again with Zero"), unified claim creation (`POST /api/claims/unified-create`), and automated in-app updates (`AppUpdater.kt`) synchronized via GitHub Actions (`.github/workflows/return-scan-apk.yml`). The APK workflow keeps only the newest two `v1.0.*` releases and never touches desktop releases.
- Cross-platform Desktop application (`desktop/` & `desktop-agent/`) published at GitHub Release `desktop-v1.2.0.16` (Windows NSIS, Linux AppImage + deb, macOS DMG + ZIP). It files panel-wise across six isolated supplier panels (Meesho fully automatic, others assisted), guides first-time setup per panel in the dashboard, encrypts local secrets with the OS store, offers OS-matched update downloads, and registers the `ReturnAppClaimBot` Scheduled Task at install for restart-after-crash. Operator guide: `docs/DESKTOP-APP.md`. The desktop workflow keeps only the newest two `desktop-v*` releases (created with `--latest=false` so the APK family keeps the "Latest" badge) and never touches Android releases. A `desktop` branch may hold the next batch of desktop work pending review.
- Every console date filter uses the shared `DateField` (`src/date-field.tsx`): it always displays DD/MM/YYYY regardless of the PC's OS locale, still opens the native calendar picker, and keeps the value as ISO `yyyy-mm-dd` for the API. Never add a raw `<input type="date">` to a page.
- The product master (`product_master`) was cleared on 2026-10-19 (91,696 rows removed) so it can be uploaded again. Batched staged import (`/api/admin/product-master/import/start` and `/batch`) processes up to 500 rows per transaction with progress tracking, pause/retry, and cancellation, verified against the 126,176-row `Book11.xlsx`.
- Nightly OMSGuru listing-to-master bridge (`server/oms/master-bridge.ts`) runs during `npm run sync:oms`, mapping active channel listings, backfilling catalog images, and resolving unmatched return SKUs.
- Claims management system (`/claims`) features real-time aggregated ₹ totals (`formatInr`), modern lifecycle status tracking, and a redesigned View Details modal (1-click copy buttons, responsive 2-column layout, visual evidence gallery, full-screen lightbox, and HTML5 video streaming player).
- Iron Send is an operational category, tracked on the Iron tracking page (`/iron`); only the Inward Team (role `Inward`) or an Admin records ironed units received. Live sync over WebSocket `/api/live` with a polling fallback. Return analytics under Register > Return Analytics.
- `CLAUDE.md` is not in the project folder. Until it is restored, the rules in this file and in [docs/notes/agent-handoff.md](docs/notes/agent-handoff.md) are what the code follows. Do not invent a replacement.
- What is written, what was run, and what is waiting on the user are in [docs/notes/agent-handoff.md](docs/notes/agent-handoff.md#current-state). Read the latest session logs at the end of that file.

## Read in this order

1. This file.
2. [CLAUDE.md](CLAUDE.md): the business and technical rules. **This file is not in the folder as of 2026-10-12.** Do not treat a missing file as permission to change the rules in this document.
3. [docs/notes/agent-handoff.md](docs/notes/agent-handoff.md): how the work is organised, the invariants, the recipes, how to verify, and the handoff protocol.
4. [docs/notes/phase1-register-status.md](docs/notes/phase1-register-status.md): what was written, and the verification commands.
5. [docs/notes/phase1-audit-matrix.md](docs/notes/phase1-audit-matrix.md): the issue IDs (P0, P1, P2) and their status.
6. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the modules and the data flows.
7. [docs/API.md](docs/API.md): the route contract.
8. [docs/REGISTER.md](docs/REGISTER.md): the register's rules in detail.
9. The note for your task, in [docs/notes/](docs/notes/).

## Rules that must not be broken

Each rule has a check. The handoff lists the checks under [Invariants](docs/notes/agent-handoff.md#invariants).

1. **Account scope on every data route.** Every query that reads or changes account data takes the signed-in user's scope and binds the account list as a parameter.
2. **Administrator routes check the Admin role.** Configuration, and the lists of other users, are Admin-only.
3. **Activation, not replacement.** Superseded lookup rows are kept. A scan keeps its own snapshot. Scan, upload and audit history is never deleted.
4. **Only scannable rows activate.** Pending, rejected, duplicate and cancelled rows remain in upload history. Partial activation requires explicit confirmation, and a confirmation cannot bypass a fatal or no-scannable-row blocker.
5. **A partner, a courier name or a tracking host is switched off, never deleted.** Every change is audited.
6. **Schema changes are additive.** Never drop a table or column. Never bump `SCHEMA_VERSION`.
7. **Database TLS stays verified.** Never add a path that skips the certificate check.
8. **No secrets.** Never print, log or commit `DATABASE_URL`, `TEST_DATABASE_URL`, the OMSGuru credentials or `NEW_USER_PASSWORD`. Never read `.env`.
9. **No demo data.** Test data is synthetic, and every value starts with `SYN-`.
10. **Every screen control works, or is disabled with a title that says why.**
11. **Report only what you ran.** Do not write that something passes, works or is verified unless you ran it and read the output.
12. **Mobile APK release and in-app update synchronization.** Any change that applies to the mobile app or scanning behavior must be reflected in the release manifest (`data/return-scan-release.json` and `server/mobile-release.ts`) and published through the GitHub Actions APK workflow (`.github/workflows/return-scan-apk.yml`). The version code and download URL must always match the published release so installed warehouse Android devices receive the in-app update notification and can update smoothly.
13. **Desktop hardware discipline and process isolation.** The Windows desktop application and automation engine must remain operable 24/7 on 4GB RAM / 2-core CPU hardware with < 0.5% idle CPU. Never exceed 256MB V8 heap limit. All child browser processes spawned for supplier panel automation must be strictly terminated with complete process-tree signals (`taskkill /T /F`). Media downloads must stream chunk-by-chunk directly to disk and purge cache older than 24 hours. Desktop releases are automated via `.github/workflows/desktop-release.yml`.
14. **One worker loop, owned by the engine.** The automation engine (`desktop-agent/src/desktop-app-server.ts`) owns the only claim worker loop. The Electron shell (`desktop/main.ts`) is a client of it and must not hold a second copy of the loop or a second scheduler.
15. **The engine is fail-closed when exposed.** A non-loopback bind requires `ENGINE_TOKEN` (at least 24 characters) and the engine must refuse to start without one. Remote requests carry `Authorization: Bearer <ENGINE_TOKEN>`; the token is compared in constant time, is never logged, and is never accepted from a query string. Never publish the engine port directly to the internet. Everything under `AGENT_DATA_DIR` (browser profiles, operator session, evidence cache) is secret.
16. **All three deployment modes stay buildable.** Any change to `desktop/` or `desktop-agent/` must keep the Windows desktop, Linux desktop and headless Linux server modes working. `npm run typecheck` covers `desktop` and `desktop-agent` through `tsconfig.desktop.json`; a change that only passes `tsconfig.json` is not verified. The deployment artifacts in `deploy/engine/` must match the engine's real routes and environment variables.

## Commands

```bash
npm run typecheck
```

```bash
npm run build
```

```bash
npm test
```

The two database checks run only when `TEST_DATABASE_URL` is set to a dedicated database whose name contains `test`. Without it they are reported as skipped, and a skipped check has not passed.

`npm run typecheck` runs three projects: `tsconfig.json` (`src`), `tsconfig.server.json` (`server`) and `tsconfig.desktop.json` (`desktop`, `desktop-agent`).

Desktop application and automation engine:

```bash
npm run desktop
```

```bash
npm run desktop:dist
```

```bash
npm run engine
```

```bash
npm run engine:docker
```

## Roles

The project has 33 role agents in `.claude/agents/`. Thirteen of them were added on 2026-10-11 and stay unused until the user asks. Their use, and the workstreams they lead, are in [docs/notes/agent-roster.md](docs/notes/agent-roster.md). A role gives instructions, not access. Every role follows the rules above.

## Handing back

When you finish, add a dated entry to the session log in [docs/notes/agent-handoff.md](docs/notes/agent-handoff.md#session-log). Say what changed, which files, what you ran and its result, what you did not run, and what the next agent must not change. Then follow the [handoff protocol](docs/notes/agent-handoff.md#handoff-protocol).
