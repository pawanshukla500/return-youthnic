# Return App Desktop — install, operate, troubleshoot

The desktop app is a real installed Windows application: a bundled React
desktop UI (Electron shell + bundled renderer) backed by the local claim-bot
engine and its supplier browser automation — not a website wrapper. Since
1.3.0 the app window loads its own packaged renderer (`returnapp://desktop`);
it no longer loads the engine's server-rendered dashboard page. The engine
still runs in-process as the API and worker service on `127.0.0.1:3005` (or on
a remote Linux server — §9), and it still serves that dashboard HTML at `GET /`
for headless-Linux use in a browser; the desktop app simply never loads it.
The renderer architecture is documented in
[DESKTOP-RENDERER.md](DESKTOP-RENDERER.md).

The app signs the operator in, keeps six supplier panels logged in with their
own cookies, polls the Return App server for claim jobs, and files them
through the supplier browser window built into the app — no Edge, Chrome, or
Chromium install needed. Meesho files fully automatically, the other panels
assisted (prepare + evidence, operator confirms submit). Filing a claim also
creates a ticket follow-up: the engine re-opens that panel every 2 days to
read the ticket status until the ticket is finished. Only Meesho implements
`checkClaimStatus()`, so other panels' tickets currently stop with "not
supported" rather than guessing a status; implementing the reader in a
marketplace class turns tracking on for it. Closing the window keeps the app
running in the tray.

## 1. Install

1. Take the matching setup from the latest `desktop-v*` GitHub release:
   Windows `Return.App.Setup.<version>.exe` (1.3.0).
