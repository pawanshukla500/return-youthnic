# Return App: Phase 1 implementation checklist

This checklist uses only the verified Phase 1 audit. That audit covered six areas: server and database, Android, the desktop shell, the engine and Meesho filing, CI and release, and QA, docs and history. It kept 82 findings and refuted none. Several auditors reported the same problem, so this list merges duplicates into 73 checklist items. Nothing here is a new finding, and nothing was re-audited.

**How to read it**
- **Confirmed** means a second checker reproduced the finding. **Unverified** means one auditor reported it and nobody re-checked it.
- **P0** is the most urgent: a security exposure, or claims or money lost now. **P1** is serious. **P2** is important but not urgent.
- **S, M and L** show how much work an item is compared with the others in the audit. They are not time estimates.

## Where things stand

- **The checks pass today.** `npm run typecheck` is clean on all 4 projects. Locally, `npm test` ran 1,003 tests: 956 pass, 0 fail and 47 are skipped. Of the skips, 44 need a test database and 3 only run on Linux/macOS. CI ran all 1,003 green, database tests included (run 44582743854, 2026-11-19). The engine tests passed 86 of 86.
- **The core safety design holds.**
  - Account scope is bound inside SQL in the claim, automation and follow-up services.
  - The sensitive routes check for Admin or Supervisor.
  - There is one claim per scan, and duplicate evidence files are rejected by content hash.
  - A claim cannot be filed before its evidence arrives.
  - A submission interrupted mid-submit goes to manual and is never filed again automatically.
  - Recording a ticket twice is harmless.
  - Database TLS is always verified.
- **The phone and desktop basics work.**
  - The Android scan bench is solid: the camera is throttled, duplicate scans are blocked and retries cannot double-save.
  - The in-app updater downloads, resumes and checks the APK's SHA-256 today.
  - The desktop window loads only its bundled screens (rule 17), the bridge matches its types (rule 19), and the engine token never reaches the page.
- **P0: three secrets are readable by anyone in this public repo.**
  - The Android release signing key and its passwords. With these, anyone can sign an update that warehouse phones will accept.
  - A Postgres password in `deploy.yml`.
  - The WhatsApp gateway login, plus contact numbers and a person's name.

  Deleting them from the code does not undo the exposure. Only you can rotate them.
- **P0: three defects can lose claims or money.**
  1. A Meesho ticket showing "Pending approval" is recorded as approved, and tracking stops for good.
  2. In fully automatic mode, a failure after the Submit click puts the job back in the queue, so the same claim can be filed twice.
  3. In the default approval mode, while one claim waits for approval, the engine keeps taking queued claims and dropping them. Those claims are marked failed after about 45 to 60 minutes.
- **P1: serious data problems.**
  - A scan can be silently thrown away if a background sync step errors.
  - A claim started from the phone writes invented "received 1, verified" lines into the register and blocks the real bench scan.
  - Photos and video are lost if the phone kills the app.
  - Correcting a scan deletes its ticket history, which breaks rule 3.
- **Claim tracking probably does not work in the default setup.**
  - A follow-up check opened in a fresh browser view cannot find the seller ID, so each ticket stops being tracked after 3 tries.
  - Capacity is 48 checks a day, against roughly 300 or more needed at 150 claims a day.
  - 150 claims a day is reachable only on paper: an estimated 20 to 40 claims an hour in fully automatic mode, worked out from the code and never measured.
  - Only 3 real Meesho tickets have ever been filed, and none of the form steps has been checked against the live Meesho portal.
- **Release safety is thin.**
  - Nothing forces CI to pass before a production deploy or a desktop release. There is no branch protection, and those workflows skip the database tests.
  - A failed deploy cannot roll back.
  - The desktop installer is unsigned, and nothing checks it before it runs with admin rights.
  - The phone's fallback update manifest points at a deleted release (1.0.58).
  - Mandatory phone updates never trigger.
- **Waiting on you.**
  - Rotate the three credentials and decide how to rotate the Android key.
  - Turn on branch protection.
  - Provide a live Meesho session.
  - Decide: automatic or approval mode, the four claim categories, the callback number, and whether a claim may exist without a bench scan.
- **AGENTS.md is out of date.** It says 767 tests and Android tag v1.2.0.82. The real figures are 1,003 tests and v1.0.63; tag v1.2.0.82 does not exist.

**Suggested exception to the phase order (your call):** start items 12.1, 12.2 and 12.3 (the leaked secrets) and 15.1 (branch protection) now, alongside Phase 2, for two reasons:
- Every phone release in Phase 2 would otherwise still be signed with the leaked key.
- Without branch protection, a failing CI run does not stop a merge.

## How every item is closed

- **Change and checks:** the smallest change that works, with a test for any logic. `npm run typecheck` and `npm test` pass, and CI is green including the database tests.
- **Rules every PR keeps:**
  - Rule 1: account scope on every data query.
  - Rule 3: history is never deleted.
  - Rule 6: schema changes only add, never drop.
  - Rule 8: no secrets in code or logs.
  - Rule 9: test data uses `SYN-` values.
  - Rule 11: report only what was actually run.
- **Desktop PRs:** any PR touching `desktop/`, `desktop-agent/` or the installer bumps `package.json`'s version (rule 20). It must pass `tsconfig.desktop.json` and keep the headless Linux mode building (rule 16).
- **Android PRs:** they ship through `return-scan-apk.yml`, and the release manifest must match what was published (rule 12).
- **Before handing back:** run `graphify update .`, `/ponytail-review` and `/understand-diff`, then add a session-log entry to `docs/notes/agent-handoff.md`.
- **Unverified items:** reproduce them first. If one does not reproduce, close it with a note.

---

## Phase 2: Mobile (scanning, claim capture, evidence upload)

**In plain words:** every scan and every photo or video must reach the server, and a claim must never carry another return's details.

Android merges publish an APK. Until 12.1 is done, those APKs are still signed with the leaked key.

| Proposed PR | Items |
|---|---|
| 2-A `fix(register): savepoint and account filter on return-tracking sync` | 2.1 |
| 2-B `fix(android): durable evidence capture and queued uploads` | 2.2, 2.10 (purge part) |
| 2-C `fix(claims): active-only, exact-first claim lookup; no invented register rows` | 2.3 |
| 2-D `fix(android): save the scan before File Claim; no stale or made-up return data` | 2.4, 2.5 |
| 2-E `perf(android): downscale photos, sampled thumbnails` | 2.6 |
| 2-F `perf(android): upload progress, timeouts, foreground worker` | 2.9 |
| 2-G `fix(android): HTTPS in release builds; video without microphone permission` | 2.10 (permission part), 2.11 |
| 2-H `perf(android): debounce live-sync refresh` | 2.12 |
| 2-I `fix(claims): one template per marketplace; Amazon evidence slots` | 2.7 |
| 2-J `perf(claims): stream evidence uploads and downloads` | 2.8 |
| 2-K `fix(server): fail-closed scope default, role gates, remove Sentry test route` | 2.13 |

- [ ] **2.1 A tracking-sync error must never throw away a scan.** P1, S, confirmed.
  - **Why:** SRV-03 and TH-06.
    - `server/register-service.ts:1187-1198` catches the sync error inside the open transaction with no SAVEPOINT. PostgreSQL then turns the COMMIT into a ROLLBACK, so the scan, its items and its audit row vanish, and the operator gets a 404 "Scan not found".
    - The UPDATE at `server/return-tracking.ts:1003-1006` has no `marketplace_id` filter. The same AWB is allowed in Myntra EJ and Myntra VB (`server/schema-import.sql:34-38`), so it can mark another account's return as received.
  - **Fix:** wrap the call in `SAVEPOINT` with `ROLLBACK TO SAVEPOINT` in the catch, or run the sync after COMMIT. Add the scan's marketplace to the UPDATE, and stop matching on order_id alone.
  - **Done when:**
    - A DB test forces the sync to fail, and the scan, its items and its audit row still exist.
    - A `SYN-` AWB scanned in one account leaves the other account's tracking row unchanged.
    - Both tests run green in CI.
  - **Depends on:** nothing. **Rules:** 1, 3.

- [ ] **2.2 Captured evidence survives the app being killed.** P1, M, confirmed.
  - **Why:** AND-02.
    - `ClaimCaptureActivity.kt:81-86` keeps captured files and the pending photo in memory only. Nothing in `android/` saves state.
    - `:1019-1039` uploads inline and queues failed files for retry only after the whole loop ends.
    - `ClaimEvidenceUploadWorker.kt:35-38` fails a 4xx silently.
    - A claim stuck in pending_evidence is never filed (`claim-automation-service.ts:589-599`), so Meesho's 7-day window can lapse.
  - **Fix:**
    - Right after unified-create, queue one unique WorkManager job per file, and have the progress dialog watch those jobs.
    - Save the captured list and the pending photo path, and restore them when the screen restarts.
    - Show pending uploads to the operator.
  - **Done when:**
    - On a phone, force-stopping the app during the camera step, and again during upload, still ends with every file on the server and the claim at ready_for_claim.
    - A 4xx failure is shown to the operator.
    - Unit tests cover save and restore.
  - **Depends on:** nothing.
  - **Needs you:** a warehouse phone for the kill test.

- [ ] **2.3 Claim lookup uses only active returns and exact matches first; no invented register rows.** P1, M, confirmed.
  - **Why:** SRV-08, plus the server half of AND-04.
    - `server/claim-automation-service.ts:1650-1689` ignores `lookup_status`, which the scan path filters (`register-service.ts:451-452`).
    - The lookup uses unescaped `ILIKE '%value%'` and ranks any already-scanned fuzzy match above an exact match that is not yet scanned. `claim-automation-routes.ts:97-110` then binds the claim to that one result.
    - `:118-169` inserts a Draft receipt scan with no audit row, and `:180-188` writes `received_qty 1, verified true` for every line.
    - The real bench scan later fails with 409 (`schema.sql:109-110`, `register-service.ts:1209-1211`).
  - **Fix:**
    - Filter on `lookup_status = 'active'`.
    - Rank exact matches before fuzzy ones, and never auto-bind a fuzzy match.
    - Escape `%` and `_`.
    - Stop creating receipt scans from the claim flow. Alternatively, mark them with their own source, audit them, and let the bench scan attach to them.
    - Never invent received quantities, and publish the change to live sync.
  - **Done when:** DB tests with `SYN-` data show that:
    - a staging or superseded row is never returned;
    - an exact unscanned match beats a scanned fuzzy one;
    - `%` and `_` are treated literally;
    - a claim-first flow followed by the bench scan of the same AWB succeeds;
    - no line is recorded as received or verified without a count.
  - **Depends on:** your decision below. **Rules:** 1, 3, 4.
  - **Needs you:** may a claim be created for a return that has no bench scan? If so, where should that record live, and what should the register show?
  - **Not measured:** the lookup is plausibly slow (it has no supporting index), but nobody ran EXPLAIN, because the auditors had no database access.

- [ ] **2.4 "File Claim" saves the scan first.** P1, M, confirmed.
  - **Why:** AND-04. `ReturnVerificationBottomSheet.kt:344-345` closes the sheet and opens claim capture without saving. `ClaimCaptureActivity.kt:1158` declares EXTRA_SCAN_ID but never reads it. The operator's counts, sub-issues and flyer state are lost.
  - **Fix:** run the normal save, with the same clientScanKey, before opening claim capture, and pass the receipt's scanId through.
  - **Done when:** on a phone, File Claim on a missing_items return leaves a register row with the operator's real counts and sub-issue, the claim points at that scan, and a retry does not save twice.
  - **Depends on:** 2.3.

