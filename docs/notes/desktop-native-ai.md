# Desktop Native AI — Milestone 1 (foundation)

Branch: `feature/desktop-native-ai`. Status: implemented, typechecked, built, tested.

## What Milestone 1 delivers

**Shared browser adapter** (`desktop-agent/src/browser-adapter.ts` + `native-browser-view.ts`)

- `openSupplierBrowser({ panelKey, profileDir, headless })` opens a supplier
  browser through the configured adapter. Default (`BROWSER_ADAPTER` unset or
  `auto`) is the bundled Chromium (`WebContentsView`) inside the desktop app,
  and the existing external system-Chromium runner everywhere else (headless
  Linux servers, plain node, CI): behaviour identical to before there.
  `BROWSER_ADAPTER=external` forces the system browser everywhere.
- Inside the desktop app the adapter drives one isolated persistent
  and updates. No cookies are ever copied from external profiles; each adapter
  signs in fresh on its own profile, and login is requested only when that
  session is expired/revoked/invalid. OTP/CAPTCHA surfaces the panel window
  for manual completion. An explicit native request that cannot be honoured
  fails loudly — never substitutes another session.
- `BaseMarketplaceAutomation`, `getAutomationEngine`, `completePortalLogin`
  and `loggedIn` now take the `SupplierBrowserApi` surface; `BrowserRunner`
  satisfies it structurally, so all five marketplace automations work
  unchanged. The follow-up worker opens browsers through the adapter and
  pre-checks `isMarketplaceSupported()` so unknown panels never open a window.

**Local AI orchestration** (`desktop-agent/src/ai-assistant.ts`)

- Provider-independent, `generateText`-compatible (`Vercel AI SDK Core`
  shape), no new dependency. Only built-in provider is `GatewayProvider`
  (`AI_GATEWAY_URL` + `AI_GATEWAY_TOKEN`, Bearer, timeout, never logged).
- OFF by default (`AI_ASSIST_ENABLED=0`); the worker never blocks on AI.
- `validateAiProposal`: only `suggest_selector | retry_step |
  collect_diagnostics | draft_response`; ticket refs must equal the known
  ticket; bounded retries (cap 3) degrading to human review. Usage ledger
  counts calls/failures/latency (metadata only) and is exposed on
  `GET /api/v1/engine/info`.

**Operational memory**

- Authoritative: `server/schema-ai-memory.sql` (`ai_memory_procedures`,
  `ai_memory_events`, additive, registered last in `SCHEMA_FILES`) + pure
  rules in `server/ai-memory.ts` (signature normalization, approved-only
  match, approve/disable/requeue transitions).
- Local: `desktop-agent/src/ai-memory-cache.ts` (approved/disabled mirror,
  capped events, 24h prune, crash-safe load). AI suggestions stay `pending`
  until an operator approves them.

**Nightly tracking window** (`server/nightly-window.ts`, `desktop-agent/src/follow-up-window.ts`)

- Pure IST arithmetic (fixed +05:30, no DST): `isWithinNightlyWindow`,
  `isEligibleForNightlyCheck` (>= 48h on the submission timestamp),
  `nextNightlyWindowStart`, `nextEligibleCheckAt`.
- `recordFollowUpResult` reschedules with `nextEligibleCheckAt` (48h cadence
  aligned into the window). The engine gates leasing with
  `shouldSkipFollowUpCycle` (`FOLLOWUP_NIGHTLY_ONLY=1` default, `=0` restores
  check-whenever-due). Missed windows are never caught up outside the window;
  due rows wait for the next window. `engineStatus()` now reports
  `browserAdapter`, `aiAssist`, and `nightlyWindow` (next window start,
  ms-until) for the dashboard.

## Verification (2026-11-02, this branch)

- `npm run typecheck`: 0 errors across `tsconfig.json`, `tsconfig.server.json`, `tsconfig.desktop.json`.
- `npm run build`: exit 0 (`dist/`, `server/dist.js`).
- `npm run desktop:build`: exit 0 (`desktop/dist/main.cjs`, 224.3kb).
- `npm test`: 624 tests — 584 pass, 0 fail, 40 skipped (37 need
  `TEST_DATABASE_URL`, 3 POSIX-only secret-permission checks). Includes 36 new
  tests: `server/tests/nightly-window.test.ts`, `server/tests/ai-memory.test.ts`,
  `desktop-agent/follow-up-window.test.ts`, `desktop-agent/browser-adapter.test.ts`,
  `desktop-agent/ai-assistant.test.ts`, `desktop-agent/ai-memory-cache.test.ts`.

## Explicitly NOT done in Milestone 1 (follow-ups)