2. Run it (admin rights needed — it installs per-machine into
   `C:\Program Files\Return App\` with Desktop and Start Menu shortcuts).
3. The installer automatically:
   - registers the **ReturnAppClaimBot** Windows Scheduled Task (starts the app
     hidden at every sign-in, retries on failure every minute, and relaunches
     it within 15 minutes if it stops for any reason — see
     [section 8](#8-long-running-reliability-247-operation));
   - needs no system browser: the supplier browser ships inside the app (native
     WebContentsView, the default; `BROWSER_ADAPTER=external` still drives
     Edge/Chrome via `BROWSER_PATH` on servers that need it).
4. No Node.js, no commands, no manual services. Uninstall removes the app and
   the scheduled task; supplier cookies and sign-in are kept under
   `%USERPROFILE%\.taskflow-claim-agent` so a reinstall never forces a full
   re-login.

## 2. First run — connect each panel (one at a time)

1. The app opens its bundled UI and shows a connecting page until the engine
   answers (normally immediate). Sign in with the Return App operator account
   (Admin or Supervisor). The 24/7 worker starts only after sign-in.
2. The **Dashboard** lists the six panels in order: Meesho, Flipkart, Amazon,
   Myntra VB, Myntra EJ, Ajio.
3. Per panel: enter the supplier ID + password (or leave blank to reuse the
   bot login saved on the web), Save, then **Connect**. The supplier page
   opens as a supplier tab inside this app window — complete OTP/CAPTCHA
   yourself, then switch back to the dashboard. Cookies are saved on this PC.
4. The counter tracks `X of 6 connected`. A panel whose session expires drops
   back to Connect with "ID saved — sign in again".
5. Supplier passwords are stored encrypted on the server; the operator token
   and PC API key are encrypted with the Windows credential store (DPAPI) on
   this PC. **Settings** shows which mode is active.

## 3. Daily operation

- **Dashboard**: one headline — **All panels green** or **Action required**
  (naming exactly what to do) — plus per-panel chips, worker status, recent
  activity and a live log terminal. Update checks moved to the **Updates** tab
  (Check now, auto-check toggle, dismissible banner; install over this
  version, cookies kept).
- **Browsers page**: the supplier workspace — tab strip, Back/Forward/Reload,
  open/close tabs, **Detach** into its own window and **Dock Back**, and an
  **Expand** button that fills the window with the supplier page (Esc or Exit
  Fullscreen returns). While expanded or detached, the sidebar and controls
  stay out of the way by design; sessions, cookies and any in-progress form
  input survive tab switches, detach/dock and tray hides.
- **Claims page**: the claims queue with filters, per-claim detail and the
  local evidence viewer (photos/videos stream from this PC, so they open even
  while the backend is down).
- **Follow-ups page**: the ticket follow-ups table.
- **AI Center**: the six-provider configuration, routing, approved memory,
  usage and events.
- **Settings**: backend URL and diagnostics, credential-storage mode, worker
  controls, appearance (light default, dark option).
- **Logs**: live terminal on the Dashboard + files at
  `%USERPROFILE%\.taskflow-claim-agent\logs\bot-YYYY-MM-DD.log` (7 days kept).
- **Evidence cache**: `%USERPROFILE%\.taskflow-claim-agent\evidence-cache`
  (downloaded photos/videos, verified by size + SHA-256, pruned after 24h).
- **Browser profiles**: `%USERPROFILE%\.taskflow-claim-agent\browser-profiles`
  (one per panel — never delete while connected).
- **Tray menu**: open, pause/resume, check-now, quit. Quit stops the worker;
  closing the window does not.
- **Updates**: Updates tab → Check now (or wait for the automatic check) → the
  download link saves the new setup into your Downloads folder; close the app
  and run it to install over this version (cookies kept). No silent
  auto-install. A banner appears when a newer GitHub release exists; Later
  dismisses it per release tag.

### Overall status and the green panel state

The Dashboard headline answers "is anything waiting on me?":

- **All panels green** — every panel has saved cookies, the bot is running, and
  no ticket check is failing. Each panel chip is green with its own name.
- **Action required** — the headline turns amber and names exactly what to do:
  sign in, start the paused bot, connect the panels that have no saved
  session, open the panels that say *Needs you*, or look at ticket checks that
  are failing.

The headline is derived, not typed: it reads the same `/api/status` and
`/api/panels` data the rest of the page shows, so it can never disagree with
the panel strip underneath it. Each chip carries its own state (*Ready* /
*Working* / *Needs you* / *Cooling down* / *Connect*).

### Ticket follow-ups (checked every 2 days)

Filing a claim is not the end of it: a marketplace ticket stays open for days.
When a filing job completes, the server creates a follow-up for that ticket,
and the bot re-opens that panel on its own every 2 days — using the panel's
saved cookies, no password needed — reads the ticket status, and records it.
The **Follow-ups** page shows the marketplace, the marketplace's own ticket
ID, the claim status, when the last check ran, when the next one is due, how
many checks have run, and the current state.

The check stops by itself when there is nothing left to chase:

| Outcome | What you see |
|---|---|
| Ticket approved / rejected / paid / reconciled | *Finished — ticket resolved*; the claim status moves with it |
| Three checks in a row fail | *Stopped — the check kept failing*; look at the ticket once by hand |
| The panel has no automatic status reader yet | *Paused — this panel has no automatic check yet* (see [section 4](#4-what-each-panel-does-today)) |
| The saved session expired | The ticket stays active, and the dashboard asks you to connect that panel again |

Follow-up checks never run while a claim is being filed, and filing never runs
while a check is open: both use the same supplier browser profile.

## 4. What each panel does today

| Panel | Mode | Confirmation rule |
|---|---|---|
| Meesho | Fully automatic | Filed only on a **new 9–15 digit Meesho ticket** absent before Submit |
| Flipkart / Amazon / Myntra VB / Myntra EJ / Ajio | Assisted | Prepares form + evidence, waits for operator; never auto-completes |

A job is never marked submitted from a screenshot alone. Duplicate filing is
prevented by server-side leases + bounded attempts; an uncertain submission
stops for manual reconciliation instead of retrying blind.

**Ticket status reading exists for Meesho.** `desktop-agent/src/marketplaces/meesho.ts:537` implements `checkClaimStatus()` (DOM ticket-table reader, fixture-tested; live-portal verification still pending). All other panels use the shared default that answers "not implemented", which stops the follow-up for that panel instead of guessing. Once the status page for another marketplace is described, that marketplace implements `checkClaimStatus()` and its tickets start being tracked automatically.

## 5. Recovery

| Failure | What happens |
|---|---|
| PC reboot | Scheduled task + auto-start relaunch hidden; saved sign-in resumes |
| App crash | Fatal errors exit non-zero so the task restarts a clean process; the 15-minute watchdog catches any other stop |
| Engine cannot bind at startup | The shell retries every 30s (up to 20 times); the window shows the renderer's connecting page the whole time and is rebuilt when the engine starts |
| Window renderer dies | The window reloads automatically; filing continues |
| Network drop | Saved sign-in kept; the UI shows its connecting/offline state and recovers on its own; the worker retries with backoff |
| Portal OTP/CAPTCHA | Browser stays open, panel shows Needs you, others keep filing |
| Order not eligible (e.g. Meesho packaging policy) | Job marked `not_eligible`, skipped, manual review on web |

## 6. Troubleshooting

- **"Desktop renderer not built" page**: only a development build can show
  this — `desktop/renderer/dist` is missing. Run
  `npm run desktop:renderer:build` and restart. Installed builds ship the
  renderer in the installer.
- **Connecting page that never clears**: the engine is not answering at the
  shown URL. If the app just started, the shell may still be retrying the
  engine start (watch the log); otherwise restart the app and check the tray.
  The window itself is fine — it renders this state by design.
- **Bot idle, jobs queued**: check operator still signed in (`/api/status`),
  panel cookies on the Dashboard, backend URL reachable (Test Ping).
- **Browser never opens**: the bundled browser needs no install. This entry
  only applies with `BROWSER_ADAPTER=external`: then install Edge/Chrome or
  set `BROWSER_PATH`, and see the bot log for `No compatible Chromium browser`.
- **Supplier browser not visible on the Browsers page**: the workspace is
  smaller than the 120×120 DIPs fail-closed floor, the tab is detached or
  expanded, or another sidebar page is active — all of these hide the native
  view by design. Use Exit Fullscreen / Dock Back, or return to the Browsers
  page.
- **Esc does not exit the expanded browser**: while the supplier page has
  keyboard focus it consumes Esc; use the **Exit Fullscreen** button.
- **Task missing**: reinstall, or recreate with
  `schtasks /create /TN "ReturnAppClaimBot" /TR "\"C:\Program Files\Return App\Return App.exe\" --hidden" /SC ONLOGON /F`.
- **Sign-in loops**: delete `%USERPROFILE%\.taskflow-claim-agent\operator-session.json`
  and sign in again (one-time; DPAPI-bound tokens don't roam between machines).
- **Follow-ups say "no automatic check yet"**: expected for marketplaces whose
  status page has not been implemented. The ticket is not lost; the panel needs
  its `checkClaimStatus()` implementation before it can be tracked automatically.
- **Follow-ups say "the check kept failing"**: the panel opened but the ticket
  could not be read. Open that ticket once by hand, then check the panel
  cookies on the Dashboard.

## 7. Engine local API (all require operator sign-in)

These routes are served by the engine (`desktop-agent/src/desktop-app-server.ts`)
and consumed by the bundled renderer over the preload bridge:

| Route | Purpose |
|---|---|
| `GET /api/status` | Worker state, active job, next poll, backend URL, follow-up worker state, nightly window, browser adapter |
| `GET /api/operator/session` | Whether a claim-bot-capable operator is signed in |
| `POST /api/operator/login` / `POST /api/operator/logout` | Operator sign-in (Admin/Supervisor only) and sign-out |
| `GET /api/panels` | Six panels: state, active job, cookie status, last result |
| `GET /api/jobs` | Recent claim jobs |
| `GET /api/follow-ups` | Ticket follow-ups (proxied to the server with the operator's token) |
| `GET /api/evidence/:claimId` and `GET /api/evidence/:claimId/:fileName` | Local evidence cache listing/streaming; traversal-safe, work while the backend is down |
| `POST /api/panels/:key/clear` | Clear a panel hold so it rejoins rotation |
| `GET /api/security` | Whether OS credential store encryption is active |
| `GET /api/updates/check` | Newest `desktop-v*` release vs running version + download links |
| `GET /api/portal-logins` | Per-panel ID-saved + cookie-saved status |
| `POST /api/portal-logins` | Save a supplier ID/password (server-encrypted) |
| `POST /api/portal-logins/test` | Open the visible browser and save that panel's cookies |
| `POST /api/jobs/run-one` | Queue one waiting claim immediately |
| `GET /api/portal-browser` + `POST /api/portal-browser/*` | Supplier browser tabs: snapshot, open, switch, nav, close, detach, dock, focus, hide/show, test-claim |
| `GET /api/logs/stream` | Live log terminal (EventSource) |

Cross-origin calls from the renderer are restricted by the engine's CORS
allowlist: exactly `returnapp://desktop` in production (plus the Vite dev
origins outside production, plus exact http(s) origins in
`ENGINE_CORS_ORIGINS`). Preflights are answered before the bearer gate and the
allow-origin is never `*`. See [DESKTOP-RENDERER.md](DESKTOP-RENDERER.md) §5.

## 8. Long-running reliability (24/7 operation)

The app is expected to run for weeks on a warehouse PC. Five mechanisms keep it
alive:

1. **Crash guards (`desktop-agent/src/crash-guard.ts`).** An unhandled promise
   rejection (one failed HTTP call, a closed browser socket) is logged and the
   bot keeps filing. An uncaught exception is logged **synchronously** and the
   process exits non-zero, so the supervisor starts a clean process instead of
   limping on with possibly-leaked browser processes.
2. **Scheduled-task watchdog.** The installer registers `ReturnAppClaimBot`
   with a 15-minute repetition on its logon trigger and `RestartOnFailure`
   every minute. `MultipleInstancesPolicy=IgnoreNew` means the repetition never
   duplicates a running instance; it only relaunches a stopped one. A clean
   exit that `RestartOnFailure` would not catch is therefore still recovered
   within 15 minutes. The task never times out (`ExecutionTimeLimit=PT0S`).
3. **Engine start retry.** If the local engine cannot bind at startup (a
   previous instance still releasing the port, antivirus scanning the app
   folder), the shell retries every 30 seconds up to 20 times, then rebuilds
   the window against the running engine. A remote-engine misconfiguration is
   never overridden. The bundled renderer shows its connecting state
   throughout.
4. **Renderer recovery.** If the window's renderer dies (GPU reset, out of
   memory), it is reloaded automatically; a failed renderer load retries once.
   The engine keeps filing throughout; only the window is affected.
5. **Bounded resources.** The evidence cache is pruned to 24 hours at startup,
   logs are pruned to 7 days, the in-memory log ring is capped, and the poll
   interval backs off while the queue is empty.

Crash recovery was verified by running the packaged build and by tests in
`desktop-agent/crash-guard.test.ts`, which spawn real processes: a rejected
promise must not terminate the engine, and a fatal error must exit non-zero
with the line already written to disk.

### Building the installer locally on Windows

`npm run desktop:dist` first builds the bundled renderer
(`desktop:renderer:build`), then the main-process bundle, then produces
`dist-electron/Return.App.Setup.<version>.exe`. On a Windows PC with aggressive
antivirus, electron-builder can fail with `EPERM: operation not permitted,
rename ...<tool>.tmp -> <tool>` while unpacking its own build tools. The app
code is not involved; the antivirus is holding a handle on a freshly written
tool binary. It is fixed by letting one build fail, then renaming the leftover
`<tool>.tmp` directory to the final name and writing a completion marker next
to it:

```powershell
$base = "$env:LOCALAPPDATA\electron-builder\Cache"
# For each toolset that failed (7zip@1.0.0, nsis-3.0.4.1, nsis-resources-3.4.1):
#   rename "<tool>.tmp" -> "<tool>", then write "<tool>.state" (UTF-8, no BOM):
#   {"version":1,"state":"complete","timestamp":<ms>,"fileCount":0,"extractedSize":0}
```

The marker must be written **without a byte-order mark** (`[System.IO.File]::WriteAllText`
with a `UTF8Encoding($false)`), or electron-builder cannot parse it and
re-extracts. CI on `windows-latest` does not have this problem.

## 9. Remote engine mode (Linux server)

The claim bot can run on a Linux server instead of (or in addition to) the
warehouse PC. In that mode the desktop app is a client of the remote engine.

Set these in the environment the desktop app starts with:

```powershell
$env:RETURN_ENGINE_URL = "https://claims-engine.example.com"
$env:ENGINE_TOKEN = "<the same token as the server>"
```

What changes:

- The desktop app does **not** start a local engine and does **not** run a
  local worker. Nothing is filed from this PC.
- The window still loads the bundled renderer (`returnapp://desktop`). The
  renderer's engine client targets the remote URL, and the shell injects the
  bearer token on every request to the engine origin, so panels, logs,
  evidence and controls all work unchanged. The token never reaches the
  renderer.
- Start-at-login is not registered in this mode (it would launch a local
  engine at the next sign-in instead of connecting to the server).
- Closing the desktop window does not stop filing: the server keeps working.
- Leave `RETURN_ENGINE_URL` unset and the app behaves exactly as before
  (embedded engine on `127.0.0.1:3005`).

Full server setup, health checks, systemd and Docker are in
[LINUX-SERVER.md](LINUX-SERVER.md).

## 10. What changed since 1.2.0

- The app window loads a genuine bundled React 19 renderer
  (`desktop/renderer/`, served at `returnapp://desktop`) instead of the
  engine's server-rendered dashboard at `http://127.0.0.1:3005`. The engine
  stays the API/worker; its `GET /` dashboard HTML remains for headless Linux
  browsers.
- The renderer renders its own full-page offline/connecting state, so the app
  opens usefully even with the engine stopped, and recovers when the engine
  starts.
- The engine API grew a strict CORS allowlist (exactly `returnapp://desktop`
  in production; preflight answered before the bearer gate; never `*`).
- New operator-gated local evidence endpoints (`GET /api/evidence/:claimId`,
  `GET /api/evidence/:claimId/:fileName`) stream the evidence cache and work
  while the backend is down. `GET /api/status` also reports the nightly window
  and the browser adapter.
- The preload bridge (`window.desktopApp`) is typed and minimal; the remote
  engine token is never exposed to the renderer (the shell injects it).
- Packaging ships `desktop/renderer/dist`, fixes the preload path in the
  packaged build, and `desktop:dist` builds the renderer first. Version 1.3.0.
- Installer behavior is unchanged: `ReturnAppClaimBot` Scheduled Task,
  per-machine NSIS, sessions and data preserved under
  `%USERPROFILE%\.taskflow-claim-agent` across upgrades.

## 11. Honestly not yet done

- Full auto-filing for Flipkart/Amazon/Myntra/Ajio (assisted today; writing
  untested portal scripts would be mock automation). This also means only
  Meesho is useful in headless remote mode.
- **Only Meesho implements `checkClaimStatus()` so far** (`meesho.ts:537`,
  fixture-tested, live verification pending). The follow-up framework is
  complete end to end (schema, service, routes, worker, dashboard). Each
  remaining marketplace's status page needs its own reader before its tickets
  are tracked; no ticket state is ever guessed.
- Esc is not forwarded from a focused supplier WebContentsView; exit the
  expanded browser with the Exit Fullscreen button.
- Silent auto-update (needs code signing + notarization first).
- The installer is **not code-signed**. Windows SmartScreen will warn on first
  run until a certificate is bought.
- No live claim has been filed from this exact build in this session; Meesho
  flow is proven by prior runs, the rest by assisted screenshots + tests.
- No live claim has been filed from a Linux server. The Linux paths are written
  and reviewed, not exercised end to end.
- AI assistance runs through the AI Center page (6 providers, routing,
  approved-memory path). Historical design notes live in
  [notes/ai-provider-comparison.md](notes/ai-provider-comparison.md) and are
  superseded where they say no LLM integration exists.
