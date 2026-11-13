# Meesho Claim Automation — Steps, Setup, and Live Verification (2026-11-13)

Verified live against the installed desktop app 1.3.0 (`Return App.exe`, engine in-process, signed in as Pawan Shukla, backend `https://return.youthnic.shop`).

## How login is set up (what "fill id password from env" means in practice)

Credential resolution order in the engine (`desktop-agent/src/portal-login.ts` → `signInMarketplace` → `completePortalLogin`):

1. ID + password typed in the app's **Settings → supplier login** form (saved to the backend, encrypted).
2. Saved backend login (Marketplace Logins admin API).
3. Claim job bundle credentials (from the server, decrypted with `AUTOMATION_SECRET_KEY`).
4. **`.env` fallback — `MEESHOID` + `MEESHO_PWD`** (aliases `MEESHO_ID`/`MEESHO_USERNAME`, `MEESHO_PASSWORD`/`MEESHO_PASS`). The engine loads `.env` itself: repo `.env` when run from the checkout, or `AGENT_DATA_DIR/.env` (`~/.taskflow-claim-agent/.env`) for the installed app (`desktop-agent/src/load-env.ts`). When a login succeeds from env and none was saved, it is auto-persisted to the backend (with a warning if that sync fails).

Login mechanics (`completePortalLogin`, portal-login.ts:177):
1. Navigate to the panel URL (`https://supplier.meesho.com/panel/v3/new/root/login`).
2. Meesho landing page: clicks `#loginbutton` / `a[href*="/login"]`.
3. Detects the password box; human-types the ID into `input[name="emailOrPhone"]`, then the password, then clicks the **Log in** button.
4. Waits for the authenticated state (`isPortalLoggedIn`: panel URL fragment `/panel/v3/new/` or "Welcome back"/"Pending Orders" text, rejects `/login` URLs and visible password fields).
5. Writes the session marker + saves cookies in the per-panel profile (`~/.taskflow-claim-agent/browser-profiles/profile-meesho`, partition `persist:supplier-meesho`).
6. OTP/CAPTCHA: the browser is shown for manual entry; cookies save when the panel opens.

The **operator setup** is therefore: put `MEESHOID`/`MEESHO_PWD` in `.env` (already present), open the app → Settings → Meesho → **Sign in and save cookies**. The claim worker uses the same path automatically when a job runs.

## Live verification performed 2026-11-13