- `checkClaimStatus()` per marketplace: still defaults to `not_supported`
  (no credentials, no verified portal flow — never invent a check).
- AI claim replies/task center, report-analysis UI, memory approve/disable
  API + UI, native browser tabs in the Electron window, desktop installer
  run-through (build only, no install test), CPU/RAM measurement on hardware.
- No AI provider credential exists; `AI_GATEWAY_URL/TOKEN` are unset template
  names only. The coding-model session token was not reused.

## Milestone 2 (branch `feature/desktop-native-ai-2`)

- **Filing worker through the adapter.** `pollAndProcessJob` opens the supplier
  browser via `openSupplierBrowser`; the hold-open manual-intervention flow
  (`holdPortalBrowser`, now typed to the adapter surface) and teardown are
  unchanged. Manual-intervention panels are surfaced via the adapter's
  `showForManualStep()` (native) or the existing OS window (external, no-op).
  Default remains external: identical behaviour until the operator opts into
  native.
- **Follow-up assistance loop (advisory only).** After each reported check the
  worker runs `runFollowUpAssist`: memory-first (`decideFollowUpAssist`),
  bounded AI draft when enabled, human review otherwise. It never changes what
  was reported and never executes a marketplace action. The server now returns
  an additive `statusChanged` flag (`recordFollowUpResult`, threaded through
  `POST /api/automation/follow-ups/:id/result` and `AgentClient.reportFollowUp`)
  so unchanged tickets skip assistance (workflow step 6).
- **Memory dashboard section + safety kill-switch.** `GET /api/v1/ai-memory`
  (procedures with status, newest 20 events, usage ledger, assist flag) renders
  an "Approved AI memory" panel reusing the page's table styles; every field is
  HTML-escaped server-side. `POST /api/v1/ai-memory/disable` flips one cached
  procedure to `disabled` locally (operator-gated; upstream approval sync is a
  later milestone). Follow-ups copy updated to the nightly window.
- Verification: typecheck 0 errors, build + desktop:build exit 0, full suite
  green (see PR). New tests: `ai-memory-panel.test.ts` (escaping, cap,
  disable), `portal-hold.test.ts` (hold/close on the adapter surface),
  `decideFollowUpAssist` cases in `ai-assistant.test.ts`.

## Milestone 3 (branch `feature/desktop-native-ai-3`)

- **Authoritative memory approval in Postgres.** New `operator_tasks` table
  (`server/schema-ai-tasks.sql`, registered in `SCHEMA_FILES`) plus
  `server/ai-memory-store.ts` (list/create/transition/correct procedures with
  signature normalization, transition table
  pending→approved→disabled→pending) and `server/ai-memory-routes.ts`: admin
  routes to inspect/approve/disable/correct procedures, agent sync route
  returning only `approved`+`disabled` rows scoped to the agent's accounts
  (pending never leaves the server), and operator-task routes (create/list/
  resolve with history, 404s outside scope, double-resolve rejected).
  Mounted from `mountClaimAutomationRoutes`.
- **Worker sync-down + task creation.** Local `ai-memory.json` is now a
  stale-TTL mirror (6h via `isCacheStale`/`markSynced`/`syncedAt`): the engine
  pulls approved+disabled procedures, drops local disabled ones, and matches
  approved ones before any AI call. Filing failures now file a
  `pending_approval` operator task (tracking failures, missing evidence,
  expired sessions) instead of only logging.
- Verification: typecheck 0 errors x3, build + desktop:build exit 0,
  `npm test` 641 tests: 601 pass, 0 fail, 40 skipped (37 need
  `TEST_DATABASE_URL`, 3 POSIX-only). New tests: `ai-memory-store.test.ts`
  (SQL shape, transitions, normalization), `operator-tasks.test.ts` (scope,
  double-resolve, history), TTL cases in `ai-memory-cache.test.ts` — 21/21.
  The task test caught a real `$1` placeholder collision in the scope check
  (fixed before merge).
- Still not verified: dedicated DB tests locally (CI runs them), installer
  run, live panels, AI provider call, CPU/RAM. `checkClaimStatus()` per
  marketplace still `not_supported`. Task-center and report-analysis UI are
  later milestones.

## Operator knobs (names only, see `.env.example`, `deploy/engine/.env.example`)

`BROWSER_ADAPTER`, `FOLLOWUP_NIGHTLY_ONLY`, `AI_ASSIST_ENABLED`,
`AI_GATEWAY_URL`, `AI_GATEWAY_TOKEN`, `AI_MODEL_NAME`, `AI_MAX_CALLS_PER_JOB`,
`AI_TIMEOUT_MS`.
