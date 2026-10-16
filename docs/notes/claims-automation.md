# Desktop Claim Automation & Bot Credentials Architecture

## Overview

The Desktop Claim Automation Agent (`desktop-agent/` -> `desktop-agent/dist/TaskFlowClaimAgent.exe`) is an autonomous Windows worker designed to run continuously on warehouse PCs. It polls queued return claims from the Return App backend (`https://return.youthnic.shop` or local `http://127.0.0.1:3001`), automates supplier panel navigation via Chrome DevTools Protocol (CDP), simulates realistic human keystrokes and timing, files return claims, captures visual confirmation proofs, and cleans local evidence files.

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
   - In `submit` mode, clicks Submit button, captures confirmation screenshot, extracts ticket ID (e.g. `MSHO-TKT-...`), and updates database record.
   - Automatically cleans local downloaded evidence files from disk cache via `cleanClaimEvidenceFiles(claimId)`.

## Build & Run Commands

```bash
# Build the standalone Windows EXE
npm run build:agent

# Test browser detection and launch
.\desktop-agent\dist\TaskFlowClaimAgent.exe --test-browser

# Run continuous background worker
.\desktop-agent\dist\TaskFlowClaimAgent.exe
```
