# Return App Desktop — install, operate, troubleshoot

The desktop app is a real installed Windows application (Electron shell + local
claim-bot server + CDP browser automation), not a website wrapper. It signs the
operator in, keeps six supplier panels logged in with their own cookies, polls
the Return App server for claim jobs, and files them through a visible system
browser — Meesho fully automatically, the other panels assisted (prepare +
operator confirm). Closing the window keeps it running in the tray.

## 1. Install

1. Take the matching setup from the latest `desktop-v*` GitHub release:
   Windows `Return.App.Setup.<version>.exe`.
2. Run it (admin rights needed — it installs per-machine into
   `C:\Program Files\Return App\` with Desktop and Start Menu shortcuts).
3. The installer automatically:
   - registers the **ReturnAppClaimBot** Windows Scheduled Task (starts the
     app hidden at every sign-in, restarts it up to 3 times on failure);
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

## 4. What each panel does today

| Panel | Mode | Confirmation rule |
|---|---|---|
| Meesho | Fully automatic | Filed only on a **new 9–15 digit Meesho ticket** absent before Submit |
| Flipkart / Amazon / Myntra VB / Myntra EJ / Ajio | Assisted | Prepares form + evidence, waits for operator; never auto-completes |

A job is never marked submitted from a screenshot alone. Duplicate filing is
prevented by server-side leases + bounded attempts; an uncertain submission
stops for manual reconciliation instead of retrying blind.

## 5. Recovery

| Failure | What happens |
|---|---|
| PC reboot | Scheduled task + auto-start relaunch hidden; saved sign-in resumes |
| App crash | Task restarts it (3 tries); tray quit is the only full stop |
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

## 7. Dashboard local API (all require operator sign-in)

| Route | Purpose |
|---|---|
| `GET /api/status` | Worker state, active job, next poll, backend URL |
| `GET /api/panels` | Six panels: state, active job, cookie status, last result |
| `POST /api/panels/:key/clear` | Clear a panel hold so it rejoins rotation |
| `GET /api/security` | Whether OS credential store encryption is active |
| `GET /api/updates/check` | Newest `desktop-v*` release vs running version + download links |
| `GET /api/portal-logins` | Per-panel ID-saved + cookie-saved status |
| `POST /api/portal-logins` | Save a supplier ID/password (server-encrypted) |
| `POST /api/portal-logins/test` | Open the visible browser and save that panel's cookies |
| `POST /api/jobs/run-one` | Queue one waiting claim immediately |

## 8. Honestly not yet done

- Full auto-filing for Flipkart/Amazon/Myntra/Ajio (assisted today; writing
  untested portal scripts would be mock automation).
- Silent auto-update (needs code signing + notarization first).
- No live claim has been filed from this exact build in this session; Meesho
  flow is proven by prior runs, the rest by assisted screenshots + tests.
