# Claim Queue Semantics — Mobile → Firebase → Desktop (verified 2026-11-14)

How a claim captured on the warehouse phone reaches the desktop bot, and why **nothing is lost when the desktop PC is off**. Every step below was verified against the code on main (`5ed02b6`).

## The chain

1. **Capture on mobile (Android):** photo / unboxing video evidence is captured in the app and uploaded to **Firebase Storage**; the claim itself is created server-side (`POST /api/claims/unified-create` → `claims` row + an initial `claim_automation_jobs` row in stage `queued`, `server/claim-automation-service.ts:467`).
2. **Evidence registration:** each uploaded file is registered with `POST` → `addClaimMedia` (`server/claims-service.ts:1194`), storing the Firebase `storage_object_path`, hash, size, MIME.
3. **Evidence gate:** while required evidence is incomplete the claim stays `pending_evidence`. The lease query (`pollNextAutomationJob`, `server/claim-automation-service.ts:584-606`) only leases jobs whose claim status is `ready_for_claim | processing | reclaim | escalated` — `pending_evidence`, `waiting_for_approval`, and recorded outcomes **never lease**. The job row simply waits in PostgreSQL.
4. **Ready flip:** when the last required file lands, `addClaimMedia` runs `evidenceReadiness` and flips the claim `pending_evidence → ready_for_claim` with a history entry "All required evidence uploaded" (`server/claims-service.ts:1245-1252`). No human step, no desktop needed.
5. **Desktop offline:** nothing is required of the desktop. Jobs are FIFO by `created_at ASC`; the queue lives in the database, not in any process.
6. **Desktop back online:** on app start the engine resumes the saved operator session (`resumeClaimBotIfSignedIn`) — this is the "all logins done" gate the operator described: the 24/7 worker starts only after the signed-in session validates. The worker then polls, leases the oldest eligible job (`FOR UPDATE SKIP LOCKED` — safe against multiple agents), downloads evidence from the backend to the local cache (sha256 + size verified), and files the claim.
7. **Result write-back:** ticket ID, screenshots, progress, and completion post to the server with agent-key auth; the claim becomes `submitted`, a follow-up row is created, and the register is synced (see `completeJobSubmission`).

## Operator-visible consequences

- A phone can file claims at midnight with the warehouse PC **off**; they process themselves at the next poll after the PC signs in. Verified live: the worker resumed at 07:36 and immediately leased a queued claim.
- Uploading evidence late never loses a claim — the job stays queued until the evidence gate flips it eligible.
- A claim missing mandatory evidence never gets half-filed on the portal: the desktop additionally refuses to submit with zero downloaded evidence, and any upload-box verification failure stops for the operator instead of pretending success.
- Pause/stop: pausing the worker leaves queued jobs untouched; they resume on the next poll after start.

## Rebuild this graph after code changes

`graphify update .` (code-only, no API cost) — see AGENTS.md § Code knowledge graph.
