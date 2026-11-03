# Milestone 7 — Meesho E2E: execution plan (Phase 1 audit → build)

Base: `main` @ `bd2fe18` (PR #47 merged). Branch: `feature/meesho-claims-e2e-m7`.
Audit: 4-surface workflow 2026-11-03 (desktop automation, server pipeline, Android/Firebase, AI+memory).
Full evidence in session tool-outputs; key findings below.

## What is implemented (reuse, do not rebuild)

- Job queue with leases, 15-min expiry, uncertain-submit never auto-resubmits, `requireApprovalBeforeSubmit`
  (`server/claim-automation-service.ts`, `desktop-agent/src/marketplaces/meesho.ts` prepare/submit).
- Ticket novelty extraction, `completeJobSubmission` → claim `submitted` + register `Raised` + follow-up row.
- Evidence pipeline: multipart upload → server SHA-256/magic-byte/dedup → Firebase path
  `claim-evidence/<marketplace>/<order>/claim-<id>/<field>-<hash20><ext>` → `addClaimMedia` flips
  `pending_evidence` → `ready_for_claim` in-txn; deactivate reverses; manual `ready_for_claim` requires
  `evidenceComplete` (409 otherwise). `claims_receipt_scan_uidx` blocks duplicate claims at DB.
- `MEESHO_ISSUES` 5 codes + labels, description templates, draft mapping from scan categories,
  due date received+6d (TAT 7).
- AI Center (PR #47): `runRoutedAssist`, agent activity, usage ledger, pending→approved memory only.

## Gaps → fix (ordered)

1. **Evidence race (§4).** `createOrQueueAutomationJob` runs in `unified-create` before uploads; `pollNextAutomationJob`
   leases `queued` jobs regardless of claim status; desktop has no evidence gate.
   Fix: lease-select excludes `c.status = 'pending_evidence'` (covers old + new jobs, auto-eligible on flip,
   no migration, no new stage); desktop refuses submit with zero downloaded evidence.
2. **Forced Tampered (§5).** Android single-item spinner, server default, `MEESHO_PACKET_STATE` constant,
   desktop hardcode. Fix: `Intact|Tampered|Unknown` validated end-to-end (Android spinner, `createClaim`/
   `prepareMeeshoClaim` override, `meeshoClaimDescription` param); default `Unknown`; desktop treats
   `Unknown`/missing as `manual_intervention_required` (operator task, never auto-submit). Deadline logic
   unchanged (received+6d, no silent extension).
3. **Single-issue automation (§6).** Desktop clicks only "I have received wrong return"; silent fallback to
   wrong_return in `prepareMeeshoClaim`. Fix: code→portal-label map for all 5 `MEESHO_ISSUES` in desktop;
   unknown code → human review; silent fallback → 400. Bundle carries `packetState` + `marketplaceIssueCode`.
4. **Submit not fail-closed (§8).** Warn-only navigation failures, optional evidence, novelty-only ticket proof,
   `stage 'failed'` never emitted. Fix: navigation failures → `manual_intervention_required`; evidence-empty
   → same; portal `formErrors` block success; crash path emits `failed` via existing progress route.
5. **`checkClaimStatus` (§10).** Base returns `supported:false`; Meesho follow-ups dead-end. Fix: implement My
   Tickets reader (authenticated ticket page, ticket-ID row match, status/rejection/evidence-request fields);
   fixture-tested; live run operator-gated. Follow-up loop + `runFollowUpAssist` then engage automatically.
6. **Small Firebase/capture items (§7):** align multer limit with template max (25MB), remove unreachable
   `local://` fallback branch, keep server-side magic-byte/SHA as authoritative. No public links, no service
   credentials in installer (already true; add regression test on bundle/API shape).
7. **Credentials (§2):** metadata-only inspection via existing authed routes (no plaintext anywhere); secure
   in-app setup form already exists? verify — else add. Live usability = operator login.
8. **Live discovery (§3) + live tests (§11 real):** operator-gated (needs Meesho login + explicit approval).
   Deliverable: versioned portal map `docs/notes/meesho-portal-map-v1.md` (code-derived, marked unverified),
   read-only discovery procedure, fixture-tested reader. No submissions without authorization.

## Test plan (§11)

- Server (mocked `pg` fake-pool, repo pattern): gate SQL excludes pending_evidence; ready flip leases;
  packet validation/defaults; unknown issue 400; template-limit alignment. DB-gated tests follow
  `register-db.test.ts` pattern (skip without `TEST_DATABASE_URL`).
- Desktop (existing engine/fake-browser patterns): issue-label map, Unknown-packet refusal, evidence-empty
  refusal, My-Tickets fixture parse, no-leak (keys never in logs/usage).
- Android: changed files compile via existing CI; version bump per APK release rules if UI changes ship.
- Real vs mocked documented separately; live runs only with operator approval.

## Acceptance honesty

Operator-gated (mark unverified without them): live Meesho login, portal discovery, real submissions,
real ticket IDs, `checkClaimStatus` against live panel, payment reconciliation against live data,
packaged-installer run, CPU/RAM. Everything else verified in CI + local runs.
