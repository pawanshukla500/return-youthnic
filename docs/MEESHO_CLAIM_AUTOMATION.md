# Meesho Return Claim Capture & Desktop Automation Guide

This document explains the end-to-end architecture, field mappings, mobile capture flow, Firebase Storage integration, Return Register Ticket ID linkage, and Windows Desktop EXE Claim Automation Bot for Meesho returns.

---

## 1. Architecture Overview

```
                               ┌────────────────────────────────────────────────────────┐
                               │               Android Warehouse Scanner                │
                               │  - CameraX / Zebra Barcode Scanner                     │
                               │  - Claim Details Capture Activity                      │
                               │  - 720p HD MP4 Unboxing Video (<= 25MB)                │
                               │  - WorkManager Background Evidence Sync                │
                               └───────────────────────────┬────────────────────────────┘
                                                           │
                                                           │ POST /api/claims/unified-create
                                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       Express & PostgreSQL Backend                                     │
│  - Return Register: receipt_scans, receipt_scan_items, receipt_scan_issues                             │
│  - Claim Management: claims, claim_media, claim_status_history, claim_tickets                          │
│  - Automation Queue: claim_automation_jobs, claim_automation_agents, marketplace_credentials           │
│  - Ticket ID Sync: syncClaimTicketToRegister() links Ticket Code & Status directly to Register         │
└───────────────────────────┬────────────────────────────────────────────┬───────────────────────────────┘
                            │                                            │
                            ▼                                            ▼
┌───────────────────────────────────────┐            ┌───────────────────────────────────────────────────┐
│           Web App Register            │            │       Windows Desktop Claim Bot (Node SEA EXE)    │
│  - /register (Return Scan Register)   │            │  - TaskFlowClaimAgent.exe (Single Binary)         │
│  - Real-time Ticket ID & Status Badge │            │  - Chrome DevTools Protocol (CDP) / Puppeteer     │
│  - Approved 19-Column CSV/XLSX Export │            │  - Automates Meesho Supplier Portal Submissions   │
│  - /claims (Claims & Automation Hub)  │            │  - Extracts Meesho Claim Ticket ID -> Database    │
└───────────────────────────────────────┘            └───────────────────────────────────────────────────┘
```

---

## 2. Field Mappings & Pre-filling Rules

All identifiers are derived directly from the loaded marketplace return reports and physically scanned return data:

| Field Name on Meesho Panel | Return App Database Column | Description & Behavior |
| :--- | :--- | :--- |
| **Sub Order Number** | `expected_return_items.display_order_item_id` / `order_line_id` / `receipt_scan_items.order_item_id` | **Order Item ID**. Pre-filled automatically. Has quick copy button. |
| **AWB Number** | `expected_returns.tracking_id` / `receipt_scans.scanned_tracking` | **Tracking ID**. Pre-filled automatically. Has barcode scan fallback. |
| **State of the packet** | Locked to `'Tampered'` | Meesho claims must always select **Tampered**. Permanently selected. |
| **Packet ID** | `receipt_scans.flyer_id` | **Meesho Flyer ID**. Pre-filled if scanned during return. Manual edit & barcode scan allowed. If no flyer was scanned, defaults to `"NA"`. |
| **Product SKU Details** | `skus.code`, `product_master`, catalog thumbnail image | Removed Good / Bad counters (as opening a claim implies bad quantity by default). Displays catalog photo, SKU, Master SKU, and badge `Bad Qty: 1 (Issue Claim)`. |

---

## 3. Auto-Generated Description Template (Team Tullipprints)

When the issue is selected, the description is pre-filled automatically with the exact Tullipprints team format:

### For "I have received wrong return":
```text
Team,

Please Note This Sub Order ID <subOrderId> Has received Us the wrong please check attached all the prrof and video and and make sure we claim will be approved )

Sub Order ID: <subOrderId>
AWB Number: <awb>
State of the packet: Tampered
Packet ID: <packetId>

Regards,
Return Team Tullipprints
```

### For "Item/s are missing in my return":
```text
Team,

Please Note This Sub Order ID <subOrderId> has arrived with missing item/s: <subIssueLabel>. Please check attached proof and video and make sure our claim will be approved.

Sub Order ID: <subOrderId>
AWB Number: <awb>
State of the packet: Tampered
Packet ID: <packetId>
Claim Amount: Rs. <missingAmount>

Regards,
Return Team Tullipprints
```

---

## 4. Ticket ID Linkage with Return Register

