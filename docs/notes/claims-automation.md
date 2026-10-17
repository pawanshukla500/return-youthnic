# Desktop Claim Automation & Bot Credentials Architecture

## Overview

The claim bot runs inside the Windows desktop app (`npm run desktop`). After sign-in it polls queued return claims from `https://return.youthnic.shop`, opens the supplier panel through Chrome DevTools Protocol, files the claim, and cleans local evidence files. The scan screen stays on the website and the phone.

## Key System Features

### 1. Persistent Browser Profile & Cookie Storage
- **Profile Directory**: Saved locally on the machine at `~/.taskflow-claim-agent/browser-profiles/profile-[marketplace]` (e.g. `profile-meesho`).
- **One-Time Login**: Session cookies, local storage tokens, and browser state persist across agent restarts and reboots.
- **Auto-Detection**: When the agent navigates to a supplier panel (e.g., `supplier.meesho.com`), it inspects whether an active authenticated session exists. If already logged in, it skips the login form and proceeds directly to Support.

### 2. Human-Like Keystroke & Delay Simulation
- **Timing Invariant**: Strict 1-second (`1,000ms`) delay between all actions, button clicks, field navigation, and form steps.
- **Realistic Keystrokes**: Credentials and form text are typed character-by-character with randomized intervals between 40ms and 90ms.
- **CDP Input Events**: Uses `Input.dispatchKeyEvent` (`keyDown` / `keyUp`) accompanied by native DOM value assignment and synthetic `input`/`change` event dispatching to guarantee compatibility with React / controlled input forms.

### 3. Admin UI Credential Management (`/admin` -> Marketplace accounts)
- **Location**: In the Admin panel under the **Marketplace accounts** tab.
- **Bot Status**: Each marketplace card displays live automation readiness:
  - `🤖 Bot: [usernameMasked] (assisted / fully_automated) · Session saved`
  - `🤖 Bot: Not configured`
- **Configuration Modal**: Clicking **⚙️ Bot Login** opens a secure modal to configure:
  - Portal Login URL (e.g. `https://supplier.meesho.com/panel/v3/new/root/login`)
  - Username / Phone Number / Email
  - Password (with Show/Hide eye toggle)
  - Automation Mode: `assisted` (prepares claim for 1-click review), `fully_automated` (submits directly), or `headless` (silent background execution)
  - Auto-prepare toggle
  - Require approval before final submit toggle
- **Security (Rule 8: No secrets)**: Stored in PostgreSQL table `marketplace_credentials` with AES-256-GCM encryption (`username_encrypted`, `password_encrypted`). Passwords are never sent to the client; usernames are masked (`maskSecret`).

### 4. Meesho Supplier Flow Automation
The automation engine (`desktop-agent/src/marketplaces/meesho.ts`) implements the exact Meesho flow:
1. **Landing & Login**:
   - Navigates to `https://supplier.meesho.com/panel/v3/new/root/login` (or `#loginbutton` on landing).
   - Checks if already logged in via persistent cookies; skips login if active session detected.
   - If not logged in, human-types `input[name="emailOrPhone"]` and `input[name="password"]`, waits 1s, clicks `button[type="submit"]`.
   - Handles 2FA/OTP or CAPTCHA by capturing screenshot and setting job to `manual_intervention_required` so the operator can complete verification in the open window.
2. **Support Section**:
   - Locates and clicks the "Support" navigation element (or navigates directly to `/support`).
   - Waits 1.5s.
3. **Issue Selection**:
   - Clicks "I have received wrong return" (or matching category for damaged/missing items).
   - Waits 1.5s.
4. **Raise Ticket**:
   - Clicks "Raise a Ticket" button (`button:has-text("Raise a Ticket")`).
   - Waits 1.5s.
5. **Fill Claim Form**:
   - Types Sub-Order ID into `subOrderId` input with human keystrokes.
   - Selects packet condition "Tampered".
   - Types flyer ID / barcode.
   - Attaches proof images (front, back, label) and unboxing video via CDP file input setting.
   - Types detailed claim description with order ID, AWB, SKU, and condition details.
