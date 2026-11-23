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


---

## 7. Master Directory: 104 Meesho Claims, Orders & Ticket Tracking

Below is the verified record of all **104 Meesho claims** in the production database (`return-scan_youthnic`):

- **Submitted with Active 12-digit Meesho Tickets**: 77 claims (Total claimed: ₹49,926.00)
- **Approved Settlements with Payouts**: 2 claims (Total paid: ₹876.57: Ticket `794219443852` for ₹618.24 and Ticket `794219052322` for ₹258.33)
- **Ready for Claim (Queued for Filing)**: 17 claims
- **Waiting for Approval (Staged)**: 6 claims
- **Manual Intervention Required / Failed**: 2 claims (Claim #6 parcel condition unverified, Claim #7 viz error)

## 4. Complete Master Table of All 104 Meesho Claims

| # | Claim ID | Status | Sub-Order ID | Courier AWB | Ticket ID | Claim (₹) | Approved (₹) | Issue Description | Follow-Up State |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | `waiting_for_approval` | `338243988689977984_1` | `VLR083002308587` | `Raise` | — | — | I have received wrong return | Not scheduled |
| 2 | 2 | `approved` | `342207442614944832_1` | `R2744240422FPL` | `794219443852` | — | ₹618.24 | I have received wrong return | Active (checks: 2) |
| 3 | 3 | `waiting_for_approval` | `341378275264922945_1` | `SF4281497425FPL` | `CLM-3` | — | — | I have received wrong return | Not scheduled |
| 4 | 4 | `approved` | `344400518893652096_1` | `R2752538828MEO` | `794219052322` | — | ₹258.33 | I have received wrong return | Active (checks: 2) |
| 5 | 5 | `submitted` | `342536019516041216_1` | `R2725108455MEO` | `794219857178` | — | — | I have received wrong return | Active (checks: 2) |
| 6 | 6 | `manual_action_required` | `346205788091303808_1` | `23409621696321` | `CLM-6` | — | — | I have received wrong return | Not scheduled |
| 7 | 7 | `failed` | `346825030177981952_1` | `VLR083122856598` | `CLM-7` | — | — | Item/s are missing in my return | Not scheduled |
| 8 | 8 | `waiting_for_approval` | `339305921300071936_1` | `23409621449451` | `CLM-8` | — | — | I have received wrong return | Not scheduled |
| 9 | 9 | `waiting_for_approval` | `345419105479230976_1` | `VL0085889895501` | `CLM-9` | — | — | I have received wrong return | Not scheduled |
| 10 | 10 | `ready_for_claim` | `345578205020538752_1` | `VLR083133380904` | `CLM-10` | — | — | I have received wrong return | Not scheduled |
| 11 | 11 | `ready_for_claim` | `344462252966791296_1` | `VLR083116025067` | `CLM-11` | — | — | I have received wrong return | Not scheduled |
| 12 | 12 | `waiting_for_approval` | `346279925340678144_1` | `VLR083129423388` | `CLM-12` | — | — | I have received wrong return | Not scheduled |
| 13 | 13 | `waiting_for_approval` | `348336572878882304_1` | `R2801381467MEO` | `CLM-13` | — | — | I have received wrong return | Not scheduled |
| 14 | 14 | `ready_for_claim` | `348025472539771904_1` | `SF4409544400FPL` | `CLM-14` | — | — | I have received wrong return | Not scheduled |
| 15 | 15 | `ready_for_claim` | `346624014892221440_1` | `SF4377648922FPL` | `CLM-15` | — | — | I have received wrong return | Not scheduled |
| 16 | 16 | `ready_for_claim` | `347993691180091266_1` | `R2796212939MEO` | `CLM-16` | — | — | I have received wrong return | Not scheduled |
| 17 | 17 | `ready_for_claim` | `349861320543027328_1` | `23409631984005` | `CLM-17` | — | — | I have received wrong return | Not scheduled |
| 18 | 18 | `ready_for_claim` | `348128187652179008_1` | `R2801386208MEO` | `CLM-18` | — | — | I have received wrong return | Not scheduled |
| 19 | 19 | `ready_for_claim` | `341240322829587264_1` | `R2757859007MEO` | `CLM-19` | — | — | I have received wrong return | Not scheduled |
| 20 | 20 | `ready_for_claim` | `346278934651717504_1` | `R2770733817MEO` | `CLM-20` | — | — | I have received wrong return | Not scheduled |
| 21 | 21 | `ready_for_claim` | `346223100293655746_1` | `R2784926755FPL` | `CLM-21` | — | — | I have received wrong return | Not scheduled |
| 22 | 22 | `ready_for_claim` | `342681254227436672_1` | `R2742242672MEO` | `CLM-22` | — | — | I have received wrong return | Not scheduled |
| 23 | 23 | `ready_for_claim` | `348894709668227778_1` | `23409630097804` | `CLM-23` | — | — | Item/s are missing in my return | Not scheduled |
| 24 | 24 | `ready_for_claim` | `348722791360299651_1` | `23409624913288` | `CLM-24` | — | — | Item/s are missing in my return | Not scheduled |
| 25 | 25 | `ready_for_claim` | `345847242806503426_1` | `R2775598956MEO` | `CLM-25` | — | — | I have received wrong return | Not scheduled |
| 26 | 26 | `ready_for_claim` | `350304142172816448_1` | `R2814037736FPL` | `CLM-26` | — | — | Item/s are missing in my return | Not scheduled |
| 27 | 27 | `ready_for_claim` | `347934255940742336_1` | `R2788588708MEO` | `CLM-27` | — | — | I have received wrong return | Not scheduled |
| 28 | 28 | `ready_for_claim` | `349624609664860736_1` | `R2823086323FPL` | `CLM-28` | — | — | I have received wrong return | Not scheduled |
| 29 | 30 | `submitted` | `334648577696643011_1` | `R2605720112FPL` | `791956917478` | ₹800.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 30 | 42 | `submitted` | `335402404003624896_1` | `R2618857951MEO` | `792240795838` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 31 | 44 | `submitted` | `332230445402695042_1` | `R2580449109FPL` | `792241728583` | ₹1200.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 32 | 49 | `submitted` | `335416420152467072_1` | `R2633913412MEO` | `792243513500` | ₹576.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 33 | 51 | `submitted` | `338806412908365639_1` | `R2628178909FPL` | `792247087736` | ₹1699.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 34 | 52 | `submitted` | `336029483686608000_1` | `R2647287014FPL` | `792248014703` | ₹346.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 35 | 56 | `submitted` | `337528072738842752_1` | `R2647530865FPL` | `792502707362` | ₹400.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 36 | 57 | `submitted` | `338435954446894407_1` | `R2651232665FPL` | `792503552994` | ₹1699.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 37 | 60 | `submitted` | `338542577035183941_1` | `VLR083012180822` | `792504387597` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 38 | 61 | `submitted` | `338438144523699522_2` | `R2620760672FPL` | `792591648391` | ₹1200.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 39 | 62 | `submitted` | `338655096926029760_1` | `R2647755843MEO` | `792676251208` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 40 | 63 | `submitted` | `336548120890902337_1` | `R2626791912MEO` | `792676273888` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 41 | 64 | `submitted` | `341503948226793153_1` | `1490711917569881` | `792676322824` | ₹499.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 42 | 65 | `submitted` | `337823771644069440_1` | `23409625344741` | `792676377497` | ₹400.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 43 | 66 | `submitted` | `336445805203039488_1` | `R2650974544FPL` | `792676419752` | ₹600.00 | — | Meesho - Damaged Return | Active (checks: 0) |
| 44 | 67 | `submitted` | `338330503349414016_1` | `2340962077798` | `792676444173` | ₹1200.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 45 | 68 | `submitted` | `339470266868106368_1` | `VLR083026829190` | `792676465576` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 46 | 69 | `submitted` | `338323352299439936_1` | `VLR083008877085` | `792676551699` | ₹490.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 47 | 70 | `submitted` | `340498064818750720_1` | `1490711910016435` | `792676594253` | ₹350.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 48 | 71 | `submitted` | `340059470425326080_1` | `VLR083029170675` | `792677162434` | ₹820.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 49 | 72 | `submitted` | `332953264240886976_1` | `R2606341957MEO` | `792677189884` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 50 | 73 | `submitted` | `338222820440343168_1` | `R2637804924MEO` | `792677212608` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 51 | 74 | `submitted` | `337143732424329152_1` | `R2637827880MEO` | `792677236618` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 52 | 75 | `submitted` | `337984029435823936_1` | `R2661308351MEO` | `792677262276` | ₹576.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 53 | 76 | `submitted` | `334019587972376064_1` | `R2596957729MEO` | `792677299231` | ₹576.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 54 | 77 | `submitted` | `338510636412498944_1` | `1490711894942731` | `792678066670` | ₹820.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 55 | 78 | `submitted` | `338197688107861824_1` | `23409619437678` | `792678208357` | ₹1056.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 56 | 79 | `submitted` | `339268717706151808_1` | `VLR083025817716` | `792678962230` | ₹400.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 57 | 81 | `submitted` | `339847812507136768_1` | `R2694312168FPL` | `793455533595` | ₹820.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 58 | 82 | `submitted` | `343321345669031875_1` | `VLR083082728754` | `793455555960` | ₹820.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 59 | 84 | `submitted` | `343369160399750464_1` | `1490711951631575` | `793455582007` | ₹576.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 60 | 85 | `submitted` | `341994331866694912_1` | `VLR083070903326` | `793455607876` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 61 | 86 | `submitted` | `342897031399721088_1` | `R2742228164MEO` | `793455672802` | ₹800.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 62 | 87 | `submitted` | `344193142757756608_1` | `1490711965574326` | `793542870550` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 63 | 91 | `submitted` | `342646095699888256_1` | `VLR083076757678` | `793457348901` | ₹399.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 64 | 92 | `submitted` | `340381877620707968_1` | `R2708273850MEO` | `793457381600` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 65 | 94 | `submitted` | `342534776221689795_1` | `R2703122194MEO` | `793457406244` | ₹800.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 66 | 95 | `submitted` | `341821143751567360_1` | `R2730231838FPL` | `793458118706` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 67 | 96 | `submitted` | `342713084246845376_1` | `R2733973092MEO` | `793458154509` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 68 | 97 | `submitted` | `339961375815123906_1` | `VLR083076343073` | `793458254227` | ₹300.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 69 | 98 | `submitted` | `340445759683626112_1` | `R2700475192MEO` | `793459067974` | ₹600.00 | — | Meesho - Item Missing | Active (checks: 0) |
| 70 | 100 | `submitted` | `342607706188244928_1` | `R2733974210MEO` | `793459129132` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 71 | 101 | `submitted` | `340011122357633792_1` | `R2709515090FPL` | `793459935868` | ₹375.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 72 | 104 | `submitted` | `342517570175853699_1` | `VLR083074253028` | `793714984432` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 73 | 105 | `submitted` | `341791517251708929_1` | `R2722781849MEO` | `793798679073` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 74 | 106 | `submitted` | `344161826326013056_1` | `VLR083090873534` | `793798751990` | ₹820.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 75 | 107 | `submitted` | `341173008268965892_1` | `R2717680373MEO` | `793799372647` | ₹820.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 76 | 108 | `submitted` | `340892774209099264_1` | `R2708283149MEO` | `793886177511` | ₹820.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 77 | 109 | `submitted` | `344071558157763648_1` | `R2752486415MEO` | `793800116064` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 78 | 112 | `submitted` | `342303057841316992_1` | `R2725130036MEO` | `793800158397` | ₹576.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 79 | 113 | `submitted` | `343573411903547408_1` | `R2756147450FPL` | `793974391977` | ₹820.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 80 | 114 | `submitted` | `343016512516114560_1` | `VLR083089900582` | `793800368056` | ₹400.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 81 | 115 | `submitted` | `343287249433617536_1` | `R2725887420FPL` | `793801224122` | ₹540.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 82 | 117 | `submitted` | `346007750472959488_1` | `VLR083107283080` | `793801262509` | ₹520.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 83 | 118 | `submitted` | `345117527188071104_1` | `1490711905510572` | `793801313000` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 84 | 119 | `submitted` | `341925821109741568_1` | `R2722858155MEO` | `793801489723` | ₹576.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 85 | 120 | `submitted` | `345444577856521731_1` | `R2757831389MEO` | `793801664689` | ₹600.00 | — | Myntra - Wrong Returns - Received own product | Active (checks: 0) |
| 86 | 121 | `submitted` | `340368790947589312_1` | `R2769433497FPL` | `793802130849` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 87 | 122 | `submitted` | `340849206899704960_1` | `R2717620823MEO` | `793802170573` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 88 | 123 | `submitted` | `342856671366972740_1` | `VLR083069061493` | `793802201555` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 89 | 124 | `submitted` | `343621928386799616_1` | `R2747073328MEO` | `793802269882` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 90 | 125 | `submitted` | `344384249837103107_1` | `VLR083091623830` | `793802293399` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 91 | 126 | `submitted` | `339484246744502784_1` | `R2725082582MEO` | `793802388968` | ₹600.00 | — | Meesho - Item Missing | Active (checks: 0) |
| 92 | 127 | `submitted` | `342645398268249408_1` | `R2725070645MEO` | `793802413855` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 93 | 128 | `submitted` | `341845935945647424_1` | `R2742292122MEO` | `793802448807` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 94 | 129 | `submitted` | `344215398581364675_1` | `R2752521681MEO` | `793802541953` | ₹500.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 95 | 130 | `submitted` | `343276652570698880_1` | `23409627727458` | `793802602797` | ₹312.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 96 | 131 | `submitted` | `340194189347102982_1` | `R2742289078MEO` | `793802667934` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 97 | 132 | `submitted` | `343029988039681984_1` | `R2747116755MEO` | `793803048465` | ₹576.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 98 | 137 | `submitted` | `346543031875208256_1` | `VLR083163816673` | `795423648969` | ₹900.00 | — | Meesho - Used Product | Active (checks: 0) |
| 99 | 138 | `submitted` | `349514909221747136_1` | `1490711896984421` | `795423669744` | ₹420.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 100 | 139 | `submitted` | `345546117388764672_1` | `R2761581080MEO` | `795423705963` | ₹729.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 101 | 140 | `submitted` | `344500280695310208_1` | `R2761583665MEO` | `795423734625` | ₹600.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 102 | 141 | `submitted` | `345261209816073280_1` | `R2742290302MEO` | `795423766920` | ₹800.00 | — | Meesho - Wrong Return Received | Active (checks: 0) |
| 103 | 142 | `submitted` | `349860079821718400_1` | `VLR083162165467` | `795423790142` | ₹600.00 | — | Bottem Missing Received | Active (checks: 0) |
| 104 | 143 | `submitted` | `347306544817587200_1` | `VLR083164044334` | `795423837711` | ₹600.00 | — | Bottem Missing Received | Active (checks: 0) |

