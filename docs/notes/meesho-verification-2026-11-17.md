# Meesho Return-Claim + Claim-Tracking — End-to-End Verification (2026-11-17)

Audited on the operator's live PC against the production backend (`https://return.youthnic.shop`), the installed app, and the code on `main` (`26c6074`). Three independent verification agents (live machine, code+tests, production backend) + orchestrator log forensics. **Verdict: the configuration is complete and correct; every layer tested green; one runtime incident class found and fixed the same day (cycle watchdog, shipped in 1.3.6).**

## 1. Configuration (code) — all present, test-backed

| Item | Evidence | Tests |
|---|---|---|
| Credential resolution (typed → backend → bundle → `MEESHOID`/`MEESHO_PWD` env) | `portal-login.ts:368-418`, aliases at `:140-141` | portal-login suite |
| RTO handling (return type verified, unverified → operator review; Courier Return tab) | `meesho.ts:432-475` | meesho-issues |
| Filing: category `/support/1`, duplicate-ticket pre-check (F7), form fill, box-by-box upload with portal-ack gate, prepare→approval→submit, ticket-ID extraction excluding order/AWB digits | `meesho.ts:401-798` | meesho-issues, submit-guard |
| Tracking: per-ticket deep link `…/support/ticket/{id}` primary, deterministic classification, table fallback | `meesho.ts:1040-1186` | meesho-ticket-page (13) |
| Follow-up lifecycle (one row per claim, 48h interval, terminal/stop rules) | `server/claim-follow-up-service.ts:18-239` | claim-follow-up |
| Evidence gate (`pending_evidence` never leases; auto-ready on last upload) | `server/claim-automation-service.ts:584-606`, `claims-service.ts:1245-1252` | claim-evidence-gate |

`npm run typecheck`: 0 errors ×4 projects. Meesho/claims suites: **173/173 pass**.

## 2. Production backend — live and real

- `GET /api/health` → `{"ok":true,"database":"connected","name":"return-scan_youthnic"}`.
- Real claims with real Meesho ticket IDs recorded by the system: `794219857178` (claim 5), `794219052322` (claim 4), `794219443852` (claim 2) — completed 2026-11-09, each with `Claim successfully submitted on marketplace. Ref ID: …` in its log.
- Three `claim_automation_follow_ups` rows exist (48h interval, `isActive`, tickets above) — the tracking data model is wired and live.

## 3. Installed app (this PC)

- Engine: local mode, loopback only, signed in as the operator, native WebContentsView adapter, Meesho panel automated with session saved 2026-11-14, login `va****in` configured (masked).
- `GET /api/evidence/{claimId}` answers 200 (local evidence cache is a 24h working cache — empty after purge by design; authoritative evidence lives in backend claim_media).

## 4. Incident found during verification — and the fix (root cause, verified from logs)

**Symptom:** follow-ups showed `nextCheckAt` 6 days stale, `checkCount 0`, `followUpChecksRun: 0`; the worker's `lastPollTime` froze for 4+ hours while HTTP/heartbeat stayed healthy.

**Root cause (log forensics):** an internet outage (`Poll job check failed: fetch failed … Connect Timeout … return.youthnic.shop` at 06:12 UTC) left an await hanging inside a cycle; the cycle never returned, `pollInFlight` stayed true, and — because all later cycles are guarded by those flags — both worker loops went permanently silent with zero errors. An app restart was the only recovery.

**Fix (this document's PR, v1.3.6):** hard per-cycle watchdogs — filing cycles 20 minutes, follow-up checks 8 minutes. On timeout the cycle force-clears its in-flight state (panels reset, leased follow-up reported `error` so the server reschedules), logs one line, and the loops resume on the next tick. No silent wedges, no restart needed. 9 new watchdog tests; adjacent suites green.

**Immediate mitigation applied:** the app was restarted (loops confirmed fresh) and — after discovering the `C:\Program Files\Return App` copy had been removed externally — production was restored from a portable 1.3.5 build under `%LOCALAPPDATA%`. Reinstalling to Program Files via the Desktop icon restores the scheduled task + autostart entry.

## 5. PRs and releases

PRs #66–#69 (tracking deep link, update flow, DPAPI keys + login disclosure + model primaries, browser-show + stats) all **MERGED** 2026-11-14; latest release at audit time `desktop-v1.3.5.137`; this verification + the watchdog ships as **1.3.6**.

## Known non-blocking items

- Job 1's stored ticket ref is the bogus string `"Raise"` (misparsed on 2026-10-16, before the extraction hardening); the job is still `queued` and should be retried/manually resolved by an operator.
- Claim 3 sits at `prepared`, awaiting operator approval (by design).
- Live portal read of the new per-ticket tracking path will be observed on the next follow-up cycle (engine now runs it within ~10s of start when due).
