# Milestone 8 — Windows performance, native UX, reliable Meesho execution: execution plan

Base: `main` @ `60ca081` (PR #48 merged). Branch: `feature/windows-claim-performance-m8`.
Audit: 4-surface workflow 2026-11-03 (engine/runtime, AI usage, status+eligibility, idempotency).
Full evidence in session tool-outputs; key findings below.

## What PR #48 changed (verified)

Evidence gate in lease select, selectable parcel condition end-to-end (Android spinner,
server normalize, bundle fields, desktop fail-fast), 5-code issue mapping + 400 on unknown,
fail-closed submit, Meesho `checkClaimStatus()` reader + contract update, portal map v1,
credential flow metadata-only. M7 items stay; do not rebuild.

## Confirmed issues → fixes (ordered)

1. **F1 complete idempotency (G1).** `completeJobSubmission` unconditional overwrite + no ticket
   uniqueness. Fix: stage precondition (`submitting` only) + ticket-uniqueness check + idempotent
   replay via client request id. Late/out-of-stage → 409/ignorable. Test: double-complete.
2. **F2 retry/approve guards (G2/G3).** `retryAutomationJob` / `approveJobForSubmission` touch any
   stage. Fix: stage filters — never completed/submitted/submitting except an explicit operator
   override. Test: retry/approve completed → rejected.
3. **F3 queue allowlist.** Negative exclusion leases submitted/approved/paid/reconciled/failed/
   manual_action_required. Fix: explicit eligible claim-status set (check retry path resets claim
   status first — read code before choosing the set). Test: gate SQL.
4. **F4 pre-submit revalidation.** Action fixed at poll; nothing re-fetched before Submit.
   Fix: desktop re-fetches job/claim state right before Submit click; abort on change. Keep
   existing approval routing unchanged. Test: fake-browser stale-job aborts.
5. **F5 status trust (item 4).** Desktop `resolv|completed → approved` hint + server trusts hint
   verbatim → Resolved can mark approved with no payment evidence. Fix: server re-normalizes raw
   text and only accepts agreeing hints; tighten desktop hint to server semantics
   (drop resolv/completed → approved). Resolved/Closed alone → unknown → no claim change.
   Test: Resolved-hint → no change; Closed-hint → no change.
6. **F6 ticket history (G5/G6).** Follow-up upsert + single register row silently replace; suffix
   masks collisions. Fix: preserve history rows on replace (read functions first for minimal
   append point); keep suffix only with history. Test: second ticket keeps history.
7. **F7 pre-submit existence check (G4).** No portal search before Submit. Fix: meesho.ts searches
   Support for existing sub-order ticket; found → manual_intervention_required (verify, don't
   resubmit). Test: fixture with existing ticket → skip.
8. **F8 AI usage (items 3, 7, 8).** Drops in requestAiProposal/runRoutedAssist/SDK bridge/Test
   Connection/reportUsage path; null→0 coercion; no dedup/reconciliation. Fix: return usage end
   to end, populate bridge fields, record both test modes, wire reportUsage with token/cost,
   idempotency keys, stop null→0 (use null = unknown). ADK eval: check @google/adk compat with
   Electron Node runtime; adopt only if compatible+beneficial, else document and retain Vercel SDK.
   Test: ledger asserts real tokens; dedup test.
9. **F9 main-thread relief (items 1, 6).** Sync fs in capture/screenshot/update download; AI await
   inside loops. Fix: async IO + streamed update download; evaluate utilityProcess (document why
   in-process loop stays: views must live in main process; move would need full IPC for every
   browser call). No Tauri migration, no .NET worker (document: no material gain for scheduling/
   media/crash recovery beyond current guards). Test: no-sync-IO assertion.
10. **F10 view bounds + workspace layout (items 2, 6; §3).** Resize-only relayout, no DPI/move/
    zoom handlers, fullscreen overlay. Fix: display-metrics-changed + move handlers; dashboard
    reserves a browser workspace rectangle via IPC (read main.ts + dashboard first); never cover
    nav/controls. Test: fixture bounds, IPC contract.
11. **Docs + §3 UI.** Maintainable components for new dashboard surface only; no production web
    app rewrite. Operator guide updates.

## Non-issues (do not touch)

Single engine/loops, in-process require, poll-guard, owned WebContentsView, lease single-flight,
uncertain-submit guard, createOrQueue dedup, 409 on /progress, per-run ticket novelty, unique
follow-ups, Poll-Now single-flight.

## Gates before PR

typecheck x3, build, full `npm test`, desktop esbuild bundle, clean-room NSIS (default
dist-electron locked by running app — do not touch), APK/lint via CI. Live: operator-gated,
mark unverified. Real-vs-mocked documented separately.


## Implementation record (2026-11-03, branch `feature/windows-claim-performance-m8`)

Server guards (all in `server/claim-automation-service.ts` unless noted):

- F1: `completeJobSubmission` takes the ticket once, widens the guard select
  (stage, prior ticket, claim status) and enforces: same-ticket replay on a
  completed job is idempotent (ROLLBACK, returns marketplace); a different ticket
  on a completed job, a `not_eligible` job, or a claim with a recorded outcome
  (`submitted`, `under_review`, `approved`, `rejected`, `reconciled`, `paid`) is 409.
  Cross-job checks stop a second job re-filing the claim with another ticket.
- F2: `retryAutomationJob` re-reads job+claim under lock first: 409 on `completed`/
  `submitting` jobs and on recorded claim outcomes; re-arms only operator-held
  claims (`manual_action_required`, `failed`, `rejected` → `ready_for_claim` with a
  status-history row). `approveJobForSubmission` 409s on finished/in-flight/ruled-out
  job stages and on claims outside the approvable set.
- F3: lease select uses an explicit allowlist
  `c.status IN ('ready_for_claim', 'processing', 'reclaim', 'escalated')` instead of
  the `<> 'pending_evidence'` exclusion. The M7 evidence-gate test was updated to pin
  the allowlist (spec-driven expectation change).
- F5: `recordFollowUpResult` (`server/claim-follow-up-service.ts`) treats server-side
  normalization as authoritative: a client `normalizedStatus` hint is accepted only
  when it equals the server normalization, so a bare Resolved/Closed row can never
  approve a claim or mark it paid. Desktop reader (`meesho.ts`) no longer maps
  `resolv|completed` → `approved`; its docstring already promised unambiguous hints only.
  `meesho-issues.test.ts` now pins Resolved/Completed → no hint.
- F6: `syncClaimTicketToRegister` history reason keeps both codes
  (`Ticket replaced OLD with NEW`); status-only updates keep a status-change reason.
- F4: `getJobExecutionBundle` now also returns the live `claimStatus`; the desktop run
  loop re-fetches the bundle immediately before `execute("submit")` and aborts to
  manual review when `isSafeToSubmitBundle` fails (job gone/finished/re-queued, or
  claim recorded/not fileable). New pure module `desktop-agent/src/submit-guard.ts`
  with `desktop-agent/submit-guard.test.ts`.
- F7: `findExistingTicketForOrder(rows, refs)` (pure, fixture-tested) matches support-table
  rows naming the sub-order/order/AWB/packet digit runs plus a distinct ticket ID;
  `execute()` checks it after the recent-ticket snapshot and stops with
  `manual_intervention_required` instead of re-filing. Order digit runs are excluded
  from ticket candidates so order numbers are never mistaken for tickets.

Desktop runtime:

- F10: supplier views are confined to a dashboard-owned workspace rect.
  `setBrowserWorkspaceRect`/`getBrowserWorkspaceRect`/`supplierViewBounds` in
  `native-browser-view.ts` (clamped into the window; null restores full-window);
  shell IPC `desktop:browser-rect` with shape validation in `desktop/main.ts`;
  `resize` + `move` + `display-metrics-changed` all re-layout; preload exposes
  `setBrowserWorkspaceRect`; the engine dashboard shows a `#browser-workspace`
  placeholder, keeps its controls visible, and reports the rect on show/hide/resize
  (no-ops outside Electron). Pinned by `supplier-view-manager.test.ts` workspace cases.
- F9: screenshots and portal-download setup use async fs (`captureScreenshot`,
  `savePortalDownload`, evidence dir create/clean/prune in `agent-client.ts`).
  Evidence downloads already stream chunk-by-chunk with size+hash checks and stay
  sequential by design (2-core/4GB target). `utilityProcess` evaluated and rejected:
  `WebContentsView`s must live in the main process, so moving the loop would split
  browser ownership across processes and re-create every browser call as IPC without
  removing main-thread work. No Tauri migration, no .NET worker: scheduler (poll-guard
  single loop), crash guards (crash-guard, 15-min watchdog task), and recovery paths
  already exist; a second runtime adds IPC/deployment surface with no material gain.

AI usage (F8) and ADK (Phase 7):

- Provider token counts now survive end to end: `TokenUsage` (input/output/cached/
  reasoning) on `AiGenerateResult`; `requestAiProposal` returns `{ text, usage }` and
  stashes `lastUsage` in the ledger; `runRoutedAssist` records real tokens and costs
  them with `estimateCost` instead of `null`s + `{}`; Test Connection records its probe
  usage and returns it to the UI; the SDK bridge passes through reasoning/cached tokens
  (`ai@5.0.285` `LanguageModelV2Usage`: `reasoningTokens`, `cachedInputTokens`).
- ADK evaluated 2026-11-03: `@google/adk@2.4.0` (~10 MB tarball) pulls A2A/MCP/OTel/winston
  plus peer surface (5 Mikro-ORM dialects, google-cloud exporters); it is a DB-backed
  multi-agent service framework, mismatched to single-shot advisory drafts on a 256 MB
  heap / 4 GB target. Retained: Vercel AI SDK Core (`ai@5.0.285` + `@ai-sdk/*`), already
  bundled and proven by the packaged-app SDK-path test. No provider duplication added.

Tests (all passing at last full run): `server/tests/claim-idempotency-m8.test.ts` (10),
`desktop-agent/submit-guard.test.ts` (4), `meesho-issues.test.ts` F7 matcher cases,
`supplier-view-manager.test.ts` workspace cases, updated evidence-gate allowlist test,
AI usage preservation test in `ai-assistant.test.ts`.

Still operator-gated / not run: live Meesho discovery and filing, low-spec packaged-app
performance measurements, installed-app smoke test. Clean-room NSIS + full suite re-run
before commit/PR.