### The Synchronizer: `syncClaimTicketToRegister()`
Located in [`server/claim-automation-service.ts`](file:///d:/Return%20APP%20-%20New/server/claim-automation-service.ts).

1. **On Mobile Claim Creation (`POST /api/claims/unified-create`)**:
   - Creates a pending claim ticket with initial code `CLM-<claimId>`.
   - Links `receipt_scan_issues.claim_ticket_id` to `claim_tickets.id`.
   - Marks the return scan in the Return Register with status `Draft`.
2. **On Desktop Automation Bot Submission (`completeJobSubmission`) / Manual Resolve**:
   - The desktop bot extracts the actual Meesho Support Ticket / Claim Reference ID (e.g., `M-10928374`).
   - Updates `claim_tickets.ticket_code = marketplaceClaimId` and `status = 'Raised'`.
   - Inserts audit entry in `claim_ticket_history`.
3. **Visibility**:
   - **Return Register Table (`/register`)**: Directly shows the Ticket ID chip and status (`Raised`, `Draft`, `Approved`, `Rejected`).
   - **Approved Export (19 Columns)**: Column 16 (`Ticket ID (Only If Return Received Issue)`) and Column 17 (`Ticket ID Status`) contain the ticket code and status.
   - **Operational Export**: Traceability columns reflect flyer ID, tracking validation, and ticket code.

---

## 5. Firebase Setup & Android SDK Integration

### 1. `google-services.json`
Placed at `android/app/google-services.json`:
- **Project Number:** `1055211807035`
- **Project ID:** `return-scan-app`
- **Firebase Database URL:** `https://return-scan-app-default-rtdb.europe-west1.firebasedatabase.app`
- **Storage Bucket:** `return-scan-app.firebasestorage.app`
- **Client App IDs:** `return.youthnic.app` and `shop.youthnic.returnscan`

### 2. Gradle Configuration
- **Root `android/build.gradle`**:
  ```groovy
  plugins {
      id 'com.android.application' version '8.7.3' apply false
      id 'org.jetbrains.kotlin.android' version '2.0.21' apply false
      id 'com.google.gms.google-services' version '4.4.2' apply false
  }
  ```
- **App `android/app/build.gradle`**:
  ```groovy
  plugins {
      id 'com.android.application'
      id 'org.jetbrains.kotlin.android'
      id 'com.google.gms.google-services'
  }
  dependencies {
      implementation platform("com.google.firebase:firebase-bom:33.5.1")
      implementation "com.google.firebase:firebase-analytics"
      implementation "com.google.firebase:firebase-storage"
  }
  ```

---

## 6. Windows Desktop EXE Claim Automation Bot

### Standalone Executable Build
The desktop bot is packaged into a self-contained Single Executable Application (SEA) using Node's official SEA framework and postject:
```bash
npm run build:agent
```
Output:
`desktop-agent/dist/TaskFlowClaimAgent.exe`

### Key Features of the Desktop Bot
1. **Agent Registration & Heartbeat**:
   - Connects to `https://return.youthnic.shop/api/automation/agent/register`.
   - Receives API Key and heartbeat interval.
   - Reports current task and online status.
2. **Automated Polling Queue**:
   - Continuously queries `/api/automation/agent/poll`.
   - When a Meesho claim job is queued or approved, claims the job (`stage = downloading_media` -> `submitting`).
3. **Browser Automation via Chrome DevTools Protocol (CDP)**:
   - Connects to an existing Chrome session or launches Chrome with a dedicated persistent user profile (`--user-data-dir`).
   - Keeps Meesho supplier login cookies alive across sessions so 2FA/OTP is only needed once.
4. **CAPTCHA & 2FA Handling**:
   - If Cloudflare / Arkose / OTP challenge is detected on Meesho panel:
     - Captures full-page screenshot.
     - Updates stage to `manual_intervention_required` with notification to warehouse supervisor.
     - Leaves browser open for human supervisor to solve challenge.
5. **Form Submission & Ticket Extraction**:
   - Types `subOrderId`, sets packet state to `Tampered`, fills `packetId`.
   - Attaches received product photos, reverse waybill photo, and 480p SD unpacking video.
   - Puts auto-generated description.
   - Clicks `Submit Claim`.
   - Captures confirmation screenshot and extracts Meesho Claim Ref ID.
   - Calls `/api/automation/agent/jobs/:id/complete` which triggers `syncClaimTicketToRegister()`.
6. **Local Disk Space Cleanup (`cleanClaimEvidenceFiles`)**:
   - Once the submission completes successfully (`stage === 'completed'`), the agent immediately invokes `cleanClaimEvidenceFiles(claimId)`.
   - Recursively deletes the temporary `claim-${claimId}` directory, removing downloaded photos and unboxing videos so the workstation disk never runs out of space.

---

## 7. Web Claims Portal & Evidence Review (`/claims`)

- **Overview & Analytics**:
  - Live aggregated merchandise values in Indian Rupees (`₹`) via `formatInr()`.
  - Status lifecycle breakdown: `Ready for Claim`, `Submitted`, `Processing`, `Waiting for Approval`, `Approved`, `Rejected`, and `Manual Action Required`.
  - Manual `↻ Refresh` button and auto-reload on tab activation.
- **View Details Modal**:
  - Eliminates horizontal scrollbars with responsive styling (`max-width: min(1080px, 95vw)` and `overflow-x: hidden`).
  - 1-click quick-copy pills with visual tooltip (`Copied!`) for Tracking ID, Order ID, and Description.
  - Automation status card showing bot host, stage, attempts, and error logs.
  - Visual Evidence Gallery displaying master catalog photo alongside received photos.
  - High-resolution click-to-zoom Lightbox modal with keyboard `ESC` and backdrop dismissal.
  - Embedded HTML5 `<video>` player streaming 480p unboxing videos directly via `GET /api/claims/:id/media/:mediaId`.

---

## 8. Mobile Capture & Reset Lifecycle (`ClaimCaptureActivity`)

- **Upload Progress Bar**: Visual determinate dialog tracking file-by-file upload (`Uploading evidence files (x of y)...`) with percentage progress. If network jitter occurs, background sync automatically hands off to Android `WorkManager`.
- **Instant Form Reset**: After submission, the operator is prompted with **"File Next Return (Start Again)"**, which calls `resetFormForNextClaim()` to clear all photo slots, video URI, inputs, and claim state back to zero, focusing the barcode input for the next return.