- [ ] **2.5 No stale or made-up return details on a claim.** P1, S, confirmed (the failure path is narrower than first reported).
  - **Why:** AND-03.
    - `SessionManager.kt:144-157` writes only non-blank "last scanned" fields, so values from different returns mix. `clearSession` (`:216-224`) keeps them.
    - `ClaimCaptureActivity.kt:911-935` builds a fake lookup (found, Meesho, cached customer and price) when the lookup fails.
    - `:937-939` and the description builder fall back to a previous return's SKU.
    - These values reach `claim-automation-routes.ts:253-281`, and the packet ID is typed into Meesho (`meesho.ts:549-553`).
  - **Fix:**
    - Overwrite every "last scanned" key, blanks included, and clear them all on logout.
    - Require a successful lookup, or send only the fields the operator typed and let the server work out the rest.
    - Remove the cached fallbacks from the submit and description code.
  - **Done when:** unit tests show that a scan without a flyer clears the previous flyer, and that with the lookup forced to fail, submit is blocked or sends no cached customer, price, SKU or packet ID.
  - **Depends on:** nothing.

- [ ] **2.6 Downscale photos; decode thumbnails safely.** P1, S, confirmed (not tested on a real phone).
  - **Why:** AND-05.
    - `ClaimCaptureActivity.kt:750-755` stores camera photos at full resolution.
    - `:808-812` decodes the full image on the main thread. An out-of-memory crash is not caught, and it also loses the evidence held in memory (2.2).
    - `ImageCache.kt:114-139` already has a sampled decoder that this code does not use.
  - **Fix:** use `decodeSampledBitmap` off the main thread. Downscale to about 1,600 px on the long edge at JPEG quality 80, keeping the orientation.
  - **Done when:** a test shows a 12 MP capture stored at about 1,600 px with the correct orientation, the thumbnail no longer decodes on the main thread, and the change has been checked on the lowest-spec warehouse phone.
  - **Depends on:** nothing.

- [ ] **2.7 One claim template per marketplace; Amazon gets evidence slots.** P2, S, unverified (not checked against production, where admins may have edited templates).
  - **Why:** SRV-12.
    - Amazon's only template has no fields (`server/schema-claim-automation.sql:104-108`, `schema-claims.sql:170-175`), so Amazon evidence cannot be uploaded and those claims never become ready (`claims-service.ts:1372, 1412`).
    - For Myntra, Ajio and Flipkart, the 2-slot template hides the 5-slot one (`claims-service.ts:1002`).
    - Meesho is not affected.
  - **Fix:**
    - Seed Amazon fields, or switch off the empty template.
    - Skip templates with no active fields, and keep one template per marketplace.
    - Apply `schema-meesho-claims.sql` after `schema-claim-automation.sql`.
  - **Done when:** an Amazon test claim can upload evidence and reach ready_for_claim, and each marketplace resolves to exactly one template with the agreed slots.
  - **Rules:** 6.
  - **Needs you:** are Amazon claims in scope, and which evidence slots must Myntra, Ajio and Flipkart require?

- [ ] **2.8 Stream evidence through the server instead of holding it in memory.** P2, L, confirmed (severity lowered).
  - **Why:** SRV-09.
    - `server/claims-routes.ts:80-83` holds uploads of up to 100 MB in memory.
    - `firebase-storage.ts:162` copies the file again, the upload cannot resume, and no call has a timeout (`:154-163, 190-193`).
    - Downloads are also held in memory and support no Range requests (`firebase-storage.ts:197`, `claims-routes.ts:287-296`).
    - The error message says 25 MB (`index.ts:1126-1127`) while the limit is 100 MB.
    - The checker found real memory peaks are about twice a 20 to 25 MB file, so this is P2.
  - **Fix:** stream into a resumable storage upload while hashing, reject oversize files early, pass Range requests through with 206 responses, add timeouts and fix the message.
  - **Done when:** tests show memory stays bounded during a large upload, a Range request returns 206, and a hung storage call times out. The web console's video player can seek.

- [ ] **2.9 Upload progress, timeouts and long uploads.** P2, M, unverified.
  - **Why:** AND-08. Uploads share a 20 s read timeout (`ApiClient.kt:24-27`). Progress counts files, not bytes (`ClaimCaptureActivity.kt:1023-1035`). The upload worker is not foreground work, so Android's roughly 10-minute limit applies.
  - **Fix:** report progress by bytes, use a longer timeout for uploads only, run big files as foreground work, and upload two files at a time.
  - **Done when:** a 25 MB video on a throttled network shows moving byte progress and finishes without a client timeout.
  - **Depends on:** 2.2, 2.6.

- [ ] **2.10 Clean up leftover evidence files; record video without microphone permission.** P2, S, unverified.
  - **Why:** AND-09. Nothing ever deletes old files in `filesDir/claim-evidence` (`ClaimCaptureActivity.kt:833`, `ClaimVideoCaptureActivity.kt:81`). Pressing back mid-recording leaves a partial MP4 (`ClaimVideoCaptureActivity.kt:113-116`). `ClaimCaptureActivity.kt:700-704` demands RECORD_AUDIO, but audio is never recorded.
  - **Fix:** at start-up, delete files older than N days that no pending upload uses, delete partial files, and drop RECORD_AUDIO from the permission check and the manifest.
  - **Done when:** a test removes unused old files and keeps pending ones, and video records with the microphone permission denied.
  - **Depends on:** 2.2.

- [ ] **2.11 HTTPS only in release builds.** P2, S, unverified.
  - **Why:** AND-10.
    - `AndroidManifest.xml:28` allows unencrypted traffic everywhere.
    - `LoginActivity.kt:60-64` saves any server address, and that address then receives the password and the session token.
    - `AppUpdater.kt:212` accepts http download links.
    - With the leaked key (12.1), this opens a way to push a fake update.
  - **Fix:** allow unencrypted traffic only in debug builds or for local IPs, and require https server and download addresses in release builds.
  - **Done when:** a release build refuses an http:// server address and an http:// download link, and a debug build still works against a LAN server.
  - **Related:** 12.1.

- [ ] **2.12 Debounce live-sync refreshes on phones.** P2, S, unverified.
  - **Why:** AND-14. Every change event (`LiveSync.kt:66-68`) triggers a full `GET /api/scan/session` (`ScannerActivity.kt:139, 247-268`).
  - **Fix:** wait about 2 s to combine events, then fetch only the shift figures.
  - **Done when:** a unit test shows 10 events in 2 s cause one lightweight request.

- [ ] **2.13 Server: missing scope fails closed; role checks on OMSGuru sends; remove the Sentry test route.** P2, S, unverified.
  - **Why:** SRV-15.
    - Register-service functions default to all accounts when no scope is passed (`server/register-service.ts:160, 213, 645, …`), against `server/access.ts:69-71`. Every current route passes a scope, so this is a trap for future routes.
    - Any signed-in user can call the OMSGuru generate and send routes (`server/omsguru-routes.ts:119, 224, 272, 303-339, 350, 392`).
    - `/api/debug/sentry-test` needs no sign-in (`server/index.ts:325-329`).
    - This item is not tied to a plan phase. It sits here because register-service is the scan path. Whether the OMSGuru daily file spans accounts was not checked.
  - **Fix:** make scope required (or default to no accounts), put role checks on the send routes, and remove the Sentry route or limit it to Admin.
  - **Done when:** typecheck fails if a call leaves out scope, a Scanner-role test user gets 403 on the send routes, and the Sentry route is gone or returns 403 in production.
  - **Rules:** 1, 2.
  - **Needs you:** which roles may trigger OMSGuru email and WhatsApp sends?

**Phase 2 exit:**
- CI is green with the database tests.
- The APK is published through the workflow, with the manifest in sync (rule 12).
- On a warehouse phone: scan, then File Claim, then photos and video, then kill the app mid-upload. The claim must reach ready_for_claim with the right packet ID and SKU, and the register must show the real counts.

---

## Phase 3: Desktop app and engine

**In plain words:** stop the engine from quietly failing queued claims, make a stuck cycle actually stop, and keep the app within the 4 GB / 2-core limits.

Every PR in this phase bumps the version (rule 20) and keeps both modes building (rule 16). You can batch these on the `desktop` branch to cut the number of releases.

| Proposed PR | Items |
|---|---|
| 3-A `fix(engine): check the panel hold before leasing a job` | 3.1 |
| 3-B `fix(engine): cancel timed-out cycles; time limits on network and browser calls` | 3.2, 3.3 |
| 3-C `fix(desktop): apply the 256 MB heap cap at launch` | 3.4 |
| 3-D `perf(desktop): pause polling when hidden; restore background throttling` | 3.5 |
| 3-E `fix(engine): hourly evidence purge` | 3.6 |
| 3-F `fix(engine): retry backoff and saved panel holds` | 3.7 |
| 3-G `fix(engine): restore the AI assist safety prompt` | 3.8 |
| 3-H `fix(desktop): shell downloads (evidence link, popup path, duplicate listeners)` | 3.9, 3.10, 3.11 |
| 3-I `test(desktop): bridge contract parity and caller checks` | 3.12 |

- [ ] **3.1 Check the panel hold before taking a job.** P0, S, confirmed.
  - **Why:** ENG-01.
    - `desktop-agent/src/desktop-app-server.ts:223` leases a job. Only afterwards does `:232-235` notice the panel is held, and it drops the job without releasing the lease.
    - Each lease uses up one attempt (`server/claim-automation-service.ts:615-625`). After 3 lease expiries the job and its claim become failed (`:543-577`; `max_attempts` is 3 at `schema-claim-automation.sql:54`).
    - Approval mode is the default (`:14`), and every prepared claim holds the panel (`panel-queue.ts:101-104`, `desktop-app-server.ts:356`).
  - **Fix:** check `isPanelHeld` (and cooldown) before `pollJob`, or send the held marketplaces with the poll so the server skips them. If a lease must be given up, release it through a server call that puts the job back in the queue without using an attempt.
  - **Done when:**
    - A unit test shows a held panel makes no lease call.
    - With one `SYN-` claim prepared and others queued, after more than 45 minutes the queued jobs are still queued, with their attempt counts unchanged.
    - The log no longer repeats "Refusing to process".
  - **Depends on:** nothing. **Rules:** 14, 16, 20.

- [ ] **3.2 A timed-out cycle must actually stop.** P1, M, confirmed.
  - **Why:** ENG-03 and TH-05.
    - `cycle-watchdog.ts:33-70` only races the cycle against a timer; it never stops it.
    - `desktop-app-server.ts:411-445` releases the in-flight lock while the old cycle may still be running.
    - Nothing between opening the browser and the end of `engine.execute` (`:300-345`) checks whether the cycle was abandoned. A resumed cycle can still click Submit, then throw away the ticket (`:345`), and close or release a panel that a newer cycle is using (`:402-406`, `native-browser-view.ts:1653-1678`).
    - The 15-minute lease runs out before the 20-minute watchdog (`claim-automation-service.ts:620`, `cycle-watchdog.ts:20`).
    - CodeRabbit threads on PR #71 at `desktop-app-server.ts:412, 418, 444` are unresolved.
  - **Fix:**
    - Pass an AbortSignal and a generation number into `engine.execute` and the browser adapter, and check them before every portal step, above all Submit.
    - On timeout, kill that panel's browser (`taskkill /T /F`, or destroy the view) before releasing the lock.
    - Skip the cleanup in `finally` when a newer cycle owns the panel.
    - Record or journal a late ticket instead of dropping it.
    - Keep the watchdog shorter than the lease, or renew the lease.
  - **Done when:**
    - A test where a delayed cycle finishes after the timeout shows it does not touch the panel, does not submit and does not clear ownership.
    - The browser process count returns to normal after a forced timeout.
    - The #71 threads are resolved.
  - **Depends on:** 3.3 (same PR). **Rules:** 13, 14.
  - **Uncertain:** nobody showed end to end whether a duplicate portal submission is possible.

