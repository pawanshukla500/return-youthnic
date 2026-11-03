# Claim state machine (verified 2026-11-03 against code)

Source of truth: `CLAIM_STATUSES` + `CLAIM_TRANSITIONS` in `server/claims-service.ts`, CHECK constraint in `server/schema-claims.sql`. Stored in `claims.status`; every change writes `claim_status_history` plus `register_audit_log`.

## The 14 claim states

`pending_evidence`, `ready_for_claim`, `waiting_for_approval`, `processing`, `submitted`, `under_review`, `approved`, `rejected`, `reconciled`, `paid`, `reclaim`, `escalated`, `failed`, `manual_action_required`.

Happy path: `pending_evidence` → `ready_for_claim` (evidence gate: all required template media present) → `waiting_for_approval` → `processing` → `submitted` → `under_review` → `approved` → `reconciled` → `paid`. Recovery loops: `rejected` / `reclaim` / `escalated` / `failed` / `manual_action_required`. Transitions outside `CLAIM_TRANSITIONS` are rejected with 409. Payout fields (`approved_amount`, `paid_amount`, `payout_reference`) are guarded on `updateClaimStatus`; media add flips `pending` → ready, removal reverses it. (Note: the header comment in `claims-service.ts` still says "All transitions are allowed" — stale; the map enforces. Recorded as a finding, not silently fixed.)

## Ticket sync (`claim_tickets`)

Separate 5-state lifecycle: `Draft` → `Raised` → `Review` → `Approved` / `Rejected`, any-to-any, every move recorded in `claim_ticket_history`. Filing writes `Draft CLM-<id>`; a successful marketplace submit replaces it with the marketplace ticket id and `Raised`.

## Automation authorization (M9)

A saved supplier login never authorizes submit. The engine files only jobs leased as `submitting` via `pollNextAutomationJob` (`FOR UPDATE SKIP LOCKED`, claim allowlist `ready_for_claim`/`processing`/`reclaim`/`escalated`). `completeJobSubmission` verifies lease holder, lease liveness and the `submitting` stage atomically; replays of the same ticket id are idempotent. `manual-resolve` is a separate Supervisor/Admin override.

## Follow-ups

One `claim_automation_follow_ups` row per claim: 48-hour cadence aligned into the 01:00–02:00 IST nightly window, leased with `FOR UPDATE SKIP LOCKED`. Check outcomes: `status_read`, `not_supported`, `login_required`, `not_found`, `error`. Terminal: `approved`/`rejected`/`paid`/`reconciled`/`closed`/`resolved`. Stop rules: 3-error streak, 90-check budget, missing reader, expired sign-in stays active without spending a check. Only Meesho implements `checkClaimStatus()` (DOM reader, live verification pending); other panels stop honest with "not implemented".

## Known gaps (see handoff risks)

Payment reconciliation is one-way (no automatic `approved` → `reconciled` → `paid` matching); the SPF return-tracking path bypasses `createClaim` (no template/history/audit row); automation job `stage`, follow-up `stage` and return-tracking eligibility are free-text columns.