6. **Submission & Verification**:
   - Captures prepared screenshot. If `action === "prepare"` and `requireApprovalBeforeSubmit`, pauses at `prepared`.
   - Before submitting, it reads the "Recently raised tickets" list and waits (up to 20s) for Submit to enable. If Submit stays disabled, the field errors are read: the packaging-policy "not eligible" becomes stage `not_eligible`; anything else becomes `manual_intervention_required` with the empty fields listed.
   - In `submit` mode, clicks Submit button and verifies success only when a **new 9-15 digit ticket number** appears that was not in the "Recently raised tickets" list before Submit (the AWB, sub-order and packet digits are excluded from matching).
   - Not eligible: the job ends as `not_eligible`, the browser is closed, the evidence cache is cleaned, and the server sets the claim to `manual_action_required` with the refusal text, clearing any stale `marketplace_claim_id` and `completed_at` from earlier runs. The bot moves straight to the next job.
   - Automatically cleans local downloaded evidence files from disk cache via `cleanClaimEvidenceFiles(claimId)`.
   - Shows in the claims portal as **Record Manual Claim** with the reason; the marketplace reference is shown only for `completed` jobs.

### 4b. Bot Log File
- The installed app has no console, so every message is appended to `~/.taskflow-claim-agent/logs/bot-YYYY-MM-DD.log` (async writes; files older than 7 days pruned daily). Secrets are never logged.

### 5. Low-Spec Hardware Optimization (4GB RAM & 2-Core CPU Workstations)
- **V8 Heap Discipline:** Embedded Electron and spawned CDP browsers apply `--max-old-space-size=256` and `--renderer-process-limit=2`.
- **Process-Tree Teardown (`taskkill /T /F`):** `BrowserRunner.close()` tracks the spawned Chrome/Edge process ID and invokes `taskkill /pid ... /T /F`. This ensures no orphaned or zombie browser processes consume CPU/RAM in the background after claims finish.
- **Low-Resource Chromium Flags:** Spawned browsers run with `--disable-dev-shm-usage`, `--disable-gpu`, `--no-sandbox`, `--disable-extensions`, `--disable-background-networking`, and `--metrics-recording-only`.
- **Direct Streaming Evidence Pipeline:** In `AgentClient.downloadEvidenceFiles`, chunks stream directly from HTTP to local disk (`ReadableStream.getReader()`), preventing 50MB+ unboxing videos from consuming memory heap.
- **Automated Disk Cache Pruning:** `pruneOldEvidenceFiles()` automatically purges temporary media files older than 24 hours upon agent initialization.
- **Adaptive Backoff Queue Polling:** When claims exist, polls every 5s; when idle, backs off gracefully (10s -> 20s -> 30s) keeping idle CPU utilization < 0.5%.

### 6. Native Desktop App & Enterprise NSIS Installer
- **Electron Application (`desktop/`):** Full Return App UI + 24/7 background claims worker bundled into a single native Windows application.
- **Persistent Session Partition:** `session.fromPartition("persist:return-app-desktop")` keeps login cookies and tokens alive indefinitely without re-authenticating.
- **Installation Target:** NSIS installer (`perMachine: true`) at `C:\Program Files\Return App\`. The warehouse terminal currently runs the standalone build from `npm run desktop:pack` copied to `C:\Return App\`, which starts with Windows.
- **Automated GitHub Releases:** `.github/workflows/desktop-release.yml` triggers on desktop code updates, builds `Return.App.Setup.1.0.0.exe`, and publishes directly to GitHub Releases (Release `desktop-v1.0.2`).

## Build & Run Commands

```bash
# Build & run native Electron desktop application
npm run desktop

# Bundle desktop main process for distribution
npm run desktop:build

# Build the running directory (dist-electron/win-unpacked) used for C:\Return App
npm run desktop:pack

# Package official enterprise Windows NSIS installer (C:\Program Files\Return App\)
npm run desktop:dist
```

The claim bot window's **Sign out** button asks for confirmation, because signing out pauses the 24/7 bot until the next sign-in. An expired operator token clears the saved session; a network error keeps it, so a short outage never stops the bot.