- [ ] **3.3 Time limits on every backend call, browser call and browser shutdown.** P1, M, confirmed (one point overstated).
  - **Why:** ENG-07.
    - The fetch calls at `agent-client.ts:123, 167, 195, 353, 390, 484, 498` set no timeout. Node's defaults cap a stall at about 5 minutes, not forever.
    - The browser control call `send()` has no timeout and no close handler (`browser-runner.ts:211-240`), so a crashed Chromium hangs every waiting call.
    - `close()` waits on `Browser.close` before the process kill (`:673`).
    - A failed launch uses `proc.kill()`, not a whole-tree kill (`:182`).
    - Native `evaluate()` has no timeout (`native-browser-view.ts:1392-1394`).
  - **Fix:**
    - Add AbortSignal timeouts to every fetch: larger for media, with a stall timer.
    - Give each browser control call a timeout, and add a close or error handler that fails pending calls.
    - Put time limits on native scripts and page loads.
    - Limit `Browser.close` to about 3 s, then run `taskkill /T /F`; do the same on launch failure.
  - **Done when:** tests show that a stalled fetch, a silent browser connection and a dead connection each fail within their limit, and a forced launch failure leaves no Chromium processes behind.
  - **Rules:** 13.

- [ ] **3.4 Make the 256 MB memory cap real in the desktop app.** P1, M, confirmed by measurement (on a scratch script, not the packaged app).
  - **Why:** DESK-PERF-01.
    - `desktop/main.ts:23` adds the memory flag after start-up, too late to apply.
    - On Electron 44.8.0 the checker measured a 4,192 MB limit with the flag added this way, and 352 MB when it was passed on the command line.
    - The engine runs inside this process (`main.ts:9-16, 226-231`). The scheduled task and the login item pass only `--hidden` (`build/installer.nsh:62`, `main.ts:1378`).
  - **Fix:** pass `--js-flags=--max-old-space-size=256` in the scheduled task, the login item and the shortcuts (or run the engine as a child process with the flag). Log `heap_size_limit` at start-up.
  - **Done when:** the installed app logs a limit of about 352 MB when started from the scheduled task, the login item and the Start-menu shortcut.
  - **Rules:** 13, 16, 20.
  - **Needs you:** a Windows test PC, ideally 4 GB / 2-core.

- [ ] **3.5 Stop polling while the window is hidden; restore background throttling.** P1, M, confirmed (idle CPU not measured).
  - **Why:** DESK-PERF-02.
    - `desktop/main.ts:26` turns background throttling off. The checker measured 60 timer ticks in 6 s with that line, against 6 without it.
    - Nothing in `desktop/renderer/src` reacts to the window being hidden.
    - The Dashboard polls status every 2 s, panels every 5 s and jobs every 10 s, plus a 1 s countdown (`Dashboard.tsx:72-79, 113-118`). App adds another 5 s status poll (`App.tsx:440`).
    - `main.ts:340-354` sends bot status every 5 s to a listener that does not exist.
    - The tray menu is rebuilt every 15 s (`main.ts:1411`).
    - The Dashboard tab makes about 62 requests a minute, plus 12 internal calls.
  - **Fix:**
    - Remove `main.ts:26`.
    - Pause pollers, or slow them to 60 s, while the window is hidden.
    - Drop the duplicate status poll.
    - Remove `startBotStatusPush` and the unused `toggleBot`, `getBotStatus` and `onBotStatusChange` bridge members, changing `preload.cjs` and `global.d.ts` together.
    - Rebuild the tray menu only when it is clicked.
  - **Done when:**
    - A hidden-window test shows timers throttled.
    - A hidden window makes no engine requests over 60 s beyond the agreed slow poll.
    - The installed app, hidden in the tray on the test PC, measures under 0.5% idle CPU.
    - `docs/ARCHITECTURE.md:221` matches the code.
  - **Rules:** 13, 19, 20.
  - **Needs you:** the same test PC.

- [ ] **3.6 Clear the evidence cache every hour, follow-up folders included.** P2, S, unverified.
  - **Why:** ENG-11. The cache is cleared only at start-up (`desktop-app-server.ts:3449`) and only for `claim-*` folders (`agent-client.ts:456-479`). Follow-up screenshots (`meesho.ts:1058, 1108, 1134`) and the evidence of manual or failed claims are never cleared.
  - **Fix:** run `pruneOldEvidenceFiles` hourly, include `follow-up-*` folders, and skip the folder of the claim currently holding the panel.
  - **Done when:** a test with aged `SYN-` folders shows both kinds removed after 24 hours and the held claim's folder kept.
  - **Rules:** 13.

- [ ] **3.7 Retry backoff, saved panel holds, no dead scheduling code.** P2, S, unverified.
  - **Why:** ENG-14. The round-robin and cooldown code is never called (`panel-queue.ts:4-11, 88, 130`). Panel holds live only in memory (`:47`). A failed job is leased again on the very next poll (`server/claim-automation-service.ts:842-845, 601`), so a portal change uses up all 3 attempts in about a minute.
  - **Fix:**
    - Connect or delete round-robin and cooldown, and fix the docs.
    - Add a `next_attempt_at` backoff column (added, not replacing anything), for example 2, 10 and 30 minutes.
    - Save holds, or work them out from the server's job stages.
  - **Done when:** tests show a failed job is not leased again before its backoff ends, and a hold survives an engine restart.
  - **Depends on:** 3.1. **Rules:** 6, 14.

- [ ] **3.8 Restore the AI assistant's safety instruction.** P2, S, unverified (the engine auditor ran the expression with node).
  - **Why:** ENG-10 and TH-10.
    - A stray `+` at `desktop-app-server.ts:499-501` makes the prompt end in `NaN`, which drops the instruction never to invent ticket IDs, evidence or credentials.
    - The other AI path sends the step name as its system prompt (`ai-center-assist.ts:150`).
    - The validator checks only `ticketRef` (`ai-assistant.ts:183-191`).
    - AI is advisory only and is not used in filing.
  - **Fix:** remove the `+`, give the routed path one shared system prompt, and reject drafts that contain 9 to 15 digit numbers other than the known ticket.
  - **Done when:** a unit test shows both paths send a prompt containing "Never invent", and a draft with a made-up ticket number is rejected.

- [ ] **3.9 Remove the old in-memory popup download.** P2, S, unverified.
  - **Why:** DESK-UPD-07. `desktop/main.ts:614-616` holds the whole file in memory and writes it straight to its final name. `:988-995` still sends popups to it, although `docs/DESKTOP-APP.md:111-112` says it was removed.
  - **Fix:** delete `downloadUpdateAsset`, and make the popup handler refuse (or use the streaming path).
  - **Done when:** a modified click on an http(s) link no longer starts a download, and no download reads the whole file into memory.
  - **Rules:** 13.

- [ ] **3.10 Make the evidence "Download" link on the Claims page work.** P2, S, unverified.
  - **Why:** DESK-UI-01. `desktop/renderer/src/pages/Claims.tsx:169, 200` links to the engine's address, and `main.ts:939-944` blocks that navigation, so the click most likely does nothing.
  - **Fix:** fetch the file inside the app and save it from a local link, or add a streaming download call to both bridge files. Add the case to `desktop/gui-acceptance.mjs`.
  - **Done when:** in the installed app, Download saves the file to Downloads, and the acceptance script covers it.
  - **Rules:** 10, 19.

- [ ] **3.11 Register download and screen listeners once.** P2, S, unverified.
  - **Why:** DESK-WIN-01. Rebuilding the window after an engine retry (`main.ts:1331-1334`) adds the `will-download` listener (`:818`) and the `display-metrics-changed` listener (`:887`) again.
  - **Fix:** register both once, at module level.
  - **Done when:** after a simulated retry, one download produces one notification.

- [ ] **3.12 Test the bridge contract; check who is calling.** P2, S, unverified.
  - **Why:** DESK-IPC-01. `preload.cjs:11-64` and `global.d.ts:70-85` match today (14 members each), but no test enforces it. The handlers at `main.ts:1156-1248` never check who sent the call. `desktop:notify` does not check its payload's type.
  - **Fix:** add a node test that compares the two member lists, check the sender on every handler, and type-check the notify payload.
  - **Done when:** the test fails if one file gains a member the other lacks, and a call from any page other than the app is refused.
  - **Depends on:** 3.5 and 3.10 (both change the bridge). **Rules:** 19.

**Phase 3 exit, checked on the test PC:**
- The memory limit is logged at about 352 MB.
- Idle CPU is under 0.5% while hidden.
- In approval mode, a panel held for 60 minutes or more does not fail the queued claims.
- A forced hang leaves no Chromium processes behind.

---

## Phase 4: Meesho filing

**In plain words:** never file the same claim twice, never file the wrong details, and make the form match what Meesho actually shows today.

| Proposed PR | Items |
|---|---|
| 4-A `fix(automation): auto-submit jobs enter a submitting stage before the click; ticket journal` | 4.1 |
| 4-B `fix(automation): one active job per claim; lock only the job row` | 4.2, 4.9 |
| 4-C `fix(claims): unified-create leaves filed claims alone` | 4.3 |
| 4-D `feat(meesho): callback number, 1000-character description, all attachments, stricter upload check` | 4.4, 4.7 |
| 4-E `perf(meesho): hold the queue only for sign-in problems; reuse the prepared form; step timings` | 4.5 |
| 4-F `feat(meesho): <category> steps` (one PR per agreed category) | 4.6 |
| 4-G `fix(claims): server-side Meesho description text, signed per account` | 4.8 |

- [ ] **4.1 Fully automatic mode marks a job "submitting" before clicking Submit.** P0, M, confirmed.
  - **Why:** ENG-02 and SRV-06.
    - Auto-submit jobs are leased as `downloading_media` (`server/claim-automation-service.ts:613`) and report no progress until the end (`desktop-app-server.ts:288-293`). The engine is not allowed to set `submitting` itself (`:815-817`).
    - An error after the click (`meesho.ts:910-966`) is reported as `failed`, and the job goes back in the queue (`:842-845`). An expired lease also goes back in the queue (`:543-557`).
    - `completeJob` is a single attempt with no local record (`agent-client.ts:496-510`). After 15 minutes the server refuses both the completion and progress reports (`:1211-1214, 834-837`).
    - The only thing stopping a second ticket is the portal's own ticket-table check (`meesho.ts:405-418`), which has not been checked against the live portal.
  - **Fix:**
    1. Add a new server stage that the engine reports right before the click. It renews the lease, and an expired lease in that stage goes to manual, never back to the queue.
    2. Mark the outcome as unknown before any run that may submit, and make the post-click code return manual instead of throwing an error.
    3. Retry `completeJob` with backoff, and keep a local pending-ticket journal written with `writeSecretFile` under `AGENT_DATA_DIR`, replayed at start-up.
    4. Renew the lease during long steps. Accept completion from the same engine if its lease expired but nobody else took the job. Send a `failed` reported after a submit attempt to manual.
  - **Done when:**
    - Tests show: an error after the click leads to manual_intervention_required and never back to the queue; with the network down during completion, the ticket is recorded after restart from the journal; a 20-minute run with lease renewals keeps its lease; the same engine can complete after a quiet expiry.
    - One supervised live auto-submit run succeeds.
  - **Depends on:** 3.2. **Rules:** 6 (the new stage only adds), 14, 15, 16, 20.
  - **Needs you:** a supervised live run with the production Meesho session.