- `POST /api/portal-logins/test {marketplace:"Meesho"}` with empty typed credentials → engine used the env keys → **"Meesho is signed in and the cookies are saved on this PC. 1 waiting claim is back in the queue."** (cookies re-validated from the Nov 9 profile; no OTP needed).
- Meesho tab opened inside the desktop app's bounded workspace at `https://supplier.meesho.com/panel/v3/new/experience/yqcue/support`.
- The worker immediately leased the requeued claim #3 and filed it live: 4 evidence files downloaded to `evidence-cache/claim-3/` (barcode image, reverse waybill, unboxing video, product images), navigated to the `/support/1/1/create` category page (PR #61 category enforcement), and ran the form fill + evidence upload.
- Upload verification (PR #52) fired as designed: `Meesho evidence unverified (1/5 boxes): #attachments_12 (attachments): no evidence file mapped to this upload box; attached=0, portalAck=no` — the worker stops and asks for the operator instead of claiming success when one mandatory upload box cannot be verified.
- Crash guard verified: killing the main-window renderer produced `Claim bot window renderer gone (crashed). Reloading.` and a fresh renderer.

## The Meesho claim steps end-to-end (current build)

1. Claim created on the backend (scan → claim → `claim_automation_jobs` queued, stage `queued`).
2. Engine worker polls, leases the job (`GET /api/automation/agent/poll`), downloads evidence from the backend to the local evidence cache (sha256 + size verified).
3. Pre-submit gate (`submit-guard`): only a backend-issued `submitting` lease authorizes the portal Submit click.
4. Panel opened (native WebContentsView in the app's bounded workspace); login ensured via the path above.
5. Duplicate-ticket check (F7) on the panel.
6. Category navigation to **Returns/RTO & Exchange → I have received wrong return** (`/support/1`, enforced by PR #61).
7. Form filled: sub-order ID, AWB, packet condition, issue mapping from `MEESHO_PORTAL_ISSUE_LABELS`.
8. Evidence attached box-by-box with portal-ack verification (PR #52); any unverified mandatory box → `manual_intervention_required` (exactly what claim #3 hit today on `#attachments_12`).
9. Prepare stage: form left open for operator approval (backend `requireApprovalBeforeSubmit`), browser kept visible.
10. After approval + submitting lease: Submit clicked; marketplace ticket ID extracted; `POST /api/automation/jobs/:id/complete` with lease auth.
11. Follow-up: `claim_automation_follow_ups` row created; `MeeshoAutomation.checkClaimStatus()` re-opens the panel in the nightly window and reads the Support/My-Tickets table until approved/rejected/paid.

## Findings from today

1. **Window-paint bug (cosmetic but real)**: after the window stays hidden (tray) for many hours, showing it renders the `#0b1311` background with a frozen frame until a real interaction/reload. The reload crash-guard works around it. Worth a proper fix (e.g. force `webContents.invalidate()` on show, or refresh on `restore-from-tray`).
2. **Claim #3 needs one manual touch**: upload box `#attachments_12` had no evidence file mapped — operator should attach that one file in the held Meesho browser (or we add the field mapping) so the claim can complete.
3. Assistant-side note: PrintWindow/screen captures of the Electron window came back black while frozen; the Nov-5 acceptance set (`docs/screenshots/gui-04-browsers-tab.png`) shows the bounded workspace rendering correctly.

## Ticket ID capture → database storage (traced 2026-11-13)

**Extraction (`desktop-agent/src/marketplaces/meesho.ts`, `execute` submit path):**
1. Clicks Submit, waits 4s, captures a confirmation screenshot.
2. Builds a `known` set = every ticket ID listed on the portal before filing + every 9–15 digit run from the claim's own references (subOrderId, orderNumber, trackingId, packetId) — so order/AWB numbers are never mistaken for a ticket.
3. Scans page text for `ticket…<9–15 digits>` for up to 12s, first ID not in `known` wins.
4. Fallback: if the form closed but no ID was seen, navigates back to the support page and diffs the recent-ticket list against the pre-file snapshot.
5. No new ticket → `manual_intervention_required` (it never invents one).

**Storage (`POST /api/automation/jobs/:id/complete` → `completeJobSubmission`, `server/claim-automation-service.ts:1135`) — one DB transaction:**
- Row-locks the job (`FOR UPDATE`); scope-checked.
- Idempotency: same ticket replayed → no-op; different ticket / second completed job / already-outcome'd claim / not_eligible → 409.
- PR #50 authorization: the completing worker must hold the live lease, and on approval-required accounts only a backend-issued `submitting` stage may record a ticket.
- Writes: `claim_automation_jobs` → `stage='completed'`, `marketplace_claim_id=<ticket>`, screenshot path, completion log; `createFollowUpForJob` → one `claim_automation_follow_ups` row per claim (re-file resets the timer); `claim_status_history` → status → `submitted` with the ticket in the reason; `claims` → `status='submitted'`, `remarks` gains `Marketplace Claim ID: <ticket>`; `register_audit_log` → `claim.automation_completed`; `syncClaimTicketToRegister` → ticket code + "Raised" written into the return register against the receipt scan.

**Where it shows:** desktop Claims tab (Marketplace Ticket Ref column), the web `/claims` console (status + remarks + View Details), the Follow-ups tab (ticket + nightly status reads), and the return register. Live check 2026-11-13 (`GET /api/jobs`): claim 2 → `794219443852`, claim 4 → `794219052322`, claim 5 → `794219857178` — all completed with portal-verifiable IDs (they appear in the portal's own "Recently raised tickets").

Data-hygiene note: claim 1 (stage `prepared`) carries `marketplaceClaimId = "Raise"` — an invalid placeholder from an early flow; prepared jobs should have no ticket ref. Operator decision to blank it (production data, not touched).

## The in-app automation ("playwright-kind") mechanism

The engine drives supplier pages through a `SupplierBrowserApi` abstraction (`desktop-agent/src/browser-adapter.ts`) — Playwright-style primitives without a Playwright dependency:

- **Native adapter (desktop app):** real Electron `WebContentsView` per panel (partition `persist:supplier-<key>`); automation runs via `webContents.executeJavaScript` (evaluate), `sendInputEvent` (keyboard/mouse), `capturePage` (screenshots), in-window downloads. The operator sees and can take over the same live view (OTP/CAPTCHA).
- **External adapter (headless Linux):** system Chrome/Edge driven over CDP (`ws` WebSocket): `Page.navigate`, `Runtime.evaluate`, `Input.dispatchKeyEvent/dispatchMouseEvent`, `Page.captureScreenshot`, `DOM.setFileInputFiles`.
- **Shared API surface:** `open, navigate, evaluate, delay, humanType, humanClick, clickByText(Includes|Exact), clickVisibleLabel, clickLabelInDom, detectCaptchaOrOtp, captureScreenshot, setFileInputFiles, uploadViaChooser, connectToPage, close`.
- **File uploads (the "playwright-kind" part):** two strategies — direct `DOM.setFileInputFiles` on the input, and `uploadViaChooser` which intercepts the portal's native file chooser (`Page.setInterceptFileChooserDialog`), clicks the portal button with real mouse events, and feeds the file through the chooser protocol. `meesho.ts` requires portal acknowledgment (file name/thumbnail/success chip) per box before an attachment counts (PR #52).
- Marketplace classes (`marketplaces/meesho.ts` etc.) are written only against this API, so the same filing code runs in the desktop window and headless server. Process-tree kill discipline (`taskkill /T /F` / POSIX `kill(-pid)`) and 24h evidence-cache pruning apply to spawned browsers (AGENTS.md rule 13).
