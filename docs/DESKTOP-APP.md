# Return App Desktop — install, operate, troubleshoot

The desktop app is a real installed Windows application (Electron shell + local
claim-bot server + CDP browser automation), not a website wrapper. It signs the
operator in, keeps six supplier panels logged in with their own cookies, polls
the Return App server for claim jobs, and files them through a visible system
browser — Meesho fully automatically, the other panels assisted (prepare +
operator confirm). After a claim is filed, the engine is designed to re-open
that panel every 2 days to read the ticket status until the ticket is finished.
No marketplace's `checkClaimStatus()` reader is implemented yet, so tickets
currently stop with "not supported" rather than guessing a status;
implementing the reader in a marketplace class turns tracking on for it.
Closing the window keeps it running in the tray.

## 1. Install

1. Take the matching setup from the latest `desktop-v*` GitHub release:
   Windows `Return.App.Setup.<version>.exe`.
2. Run it (admin rights needed — it installs per-machine into
   `C:\Program Files\Return App\` with Desktop and Start Menu shortcuts).
3. The installer automatically:
   - registers the **ReturnAppClaimBot** Windows Scheduled Task (starts the app
     hidden at every sign-in, retries on failure every minute, and relaunches it
     within 15 minutes if it stops for any reason — see
     [section 8](#8-long-running-reliability-247-operation));
   - warns if no Edge/Chrome/Chromium browser is installed (install one or
     set a `BROWSER_PATH` environment variable — the bot drives it);
   - launches the app after setup.
4. No Node.js, no commands, no manual services. Uninstall removes the app and
   the scheduled task; supplier cookies and sign-in are kept under
   `%USERPROFILE%\.taskflow-claim-agent` so a reinstall never forces a full
   re-login.

## 2. First run — connect each panel (one at a time)

1. Sign in with the Return App operator account (Admin or Supervisor). The
   24/7 worker starts only after sign-in.
2. The **First-time setup** box lists the six panels in order: Meesho,
   Flipkart, Amazon, Myntra VB, Myntra EJ, Ajio.
3. Per panel: enter the supplier ID + password (or leave blank to reuse the
   bot login saved on the web), Save, then **Connect**. The supplier page
   opens in a visible browser — complete OTP/CAPTCHA yourself. Cookies are
   saved on this PC.
4. The counter tracks `X of 6 connected`. A panel whose session expires drops
   back to Connect with "ID saved — sign in again".
5. Supplier passwords are stored encrypted on the server; the operator token
   and PC API key are encrypted with the Windows credential store (DPAPI) on
   this PC. The setup box shows which mode is active.

## 3. Daily operation

- **First-time setup box**: connect/reconnect panels, `X of 6 connected`, credential-storage mode, Check-for-updates button.
- **Claims Queue Pipeline** table: filter, Run this claim, watch stages.
- **Panel-wise strip**: per-panel state (Ready / Filing / Needs you /
  Cooling down). A held panel never blocks the others; **Rejoin rotation**
  clears it.
- **Logs**: live terminal in the dashboard + files at
  `%USERPROFILE%\.taskflow-claim-agent\logs\bot-YYYY-MM-DD.log` (7 days kept).
- **Evidence cache**: `%USERPROFILE%\.taskflow-claim-agent\evidence-cache`
  (downloaded photos/videos, verified by size + SHA-256, pruned after 24h).
- **Browser profiles**: `%USERPROFILE%\.taskflow-claim-agent\browser-profiles`
  (one per panel — never delete while connected).
- **Tray menu**: open, pause/resume, check-now, quit. Quit stops the worker;
  closing the window does not.
- **Updates**: setup box → Check for updates → download the new setup and
  install over this version (cookies kept). No silent auto-install.

### Overall status and the green panel state

The dashboard opens with one headline that answers "is anything waiting on me?":

- **All panels green** — every panel has saved cookies, the bot is running, and
  no ticket check is failing. Each panel chip is green with its own name.
- **Action required** — the headline turns amber and names exactly what to do:
  sign in, start the paused bot, connect the panels that have no saved session,
  open the panels that say *Needs you*, or look at ticket checks that are failing.

The headline is derived, not typed: it reads the same `/api/status`,
`/api/panels` and follow-up data the rest of the page shows, so it can never
disagree with the panel strip underneath it. A panel card is outlined green the
moment its cookies are saved, and each chip carries its own state
(*Ready* / *Working* / *Needs you* / *Cooling down* / *Connect*).

### Ticket follow-ups (checked every 2 days)

Filing a claim is not the end of it: a marketplace ticket stays open for days.
When a filing job completes, the server creates a follow-up for that ticket, and
the bot re-opens that panel on its own every 2 days — using the panel's saved
cookies, no password needed — reads the ticket status, and records it. The
**Ticket follow-ups** table shows the marketplace, the marketplace's own ticket
ID, the claim status, when the last check ran, when the next one is due, how many
checks have run, and the current state.

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

**Ticket status reading is not built per marketplace yet.** The engine asks each
marketplace class for the ticket state, and the shared default answers "not
implemented", which stops the follow-up for that panel instead of guessing. Once
the status page for a marketplace is described, that marketplace implements
`checkClaimStatus()` and its tickets start being tracked automatically. Until
then, the table is honest about it rather than showing a made-up state.

## 5. Recovery

| Failure | What happens |
|---|---|
| PC reboot | Scheduled task + auto-start relaunch hidden; saved sign-in resumes |
| App crash | Fatal errors exit non-zero so the task restarts a clean process; the 15-minute watchdog catches any other stop (3 tries no longer applies) |
| Window renderer dies | The window reloads automatically; filing continues |
| Local engine cannot bind at startup | The shell retries every 30s (up to 20 times) and reloads the window when it succeeds |
| Network drop | Saved sign-in kept; worker retries with backoff |
| Portal OTP/CAPTCHA | Browser stays open, panel shows Needs you, others keep filing |
| Order not eligible (e.g. Meesho packaging policy) | Job marked `not_eligible`, skipped, manual review on web |

## 6. Troubleshooting

- **Bot idle, jobs queued**: check operator still signed in (`/api/status`),
  panel cookies in First-time setup, backend URL reachable (Test Ping).
- **Browser never opens**: install Edge/Chrome or set `BROWSER_PATH`; see the
  bot log for `No compatible Chromium browser`.
- **Zombie browser processes**: the runner closes the full process tree
  (`taskkill /T /F`); if one survives a hard kill, end it in Task Manager.
- **Task missing**: reinstall, or recreate with
  `schtasks /create /TN "ReturnAppClaimBot" /TR "\"C:\Program Files\Return App\Return App.exe\" --hidden" /SC ONLOGON /F`.
- **Sign-in loops**: delete `%USERPROFILE%\.taskflow-claim-agent\operator-session.json`
  and sign in again (one-time; DPAPI-bound tokens don't roam between machines).
- **Follow-ups say "no automatic check yet"**: expected for marketplaces whose
  status page has not been implemented. The ticket is not lost; the panel needs
  its `checkClaimStatus()` implementation before it can be tracked automatically.
- **Follow-ups say "the check kept failing"**: the panel opened but the ticket
  could not be read. Open that ticket once by hand, then check the panel cookies
  in First-time setup.

## 7. Dashboard local API (all require operator sign-in)

| Route | Purpose |
|---|---|
| `GET /api/status` | Worker state, active job, next poll, backend URL, follow-up worker state |
| `GET /api/panels` | Six panels: state, active job, cookie status, last result |
| `GET /api/follow-ups` | Ticket follow-ups for the dashboard (proxied to the server with the operator's token) |
| `POST /api/panels/:key/clear` | Clear a panel hold so it rejoins rotation |
| `GET /api/security` | Whether OS credential store encryption is active |
| `GET /api/updates/check` | Newest `desktop-v*` release vs running version + download links |
| `GET /api/portal-logins` | Per-panel ID-saved + cookie-saved status |
| `POST /api/portal-logins` | Save a supplier ID/password (server-encrypted) |
| `POST /api/portal-logins/test` | Open the visible browser and save that panel's cookies |
| `POST /api/jobs/run-one` | Queue one waiting claim immediately |

## 8. Long-running reliability (24/7 operation)

The app is expected to run for weeks on a warehouse PC. Five mechanisms keep it alive:

1. **Crash guards (`desktop-agent/src/crash-guard.ts`).** An unhandled promise
   rejection (one failed HTTP call, a closed browser socket) is logged and the
   bot keeps filing. An uncaught exception is logged **synchronously** and the
   process exits non-zero, so the supervisor starts a clean process instead of
   limping on with possibly-leaked browser processes.
2. **Scheduled-task watchdog.** The installer registers `ReturnAppClaimBot` with
   a 15-minute repetition on its logon trigger and `RestartOnFailure` every
   minute. `MultipleInstancesPolicy=IgnoreNew` means the repetition never
   duplicates a running instance; it only relaunches a stopped one. A clean exit
   that `RestartOnFailure` would not catch is therefore still recovered within
   15 minutes. The task never times out (`ExecutionTimeLimit=PT0S`).
3. **Engine start retry.** If the local engine cannot bind at startup (a previous
   instance still releasing the port, antivirus scanning the app folder), the
   shell retries every 30 seconds up to 20 times and reloads the window when it
   succeeds. A remote-engine misconfiguration is never overridden.
4. **Renderer recovery.** If the window's renderer dies (GPU reset, out of
   memory), it is reloaded automatically. The engine keeps filing throughout;
   only the window is affected.
5. **Bounded resources.** The evidence cache is pruned to 24 hours at startup,
   logs are pruned to 7 days, the in-memory log ring is capped, and the poll
   interval backs off while the queue is empty.

Crash recovery was verified by running the packaged build and by tests in
`desktop-agent/crash-guard.test.ts`, which spawn real processes: a rejected
promise must not terminate the engine, and a fatal error must exit non-zero with
the line already written to disk.

### Building the installer locally on Windows

`npm run desktop:dist` produces `dist-electron/Return.App.Setup.<version>.exe`.
On a Windows PC with aggressive antivirus, electron-builder can fail with
`EPERM: operation not permitted, rename ...<tool>.tmp -> <tool>` while unpacking
its own build tools. The app code is not involved; the antivirus is holding a
handle on a freshly written tool binary. It is fixed by letting one build fail,
then renaming the leftover `<tool>.tmp` directory to the final name and writing a
completion marker next to it:

```powershell
$base = "$env:LOCALAPPDATA\electron-builder\Cache"
# For each toolset that failed (7zip@1.0.0, nsis-3.0.4.1, nsis-resources-3.4.1):
#   rename "<tool>.tmp" -> "<tool>", then write "<tool>.state" (UTF-8, no BOM):
#   {"version":1,"state":"complete","timestamp":<ms>,"fileCount":0,"extractedSize":0}
```

The marker must be written **without a byte-order mark** (`[System.IO.File]::WriteAllText`
with a `UTF8Encoding($false)`), or electron-builder cannot parse it and re-extracts.
CI on `windows-latest` does not have this problem.

## 9. Remote engine mode (Linux server)

The claim bot can run on a Linux server instead of (or in addition to) the
warehouse PC. In that mode the desktop app is a client of the remote engine.

Set these in the environment the desktop app starts with:

```powershell
$env:RETURN_ENGINE_URL = "https://claims-engine.example.com"
$env:ENGINE_TOKEN = "<the same token as the server>"
```

What changes:

- The desktop app does **not** start a local engine and does **not** run a local
  worker. Nothing is filed from this PC.
- The window loads from the remote engine and the app injects the bearer token on
  every request to that origin, so the dashboard, panels, logs and controls all
  work unchanged.
- Closing the desktop window does not stop filing: the server keeps working.
- Leave `RETURN_ENGINE_URL` unset and the app behaves exactly as before (embedded
  engine on `127.0.0.1:3005`).

Full server setup, health checks, systemd and Docker are in
[LINUX-SERVER.md](LINUX-SERVER.md).

## 10. Honestly not yet done

- Full auto-filing for Flipkart/Amazon/Myntra/Ajio (assisted today; writing
  untested portal scripts would be mock automation). This also means only Meesho
  is useful in headless remote mode.
- **No marketplace implements `checkClaimStatus()` yet.** The follow-up
  framework is complete end to end (schema, service, routes, worker, dashboard),
  but every panel currently answers "not implemented", so follow-ups stop with
  that reason instead of reading a ticket. Each marketplace's status page needs
  its own reader before its tickets are tracked; no ticket state is ever guessed.
- Silent auto-update (needs code signing + notarization first).
- The installer is **not code-signed**. Windows SmartScreen will warn on first
  run until a certificate is bought.
- No live claim has been filed from this exact build in this session; Meesho
  flow is proven by prior runs, the rest by assisted screenshots + tests.
- No live claim has been filed from a Linux server. The Linux paths are written
  and reviewed, not exercised end to end.
- No AI reply service is wired in yet. See
  [notes/ai-provider-comparison.md](notes/ai-provider-comparison.md).
