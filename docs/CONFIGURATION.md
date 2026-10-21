<!-- Updated 2026-10-10. Every name and default was checked against the source. Not run. -->
# Configuration

The API and most command-line jobs read their settings from environment variables. They load a `.env` file from the project root with `dotenv`. The browser app reads no environment variables. The Vite dev server reads `.env` for one value, the `PORT` used by its `/api` proxy.

Copy `.env.example` to `.env` to start. `.env` is listed in `.gitignore`, so it is not committed. Never paste a real `.env` value into chat, docs or code.

## Environment variables

| Variable | Required | Default | Read in | Description |
|---|---|---|---|---|
| `DATABASE_URL` | **Required** for database features | none | `server/db.ts` | PostgreSQL connection string. End it with `?sslmode=verify-full`, or `&sslmode=verify-full` if it already has a `?`. Without it the server still starts, but database routes answer HTTP 503 and the log asks for this value. See [Database SSL](#database-ssl). |
| `DATABASE_SSL_CA_FILE` | Optional | none | `server/db.ts` | Path to a PEM file with the certificate authority (CA) that signed the database's certificate. Needed only when Node does not trust that authority. |
| `PORT` | Optional | `3001` | `server/index.ts`, `vite.config.ts` | Port for the API. The Vite dev proxy forwards `/api` to the same port. |
| `OMSGURU_API_TOKEN` | **Required** for OMSGuru commands | none | `server/oms/client.ts` | Bearer token for the OMSGuru API. Not in `.env.example`. |
| `OMSGURU_CLIENT_ID` | **Required** for OMSGuru commands | none | `server/oms/client.ts` | Sent in the `Oms-Cid` header. Not in `.env.example`. |
| `OMSGURU_BASE_URL` | Optional | `https://client.omsguru.com` | `server/oms/client.ts` | Overrides the OMSGuru host. The trailing slashes are removed. |
| `NEW_USER_PASSWORD` | **Required** for `npm run user:create` | none | `server/scripts/create-user.ts` | The password for the user being created. Set it in the terminal for that command only. It is never printed and never saved to a file. |
| `TEST_DATABASE_URL` | Optional, for `npm test` only | none | `server/tests/register-db.test.ts`, `server/tests/access-db.test.ts` | A dedicated test database. Its name must contain `test`. Without it the database checks are skipped. Never point it at the production database. |
| `SESSION_SECRET` | Not used | none | nothing | Appears in `.env.example`. No code reads it. Sessions are random tokens stored in the database. Remove it from the example to avoid confusion. |

`.env.example` holds `DATABASE_URL` (empty), `PORT=3001`, `SESSION_SECRET` (unused), and two commented lines: `DATABASE_SSL_CA_FILE` and `TEST_DATABASE_URL`. It does not hold the OMSGuru variables.

If the OMSGuru token or client ID is missing, the OMSGuru commands stop with the message `OMSGURU_API_TOKEN and OMSGURU_CLIENT_ID are not set in .env` before any request is sent.

## Example `.env`

```bash
DATABASE_URL=<your PostgreSQL connection string, ending in ?sslmode=verify-full>
# DATABASE_SSL_CA_FILE=<path to the CA certificate, only if the certificate check fails>
PORT=3001
OMSGURU_API_TOKEN=<your OMSGuru token>
OMSGURU_CLIENT_ID=<your OMSGuru client ID>
```

Which PostgreSQL host and database name each machine uses cannot be determined from the repository. Which certificate authority the database provider uses is not recorded in the repository either. Check the provider's documentation before you set `DATABASE_SSL_CA_FILE`.

## Required and optional settings

- **Startup does not fail** when a setting is missing. The server logs the problem and keeps running. Routes that need the database answer HTTP 503 with the message `Add DATABASE_URL to the .env file and restart the server.`
- **OMSGuru settings** are checked when a command runs, not at startup.
- **Upload limits** are fixed in `server/upload-routes.ts`: 25 MB per file, and a staged preview expires after 15 minutes.

## Database SSL

The server checks the database's TLS certificate on every connection. No setting turns that check off. `connectionSettingsFor()` in `server/db.ts` reads `DATABASE_URL` and chooses the SSL setting:

| Host or `sslmode` | Result |
|---|---|
| `localhost`, `127.0.0.1`, or `[::1]`, with no `sslmode` | No TLS |
| Any other host, with no `sslmode` | TLS, with the certificate and host name checked |
| `sslmode=disable` | No TLS |
| `sslmode=require`, `prefer`, `allow`, `verify-ca`, or `verify-full` | TLS, with the certificate and host name checked |
| `sslmode=no-verify` | Refused. The server does not connect. |

Other rules:

- `sslmode` and `sslrootcert` are removed from the string that the driver receives. Only the table above decides whether TLS is used.
- For a private or self-signed certificate authority, set `DATABASE_SSL_CA_FILE` to the path of a PEM file that contains the CA certificate. The file is read when the pool is created. `sslrootcert=<path>` in the URL does the same when `DATABASE_SSL_CA_FILE` is not set.
- Node.js checks certificates against its own list of trusted authorities, not the Windows certificate store. The standard `NODE_EXTRA_CA_CERTS` variable can add authorities for the whole process. It applies to all TLS in that process, not only to the database.

The recommended `DATABASE_URL` is the provider's connection string with `?sslmode=verify-full` added at the end. Do not paste the URL into chat, docs, or code.

Common error messages:

- `self-signed certificate in certificate chain` or `unable to get local issuer certificate`: the authority that signed the certificate is not trusted. Set `DATABASE_SSL_CA_FILE`. On a machine with antivirus or corporate web filtering that inspects TLS traffic, the inspecting authority's certificate is the one to export, and the IT team can supply it.
- `The server does not support SSL connections`: the database does not offer TLS. Turn on TLS on the database. Adding `sslmode=disable` to that one URL removes the protection of the connection, so use it only on a trusted private network.
- `The CA certificate file (DATABASE_SSL_CA_FILE or sslrootcert) cannot be read`: the path is wrong or the file is not there.
- `sslmode=no-verify is not allowed`: remove that value from the URL.

## Defaults in code

| Setting | Default | Where |
|---|---|---|
| API port | `3001` | `server/index.ts` |
| Web dev port | `5173`, bound to `0.0.0.0` | `vite.config.ts` |
| Database TLS | On for every host except localhost, certificate checked | `server/db.ts` |
| Database connection timeout | 8 seconds | `server/db.ts` |
| Lock timeout for a write transaction | 15 seconds | `server/db.ts`, `server/lookup-import.ts`, `server/register-service.ts` |
| Upload size limit | 25 MB | `server/upload-routes.ts` |
| Staged upload lifetime | 15 minutes | `server/upload-routes.ts` |
| Register page size | 50 rows, at most 200 | `server/register-routes.ts`, `server/register-service.ts` |
| Register export limit | 50,000 rows | `server/register-service.ts` |
| JSON body limit | 2 MB | `server/index.ts` |
| OMSGuru host | `https://client.omsguru.com` | `server/oms/client.ts` |
| OMSGuru request timeout | 60 seconds | `server/oms/client.ts` |
| OMSGuru attempts per request | 5 | `server/oms/client.ts` |
| OMSGuru listing page size | 100 | `server/oms/client.ts` (`OMS_PAGE_LIMIT`) |
| OMSGuru invoice page size | 100 | `server/oms/invoices.ts` (`INVOICE_PAGE_LIMIT`) |

## Other configuration files

- `vite.config.ts`: web dev server on port 5173, host `0.0.0.0`, and a proxy that sends `/api` to `127.0.0.1` on the API port.
- `tsconfig.json`: TypeScript settings for `src/` and `vite.config.ts` (strict mode, ES2022, bundler module resolution, the `react-jsx` transform, `isolatedModules`).
- `tsconfig.server.json`: TypeScript settings for `server/`, including the tests (strict mode, Node types).
- `tsconfig.desktop.json`: TypeScript settings for `desktop/` and `desktop-agent/` (strict mode, ES2022, Node types). `npm run typecheck` runs all three projects. The root `Dockerfile` copies this file into the builder stage because the typecheck step needs it.
- `package.json`: the scripts, and the list of test files that `npm test` runs. A new test file must be added to the `test` script by name.
- `.gitignore`: ignores `node_modules`, `dist`, `.env` and log files.
- `RUN.bat`: Windows helper. It installs packages on the first run, warns when `.env` is missing, opens the web app after six seconds, and runs `npm run dev`.

## Desktop Application Configuration

The cross-platform Desktop Application (`desktop/` & `desktop-agent/`) runs on warehouse workstations (Windows, Linux, macOS) and reads its configuration from the local user profile. Full operator guide: [DESKTOP-APP.md](DESKTOP-APP.md).

- **Configuration File:** `~/.taskflow-claim-agent/config.json` (under `%USERPROFILE%\.taskflow-claim-agent\config.json`).
- **Fields:**
  | Field | Default | Description |
  |---|---|---|
  | `backendUrl` | `https://return.youthnic.shop` | Target Return App backend URL. Localhost/127.0.0.1 entries are automatically migrated to production cloud URL. |
  | `agentUuid` | `agent-<hostname>-…` | Identifier for the workstation worker instance. |
  | `agentName` | `Warehouse-Agent-<hostname>` | Display name shown in the automation device list. |
  | `apiKey` | `""` | Per-PC API key from Admin/Supervisor enrollment. Stored encrypted (OS credential store) inside the packaged app. |
  | `pollIntervalMs` | `10000` (10s) | Polling frequency. Uses adaptive backoff in Electron runtime (5s active, up to 30s idle). |
  | `browserMode` | `"visible"` | `"visible"` opens the supplier browser so filing can be watched; `"headless"` runs it hidden. |
  | `browserPath` | `""` | Optional explicit browser executable (auto-detected otherwise: Edge/Chrome on Windows, Chrome/Chromium on Linux, Chrome/Edge/Chromium on macOS). |
- **Environment Overrides:**
  - `APP_URL` or `BACKEND_URL`: Overrides the backend URL (useful for local development).
  - `BROWSER_PATH`: Overrides the browser executable (warehouse PCs with a custom install path).
  - `DESKTOP_UPDATE_FEED_URL`: Overrides the GitHub releases feed used by Check-for-updates.
- **Session & Storage Locations:**
  - **Persistent App Session:** Electron partition `persist:return-app-desktop` stored in `%APPDATA%\Return App\Partitions\return-app-desktop`. Stores operator authentication cookies and tokens across reboots.
  - **Operator sign-in:** `~/.taskflow-claim-agent/operator-session.json` (token encrypted with the OS store in the packaged app; see `GET /api/security` on the dashboard).
  - **Browser Profiles:** `~/.taskflow-claim-agent/browser-profiles/profile-[marketplace]` (e.g. `profile-meesho`). Keeps marketplace supplier portal cookies and active logins alive — one isolated profile per panel.
  - **Evidence Cache:** `~/.taskflow-claim-agent/evidence-cache/`. Downloads evidence photos/videos here via stream pipeline, automatically pruning items older than 24 hours on launch.
  - **Bot logs:** `~/.taskflow-claim-agent/logs/bot-YYYY-MM-DD.log` (7 days kept).
- **Windows auto-config (installer):** `build/installer.nsh` registers the `ReturnAppClaimBot` Scheduled Task (sign-in trigger, hidden launch, restart on failure) and removes it on uninstall. Supplier cookies and sign-in are kept across reinstalls.

## Per-environment settings

The repository has no `.env.development`, `.env.production`, or `.env.test` files. The code does not read `NODE_ENV`. Each machine uses its own `.env`.
