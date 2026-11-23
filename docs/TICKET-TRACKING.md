# Ticket Tracking Architecture & Operations Guide

This document describes the ticket tracking and follow-up architecture across the PostgreSQL backend, the desktop automation engine, and the bundled Electron desktop renderer in Return App.

---

## 1. Executive Summary & Live Database Audit

As of **2026-11-23**, Return App tracks **142 total claims** recorded in the live production database (`return-scan_youthnic`):

| Metric | Count | Value (₹) | Key Details |
|---|---|---|---|
| **Total Claims** | 142 | ₹98,400+ | All claims recorded in database |
| **Submitted with Live Tickets** | **115** | **₹77,213.00** | Filed across 4 supplier accounts, actively monitored |
| — Meesho (`VB Exports` / `Ethnic Junction`) | 77 | ₹49,926.00 | 9–15 digit tickets tracked via `/support/ticket/{id}` |
| — Flipkart (`VB Exports`) | 30 | ₹19,231.00 | SPF Incident IDs tracked |
| — Myntra (`VB EXPORT PPMP`) | 6 | ₹6,677.00 | SPF tickets tracked |
| — Myntra (`ETHNIC JUNCTION`) | 2 | ₹1,379.00 | SPF tickets tracked |
| **Ready for Claim** | 17 | — | Scanned and staged for filing |
| **Waiting for Approval / Review** | 6 | — | Under manual or portal review |
| **Approved & Paid Settlements** | **2** | **₹876.57** | Full settlement confirmed with payout amounts |
| **Permanently Rejected in DB** | 0 | ₹0.00 | Zero unhandled rejections |
| **Manual Action Required / Failed** | 2 | — | Edge cases flagged for operator intervention |

### Verified Approved Claims & Payout Details
1. **Ticket `794219443852`**:
   - Sub-Order ID: `342207442614944832_1`
   - AWB: `R2744240422FPL`
   - Account: Meesho (Ethnic Junction)
   - Status: `approved` (Stop reason: `ticket_resolved`)
   - Settled Payout: **₹618.24**
2. **Ticket `794219052322`**:
   - Sub-Order ID: `344400518893652096_1`
   - AWB: `R2752538828MEO`
   - Account: Meesho (VB Exports)
   - Status: `approved` (Stop reason: `ticket_resolved`)
   - Settled Payout: **₹258.33**

---

## 2. Core Architecture & Data Lifecycle

```
[Bench Scan / Return Register]
              │
              ▼
    [Unified Claim Creation]
  (POST /api/claims/unified-create)
              │
              ▼
   [Automation Engine Loop]
 (desktop-agent/src/desktop-app-server.ts)
              │
              ├─────────────────────────────────────────┐
              ▼                                         ▼
     [Claim Filing Cycle]                   [Ticket Follow-up Loop]
    (meesho.ts / flipkart.ts)             (checkClaimStatus every 48h)
              │                                         │
              ▼                                         ▼
    [Submit to Marketplace]                   [Deep-link inspection]
 (Creates claim_automation_follow_ups)    (meesho.ts:1040 /support/ticket/{id})
              │                                         │
              └────────────────────┬────────────────────┘
                                   │
                                   ▼
                       [Classification Engine]
                     (meesho-scenarios.ts)
                                   │
      ┌────────────────────────────┼────────────────────────────┐
      ▼                            ▼                            ▼
[Action Required]           [Under Review]              [Terminal Status]
(Proof demanded,            (Next check in 48h,         (Approved ₹ / Rejected)
24-48h deadline)            wait for decision)          (is_active = false)
```

### 2.1 The Two Engine Loops
1. **Filing Loop**: Leases claims in `ready_for_claim` status, launches the browser with persistent supplier profiles, populates the form, attaches photo/video evidence, and captures the official portal ticket ID.
2. **Follow-Up Loop**: Leases active rows from `claim_automation_follow_ups` that are due for checking (`next_check_at <= NOW()`). Re-opens the supplier portal using saved session cookies, inspects ticket status, updates audit records, and triggers desktop OS notifications.

*Rule 14 Enforcement*: The two loops never run concurrently; `poll-guard.ts` ensures only one task operates the supplier browser at a time.

---

## 3. Database Schema

The ticket tracking system spans four synchronized tables in PostgreSQL:

