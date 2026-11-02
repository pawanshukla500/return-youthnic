# Desktop Native AI — Milestone 1 (foundation)

Branch: `feature/desktop-native-ai`. Status: implemented, typechecked, built, tested.

## What Milestone 1 delivers

**Shared browser adapter** (`desktop-agent/src/browser-adapter.ts` + `native-browser-view.ts`)

- `openSupplierBrowser({ panelKey, profileDir, headless })` opens a supplier
  browser through the configured adapter. Default (`BROWSER_ADAPTER` unset or
  `auto`) is the existing external system-Chromium runner: behaviour identical
  to before, including headless Linux servers.
- `BROWSER_ADAPTER=native` inside the Electron shell drives the bundled
  Chromium through `WebContentsView`, one isolated persistent
  `persist:supplier-<panel>` session per marketplace. Cookies survive restarts
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

## Operator knobs (names only, see `.env.example`, `deploy/engine/.env.example`)

`BROWSER_ADAPTER`, `FOLLOWUP_NIGHTLY_ONLY`, `AI_ASSIST_ENABLED`,
`AI_GATEWAY_URL`, `AI_GATEWAY_TOKEN`, `AI_MODEL_NAME`, `AI_MAX_CALLS_PER_JOB`,
`AI_TIMEOUT_MS`.
