# Meesho Autonomous Claim Automation — Task 1 Audit & Task 2 Workflow (2026-11-21)

## Task 1: Root-Cause Audit of Stuck Agents

Evidence gathered from live desktop logs (`bot-2026-11-21.log`, `bot-2026-11-20.log`, `bot-2026-11-19.log`), operator screenshots of `tulipprints` (`.../support/1/1/create...`, `Ticket Raised / Ticket ID: 795277339384`), and source inspection:

1. **Unhandled `Error: UnknownVizError` in `captureScreenshot` (killed Job #7 on all 3 attempts)**
   - `NativeSupplierBrowser.captureScreenshot()` (`desktop-agent/src/native-browser-view.ts`) calls `webContents.capturePage()` without catching Chromium Viz compositor errors when the `WebContentsView` is hidden/detached or the window is off the Browsers tab.
   - `MeeshoAutomation.execute()` calls `captureScreenshot()` unguarded right after typing the description (`line 879`) and right after clicking Submit (`line 950`). Tonight Job #7 (`Item/s are missing in my return`, Sub-Order `346825030177981952_1`) filled all fields, uploaded all 5 files, typed 376 chars, and crashed 3/3 times on `Error: UnknownVizError`. Calling it before Ticket ID extraction after Submit would also discard an already-created Ticket ID.

2. **Legacy Meesho `require_approval_before_submit = true` stalled Jobs #13 and #8**
   - Tonight Job #13 (`wrong_return`, `16:01:35`) and Job #8 (`wrong_return`, `16:35:10`) both stopped at `"Meesho claim prepared. Waiting for user approval..."` because existing DB rows in `marketplace_credentials` still had `require_approval_before_submit = true`. That triggered a `prepared` hold on `meesho` (`panel-queue.ts`) and halted all remaining queued claims.
   - Operators must be able to run Meesho 100% autonomously (explicit M9 credential flag `require_approval_before_submit = false` on Meesho migration/startup when never explicitly opted out, and one-click UI control), and when an operator manually submits a held `prepared` view resulting in `Ticket Raised / Ticket ID: ...`, the view observer should detect it instead of keeping the panel stuck.

3. **Panel-wide holds/cooldowns blocked healthy queued claims**
   - `panel-queue.ts` blocked the entire Meesho queue for `manual_action` (e.g., an unhandled form error or claim-specific block stalled `#7..#12` in `bot-2026-11-19.log`) and imposed a 30-minute panel `cooldown` after 3 claim errors.
   - Only panel-wide blockers (expired supplier session / OTP / CAPTCHA, or explicit `prepared` mode) should pause the Meesho panel; per-claim errors and exhausted 3-attempt failures must park only that claim (`manual_action_required`) and advance immediately to the next claim.

4. **Missing 3-attempt -> `"Manual required"` transition & retry backoff (Tasks 4 & 5)**
   - When `attempts >= max_attempts` (3), `server/claim-automation-service.ts` left the job and claim in `failed` instead of transitioning the exhausted job/claim cleanly to `manual_action_required` (`"Manual required"`) with the latest failure reason, and failed attempts retried within 5 seconds instead of exponential backoff (`next_retry_at`).
   - Web `/claims` & Desktop `Claims` need a prominent dedicated **Manual Required** list showing exhausted/manual-action claims with reason and a one-click **"Enter Ticket ID / Mark Done"** action.

5. **`ERR_ABORTED (-3)` & Unbounded Browser/IPC Waits**
   - Tonight at `16:00:34`: `Error: ERR_ABORTED (-3) loading 'https://supplier.meesho.com/panel/v3/new/growth/yqcue/home'`. Chromium aborts `loadURL` with `-3` during Meesho client/server redirects; `NativeSupplierBrowser.navigate()` let `-3` throw as a job failure.
   - Neither `NativeSupplierBrowser.navigate`/`evaluate` nor `BrowserRunner.send` enforces timeouts, explaining 8–20 minute watchdog hangs (`bot-2026-11-19.log`).
   - `NativeSupplierBrowser.humanType` performed character-by-character IPC round-trips (~20s just for a 376-char description), and `pollDelayMs(true)` slept a full poll interval between consecutive queued claims.

6. **Upload Ack & Optional Slot Handling (`barcode_image`, `attachments`)**
   - `claim_template_fields` marks `barcode_image` optional (`required = false`), yet `meesho.ts` failed the entire claim if `#barcode_image_link_6` rendered without an uploaded barcode file—even if optional on the Meesho form.
   - `meesho.ts` checked upload ack once after a static `1500ms` delay instead of polling cleanly up to 15s for portal thumbnail/filename ack.

7. **Category / Return-Type Gaps (`wrong_missing`, `rto_received_wrong`) & AI Fallback (Tasks 4 & 11)**
   - `lookupReturnForClaim` (`server/claims-service.ts`) did not map `wrong_product` + RTO return type to `wrong_barcode_rto`.
   - `meesho.ts` lacked bounded AI-assisted DOM recovery fallback (`ai-center-assist.ts` + `ai-memory`) when a portal selector fails or Meesho changes a layout, and checked `/support` without clicking `My Tickets` during pre-submit duplicate detection.

8. **Process Lifecycle & Resource Hygiene (`EADDRINUSE: 3005`, OOM, Disk Cleanup) (Tasks 6 & 7)**
   - `listen EADDRINUSE: address already in use 127.0.0.1:3005` appeared twice tonight (`16:05:31`, `16:15:55`): `desktop/main.ts` registered `app.whenReady()` even after failing `requestSingleInstanceLock()` (`app.quit()` is async), and `before-quit` did not close the engine HTTP listener before quitting.
   - Renderer OOM (`Claim bot window renderer gone (oom)`) occurred in long runs without idle view cleanup / session cache trimming, and temporary media in `evidence-cache/claim-<id>` stayed on disk when claims moved to `manual_intervention_required` or 3-attempt failure.

---

## Task 2: Live Meesho Supplier Panel Workflow Across Categories

Verified against live `supplier.meesho.com/panel/v3/new/experience/<slug>/support`:

1. **Categories Supported (`server/meesho-claims.ts` / `meesho.ts`)**:
   - `wrong_return` (`Customer Return`): `Returns/RTO & Exchange` -> `Customer Return` -> `"I have received wrong return"` (`/support/1/1/...`)
   - `missing_items` (`Customer Return` or `Courier Return`): `"Item/s are missing in my return"`
   - `wrong_barcode_rto` (`Courier Return / RTO`): `Courier Return` / `RTO` -> `"I have received a wrong barcoded package in RTO"`
   - `damaged_return`: `"I have received damaged return"`
   - `used_product`: `"I have received used product as return"`
2. **Step-by-Step Execution**:
   1. **Auth Check**: Load `/panel/v3/new/root/login` (reuses `persist:supplier-meesho` cookies); extract seller `<slug>` from `/growth/<slug>` or `/experience/<slug>`. If login/OTP/CAPTCHA requested -> hold panel (`loginRequired`), notify user, auto-resume when signed in.
   2. **Duplicate Guard**: Open `.../support` -> check `"My Tickets"` table rows + DB `marketplace_claim_id` against `[subOrderId, orderNumber, trackingId, packetId]`. Never file a duplicate order.
   3. **Category & Subcategory**: Open `.../support/1`, pick `Courier Return` (for `wrong_barcode_rto` / RTO) or `Customer Return` (default for customer returns; fallback to whichever tab exposes the exact `issueLabel`), click `issueLabel` -> click `Raise a Ticket`.
   4. **Order Details**: Fill `Sub Order ID`, `AWB Number`, `Packet ID`; click `Check`/`Verify`/`Search` if shown; abort cleanly as `not_eligible` on `"return order has been delivered"`, `"ticket already exists"`, `"not eligible"`, etc. Select `State of the packet` (`Intact` / `Tampered`), `Barcode / Flyer ID`, and `Callback Number *` (keep prefilled portal value or fill configured value if empty).
   5. **Evidence Upload**: Inspect all visible `input[type="file"]` slots (`#barcode_image_link_6`, `#product_image_link_7`, `#product_reverse_way_bill_link_8`, `#product_openingvideo_link_9`, optional `#attachments_12`). Validate `.mp4 <= 23.5 MB` for video; attach via `DOM.setFileInputFiles` + React `onChange`; wait up to 15s for filename/thumbnail/preview ack; skip optional non-`*` empty boxes.
   6. **Dynamic Description**: Populate `Description *` (`textarea`) with dynamic category template (`missing_items` itemized missing amounts, `wrong_barcode_rto` wrong manifest note, references & signature).
   7. **Submit & Ticket ID Capture**: Wait up to 20s for `Submit` enabled; click `Submit`; extract numeric 9–15 digit `Ticket ID` directly from inline confirmation (`Ticket Raised` / `Ticket ID: 795277339384`, URL stays on `.../create...`) or fallback to `"My Tickets"` table diff -> save via `POST /api/automation/jobs/:id/complete` -> delete temporary claim media -> proceed immediately to next queued claim.
