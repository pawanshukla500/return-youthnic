# Windows M9 — Submission Authorization Fix (Phase 1–2 evidence)

Branch: `fix/meesho-production-readiness-m9`. Base: `main` @ `9e86d70` (PR #49 merged as `997524b`).

## Phase 1 — audit finding (confirmed)

`desktop-app-server.ts` selected the submit path with
`jobHeader.stage === "submitting" || sessionSaved`. A saved supplier login
therefore armed portal submission on jobs that never received the
backend-issued submitting lease. The enforcement map:

- `approveJobForSubmission` (Supervisor/Admin only) records the authorization:
  job `approved`, claim `processing`, history row — one transaction, row lock.
- `pollNextAutomationJob` leases `approved` → `submitting`, agent-bound,
  attempt+1, 15-min lease (`FOR UPDATE SKIP LOCKED`). `queued` → `downloading_media`.
- Meesho engine `prepare` stops at `prepared` when `requireApprovalBeforeSubmit`
  is set, but `execute("submit")` skips that gate.
- Complete endpoint checked idempotency/terminal/outcome guards but not lease
  ownership, lease liveness, or the submitting requirement.

## Phase 2 — fix (this branch)

A saved login never authorizes submission on either path:

- Desktop action selection: `submit` only when `jobHeader.stage === "submitting"`.
  Cookie/session state is not consulted.
- Desktop keeps a `submitting` run on the submitting stage (no longer
  overwrites it with `downloading_media`, which would destroy the authorization
  the gate and the endpoint verify).
- Pre-submit gate `isSafeToSubmitBundle(stage, claim, approvalRequired=true)`:
  approval-required accounts pass only from `submitting`; auto-submit accounts
  (`requireApprovalBeforeSubmit=false`) get the same freshness/outcome
  revalidation before the engine's prepare flow can reach the portal click.
- `updateJobProgress` rejects transitions to `submitting` (the lease owns that
  transition) and, when the worker id is supplied, accepts progress only from
  the current live lease holder.
- `completeJobSubmission` verifies atomically (row lock, one transaction):
  lease holder match, live lease, and — on approval-required accounts — the
  submitting stage. `manual-resolve` carries `operatorOverride: true` instead
  and stays a separate Supervisor/Admin-gated path.

## Verification (2026-11-03, this machine)

- `npm run typecheck` — 0 errors (all three projects).
- `npm run build` — exit 0 (`dist/` client + `server/dist.js` 877.9 kB).
- Focused: `claim-idempotency-m8`, `claim-automation`, `submit-guard` — 43/43 pass.
- Full `npm test` without a database — 721 pass, 0 fail, 40 skipped (37 need
  `TEST_DATABASE_URL`, 3 POSIX-only).
- Full `npm test` with `TEST_DATABASE_URL` pointed at the dedicated `return_test`
  database on the provisioned test PostgreSQL 17.2 server — **764 pass, 0 fail,
  3 skipped** (only the POSIX-only secret-permission checks; every DB-gated
  check ran, including the 6 new authorization checks below).
- New `server/tests/claim-authorization-db.test.ts` (6 checks, real database):
  saved-login lease cannot record a ticket (409, nothing written); approve →
  lease as submitting → complete records the ticket once, starts exactly one
  follow-up, same-ticket replay idempotent, different ticket rejected;
  two racing workers — second gets nothing; expired lease cannot complete and
  the next poll parks the job as manual_intervention_required; auto-submit
  account completes from a live prepare lease; retry cannot re-arm submitting.

- `npm run typecheck` — 0 errors (all three projects).
- `npm run build` — exit 0 (`dist/` client + `server/dist.js` 877.9 kB).
- Focused: `claim-idempotency-m8`, `claim-automation`, `submit-guard` — 43/43 pass.
- Full `npm test` — 721 pass, 0 fail, 40 skipped (37 need `TEST_DATABASE_URL`,
  3 POSIX-only; same baseline as PR #49, no new skips).
- New tests: guard blocks non-submitting stages on approval accounts;
  complete rejects non-submitting stage / expired lease / non-holder (409/404),
  succeeds once for the authorized lease and for auto-submit live leases;
  progress rejects self-granted `submitting` and non-holder writes; lease select
  asserts `SKIP LOCKED` for two racing workers.

## Blocked / needs operator

- Phase 3: no local PostgreSQL, no Docker, no `TEST_DATABASE_URL` on this
  machine. DB-backed tests (concurrent lease race, approval authorization
  end-to-end) run in CI; a dedicated local test instance needs an operator
  decision (install Postgres vs provision a test URL vs CI-only).
- Phases 4–8 (installed-app GUI, live Meesho, mobile/Firebase, controlled
  filing) need the operator, credentials, and explicit per-step approval.
- Unrelated anomaly (not caused by this branch): during editing, 7 worktree
  files briefly showed as deleted outside any tool write; restored from HEAD
  (`git checkout --`) and re-verified. No content was lost.

## Phase 10 — security review, code-only part (2026-11-03, this branch)

- No secrets in the M9 surface: the new guard, desktop, service and route
  code paths log only stages, claim statuses and static reason strings.
  No password, API key or token is printed, logged or committed.
- Electron app window (`desktop/main.ts`): `nodeIntegration: false`,
  `contextIsolation: true`, `webSecurity: true`, preload-only bridge.
  The preload (`desktop/preload.cjs`) exposes only status/toggle/notify/
  browser-rect — no arbitrary execution, no secret access. The OS-level
  `sandbox: true` flag is not set on the app window (renderer relies on the
  settings above); changing it needs operator-tested GUI verification.
- Supplier-browser Chromium sandbox (AGENTS.md rule 13) is untouched by this
  branch; the automation still loads only the operator's supplier panel.
- Local secrets (`desktop-agent/src/local-secrets.ts`): DPAPI via
  `safeStorage` when available, explicit documented plaintext fallback —
  unchanged, no weakening.
- Credential flow unchanged: supplier passwords stay AES-256-GCM encrypted
  in Postgres and are decrypted only inside `getJobExecutionBundle`.
- Retry still cannot re-arm `submitting`/finished/recorded-outcome work;
  manual-resolve is unchanged apart from carrying the operator override.
- No schema change in this branch (additive-only rule holds vacuously).
- Not verifiable without the operator: installed-app sandbox behavior,
  screenshot/log redaction on a real run, recovery after interrupted work.

## Phase 11 — PR and CI (2026-11-03)

- Branch pushed; PR [#50](https://github.com/pawanshukla500/return-youthnic/pull/50)
  open with DO-NOT-MERGE until the live phases (4–9) are verified.
- CI `ci.yml` provisions its own throwaway Postgres 16 (`return_test`) and runs
  the full suite: **767 tests, 767 pass, 0 fail, 0 skipped** — the new
  `claim-authorization-db.test.ts` runs green on CI as well as locally.
- Required checks green: Build Desktop Setup (windows-latest) pass,
  Verify Web & API pass. CodeAnt review still in progress; no human reviews yet.
## Phase 4 — installer build (2026-11-03)

- Built from an isolated worktree of this branch @ `77eb21b` with a clean
  `npm ci` (only the Electron runtime binary was copied from the main
  worktree because the script allow-list blocked its postinstall download;
  versions match: electron 44.8.0, esbuild 0.28.2).
- `npm run desktop:dist` produced `dist-electron/Return.App.Setup.1.2.0.exe`
  (120,272,081 bytes, app version 1.2.0, unsigned — SmartScreen will warn).
- Install + GUI test still needs the operator (run the EXE, sign in, claim
  queue, supplier browser, Start/Pause/Resume, Poll Now, approvals, AI Center,
  tray, restart). Sanitized screenshots/logs to follow.
- Re-verified 2026-11-03: CI green on the latest push (`77cc57d`) — Build
  Desktop Setup pass, Verify Web & API pass (full 767-test suite on CI's
  throwaway Postgres). PR stays do-not-merge until live phases 4–9.
- Live worktree note: another party is editing the scan-save path in parallel
  (`src/pages/ScanReturns.tsx`, `src/index.css`, `server/register-service.ts` —
  save retry, paused queue banner, non-fatal tracking sync). Those files are
  untouched by this branch; their uncommitted changes were left exactly as found
  and are not part of any M9 commit.