- [ ] **4.2 At most one active filing job per claim.** P1, M, confirmed.
  - **Why:** SRV-05.
    - Only a non-unique index exists on the claim column (`server/schema-claim-automation.sql:66`).
    - Job creation checks and then inserts, outside a transaction, and adds a new job after a `failed` one (`claim-automation-service.ts:444-477`).
    - Retry puts a job back in the queue without checking for other jobs on the same claim (`:1366-1440`).
    - The poll locks the job row, not the claim (`:582-603`).
  - **Fix:** after checking production for existing duplicates, add a partial unique index on `claim_id` for active stages. Insert with `ON CONFLICT DO NOTHING`, and refuse a retry while another active job exists.
  - **Done when:** a DB test shows that concurrent creation, and a retry after a new job exists, leave exactly one job that can be leased, and start-up applies the index cleanly on a copy of production data.
  - **Rules:** 6.
  - **Needs you:** a read-only duplicate check on production, or approval for an agent to run one. Without it, the new index could stop the server from starting.

- [ ] **4.3 unified-create leaves an existing claim alone.** P1, M, confirmed.
  - **Why:** SRV-04.
    - When a claim already exists, `server/claim-automation-routes.ts:218-226` carries on, and `:255-281` overwrites the amount, sub-order, AWB, packet ID and content with no status check and no audit row.
    - The bot files with those values (`claim-automation-service.ts:757-758`).
    - `:292-302` together with `:985-1018` replaces a real Meesho ticket code with Draft/CLM-id in the register.
    - `meesho-claims.ts:330, 359` accept any subOrderId.
  - **Fix:**
    - For an existing claim, return it unchanged, or fill only empty values before filing, with an audit row.
    - Sync the register ticket only when no ticket exists.
    - Reject a sub-order or AWB that does not belong to the scan's expected return items.
  - **Done when:** DB tests show a second unified-create on a filed `SYN-` claim changes nothing and writes no Draft ticket, a sub-order from another return is rejected with 400, and any allowed change writes an audit row.
  - **Depends on:** 2.3 (same route; merge in order). **Rules:** 3.

- [ ] **4.4 Match the live Meesho form: Callback Number, 1,000-character description, all attachments.** P1, M, confirmed in the code (the live form is not verified).
  - **Why:** ENG-04.
    - Callback Number is filled only from a field the server never sends (`meesho.ts:630-661`; nothing in `server/*.ts` sets it).
    - The description is typed past any length limit with no 1,000-character cap (`meesho.ts:828-852`, `native-browser-view.ts:1453-1474`), and the server allows 2,000 (`claims-service.ts:39`).
    - A single generic Attachments box receives one image and never the video (`meesho.ts:706-707`).
    - The form only counts as open when a "Sub Order" field is present (`:503, 511-519`).
    - The portal map has not been checked against the live portal (`docs/notes/meesho-portal-map-v1.md:1-6`).
  - **Fix:**
    - Store a callback number per account and send it. Fail fast if Meesho requires it and it is missing.
    - Cap the description at 1,000 characters on both the server and the engine, keeping the reference block intact.
    - Attach all mapped evidence to a single Attachments box and check each file.
    - Capture the live form for each category into portal map v2, with test fixtures.
  - **Done when:**
    - Fixture tests built from cleaned live captures with `SYN-` values fill Callback Number, keep the description at 1,000 characters or less with references intact, and attach every file including the video.
    - A missing callback number goes to manual straight away instead of after a 20 s wait.
  - **Rules:** 6, if a column is added.
  - **Needs you:** a live Meesho session to capture the current Raise-a-Ticket form for each category, and the callback number to use.

- [ ] **4.5 Reach 150 claims a day: hold the queue only for sign-in problems.** P1, M, confirmed in structure; the throughput figures are estimates.
  - **Why:** ENG-08.
    - The estimate is 1.5 to 3 minutes per automatic claim, so 20 to 40 an hour. It comes from fixed waits in the code (`meesho.ts:990-1009, 924-951`) and letter-by-letter typing (`native-browser-view.ts:1453-1474`).
    - Approval mode fills the whole form again after approval (`portal-login.ts:184`) and waits for a person between claims.
    - Any manual hold stops all Meesho filing (`panel-queue.ts:101-104`).
    - A one-time code wait can last up to 180 s (`portal-login.ts:193`).
    - Only 3 real tickets have ever been filed (`docs/notes/meesho-verification-2026-11-17.md:21`).
  - **Fix:**
    - Hold the panel only for sign-in or one-time-code problems.
    - Send problems with one claim's data to manual without holding the queue.
    - Reuse the prepared form in approval mode.
    - Paste long text instead of typing it.
    - Log how long each step takes.
  - **Done when:** per-step timings are logged, a claim with missing evidence goes to manual while the next claim carries on, and a measured day of live filing gives a real claims-per-hour figure, recorded in the handoff.
  - **Depends on:** 3.1, 4.1.
  - **Needs you:** decide whether production Meesho runs in fully automatic or approval mode for the 150-a-day target.

- [ ] **4.6 Category-specific steps for the agreed categories.** P2, L, confirmed (lowered because it fails safely: it goes to manual rather than filing wrongly).
  - **Why:** ENG-09. Five issue codes share one generic flow (`meesho.ts:13-19, 420-852`). There is no item selection step for missing_items, even though `server/meesho-claims.ts:115-130` lists the items. None of this has been checked against the live portal.
  - **Fix:** agree the four categories, capture each live form, and add steps and tests per category. Keep categories that are not yet checked in approval mode.
  - **Done when:** each agreed category has a fixture test and one supervised live filing, and categories not yet checked cannot submit automatically.
  - **Depends on:** 4.4.
  - **Needs you:** which four categories the plan means, and live access or sample orders for each.

- [ ] **4.7 Stricter check that Meesho accepted each upload.** P2, S, unverified.
  - **Why:** ENG-12. `meesho.ts:785` counts an upload as accepted when the file input holds a file, which its own comments at `:232-237, 771-773` say should never count. The error check at `:783` can misread helper text such as "Max size limit 5 MB".
  - **Fix:** require a signal from the portal (file name, thumbnail or success chip), and only count error text that appears after the upload.
  - **Done when:** fixture tests show a file input with no portal signal is not counted as accepted, and helper text such as "(required)" is not counted as an error.
  - **Depends on:** 4.4.

- [ ] **4.8 Clean claim description text, signed per account.** P2, S, unverified.
  - **Why:** AND-13.
    - The default text has typos (`ClaimCaptureActivity.kt:618`).
    - Every account signs with the same hard-coded name (`:583, 594, 604, 614, 623`).
    - The issue is taken from the first item only (`ReturnVerificationBottomSheet.kt:350`).
    - Unmapped issue codes default to "wrong return" (`ClaimCaptureActivity.kt:231-238`).
  - **Fix:** build descriptions from server-side templates signed per account, fix the text, use the first item that actually has an issue, and make the operator choose when the code does not map.
  - **Done when:** tests show each account's own signature, and no default category for unmapped codes.
  - **Needs you:** the ticket signature or brand for each Meesho account.

- [ ] **4.9 The job poll locks only the job row.** P2, S, unverified.
  - **Why:** SRV-13. `server/claim-automation-service.ts:590-603` uses `FOR UPDATE SKIP LOCKED` without `OF j`, so it also locks the joined marketplace, claim and scan rows. The follow-up lease does this correctly (`claim-follow-up-service.ts:307`).
  - **Fix:** change it to `FOR UPDATE OF j SKIP LOCKED`.
  - **Done when:** a DB test shows that an open transaction inserting a Meesho claim does not make the poll return "no job".

---

## Phase 5: Claim tracking

**In plain words:** read each ticket's real status, never mark a claim approved by mistake, never lose ticket history, and keep up with the volume.

| Proposed PR | Items |
|---|---|
| 5-A `fix(follow-ups): pending wording never closes a ticket; status only moves forward` | 5.1, 5.2 |
| 5-B `fix(register): scan correction supersedes rows instead of deleting them` | 5.3 |
| 5-C `fix(engine): follow-ups open the panel, detect sign-in and work through due tickets` | 5.4, 5.5 |
| 5-D `fix(claims): SPF claims are transactional, audited and visible` | 5.6 |
| 5-E `fix(meesho): ticket-page reader reads only the ticket` | 5.7 |
| 5-F `feat(claims): ticket ID and submitted time on claims; screenshot upload` | 5.8 |
| 5-G `fix(live): announce phone-created claims; drop revoked sockets; scope ticket events` | 5.9 |

- [ ] **5.1 "Pending approval" must never close a ticket as approved.** P0, S, confirmed.
  - **Why:** SRV-01.
    - `server/claim-follow-up-service.ts:47-49` checks the approved pattern before the pending/awaiting pattern. The rejected exceptions cover only "not approved", "not eligible" and "closed without".
    - The server overrides the desktop's correct reading (`:394-397`), stops tracking (`:150`) and sets the claim to approved (`:493-512`).
    - Reproduced with tsx: "Pending approval", "Awaiting approval", "Approval pending", "Claim not accepted" and "Refund not credited" all come back as approved and final.
    - None of these phrases is tested (`server/tests/claim-follow-up.test.ts:38-60`).
  - **Fix:** check pending, awaiting and not-yet wording first. Add the exceptions "not accepted", "not settled" and "not credited". When the server and the desktop disagree, keep the less final result.
  - **Done when:**
    - Tests cover each phrase above and none comes back as approved: each is either still open or rejected.
    - A disagreement between server and desktop never produces a final status.
    - The existing tests still pass.
    - Then check production for follow-ups already closed this way. None is confirmed, because the auditors had no database access. Re-open any that are found.
  - **Needs you (optional):** one live Meesho ticket page to confirm the real wording, and approval to run the production check.
  - **Production check (read-only, no writes).** `suspect` marks ticket text with waiting or negated wording that the fixed rules no longer read as approved. Query 1 reads every follow-up check the old rules took as approved or paid, query 2 the claims a follow-up moved to approved or paid, and query 3 (item 5.2) the claims a follow-up moved out of paid or reconciled, or set paid without payout data.

    ```sql
    -- 1
    SELECT f.id AS follow_up_id, f.claim_id, c.status AS claim_status_now, f.marketplace_claim_id,
           f.is_active, f.stop_reason, e->>'at' AS checked_at, e->>'normalizedStatus' AS read_as,
           e->>'statusText' AS ticket_text,
           (e->>'statusText') ~* 'pending|await|\myet\M|review|in\s*progress|on\s*hold|verification|action\s+required|(\mnot|\mnever|\mcannot|n[''’]t)\s+(\w+\s+){0,3}(approved|accepted|eligible|settled|credited|paid)\M' AS suspect
    FROM claim_automation_follow_ups f
    JOIN claims c ON c.id = f.claim_id
    CROSS JOIN LATERAL jsonb_array_elements(f.history) AS e
    WHERE e->>'outcome' = 'status_read' AND e->>'normalizedStatus' IN ('approved', 'paid')
    ORDER BY suspect DESC, checked_at DESC;

    -- 2
    SELECT h.claim_id, h.from_status, h.to_status, h.changed_at, h.reason, c.status AS claim_status_now,
           h.reason ~* 'pending|await|\myet\M|review|in\s*progress|on\s*hold|verification|action\s+required|(\mnot|\mnever|\mcannot|n[''’]t)\s+(\w+\s+){0,3}(approved|accepted|eligible|settled|credited|paid)\M' AS suspect
    FROM claim_status_history h
    JOIN claims c ON c.id = h.claim_id
    WHERE h.changed_by IS NULL AND h.reason LIKE 'Follow-up check:%' AND h.to_status IN ('approved', 'paid')
    ORDER BY suspect DESC, h.changed_at DESC;

    -- 3
    SELECT h.claim_id, h.from_status, h.to_status, h.changed_at, h.reason, c.status AS claim_status_now,
           c.paid_amount, c.payout_reference
    FROM claim_status_history h
    JOIN claims c ON c.id = h.claim_id
    WHERE h.changed_by IS NULL AND h.reason LIKE 'Follow-up check:%'
      AND (h.from_status IN ('paid', 'reconciled')
           OR (h.to_status = 'paid' AND (c.paid_amount = 0 OR c.payout_reference = '')))
    ORDER BY h.changed_at DESC;
    ```

    If rows are found, delete nothing (rule 3). Open each ticket on the supplier portal and note its real state; a claim the portal really approved or paid needs nothing. The app cannot undo a wrong approval (`CLAIM_TRANSITIONS` lets approved move only to reconciled, and follow-ups refuse backward moves), so a wrong one needs a one-off correction you approve, run in one transaction after a backup: set the claim's true status, add a `claim_status_history` row (`changed_by` = your user, reason naming checklist 5.1 and the ticket text) and a `register_audit_log` row, and, when the ticket is still open, re-arm its follow-up (`is_active = true`, `stage = 'scheduled'`, `stop_reason = ''`, `next_check_at = now()`, `lease_expires_at = NULL`, `agent_id = NULL`).