### 3.1 `claims`
The master record of the dispute:
- `id`: Primary key.
- `receipt_scan_id`: Foreign key to `receipt_scans`.
- `marketplace`: `meesho`, `flipkart`, `myntra`, etc.
- `account_name`: Seller account (`VB Exports`, `Ethnic Junction`).
- `sub_order_id_snapshot`: 18-digit sub-order ID (essential for Meesho).
- `awb_snapshot`: Courier return tracking number.
- `claim_amount`: Original requested claim amount.
- `approved_amount`: Actual settlement payout confirmed by marketplace.
- `claim_status`: `ready_for_claim`, `submitted`, `approved`, `rejected`, `manual_action_required`.

### 3.2 `claim_automation_follow_ups`
The automation scheduler table for status checks:
- `claim_id`: Foreign key to `claims`.
- `marketplace_claim_id`: Marketplace ticket or incident ID.
- `status_at_last_check`: Full raw text or summary returned by portal.
- `last_checked_at`: Timestamp of previous automated check.
- `next_check_at`: Scheduled timestamp for subsequent check (default +48h).
- `check_count`: Number of automated checks performed.
- `is_active`: Boolean (`true` while open, `false` once resolved or halted).
- `stop_reason`:
  - `ticket_resolved`: Ticket approved, rejected, or paid.
  - `check_not_supported`: Marketplace lacks automated ticket reader.
  - `repeated_errors`: Failed 3+ consecutive checks.
  - `max_checks_reached`: Exceeded safety inspection limit.

### 3.3 `claim_tickets`
Direct association between return scans and ticket identifiers.

### 3.4 `claim_automation_jobs`
Execution and audit history of every automated interaction with timestamps, attempt counts, and structured logs.

---

## 4. Desktop Application Integration (`FollowUps.tsx`)

The bundled desktop renderer provides operators with full visibility into all 115+ tickets:

### 4.1 Real-Time StatCards
- **Total Tracked**: Total number of followed-up tickets in the database.
- **Active Tracking**: Tickets currently under automatic 48-hour monitoring.
- **Action Required**: Highlighted count of tickets where the portal requires seller response, clear unboxing videos, or proof within 24–48 hours.
- **Approved / Resolved**: Completed tickets, displaying cumulative settled payout (₹876.57).

### 4.2 Filtering & Search (`filterFollowUps`)
- **Instant Search**: Matches across Ticket ID, Sub-Order ID, AWB, Order Number, Account Name, and last check message.
- **Status Tabs**:
  - `All`: View every recorded ticket.
  - `Action Required`: Filter for tickets demanding immediate operator response.
  - `Active`: Show tickets actively awaiting portal decisions.
  - `Resolved`: Show tickets with completed resolutions (approved or rejected).
- **Portal Filter Pills**: Filter by `Meesho`, `Flipkart`, `Myntra`, or `All`.

### 4.3 1-Click Ticket ID Copy
Every Ticket ID features a dedicated clipboard copy button with visual checkmark feedback, allowing instant pasting into portal support pages.

### 4.4 Order Context Display
Displays the marketplace badge, account name, order number, 18-digit Meesho sub-order ID, AWB, and approved settlement amount badges (`+₹<amount>`).

---

## 5. Machine Learning Scenario & Response Detection

The system employs `desktop-agent/src/marketplaces/meesho-scenarios.ts` to categorize ticket responses into 10 deterministic scenarios:

| Scenario Code | Classification | Action Taken |
|---|---|---|
| `APPROVED_FULL` | Approved for full claimed amount | Set `approved`, record payout, mark `ticket_resolved` |
| `APPROVED_PARTIAL` | Approved for partial amount | Set `approved`, record partial payout, mark `ticket_resolved` |
| `REJECTED_FINAL` | Explicit rejection by portal team | Set `rejected`, record reason, mark `ticket_resolved` |
| `PROOF_REQUIRED` | Portal asks for unboxing video / label photo | Flag `isResponseNeeded = true`, trigger OS notification |
| `INVESTIGATION_PENDING` | Portal courier investigation in progress | Keep active, schedule next check in 48 hours |
| `APPEAL_WINDOW` | Rejected with option to re-open | Mark `manual_action_required` for operator review |

---

## 6. Verification and Invariants

1. **Rule 1 (Account Scope)**: Follow-ups always filter by the authenticated user's assigned accounts.
2. **Rule 8 (No Secrets)**: Zero credentials, tokens, or environment variables are stored in tickets or follow-up logs.
3. **Rule 13 (Hardware Limits)**: Follow-up checks run under the 256MB V8 heap limit with headless Chromium processes terminated cleanly.
4. **Rule 14 (One Engine, Shared Leases)**: Filing and follow-ups never conflict over browser resources.
