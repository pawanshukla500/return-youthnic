# AGENTS.md: start here

This file is for any agent, human or AI, that starts work on the Return App. Read it, then the documents below in the order given. Do not change code until you know the current state.

## What the project is

A return-scanning app for VB Exports. Marketplace return reports (Myntra VB and EJ, Flipkart, Meesho, Amazon, Ajio) are loaded as lookup data, one account at a time. A scan records what physically arrived in the return scan register, which is the permanent record. The stack is Express 4 and PostgreSQL on the server, React 19 with Vite on the client, strict TypeScript, and `node:test` through `tsx`. It runs on Windows, and PowerShell is the primary shell.

## Current state (2026-10-13)

- The app runs locally and in production on Hostinger VPS (`https://return.youthnic.shop`). Local checks: `npm run typecheck` passed (0 errors), `npm run build` passed (Vite in 1.66s, server bundled with esbuild in 13ms), and `npm test` finished with 306 tests: 282 pass, 0 fail, 24 skipped (`TEST_DATABASE_URL`).
- `GET /api/health` returns HTTP 200, database connected, name `return-scan_youthnic`.
- Native Kotlin Android client is active in `android/` at release `v1.0.20` (`versionCode: 10020`), featuring CameraX barcode scanning, runtime camera permission flow, server contract alignment (`ScanPayload.kt`), and automated in-app updates (`AppUpdater.kt`) synchronized via GitHub Actions (`.github/workflows/return-scan-apk.yml`).
- The product master has 34,795 rows loaded. On 2026-10-13, all test/scanned data was cleanly wiped in a database transaction, leaving active return lookups (2,539 returns, 2,548 items), `product_master`, and user credentials completely intact and ready for live warehouse scanning tomorrow.
- `CLAUDE.md` is not in the project folder. Until it is restored, the rules in this file and in [docs/notes/agent-handoff.md](docs/notes/agent-handoff.md) are what the code follows. Do not invent a replacement.
- What is written, what was run, and what is waiting on the user are in [docs/notes/agent-handoff.md](docs/notes/agent-handoff.md#current-state). Read the section **Start here (2026-10-13)** before the older session log.

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

## Roles

The project has 33 role agents in `.claude/agents/`. Thirteen of them were added on 2026-10-11 and stay unused until the user asks. Their use, and the workstreams they lead, are in [docs/notes/agent-roster.md](docs/notes/agent-roster.md). A role gives instructions, not access. Every role follows the rules above.

## Handing back

When you finish, add a dated entry to the session log in [docs/notes/agent-handoff.md](docs/notes/agent-handoff.md#session-log). Say what changed, which files, what you ran and its result, what you did not run, and what the next agent must not change. Then follow the [handoff protocol](docs/notes/agent-handoff.md#handoff-protocol).
