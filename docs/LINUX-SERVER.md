# Return App — Linux Server Deployment (Headless Automation Engine)

This document covers **Mode 3**: running the marketplace claim automation engine on a
dedicated Linux server with no graphical desktop, and managing it from the desktop
application or a web browser.

The engine is the same Node/TypeScript code that runs inside the Windows desktop
application (`desktop-agent/`). Nothing is rewritten for the server; only the binding,
browser mode and data directory change.

---

## 1. Deployment modes at a glance

| Mode | Where | Engine binding | Browser | Window |
|---|---|---|---|---|
| 1. Windows Desktop | Warehouse PC | `127.0.0.1:3005` (embedded) | system Edge/Chrome, visible | Electron shell |
| 2. Linux Desktop | Workstation | `127.0.0.1:3005` (embedded) | system Chromium/Chrome, visible | Electron shell |
| 3. Linux Server | VPS / bare metal | `0.0.0.0:3005` + `ENGINE_TOKEN` | Chromium, headless | none |

In every mode the **engine owns the worker loop**. The desktop shell is a client of it.
Closing the desktop window (or never opening one) does not stop automation in Mode 3.

---

## 2. Prerequisites

- Linux server (Ubuntu 22.04+/Debian 12+ tested shape), 2 vCPU / 2 GB RAM minimum.
- Node.js 22+ **or** Docker with the Compose plugin.
- Network access to the Return App backend (`https://return.youthnic.shop`).
- A per-engine API key issued by an Admin/Supervisor in the Return App backend
  (Admin → Marketplace accounts / Server PC enrollment). The engine cannot lease a
  job without it.

---

## 3. Bare-metal install (systemd)

```bash
# 1. Service account and folders
sudo useradd --system --create-home --shell /usr/sbin/nologin returnapp
sudo mkdir -p /opt/return-app /etc/return-app /var/lib/return-app-engine
sudo chown -R returnapp:returnapp /opt/return-app /var/lib/return-app-engine

# 2. Code and dependencies
sudo -u returnapp git clone https://github.com/pawanshukla500/return-youthnic.git /opt/return-app
cd /opt/return-app
sudo -u returnapp npm ci --omit=dev

# 3. Chromium (headless, driven over CDP — no display server needed)
sudo apt-get update && sudo apt-get install -y chromium

# 4. Configuration
sudo cp deploy/engine/.env.example /etc/return-app/engine.env
sudo chmod 600 /etc/return-app/engine.env
#    edit it: set ENGINE_TOKEN (openssl rand -hex 32), BACKEND_URL, AGENT_API_KEY
sudo editor /etc/return-app/engine.env
sudo chown returnapp:returnapp /etc/return-app/engine.env

# 5. Install and start the service
sudo cp deploy/engine/systemd/return-app-engine.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now return-app-engine
```

Verify:

```bash
systemctl status return-app-engine
journalctl -u return-app-engine -f
curl -fsS http://127.0.0.1:3005/api/health
```

---

## 4. Docker install

```bash
cd deploy/engine
cp .env.example .env
# set ENGINE_TOKEN, BACKEND_URL, AGENT_API_KEY, AGENT_NAME
chmod 600 .env
docker compose up -d --build
docker compose logs -f engine
curl -fsS http://127.0.0.1:3005/api/health
```

The image installs Chromium from the distro, runs as the non-root `node` user, and uses
`tini` as PID 1 so Chromium child processes are always reaped. The compose file publishes
port 3005 on **loopback only**; expose it through a reverse proxy or SSH tunnel.

---

## 5. The control API

Every route except `/api/health` requires `Authorization: Bearer <ENGINE_TOKEN>` when the
engine is bound to a non-loopback host.