- [ ] **5.2 Follow-ups only move a claim's status forward.** P1, S, confirmed.
  - **Why:** SRV-02. `server/claim-follow-up-service.ts:458-520` writes any status that differs, without checking the transition rules. It bypasses `CLAIM_TRANSITIONS` (`claims-service.ts:152-167`) and the rule that "paid" needs payout data (`:1148-1149`). Nothing stops a follow-up after a claim is settled by hand.
  - **Fix:**
    - Run follow-up results through the transition rules, so a claim never leaves paid or reconciled.
    - Record a portal "paid" as approved with a note, unless payout details are present.
    - Stop the follow-up when someone reconciles or pays a claim by hand.
  - **Done when:** DB tests show a reconciled `SYN-` claim stays reconciled after an "under review" reading, and "payment processed" without payout data does not set the claim to paid.
  - **Depends on:** 5.1 (same PR). **Rules:** 3.

- [ ] **5.3 Scan correction keeps old rows instead of deleting them.** P1, M, confirmed.
  - **Why:** SRV-07. `server/register-service.ts:1279-1287` deletes claim_ticket_history, claim_tickets and receipt_scan_issues. `:1307` blanks the flyer ID. There is no check for an already-filed claim and no time window (`:1220-1444`). This breaks rule 3.
  - **Fix:** add `is_active` and `superseded_at` columns (added, not replacing anything) and mark old rows superseded. Refuse a correction when a claim or job exists, and allow corrections only during the bench session.
  - **Done when:** a DB test shows correcting a `SYN-` scan keeps every old ticket and history row, marked superseded, and a correction on a scan that has a claim returns 409.
  - **Rules:** 3, 6.

- [ ] **5.4 Follow-up checks open the panel and detect an expired sign-in.** P1, S, confirmed by reading the code (not run live).
  - **Why:** ENG-05.
    - The follow-up opens a fresh browser view (`desktop-app-server.ts:704-735`, `native-browser-view.ts:1161-1170`). `checkClaimStatus` (`meesho.ts:1040-1095`) does navigate to the ticket page and falls back to the Support table, but it can only build those addresses once it has the seller slug.
    - The slug comes from the current page address or `portal_url`, and neither contains it on a fresh view (`meesho.ts:1044-1049`, `schema-claim-automation.sql:85-88`), so the check returns "panel address not found" before navigating.
    - Empty text is reported as not_found (`desktop-app-server.ts:744-751`), and 3 in a row stop the follow-up (`claim-follow-up-service.ts:21, 157-161`).
    - An expired session is never reported as login_required (`desktop-app-server.ts:675-676`).
  - **Fix:** store the seller slug per panel after a successful filing (or read it once from the panel home), so `checkClaimStatus` can build the ticket and Support addresses; and return login_required when the sign-in or one-time-code page appears.
  - **Done when:**
    - A fixture test starting from a blank page reads the ticket.
    - A sign-in page fixture returns login_required, which the server already handles without using up a check.
    - One live follow-up run reads a real ticket.
  - **Rules:** 14, 16, 20.
  - **Needs you:** one live follow-up run with the production Meesho session, and the current Meesho `portal_url` value.

- [ ] **5.5 Follow-ups keep up with 150 claims a day.** P1, S, confirmed.
  - **Why:** ENG-06. The engine runs one check every 30 minutes (`desktop-agent/src/config.ts:93`, `desktop-app-server.ts:807-819`) and the server hands out one ticket per check (`claim-follow-up-service.ts:306`). That is at most 48 checks a day, and about 2 a night in nightly-only mode (`:644-646`). Demand is about 75 checks a day for each day a ticket stays open.
  - **Fix:** after a check that found a due ticket, run the next one a few seconds later, until none are due; then wait 30 minutes. Optionally read several tickets per browser session. Always give way to filing through poll-guard.
  - **Done when:** a test processes 10 due follow-ups back to back while a filing cycle can still interrupt, and over a day the dashboard shows no growing backlog of due checks.
  - **Depends on:** 5.4. **Rules:** 14.

- [ ] **5.6 SPF claims: one per record, audited, visible in the queue.** P1, M, confirmed.
  - **Why:** SRV-10.
    - `server/return-tracking.ts:1013-1060` checks and then inserts, with no transaction or row lock.
    - `return_tracking_id` has only a non-unique index (`schema-return-tracking.sql:64-66`).
    - No history or audit row is written.
    - The list, detail and evidence screens all require a receipt scan (`claims-service.ts:628, 656, 729, 1404`), so these claims never appear and cannot take evidence.
  - **Fix:**
    - Run in a transaction that locks the tracking record.
    - After removing duplicates, add a partial unique index on `return_tracking_id`.
    - Write the first history row and an audit row.
    - Show claims without a receipt scan in the queue (or add a separate SPF queue).
  - **Done when:** a DB test shows two simultaneous SPF requests create one claim with a history row, and that claim appears in the queue and accepts evidence.
  - **Rules:** 3, 6.
  - **Needs you:** a read-only duplicate check on production before the index is added.

- [ ] **5.7 The ticket-page reader looks only at the ticket.** P2, S, unverified.
  - **Why:** ENG-13.
    - "Resolved" counts as approved (`meesho.ts:151-164`).
    - The first matching short line wins, and it can be navigation text (`:198-206`). This contradicts `:80-81`.
    - The server has no "resolved" pattern and ignores the desktop's reading (`claim-follow-up-service.ts:47-56, 391-397`).
  - **Fix:**
    - Read only inside the ticket's own section of the page.
    - Look for rejected, approved or paid wording before falling back to status chips.
    - Report "resolved" as text to review, not as approval.
    - Build fixtures from real pages.
  - **Done when:** fixture tests from saved pages classify approved, rejected and pending correctly and pull out the rejection reason.
  - **Depends on:** 5.1.
  - **Needs you:** a few saved live ticket pages (approved, rejected, pending).

- [ ] **5.8 Store the Meesho ticket ID and submitted time on the claim.** P2, M, unverified.
  - **Why:** SRV-11.
    - Claims have no ticket or submitted-time column (`server/schema-claims.sql:65-89`).
    - The reconciliation export has no ticket ID (`claims-routes.ts:122-125`).
    - The submission screenshot exists only as a path on the desktop PC (`claim-automation-service.ts:1236`, `meesho.ts:372, 386, 574`).
    - Approval history hard-codes where the approval came from (`:1353`).
  - **Fix:** add the columns (added, not replacing anything), set them on completion and include them in the export. Add an engine endpoint that uploads the screenshot to evidence storage, and write the real previous status in the history.
  - **Done when:** completing a `SYN-` job fills both columns, the export shows the ticket ID, and the screenshot opens from the web console.
  - **Depends on:** 4.1 (it changes the same completion code). **Rules:** 6, 20 (engine part).

- [ ] **5.9 Live updates: announce phone-created claims, drop revoked connections, keep ticket events to their account.** P2, S, unverified.
  - **Why:** SRV-14. unified-create never announces the new claim (`server/claim-automation-routes.ts:84-312`). A live connection's account scope is fixed when it connects (`live.ts:95-110`). Ticket updates go to every account (`register-routes.ts:310`).
  - **Fix:** announce after creating a claim, re-check sessions on each tick, and send ticket events with their marketplace ID.
  - **Done when:** tests show a phone-created claim reaches a connected web screen immediately, a logged-out connection is closed, and another account's screen receives no ticket event.
  - **Depends on:** 4.3. **Rules:** 1.

---

## Phase 6: End-to-end testing

**In plain words:** prove automatically that a claim gets from the phone to a filed and tracked ticket, then prove it once live.

| Proposed PR | Items |
|---|---|
| 6-A `test(claims): full claim-lifecycle DB test; claim and job created together` | 6.1 |
| 6-B `test(meesho): saved page fixtures; filing with an expired session` | 6.2 |
| 6-C `test(desktop): post-install smoke check` | 6.3 |
| 6-D `test: run every tracked test file; fix return-tracking tests` | 6.4 |

- [ ] **6.1 One automated test for the whole claim journey; no claim left without a job.** P1, L, confirmed.
  - **Why:** TH-04.
    - No test covers unified-create or job creation.
    - `server/claim-automation-routes.ts:284-289` only logs a failed job insert and still returns 201 with `jobId: null` (`:307`). Nothing ever puts such a claim back in the queue.
    - Each stage is tested only on its own, and `meesho-issues.test.ts:262-275` never drives the filing flow.
  - **Fix:**
    - Add a DB-backed test with `SYN-` data that runs unified-create, then evidence, then poll, then a fake automation returning a ticket, then completion, follow-up creation, lease and result recording, and finally checks the register ticket and status.
    - Create the job in the same transaction as the claim, or add a sweep that re-queues claims without a job.
  - **Done when:** the test runs green in CI, and a forced job-insert failure leaves no claim without a job (or the sweep re-queues it within its interval).
  - **Depends on:** 2.3, 4.1, 4.2, 4.3, 5.1, 5.2.

- [ ] **6.2 Saved Meesho page fixtures; filing with an expired session.** P1, M, confirmed (a coverage gap, not a defect).
  - **Why:** TH-07. The repo has no saved HTML pages. `meesho-ticket-page.test.ts` uses made-up strings. No test files a claim with an expired session.
  - **Fix:** use cleaned page captures (sign-in, support category, form, ticket page) with `SYN-` values and run the filing and reading code against them offline. Add an engine test where an expired session parks the job as manual_intervention_required.
  - **Done when:** both run in CI, and changing a captured page element makes a test fail.
  - **Depends on:** 4.4, 5.4. **Rules:** 9.
  - **Needs you:** cleaned HTML captures from a live session.

- [ ] **6.3 Post-install check for the scheduled task and autostart.** P1, M, confirmed (coverage gap).
  - **Why:** TH-07. No test covers the `ReturnAppClaimBot` scheduled task or a reinstall. `docs/notes/agent-handoff.md:107` lists installed-app and upgrade tests as not built. The task was found missing on 2026-11-13.
  - **Fix:** write a smoke script that checks the task, its arguments (including the memory flag from 3.4) and the Windows Run key, and run it in acceptance testing after every install and upgrade.
  - **Done when:** the script passes on the test PC after a fresh install, after an upgrade and after a reboot.
  - **Depends on:** 3.4.
  - **Needs you:** the test PC and a reboot.

