<!-- Updated 2026-10-19. CI runs 444 tests with postgres:16 service. Android v1.0.58. Desktop source v1.2.0: cross-platform installers (Windows/Linux/macOS) + panel-wise continuous filing; last published installer still desktop-v1.1.0.10 until 1.2.0 merges. -->
# return-scanning-app

A return scanning app for VB Exports. Marketplace return reports (Myntra VB and Myntra EJ, Flipkart, Meesho, Amazon, and Ajio) are loaded as lookup data, one account at a time. A scan then records what physically arrived in the return scan register, which is the permanent record. The app also stores channel listings and master SKUs from the OMSGuru API, for product titles and images.

**Status (2026-10-19):** Full local and CI test suites pass with 444 tests (407 pass, 0 fail, 37 database checks run against a dedicated `postgres:16` container). Deployed to production VPS (`https://return.youthnic.shop`). Native Android return scanning app active at `v1.0.58` (`versionCode` 10058). Cross-platform desktop application source is at `1.2.0` (`Return.App.Setup.1.2.0.exe` verified locally, 118,871,660 bytes); Windows/Linux/macOS installers publish as GitHub Release `desktop-v1.2.0.*` on merge via the matrix workflow. GitHub keeps only the newest two releases of each family (`v1.0.*` Android, `desktop-v*` desktop). See [docs/notes/agent-handoff.md](docs/notes/agent-handoff.md).

## For agents

Start at [AGENTS.md](AGENTS.md). It lists the documents to read, in order, and the rules that must not be broken. The full handoff, with the current state and how to verify it, is in [docs/notes/agent-handoff.md](docs/notes/agent-handoff.md).

## Installation

```bash
npm install
```