| Route | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Liveness/readiness. No token. Used by Docker and systemd probes. |
| `/api/v1/engine/info` | GET | Version, platform, bind, uptime, worker status, panel states, data dir. |
| `/api/status` | GET | Worker running/processing, active job, next poll, backend URL. |
| `/api/panels` | GET | Per-panel state, cookie/session status, last result. |
| `/api/panels/:key/clear` | POST | Clear a panel hold so it rejoins the rotation. |
| `/api/follow-ups` | GET | Ticket follow-ups for the dashboard (proxied to the backend with the operator's token). |
| `/api/jobs` | GET | Recent claim jobs. |
| `/api/jobs/run-one` | POST | Queue one specific claim now. |
| `/api/scheduler/toggle` | POST | Pause / resume the worker. |
| `/api/scheduler/poll-now` | POST | Check for claims immediately. |
| `/api/portal-logins` | GET/POST | Supplier ID/password status and saving (server-encrypted). |
| `/api/portal-logins/test` | POST | Open the portal and save that panel's session cookies. |
| `/api/logs/stream` | GET | Server-Sent Events stream of engine logs. |
| `/api/security` | GET | Whether OS credential-store encryption is active. |
| `/api/updates/check` | GET | Newest desktop release vs the running version. |

### Manual login, OTP and CAPTCHA

Some panels cannot be automated headlessly at the login step. Two supported paths:

1. **Seed the session on a host of the same operating system**, then copy the panel profile
   directory (`AGENT_DATA_DIR/browser-profiles/profile-<panel>`) to the server's data
   volume. Chromium encrypts its cookie jar with a key held by the OS for that user —
   DPAPI on Windows, the desktop keyring on Linux — so the copy carries a usable session
   only within the same OS. A Windows profile copied to a Linux server does **not** carry
   over, and the panel will still ask for a login; use path 2 to sign in on the server
   itself.
2. **Run the engine with a display** for that panel: set `BROWSER_MODE=visible` and either
   give the host a VNC/X session or start a temporary container with `Xvfb`. Complete the
   OTP/CAPTCHA once, then return to headless. This is the supported way to seed a session
   on the Linux server.

A challenge the engine cannot pass sets the panel to `manual_action` and leaves the other
panels filing. It never guesses a credential.

---

## 6. Connecting the desktop client to a remote engine

Set these in the environment the desktop application starts with:

```powershell
$env:RETURN_ENGINE_URL = "https://claims-engine.example.com"
$env:ENGINE_TOKEN = "<the same token as the server>"
```

The desktop shell then:

- does **not** start a local engine and does **not** run a local worker;
- loads its window from the remote engine and injects the bearer token on every request
  to that origin;
- shows the remote worker state, panels, logs and controls;
- does **not** register itself to start at login. The autostart entry carries no
  environment, so it would come back at the next sign-in without `RETURN_ENGINE_URL` and
  silently start a local engine instead of connecting to the server. The remote engine is
  the one that files claims, so nothing is lost. The token is never written to an
  autostart file or a registry value, which would be readable by anyone who can read the
  user profile.

If `RETURN_ENGINE_URL` is unset the shell behaves exactly as before: it embeds a local
engine on `127.0.0.1:3005` and registers itself to start hidden at login.

---

## 7. Security rules

1. Never bind the engine to `0.0.0.0` without `ENGINE_TOKEN`. The engine refuses to start
   (fail-closed), so this cannot be misconfigured silently.
2. Never publish port 3005 directly to the internet. Use a reverse proxy with TLS, or an
   SSH tunnel (`ssh -L 3005:127.0.0.1:3005 user@server`).
3. `AGENT_DATA_DIR` contains supplier browser cookies and the operator session. Treat it
   as a secret: encrypted disk where possible, and never in a public backup. The engine
   already enforces this — `ensureAgentDataDir()` creates the root 0700 and re-chmods it
   on every call, and `writeSecretFile()` writes `config.json` and `operator-session.json`
   0600 — so a folder or file left loose by an older build is tightened rather than
   trusted. Run the engine as its own unprivileged user so that mode is meaningful.
4. The engine token and the PC API key are never logged. Do not add logging that prints
   them.
5. Chromium keeps its renderer sandbox. The browser loads untrusted supplier pages, so
   the sandbox is what keeps a compromised page away from the mounted browser profiles
   and their supplier cookies. It is disabled only when `BROWSER_NO_SANDBOX=1` is set, or
   when the engine runs as root on Linux (where Chromium refuses to start otherwise).
   Run the engine as its own unprivileged user and leave the flag unset unless your
   container runtime blocks the user namespaces the sandbox needs.

---

## 8. Operations

### Ticket follow-ups

After a claim is filed, the engine re-opens that panel on its own every 2 days, reads the
ticket status, and reports it to the backend, which reschedules or stops it. The engine's
own look-up cadence is `FOLLOWUP_INTERVAL_MS` (30 minutes by default); the backend only
hands out a ticket when it is genuinely due, so this is a cheap poll. A follow-up check
never runs at the same time as a filing job, because both drive the same supplier profile.
The engine exposes the state on `GET /api/status` (`lastFollowUpCheckTime`,
`followUpChecksRun`, `lastFollowUpResult`).

### Health checks

`GET /api/health` returns `200` with the worker state. Wire it into your monitoring:

```bash
*/1 * * * * curl -fsS http://127.0.0.1:3005/api/health > /dev/null || systemctl restart return-app-engine
```

### Recovery

| Failure | What happens |
|---|---|
| Engine crash | systemd `Restart=always` (or Docker `restart: unless-stopped`) relaunches it. |
| Server reboot | Service starts on boot; a saved operator sign-in resumes the worker. |
| Network drop | Saved sign-in is kept; polling retries with backoff. |
| Portal OTP/CAPTCHA | Panel goes to `manual_action`, other panels keep filing. |
| Chromium zombie | `tini` reaps it; the runner also kills the full process tree per claim. |
| Backend 5xx | Job progress updates fail safely; an uncertain submission is never auto-retried. |

### Upgrading

```bash
cd /opt/return-app && sudo -u returnapp git pull
sudo -u returnapp npm ci --omit=dev
sudo systemctl restart return-app-engine
```

For Docker: `docker compose pull && docker compose up -d --build`. The data volume
survives, so panels do not need to sign in again.

### Logs

- Journal: `journalctl -u return-app-engine -f` (systemd) or `docker compose logs -f`.
- Daily files: `AGENT_DATA_DIR/logs/bot-YYYY-MM-DD.log`, kept 7 days.

---

## 9. Scaling to multiple engines

The backend leases each job to exactly one engine (server-side leases + bounded attempts),
so several engines can run against the same account set:

1. Give each engine its own `AGENT_NAME`, `AGENT_UUID` and API key.
2. Give each engine its own `AGENT_DATA_DIR` volume (its own browser profiles).
3. Point them at the same `BACKEND_URL`.

Add `engine-2`, `engine-3` services to `docker-compose.yml` with distinct tokens and
volumes. No code change is required.

---

## 10. What is not done yet

- No live claim has been filed from a Linux server in this repository's history. The
  Linux code paths (browser discovery, process-tree kill, auto-start) are written and
  reviewed, not exercised end to end.
- Only the Meesho panel files claims automatically. Flipkart, Amazon, Myntra and Ajio run
  assisted and need a visible browser and an operator, so they are not useful in headless
  Mode 3 yet.
- No marketplace implements the ticket status reader (`checkClaimStatus()`) yet. The
  follow-up framework runs end to end, but each panel currently answers "not implemented",
  so its follow-ups stop with that reason rather than reading a ticket.
- No AI reply service is wired in. See `docs/notes/ai-provider-comparison.md`.