- [ ] **6.4 Run every test file; fix the forgotten one.** P2, S, confirmed (the claim-aging bug cannot happen in production).
  - **Why:** TH-03. `server/tests/return-tracking.test.ts` is the only tracked test file missing from the `npm test` list. Run on its own, it fails 4 of 15 tests. The checker found that the 1970 placeholder date is already cleaned earlier in the real import path (`return-tracking.ts:420-423`), and the other three failures look like outdated tests.
  - **Fix:**
    - Make `cleanDateStr` treat anything starting with `1970-01-01` as empty, as a second safeguard.
    - Settle the three outdated assertions.
    - Add the file to the test list, plus a CI check that every tracked test file is listed (or switch to a glob).
  - **Done when:** `npm test` includes the file and passes, and leaving a test file off the list fails CI.
  - **Needs you:** should a return still in transit show a filing deadline? What does Myntra's CSV put in an empty return_created_date?

- [ ] **6.5 Live end-to-end run (phase exit).** This is not a finding; it comes from the plan and from TH-04.
  - **Steps:** scan a real return on a warehouse phone and capture evidence. The desktop files the claim on Meesho, the ticket is recorded, and a follow-up reads it. Record what ran and what was seen in the handoff (rule 11).
  - **Depends on:** 6.1 to 6.4, and Phases 2 to 5.
  - **Needs you:** a live Meesho session, a real return, a phone and the desktop PC.

---

## Phases 12 to 15: release management, auto-update, update UI, CI pipeline (with 16, CodeRabbit)

**In plain words:** get the leaked secrets out, make updates safe to install, and make sure nothing reaches production or a release without passing the checks.

Items 12.1, 12.2, 12.3 and 15.1 are recommended to start now (see "Where things stand").

For each credential: rotate it first, then store the new value as a secret or VPS env value, then merge the code change. Otherwise production loses the connection.

| Proposed PR | Items |
|---|---|
| 12-A `security(android): signing key only from secrets; pinned signer` | 12.1 |
| 12-B `security(deploy): no literal fallbacks in the deploy workflow` | 12.2 |
| 12-C `security(whatsapp): no default gateway credential or contacts` | 12.3 |
| 12-D `fix(mobile-release): fallback follows the published release; no borrowed hash` | 12.4 |
| 12-E `ci(android): lint gate, rising versionCode, dead workflow removed, api_url passed` | 12.5 |
| 12-F `ci(release): generated release notes; stricter version guard` | 12.6, 12.7 |
| 12-G `ci(release): prerelease channel and promotion` | 12.8 |
| 13-A `security(desktop): safe installer file name` | 13.1 |
| 13-B `security(desktop): https allowlist, size and SHA-256 check` | 13.2 |
| 13-C `fix(desktop): finish the running claim before installing or quitting` | 13.3 |
| 13-D `feat(desktop): update marker, install result, recovery from a cancelled install` | 13.4 |
| 13-E `fix(desktop): one update download at a time, with timeout and cancel` | 13.5 |
| 13-F `fix(desktop): update check uses the desktop app's own version` | 13.6 |
| 14-A `feat(desktop): release date, notes, size and install result on the update screen` | 14.1 |
| 14-B `feat(android): mandatory updates, release notes, version display` | 14.2 |
| 15-A repository settings, plus `ci: deploy and publish wait for CI` | 15.1 |
| 15-B `fix(deploy): images tagged by commit, automatic rollback, safe env write` | 15.2 |
| 15-C `ci(db): schema guard catches dropped columns; upgrade-path test` | 15.3 |
| 15-D `ci: ESLint, CodeQL, dependency review, Dependabot, gitleaks` | 15.4 |
| 15-E `ci: Playwright smoke test` | 15.5 |
| 15-F `ci(deploy): path allowlist, pinned host key, non-root deploy user` | 15.6, 15.7 |
| 15-G `docs: correct versions, test counts and described behaviour` | 15.8 |
| 16-A `chore: CodeRabbit configuration` | 16.1 |

### 12. Release management

- [ ] **12.1 Replace the leaked Android signing key.** P0, M, confirmed.
  - **Why:** AND-01 and REL-01, plus the signer pin from AND-11.
    - `android/app/release.keystore` is tracked in a public repo (added in 0962d4f).
    - Its passwords and alias are written in plain text in `android/app/build.gradle:29-36, 44-51` and `.github/workflows/return-scan-apk.yml:92-94`.
    - When the secret is missing, `:79-86` falls back to the committed file. Debug builds also sign with the release key.
    - CI checks that the signature is valid but never which key made it (`:132-136`).
    - The GitHub secret was set a minute before the commit and the same passwords are used, so it is very likely the same key. Nobody compared the key fingerprints.
    - Deleting the file does not help, because git history keeps it.
  - **Fix:**
    - Create a new key held only in GitHub secrets, remove every plain-text password, and make CI fail if the secret is missing.
    - Delete the file.
    - Rotate using Android's key-rotation scheme (APK Signature Scheme v3), so installed phones on Android 9 or newer accept the new key. Older phones need a reinstall.
    - Pin the expected signer fingerprint in CI.
    - Optionally, have the updater compare signers before installing.
  - **Done when:**
    - `git grep` finds no keystore and no password text.
    - A workflow run without the secret fails.
    - CI fails if the signer fingerprint differs.
    - A phone running the current app installs the first update signed with the new key, in place.
  - **Rules:** 8, 12.
  - **Needs you:**
    - Choose between rotating in place (APK Signature Scheme v3) and reinstalling, with a plan for any phones older than Android 9.
    - Create the new key and the secrets.
    - Decide whether to purge git history.
    - Provide a phone for the upgrade test.

- [ ] **12.2 Remove the Postgres password from deploy.yml.** P0, S, confirmed.
  - **Why:** REL-02 and TH-02.
    - `.github/workflows/deploy.yml:101` falls back to a written-out database address with a user name and password, there since d000f29. When the secret is not set, `:125` writes it into the production .env.
    - `:102` has a Sentry address fallback, which is low risk.
    - The database host is a Docker-internal name, so whether it can be reached from the internet depends on the VPS firewall, which was not checked.
    - Generic secret scanning is switched off.
  - **Fix:** delete both fallbacks, make the job fail if `VMS_DATABASE_URL` is missing, and turn on non-provider secret scanning.
  - **Done when:** `git grep` finds no database address in the code, a run without the secret fails, and production still connects after the password change.
  - **Rules:** 8.
  - **Needs you:** rotate the VMS/packing database password, confirm the GitHub secret is set, and confirm port 5432 is not open on the VPS.

- [ ] **12.3 Remove the WhatsApp gateway login and contact numbers.** P0, S, confirmed.
  - **Why:** TH-01 (also noted under REL-02).
    - `server/whatsapp.ts:30` and `scripts/vps-watchdog.sh:15` fall back to the same user:password text. It has been there since b181524 (2026-11-03), earlier than the handoff says.
    - `whatsapp.ts:31-34` also hard-code a group ID, two personal phone numbers and a name.
    - It used to be in `scripts/vps-postgres-backup.js` too, and is still in that file's history.
    - `docs/notes/phase1-audit-matrix.md:52` still says no credentials are hardcoded.
  - **Fix:** remove the defaults so WhatsApp stays off when its settings are missing, move the IDs and the name to env settings, and correct the handoff and the audit matrix.
  - **Done when:** `git grep` finds none of the values, a unit test shows nothing is sent without settings, and alerts still arrive after rotation.
  - **Rules:** 8.
  - **Needs you:** rotate the gateway login, set the new values on the VPS, and decide whether to purge git history (or accept that the old value stays public once it is rotated).

- [ ] **12.4 The phone's fallback manifest follows the published release; no borrowed hash.** P1 per the Android audit, P2 per the release audit; S; confirmed.
  - **Why:** AND-07, REL-08 and TH-09.
    - `data/return-scan-release.json` and `server/mobile-release.ts:21-31` pin 1.0.58, whose release was deleted (404).
    - After a server restart, `/download/return-scan.apk` points there until some phone calls `/api/app/latest` (`:140, 160-163`).
    - If GitHub stops sending a file hash, the server uses 1.0.58's hash instead (`:81`), so every update would fail as "corrupted".
    - The GitHub request has no timeout and failures are not cached (`:42, 118-123`).
    - This breaks rule 12. Phones already on 1.0.63 are not offered a downgrade (`AppUpdater.kt:86`).
  - **Fix:**
    - Offer no update when the hash is missing, and make the phone refuse a blank hash.
    - Have the APK workflow update the manifest, or publish it as a release file.
    - Add a timeout and a short cache for failures.
    - Resolve the download link the same way as the manifest route.
  - **Done when:** tests show a missing hash means no update and the fallback always names a release that still exists, and after a server restart the download link, checked with curl on production, points at a live release.
  - **Rules:** 12.

- [ ] **12.5 Android build pipeline hardening.** P2, S, unverified.
  - **Why:** AND-11 and REL-14.
    - Lint can never fail the build (`android/app/build.gradle:86-89`).
    - versionCode is 10000 plus the workflow run number (`:16-18`), so it resets if the workflow is renamed.
    - No Play Store bundle (AAB) is built.
    - A stale copy at `android/.github/workflows/return-scan-apk.yml` never runs.
    - The `api_url` input is never passed to the build (`return-scan-apk.yml:20-23`, `build.gradle:59, 67`).
  - **Fix:**
    - Make lint fail on errors.
    - Base versionCode on a stored number and check it is higher than the latest release.
    - Build an AAB only if the Play Store is in scope.
    - Delete the dead workflow and pass `API_URL`.
  - **Done when:** a lint error fails CI, a run that would publish a lower versionCode fails, and a manual build with `api_url` points at that server.
  - **Depends on:** 12.1 (same workflow). **Rules:** 12.

- [ ] **12.6 Real release notes.** P2, S, unverified.
  - **Why:** REL-12. Desktop releases use fixed text (`desktop-release.yml:150-163`), APK releases a one-line note (`return-scan-apk.yml:203`), and `android/CHANGELOG.md:5` is out of date.
  - **Fix:** use `gh release create --generate-notes` (or git-cliff), with the fixed platform text appended.
  - **Done when:** the next desktop and APK releases list the merged PRs.

- [ ] **12.7 The version guard compares properly and refuses to publish the same version twice.** P2, S, unverified.
  - **Why:** REL-10.
    - The guard runs only on PRs and checks only that the version changed (`desktop-release.yml:76, 81`), so a lower version passes.
    - The direct push 26c6074 published 1.3.5 again as `desktop-v1.3.5.137`, which installed apps cannot see, and pruning deleted the original 1.3.5.
    - Server-only files also force a desktop release (`:11-17, 29-35`).
  - **Fix:** skip or fail publishing when a tag for that version already exists, require the new version to be higher, and limit the trigger paths to files that ship in the installer.
  - **Done when:** a push with an unchanged version publishes nothing, and a PR that lowers the version fails.
  - **Rules:** 20.

- [ ] **12.8 Release channels.** P2, M, unverified.
  - **Why:** REL-11. Every push to main ships straight to stable (`desktop-release.yml:112`, `return-scan-apk.yml:170`). `update-check.ts:91` does not skip pre-releases.
  - **Fix:** publish main as a pre-release (or under beta tags) and promote it to stable by a manual action. Give the updater a channel setting that filters pre-releases.
  - **Done when:** a merge creates a pre-release that installed stable apps ignore, and promoting it makes it visible to them.
  - **Needs you:** the channel model: who promotes a release, and when.