You need Node.js (LTS) and a PostgreSQL database. Full prerequisites are in [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

## Quick start

1. Copy `.env.example` to `.env`. Set `DATABASE_URL` to your PostgreSQL connection string with `?sslmode=verify-full` added at the end, so the database certificate is checked. See [Database SSL](docs/CONFIGURATION.md#database-ssl).
2. Start the app:

```bash
npm run dev
```

On Windows you can double-click `RUN.bat` instead. It installs packages on the first run and opens the web app.

3. Create the first sign-in user (see [Creating users](#creating-users)). Then open http://localhost:5173 and sign in. Each screen has its own address: `/` Overview, `/scan`, `/register`, `/claims`, `/uploads`, `/admin`. The API health check is at http://localhost:3001/api/health.

## Creating users

The app starts with no users, no scans, and no sample data. Create each sign-in user from a terminal in the project folder. The password is read from an environment variable, so it never appears on the command line or in the output.

Set the password for the current terminal session. Use a password of at least 10 characters. In PowerShell, single quotes keep a `$` in the password as typed:

```bash
$env:NEW_USER_PASSWORD = '<password>'
```

Create an administrator with access to every marketplace. Only an administrator can open the Admin page and change configuration:

```bash
npm run user:create -- --name "Full Name" --email person@company.com --role Admin --all-marketplaces
```

Create a user with access to some marketplaces. The names must match the marketplace accounts in Admin: Amazon, Flipkart, Meesho, Myntra VB, Myntra EJ, Ajio.

```bash
npm run user:create -- --name "Full Name" --email person@company.com --role Scanner --marketplaces "Myntra VB,Flipkart"
```

Roles are free text, and the role `Admin` is the only one with a meaning in the app. Every other user sees the accounts assigned to them, or every account if the user has the all-accounts flag. Only an administrator can open the Admin page.

## Usage

The web app has six pages. The Admin page is shown to administrators only.

- **Overview**: counts of returns received, issue returns, claims raised, and the clear rate. It also shows the last 7 days of volume, the top issue reasons, issues by marketplace, high-risk SKUs, and recent scans. Every figure is counted from the scans of the accounts you can see.
- **Scan returns**: choose an account or leave it on Auto detect, then enter or scan an AWB. If the tracking ID matches more than one account you can see, choose the account. Check every item of the return: its physical check, its received quantity, and any issue (category, missing-item sub-issue, quantity, ticket ID). Save the return once every item is verified. A retry is safe. The scanned AWB and the match are saved with the return.
- **Return register**: one row per verified item, with the date, marketplace, tracking and order IDs, the marketplace and product SKUs, the logistic partner, return type and reason, the received issue, sub-issue, ticket ID and status, and rejection reason. Filter it, sort it, export it as CSV or Excel (the approved 19 columns, or the operational set with the traceability columns), and change a ticket's status (a rejection needs a reason). Every change is kept.
- **Claims**: claim tickets and marketplace dispute claims by account and status. Includes real-time aggregated claim merchandise values in Indian Rupees (`formatInr`), modern status filters (`ready_for_claim`, `submitted`, `processing`, `waiting_for_approval`, `approved`, `rejected`), manual `↻ Refresh`, and an overhauled View Details modal featuring quick-copy buttons, desktop automation status, an inline media gallery, click-to-zoom Lightbox, and embedded 480p SD unboxing video player.
- **Data uploads**: choose the account and use the explicit marketplace-return mode for CSV or Excel reports (up to 25 MB). Safe rows can activate with explicit confirmation while pending and invalid rows remain in history. Use the separate bulk-scanned-AWB mode for multi-sheet scanner lists; it validates against active lookups only and never activates or creates scans. Previous lookup rows are kept as history, and scanned returns stay in the register.
- **Admin** (administrators only): team members, missing-item sub-issues, issue categories (on or off, and whether a ticket ID is needed), logistics partners with their courier names and tracking hosts, marketplace accounts (upload status), product master batched import (up to 500 rows per transaction with progress and cancellation), and system status. Users are created from the command line, as shown above.

## Native Mobile & Desktop Clients

- **Native Android Scanner (`android/`)**: Built in Kotlin with CameraX for rapid hardware-grade barcode scanning, runtime camera permissions, photo & 480p SD unboxing video evidence capture, visual upload progress dialogs, instant "Start Again with Zero" form reset, and automated in-app updates (`v1.0.58`, `versionCode: 10058`) synchronized with GitHub Releases. Only the newest two `v1.0.*` releases are kept.
- **Cross-platform Desktop Application (`desktop/` & `desktop-agent/`)**, source `1.2.0`:
  - **Setup files for every OS**: Windows NSIS (`Return.App.Setup.<version>.exe`, per-machine, Desktop + Start Menu shortcuts), Linux AppImage + `.deb` (Ubuntu/Debian), macOS DMG + ZIP. Built in parallel by `.github/workflows/desktop-release.yml` (windows/ubuntu/macos runners) and published as one `desktop-v*` release. Only the newest two `desktop-v*` releases are kept, and they are never marked "Latest" so the Android APK keeps that badge for in-app updates.
  - **Panel-wise continuous filing**: six isolated supplier panels (Meesho, Flipkart, Amazon, Myntra VB, Myntra EJ, Ajio), each with its own login cookies and queue. The worker rotates round-robin, so a panel waiting on OTP/CAPTCHA or cooling down never blocks the others; held panels rejoin from the dashboard (`GET /api/panels`). Meesho is fully automated; other panels run assisted (prepare + evidence, operator confirms submit).
  - **4GB RAM & 2-Core CPU Optimization**: Engineered for entry-level warehouse workstations. Operates 24/7 with < 0.5% idle CPU utilization, V8 heap limits (`--max-old-space-size=256`), restricted renderer processes (`renderer-process-limit=2`), background throttling (`backgroundThrottling: true`), and disabled spellcheck dictionaries.
  - **Persistent Session Storage**: Uses Electron partition `persist:return-app-desktop`. Operators sign in once with standard username/password; session cookies and tokens remain valid across restarts and reboots.
  - **System Tray 24/7 Automation Worker**: Closing the window minimizes the app into the Windows notification tray. Features an adaptive backoff queue scheduler (5s active / 10s-30s idle) that continuously polls marketplace claims.
  - **Chrome DevTools Protocol (CDP) Claim Engine**: Automates supplier claim filing with human keystroke typing and automatic process-tree termination on every OS (`taskkill /T /F` on Windows, process-group kill on Linux/macOS). Meesho is fully automated; other marketplaces run assisted with manual confirmation.
  - **Authenticated Worker & Leases**: Admin/Supervisor enrollment issues a per-PC API key. Jobs use expiring leases, bounded retries, and signed-in operator checks.
  - **Streaming Media Pipeline**: Direct HTTP chunk-to-disk streaming (`ReadableStream.getReader()`), size/SHA-256 verification, multi-file evidence mapping, and automated 24-hour temporary file cache pruning.
  - **Auto-start on every OS**: Packaged installs register auto-start by default (Windows registry, Linux desktop entry, macOS login item) and launch hidden in the tray.

For example, to load a Flipkart return report: open **Data uploads**, choose **Flipkart**, drop the file, read the preview, and when it can be activated, click **Activate**.

Command-line jobs (run from the project folder):

```bash
npm run sync:oms -- --list
npm run sync:oms
```

The full command list is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). The register's rules and data model are in [docs/REGISTER.md](docs/REGISTER.md).

## Testing

```bash
npm run typecheck
npm run build
npm test
```

The two database checks run only when `TEST_DATABASE_URL` is set to a dedicated test database. Without it they are reported as skipped. See [docs/TESTING.md](docs/TESTING.md).

## Documentation

- [Agent handoff](docs/notes/agent-handoff.md): the state of the work, how it is organised, and how to verify and hand it over
- [AGENTS.md](AGENTS.md): the entry point for agents
- [CLAUDE.md](CLAUDE.md): the rules the code depends on
- [Getting started](docs/GETTING-STARTED.md)
- [Development](docs/DEVELOPMENT.md)
- [Testing](docs/TESTING.md)
- [Configuration](docs/CONFIGURATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Return scan register](docs/REGISTER.md)
- [API reference](docs/API.md)
- [Working notes](docs/notes/) (layouts, spreadsheet numbers, OMSGuru, the UI audit, the register status, the Phase 1 audit matrix, and the agent roster)

The repository has no license file.
