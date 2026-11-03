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