### 13. Auto-update

- [ ] **13.1 The installer's file name cannot escape the Downloads folder.** P2, S, reproduced with node while DESK-UPD-01 was being checked.
  - **Why:** DESK-UPD-06, and the checker notes on DESK-UPD-01 and REL-07. `desktop/main.ts:594-598` decodes the last part of the URL, so `%5C` becomes a backslash and the file can be written outside Downloads. The checker resolved a crafted name to `AppData\Roaming\evil.exe`. Containment is checked only when the installer is run (`:705-712`), after the file is already written.
  - **Fix:** strip the decoded name down to a bare file name, reject `/`, `\` and `..`, guard the decoding, and check the final path is inside Downloads before writing.
  - **Done when:** a node test with the crafted name is refused. This function has no tests today.

- [ ] **13.2 Check the installer before running it.** P1, M, confirmed (the impact is partly overstated).
  - **Why:** DESK-UPD-01 and REL-07.
    - `main.ts:641` accepts http or https links from any host.
    - `:650-676` saves the file with no size or hash check.
    - `update-check.ts:83-91` ignores the file hash and size that GitHub publishes (one exists for 1.3.6).
    - `update-check.ts:17-20` lets a setting replace the update feed.
    - The installer runs with admin rights (`package.json` nsis perMachine), and releases ship only the .exe (`desktop-release.yml:145-164`).
    - With the default feed the link is GitHub over https, so an attack needs a changed feed or a hostile engine.
  - **Fix:**
    - Allow only https links to github.com and GitHub's file hosts.
    - Return the size and SHA-256 from update-check, check both after download, and refuse on a mismatch.
    - Once the installer is signed, check the signer before launching it.
  - **Done when:** tests show an http link, a foreign host, a wrong size and a wrong hash are each refused, and a correct download passes.
  - **Depends on:** 13.1.
  - **Needs you:** decide on, and buy, a Windows code-signing certificate.

- [ ] **13.3 Finish the running claim before installing or quitting.** P2, M, confirmed (lowered because the server parks the job safely).
  - **Why:** DESK-UPD-02.
    - `main.ts:713-724` quits 1.5 s after "Run installer", with no pause and no wait.
    - `before-quit` (`:1418-1423`) stops nothing, and `enginePause` does not wait (`desktop-app-server.ts:3428-3430`).
    - Quitting mid-submit costs a manual check on the portal. Quitting at an earlier stage costs an attempt and a 15-minute wait (`server/claim-automation-service.ts:507-519, 541-557`).
    - Quit from the tray behaves the same.
  - **Fix:** add an engine "drain" that stops new cycles, waits for the current filing or follow-up within the watchdog limits, and releases a queued job's lease. Call it before installing and before quitting, and show "waiting for claim #N" in the update flow.
  - **Done when:**
    - A test shows the drain finishes once the running cycle ends.
    - In the installed app, Run installer during a filing waits, then installs.
    - `docs/DESKTOP-APP.md:102` matches.
  - **Depends on:** 3.2. **Rules:** 14, 20.

- [ ] **13.4 Know whether an update installed, and recover if it did not.** P1, L, confirmed.
  - **Why:** DESK-UPD-03.
    - There is no silent install, by design (`update-check.ts:8-11`), and the setup wizard needs a person (`package.json:106-112`).
    - The app quits even if the installer never starts (`main.ts:715-723`). A cancelled admin prompt leaves the bot down until the scheduled task relaunches it, up to 15 minutes later (`build/installer.nsh:33-37`).
    - There is no version marker, no rollback and no cleanup of old installers.
  - **Fix:**
    - Write a pending-update marker before launching the installer.
    - On the next start, compare versions and show either "Updated to vX" or "Update failed: retry, or reinstall the previous version".
    - Quit only once the installer has started, and relaunch the old app if setup fails.
    - Delete old installers after a confirmed upgrade.
    - Consider a silent install once the installer is signed.
  - **Done when:** on the test PC, cancelling the admin prompt leaves the app running, a successful upgrade shows the new version, and a forced failure offers a retry.
  - **Depends on:** 13.2, 13.3.
  - **Needs you:** decide whether unattended install is wanted (it needs the certificate), and the test PC.
  - **Uncertain:** nobody settled whether the 15-minute relaunch can fire in the middle of an install.

- [ ] **13.5 One update download at a time, with a timeout and a cancel button.** P2, S, unverified.
  - **Why:** DESK-UPD-08. The banner and the Updates page each run their own download (`App.tsx:305`, `Updates.tsx:198`) into the same partial file (`main.ts:599`). There is no timeout (`:650`), and every chunk sends a separate progress message (`:658-671`).
  - **Fix:** keep one download per link in the main process, add an idle timeout and a cancel call (in both bridge files), send progress about 4 times a second, and share the download state between the two screens.
  - **Done when:** starting the download from both places shows one download, and a stalled download shows an error with Retry within the timeout.
  - **Rules:** 19.

- [ ] **13.6 Remote-engine mode checks the desktop app's own version.** P2, S, unverified.
  - **Why:** DESK-UPD-05. The update check runs on the engine (`App.tsx:275`, `Updates.tsx:127`). Outside the local engine, the engine's version falls back to 0.0.0 (`update-check.ts:66-71`, `main.ts:1382`, `deploy/engine/Dockerfile:17-24, 85`), so the banner always says an update is available.
  - **Fix:** run the check in the desktop app using `app.getVersion()` (a new call in both bridge files), or pass the current version to the engine. Also set `RETURN_APP_VERSION` in the engine image and service.
  - **Done when:** a desktop app pointed at a Linux engine shows "up to date" when it is.
  - **Rules:** 16, 19.

### 14. Update screens

- [ ] **14.1 Desktop update screen: release date, what's new, size, install result.** P2, M, confirmed (lowered because it is display only).
  - **Why:** DESK-UPD-04.
    - The check result has no date, notes or size (`update-check.ts:56-64, 83`).
    - "Last checked" changes only on manual checks (`Updates.tsx:136-138`, compared with `App.tsx:269-286`).
    - The up-to-date state hides the latest version (`:210-214`), and the page does not check when opened.
    - Size appears only during the download.
  - **Fix:** add the release date, notes, size and hash to the check result and show them, record every check, check when the page opens, and show the install result from 13.4.
  - **Done when:** screen tests show each field, and "last checked" updates after the background check.
  - **Depends on:** 12.6, 13.2, 13.4.

- [ ] **14.2 Phone: mandatory updates, release notes, current version.** P1, M, confirmed.
  - **Why:** AND-06.
    - `server/mobile-release.ts:80` hard-codes the minimum required version to 10001, so a mandatory update never triggers.
    - Even if it did, only the dialog is locked (`AppUpdater.kt:153, 165-169`): there is a Hide button (`:257`), and scanning is not blocked (`ScannerActivity.kt:316-328`).
    - The notes are a generic line (`return-scan-apk.yml:203`).
    - `strings.xml:117` never shows the current version, and `:119` would show a literal `%1$s`.
  - **Fix:** read the minimum version and the notes from the manifest or the release text even when GitHub answers, use generated notes, fix both strings, and block the scanning screens until a mandatory update is installed.
  - **Done when:** a test shows a manifest with a higher minimum marks the update as mandatory, and on a phone a mandatory update blocks scanning and shows the current version, the latest version and real notes.
  - **Depends on:** 12.4, 12.6. **Rules:** 12.

### 15. CI and release pipeline

- [ ] **15.1 Nothing reaches production or a release without CI passing.** P1, M, confirmed.
  - **Why:** REL-03 and TH-08.
    - main has no branch protection and no rulesets.
    - Commit 26c6074 went straight to main and triggered both a deploy and a release.
    - The deploy and desktop-release workflows run their own tests without a database (`deploy.yml:17-44`, `desktop-release.yml:96-97`), so the database tests run only in `ci.yml`.
    - The version-bump guard is only advisory.
    - Deploy does run typecheck, build and the unit tests, so a broken build does not deploy; a failing database test can.
  - **Fix:**
    - Protect main: require PRs, require "Verify Web & API", plus the desktop and APK checks when their files change, require review conversations to be resolved, and block direct pushes.
    - Make deploy and publish wait for CI on the same commit (or call `ci.yml` as a reusable workflow).
  - **Done when:** a direct push to main is refused, a PR with a failing database test cannot merge, and the deploy and publish runs show they waited for CI.
  - **Needs you:** a repo admin turns on protection and chooses the required checks.

- [ ] **15.2 A failed deploy rolls back.** P1, M, confirmed (the env-file problem has not happened yet).
  - **Why:** REL-05.
    - `.github/scripts/deploy-remote.sh:41` rebuilds the running container in place.
    - `:53` deletes the old image before the health check (`:55-72`), and a failed health check exits without restoring anything.
    - `:21` writes the .env file with unescaped sed: a `&` in a value corrupts the file, and a `|` aborts the deploy.
    - `deploy.yml:189` ignores a failed certificate upload, while `.env` always points at that certificate (`:110`).
    - `deploy-remote.sh:77` uses `curl -k` for the external check, and its failure is ignored.
  - **Fix:**
    - Tag each image by commit and keep the previous one.
    - Delete old images only after the health check passes; on failure, switch back to the previous image and restart.
    - Write the env file safely.
    - Fail if the certificate file is missing.
    - Run the external check without `-k`, and make it fatal for the main domain.
  - **Done when:** a deliberately broken build in a staging or dry run returns to the previous image automatically, and a unit test shows a value containing `&` survives the env write.
  - **Rules:** 7, 8.

- [ ] **15.3 The schema guard catches dropped columns; test the upgrade path.** P1/P2, S to M (SRV-16 unverified, REL-09 confirmed).
  - **Why:** SRV-16 and REL-09. `server/db.ts:85` blocks only DROP TABLE, TRUNCATE and DELETE FROM. The database tests apply the schema only to an empty database (`ci.yml:54-57`).
  - **Fix:** extend the guard to DROP COLUMN, ALTER … TYPE and RENAME (keeping the allowance for DROP CONSTRAINT), with unit tests. Add a CI job that applies the previous release's schema, then the current one.
  - **Done when:** a test schema containing DROP COLUMN is refused, and the upgrade job runs green.
  - **Rules:** 6.

- [ ] **15.4 Code checks, security scanning and secret scanning.** P1, M, confirmed.
  - **Why:** REL-09 and TH-01.
    - There is no lint script and no ESLint config.
    - There is no CodeQL, no dependency review and no Dependabot (`dependabot_security_updates` is switched off).
    - `xlsx ^0.18.5` has public security advisories; npm audit was not run.
    - No secret scanner runs in CI.
  - **Fix:** add ESLint to `ci.yml`, CodeQL for JS/TS and Java/Kotlin, `npm audit --omit=dev --audit-level=high` or dependency review on PRs, Dependabot, and gitleaks.
  - **Done when:** each job runs on PRs, a planted fake `SYN-` secret fails gitleaks, and the findings are sorted into issues.

- [ ] **15.5 Browser smoke test.** P1, M, confirmed (part of REL-09).
  - **Why:** REL-09. There is no end-to-end job, and the web console has no UI test runner (`docs/notes/agent-handoff.md:110`).
  - **Fix:** add a minimal Playwright smoke test against the built app, using the CI database and `SYN-` data.
  - **Done when:** it runs on every PR and fails if sign-in or the register page breaks.
  - **Depends on:** 6.1.

- [ ] **15.6 Deploy only when files that ship change.** P2, S, confirmed.
  - **Why:** REL-04. `deploy.yml:3-11` skips only android/, docs/ and top-level .md files. dbd7289 (agent tooling only) and 0fd8bca (desktop only) both redeployed production.
  - **Fix:** deploy only when listed paths change: server, src, public, Dockerfile, compose file, package files, the watchdog and the deploy scripts.
  - **Done when:** a merge that touches only docs, tooling or the desktop app does not run the deploy step.

- [ ] **15.7 Pin the VPS host key; deploy as a non-root user.** P2, S, confirmed (a hardening gap).
  - **Why:** REL-06. `deploy.yml:76-78` trusts whatever server key answers, `:164` accepts new keys automatically, and `:158` defaults to root. Every production secret is then copied over (`:187`).
  - **Fix:** store the host key in a secret, set StrictHostKeyChecking=yes, and deploy as a user in the docker group.
  - **Done when:** a deploy against a wrong host key fails.
  - **Needs you:** the VPS host key fingerprint, and creating the deploy user on the VPS.

- [ ] **15.8 Correct the docs.** P2, S, unverified.
  - **Why:** AND-12, REL-14, TH-10 and DESK-DOC-01.
    - AGENTS.md says 767 tests, three typecheck projects and Android tag v1.2.0.82. The real figures are 1,003 tests, 4 projects and v1.0.63; that tag does not exist.
    - `docs/notes/phase1-audit-matrix.md` (dated 2026-10-10) has wrong statuses.
    - The handoff dates the WhatsApp leak to the wrong commit and says there is no UI test runner, but the desktop screens have happy-dom tests.
    - `docs/DESKTOP-APP.md:102-103, 111-112, 125-126` and `docs/ARCHITECTURE.md:221` disagree with the code.
  - **Fix:** correct them now to describe what the code does today, and update them again as items land. The AI prompt fix itself is 3.8.
  - **Done when:** every number and version in AGENTS.md matches a command run that day.
  - **Rules:** 11.

### 16. CodeRabbit and PR discipline

- [ ] **16.1 Configure CodeRabbit and close the open review threads.** P2, S, unverified.
  - **Why:** REL-13 and TH-08.
    - There is no `.coderabbit.yaml`. CodeRabbit shows SKIPPED on #71 and #69, and did not review #72.
    - Unresolved threads: #71 has 4, covered by 3.2. #68 has 3 rated Major in `desktop-agent/src/ai-providers.ts:91, 109, 153`, whose content this audit did not analyse. #69 has 3, all outdated.
  - **Fix:** add `.coderabbit.yaml` with path instructions taken from AGENTS rules 1 to 20, turn on automatic review for main, optionally make it a required check, and work through the #68 and #71 threads.
  - **Done when:** the next PR gets a CodeRabbit review that cites the rules, and the #68 and #71 threads are resolved or turned into tickets.
  - **Depends on:** 15.1.
  - **Needs you:** is CodeRabbit (or codeant-ai) the reviewer of record, and should its check be required?

### 17. Final verification

This step has no findings of its own. Re-run and record:
- typecheck, build, `npm test` and CI, with the database tests included;
- the APK and desktop release workflows;
- the installed-app checks from Phases 3 and 13 on the test PC;
- the live end-to-end run (6.5);
- `/ponytail-review`, `graphify update .` and `/understand-diff`;
- the docs refresh (15.8).

---

## Needs you before or during the work

**Do now (these are already public)**
- Rotate the WhatsApp gateway login, set the new values on the VPS, and decide whether to purge git history (12.3).
- Rotate the VMS/packing database password, confirm the GitHub secret is set, and confirm port 5432 is not open on the VPS (12.2).
- Android signing key: choose between rotating in place (APK Signature Scheme v3) and reinstalling, plan for any phones older than Android 9, create the new key and secrets, and decide on a history purge (12.1).
- Turn on branch protection and choose the required checks (15.1).

**Decisions**
- May a claim exist without a bench scan? If so, where is it recorded and what does the register show (2.3, 2.4)?
- Are Amazon claims in scope? Which evidence slots must Myntra, Ajio and Flipkart require (2.7)?
- Which roles may trigger OMSGuru email and WhatsApp sends (2.13)?
- Fully automatic or approval mode for the 150-a-day target (4.5)?
- Which four Meesho claim categories (4.6)?
- The callback number to use (4.4), and the ticket signature or brand for each Meesho account (4.8).
- Should in-transit returns show a filing deadline, and what does Myntra put in an empty return_created_date (6.4)?
- The release channel model (12.8).
- Whether to buy a Windows code-signing certificate (13.2, REL-07), and whether to allow unattended installs (13.4).
- Whether CodeRabbit or codeant-ai is the reviewer of record, and whether it is required (16.1).
- Permission for read-only production checks: duplicates before the new unique indexes (4.2, 5.6), and follow-ups already closed as approved by mistake (5.1).

**Live Meesho access**
- Capture the Raise-a-Ticket form for each category (4.4, 4.6), and cleaned page captures for fixtures (6.2).
- One live follow-up run, plus the current Meesho `portal_url` value (5.4).
- Saved ticket pages: approved, rejected and pending (5.7). Optionally, one page to confirm the "pending" wording (5.1).
- A supervised live automatic filing (4.1), and a measured day of filing (4.5).
- The final live end-to-end run with a real return (6.5).

**Devices and machines**
- Warehouse phones, including the lowest-spec model and any phone older than Android 9 (2.2, 2.4, 2.6, 12.1, 14.2).
- A Windows test PC, ideally 4 GB / 2-core (3.4, 3.5, 6.3, 13.3, 13.4).

**VPS**
- The host key fingerprint and a non-root deploy user (15.7).

**Already waiting in the handoff (not re-audited)**
- 16 "Waiting on the user" items in `docs/notes/agent-handoff.md`, including the Myntra 10708/45833 mapping, the activation and duplicate policies, retention and personal data, removing demo rows, the ATSPL carrier name and the Meesho SKU size keys.

## Refuted or uncertain

No finding was refuted. These are uncertain or narrower than first reported:
- **SRV-01:** the P0 depends on Meesho actually showing "Pending approval"-style wording. The desktop's own keywords suggest it does; a live ticket page would settle it.
- **ENG-02 / SRV-06:** today, only the portal's ticket-table check prevents a duplicate, and it has not been checked against the live portal.
- **ENG-03 / TH-05:** nobody showed end to end that a duplicate submission happens. One of the #71 threads is rated Minor, not Major.
- **ENG-04:** it is unknown whether the live form requires Callback Number, enforces 1,000 characters or has only one generic Attachments box.
- **ENG-05:** not run live. It works if someone edited `portal_url` to include the seller path, or if a Meesho view is already open.
- **ENG-07:** backend calls are capped at about 5 minutes by Node's defaults, not unlimited.
- **ENG-08:** the throughput figures are estimates from fixed waits in the code, never measured.
- **ENG-09:** lowered to P2 because it fails safely. "Four categories" is not defined anywhere.
- **AND-01 / REL-01:** the GitHub secret is very likely the same leaked key. Nobody compared fingerprints.
- **REL-02 / TH-02:** the database host is Docker-internal. Whether it can be reached from the internet depends on the VPS firewall, which was not checked.
- **TH-01:** nobody checked whether the gateway login still works.
- **AND-03:** the path is narrower than reported (mainly when the lookup fails briefly). The checker also found a SKU fallback the auditor missed.
- **AND-04:** how the register shows the Draft rows was not checked. The 409 on the later bench scan is confirmed under SRV-08.
- **AND-05:** the real impact depends on the phones' Android version and camera. It was not tested on a phone.
- **AND-07 vs REL-08:** the auditors disagree on severity (P1 vs P2). The fallback applies only after a server restart, and installed phones are not offered a downgrade.
- **SRV-08:** the lookup is plausibly slow, but nobody ran EXPLAIN.
- **SRV-09:** lowered to P2. Real memory peaks are about twice a 20 to 25 MB file.
- **SRV-12 / SRV-15:** not checked against production data. Whether the OMSGuru daily file spans accounts is unknown.
- **DESK-UPD-01 / REL-07:** the http or interception case needs a changed feed or a hostile engine. The APK half is overstated, because the phone does check the APK hash.
- **DESK-UPD-02:** lowered to P2, because the server parks the job safely.
- **DESK-UPD-03:** unknown whether the 15-minute relaunch can fire in the middle of an install.
- **DESK-UPD-04:** lowered to P2. It goes back to P1 if the plan's Section 14 lists these fields; the auditor could not see the plan.
- **DESK-PERF-01:** measured on a scratch Electron script, not the packaged app.
- **DESK-PERF-02:** idle CPU was not measured, and the request rate is about 62 a minute, not 90.
- **REL-04, REL-06:** both lowered to P2.
- **REL-05:** the env-file corruption has not happened yet; the current values presumably contain neither `&` nor `|`.
- **TH-03:** the claim-aging bug cannot happen in production, and the other three failures look like outdated tests.
- **TH-04:** the race between two jobs cannot happen through unified-create, and `jobId: null` is normal for non-Meesho claims.
- **TH-06:** realistic triggers are brief problems such as deadlocks or lock timeouts. None was observed in production.
- **TH-08:** a broken build does not auto-deploy, because deploy runs the unit tests. Failing database tests can still deploy.
- **Unverified P2 findings** (one auditor, no second check; each is marked in its item): SRV-11, SRV-12, SRV-13, SRV-14, SRV-15, SRV-16, AND-08, AND-09, AND-10, AND-11, AND-12, AND-13, AND-14, DESK-UPD-05, DESK-UPD-06 (but reproduced with node during the DESK-UPD-01 check), DESK-UPD-07, DESK-UPD-08, DESK-UI-01, DESK-IPC-01, DESK-WIN-01, DESK-DOC-01, ENG-10 (the expression was run with node by the engine auditor), ENG-11, ENG-12, ENG-13, ENG-14, REL-10, REL-11, REL-12, REL-13, REL-14, TH-09, TH-10.
- **Handoff item "claim to evidence-slot template":** the QA auditor did not check it. The server audit's SRV-12 covers part of it.

## Not covered by this audit

- **Live Meesho supplier panel:** no filing, follow-up or form capture was done, and the per-ticket read has never been observed. Only 3 production tickets exist.
- **Real phones or emulators:** no device testing. Gradle tests, lint and builds were not run locally; the last APK CI run, on 2026-11-03, succeeded.
- **The installed desktop app:** no live update or install, no admin-prompt or SmartScreen flow, no installer upgrade, no reboot or scheduled-task check, and no idle-CPU or packaged-app memory measurement.
- **Headless Linux engine mode:** not run.
- **Production server and database:** no access. Not checked: the data, templates as admins edited them, duplicate rows, query plans, VPS firewall and open ports, and any local APK files on the VPS.
- **Credentials:** whether the leaked ones still work, and what the GitHub secrets actually contain.
- **Database tests locally:** not run, because there is no local test database. They ran in CI: 1,003 pass.
- **Firebase storage:** not tested under load, and real upload speeds on the warehouse network were not measured.
- **Other marketplaces' automation:** only Meesho files automatically; the other panels answer "not implemented".
- **Web console screens:** there is no UI test runner for `src/`.
- **The plan's own acceptance wording for each phase** (for example, the Section 14 fields): the auditors did not see it.
- **The content of CodeRabbit's #68 threads.**
- **Process steps:** `/ponytail-review` and `/understand` were not run (this was a read-only audit), and one `graphify section` call failed with a KeyError.
- **The 16 "waiting on the user" decisions in the handoff:** listed above, not re-audited.