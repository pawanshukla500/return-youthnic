# Mission: Genuine Windows Desktop Application — Independent Electron Renderer

**Repository:** `pawanshukla500/return-youthnic`
**Base:** latest `origin/main` (PR #50 merged; preserve its claim-authorization fixes)
**Suggested isolated branch:** `feature/native-electron-desktop-shell`
**Target:** Windows 10/11 x64
**Technology:** existing Electron + React 19 + TypeScript + Vite, Chromium `WebContentsView`
**Scope:** desktop application architecture, frontend migration, renderer/process integration, real Windows installer tests, and documentation. Do **not** expand marketplace filing workflows.

## 1. Outcome, not a cosmetic wrapper

The installed EXE must launch an independent **bundled desktop UI**. It must **not** use `mainWindow.loadURL(engineUrl)` to render the HTTP server's dashboard. It may continue using a local background service for worker APIs and events, but the application's shell, navigation, settings, claim screens, AI Center, and browser controls must be packaged renderer assets loaded using a secure local app protocol or `loadFile`.

A desktop renderer can use web technologies; the unacceptable design is an Electron window merely pointing to the engine's server-generated webpage. The background engine is not itself a defect: retain its stable API and automation logic.

### Verified baseline in source (revalidate before editing)

- `desktop/main.ts` starts the local engine with `startDesktopAppServer()` and calls `mainWindow.loadURL(engineUrl)`.
- `desktop-agent/src/desktop-app-server.ts` generates the desktop dashboard using `getDashboardHtml()`; its local HTTP service also owns worker control APIs.
- `package.json` currently bundles `desktop/dist/**/*`, `desktop/preload.cjs`, and `public/**/*` but no dedicated Vite desktop renderer output.
- Native marketplace pages use Electron `WebContentsView`; preserve this design and existing persistent per-account sessions.
- PR #50 already hardened job submission authorization and added integration tests; do not regress that work.
- Post-PR #50 changes may already have introduced marketplace tabs and detached windows: inventory them and reuse instead of duplicating.

## 2. Start with a code-and-risk audit

Read `AGENTS.md`, `README.md`, `docs/notes/agent-handoff.md`, current desktop/engine architecture, and PRs #47–#50. Inspect Git status, branches, worktrees, and other agents' active changes. Preserve unrelated edits. List actual features, IPC APIs, local engine routes, session partitions, installer assets, UI pages, dependencies and test coverage. Produce a migration map from each `getDashboardHtml()` feature to its future React screen. Distinguish implemented/tested/live-verified/proposed capabilities.

## 3. Create a dedicated desktop renderer

Recommended structure (adapt to existing conventions):

```
desktop/
  main.ts
  preload.cjs
  renderer/
    index.html
    main.tsx
    App.tsx
    layouts/
    pages/
    components/
    state/
    hooks/
    services/
    styles/
    types/
  assets/
```

Use React, TypeScript and Vite with dedicated scripts such as `desktop:renderer:build`, `desktop:build`, `desktop:dist`. Use version-pinned dependencies consistent with the repository. Produce local, hashed, packaged renderer assets; avoid runtime CDN dependencies for essential fonts/assets. Configure CSP, application origin, routing and base paths to work from an NSIS installation with no Vite dev server. In production `mainWindow` loads the bundled desktop assets. In development it may load the Vite dev URL, clearly gated by development mode.

The desktop UI should start and render a useful disconnected/connecting state **even if the local engine or Hostinger backend is unavailable**. Startup recovery must not destroy authenticated browser profiles or duplicate job executions.

## 4. Native application shell and UX

Build a coherent Windows desktop experience (clean light default, dark option) with:

- Standard Windows minimize, maximize, restore, close-to-tray and explicit Quit; durable window size/position; high-DPI and multiple monitors.
- Persistent sidebar and meaningful navigation, keyboard support, focus management, accessible menus and notifications.
- Dashboard: claim counts by real status, connected accounts, worker status, recent activity, errors.
- Claims: filter/search, detail and evidence preview, upload verification, approval state, ticket, timeline, retries/manual intervention.
- Marketplace browsers: tabs, account identity, loading/connection state, Back/Forward/Reload, embedded native viewport, optional safe detach/dock.
- Follow-ups: real tickets, check timestamps, outcomes, amount/payment reconciliation only when verified.
- AI Center: existing six provider configuration, models, status, routing, real usage, approved memory and events.
- Settings: backend, credentials, notifications, appearance, updates, diagnostic information.

Every visible action must work through real services or explicitly explain that the feature is unavailable. No fake success, stub stats or simulated progress. Store UI-only preferences separately from secrets.

## 5. Built-in Chromium browser, not an overlay

Maintain Electron `WebContentsView` instances owned by the **Electron main process**. Supplier pages are neither iframes nor browser extensions. Preserve existing profile isolation, browser tab manager, WebContentsView ownership and session cookies.

Layout: app title bar + sidebar + tab strip + navigation toolbar + bounded marketplace viewport + claim status/action strip. The supplier view must never obscure the sidebar, toolbar or approval controls.

The desktop React renderer measures the dedicated browser placeholder; report its bounds to the main process by typed, validated IPC using appropriate resize/layout observers. Invalidate/recompute bounds on resize, maximize, display scaling, sidebar changes, tab switches and detach/dock. Use device-independent coordinates. **If bounds are missing or invalid, hide the native view rather than default to full-window.** Full-window browser mode must be an explicit operator action with a clear exit.

Tab switching must not reload the portal, remove cookies, destroy ongoing form input or double-start worker runs. Detaching a view requires a safe transfer of ownership to another Electron window, without cloning the session/worker. Guard against closing or detaching a tab during a critical claim step. Support manual OTP/CAPTCHA and normal sign-in without bypassing supplier security controls.

## 6. Separate and supervise the background engine

Existing engine responsibilities stay outside the renderer: job polling/leasing, evidence download, browser automation coordination, AI calls, ticket follow-ups, scheduling, local filesystem, credential APIs and logging.

Assess process isolation and choose the smallest safe approach (Electron `utilityProcess` or supervised child process if compatible). The main process must still own native browser views; worker commands to browser views must use typed, bounded IPC. Do not transfer live `WebContentsView` objects between processes.

Keep existing local and remote engine modes if supported. Avoid exposing a loopback engine to LAN or other websites without authentication, origin restrictions and CSRF protections. If loopback HTTP remains, ensure the packaged renderer can use it securely and that the local port is not treated as a public API. For remote-engine mode preserve bearer token isolation and existing authorization semantics.

Define explicit crash/restart behavior for renderer, engine, supplier-browser renderer, and backend outages. Reconnection may restore UI but must not repeat uncertain submissions. Avoid unbounded background resource use on 2-core/4GB machines; benchmark actual cold start, switching, downloads, AI requests, CPU and memory.

## 7. Secure typed communication

Create a minimal, typed preload bridge or internal API client, for example:

- app/operator status, marketplace accounts, worker health, claim lists/details
- worker pause/resume/poll operations with existing permissions
- browser tabs open/activate/hide/detach/dock, bounded viewport updates
- provider configuration, usage data, updates, notifications
- authorized claim approval and manual-resolution actions
- subscriptions for job progress, browser status, uploads and worker events

Use `contextIsolation`, sandboxing when compatible, `nodeIntegration: false`, origin checks and input validation. Do not expose `ipcRenderer`, arbitrary execution, raw file access or secrets to the renderer or marketplace pages. Secure event subscription lifetimes; avoid duplicate listeners after reload.

## 8. Credentials and secrets — preserve current production state

The owner has already configured `AUTOMATION_SECRET_KEY` in **GitHub Actions repository secrets**. The current Hostinger deployment workflow references it, and backend PostgreSQL supplier-password decryption may still depend on it. Do not create, rotate, reveal or delete this key. Verify runtime injection by a non-disclosing health/presence check where authorized.

Operator login remains backend-authenticated. LLM provider keys remain local and encrypted with Windows DPAPI when available. Existing supplier Chromium sessions must survive application upgrades. A future local supplier-credential vault can be built with a controlled migration, not by removing backend encrypted credentials prematurely. Production must not silently fall back to plaintext.

Review tracked deployment workflows for credential-bearing fallback strings. Remove secret-bearing defaults safely, switch to protected deployment configuration, and raise an urgent credential-rotation assessment without printing values.

## 9. Preserve business logic; fix misleading presentation

Preserve PR #50's backend-issued submitting leases, approval rules, idempotency, account scope, and manual resolution restrictions. The frontend rewrite must not create a new path to unauthorized claim filing.

An earlier real Meesho test downloaded four evidence files but failed verification for the required supplier upload boxes. The engine still reported a prepared claim. That defect is a separate worker/portal-adapter fix: the new UI must display the actual attachment state, block misrepresented preparation, and give a safe manual path. Do not represent downloaded evidence as uploaded evidence. The claim worker adapter fix should have its own tests and must not be hidden by the UI rewrite.

Do not implement unverified Flipkart, Amazon, Myntra or Ajio claim filing procedures; the owner will supply those workflows later.

## 10. Branding and offline behavior

Use the existing Brandfetch brand manifest or obtain authorized official assets. Cover Meesho, Flipkart, Amazon, Myntra, AJIO, Shopify, Cocoblu and six AI providers (Meta, OpenAI, Kimi, Anthropic, Google/Gemini, Z.ai). Verify correct product/brand identity. Display-only Brandfetch CDN URLs are not permission to scrape/download for packaging. Bundle permitted local assets, provide neutral offline fallbacks and do not confuse seller accounts with marketplaces.

## 11. Packaging and installer

Update `package.json` and Electron Builder configuration to include local renderer output, correct main/preload code, required background engine runtime/modules, SDK dependencies, app icons and permitted assets. Verify real `.asar`/`asarUnpack` requirements and native modules, if any. No installed Node.js, Python, Chrome, Vite or dev server should be needed to run the shipped Windows app. Do not package GitHub/deployment secrets.

Verify clean install, upgrade from existing installed version, user data/cookie preservation, tray/autostart, updates and uninstallation behavior. Do not accidentally relaunch an old or duplicate worker during upgrades.

## 12. Test in the actual Windows executable

Run typechecks, relevant unit tests, PostgreSQL integration tests, secure IPC tests, React component tests, real Electron GUI automation, visual regression, NSIS packaging and clean Windows VM/hardware testing.

Mandatory acceptance journey:
1. Installed EXE opens its **bundled renderer**, with engine stopped/unavailable.
2. Dashboard displays actionable offline/connecting state without rendering local HTTP dashboard HTML.
3. Engine starts/reconnects and worker control updates correctly.
4. User signs in, sees authorized accounts and real claim counts.
5. Native Meesho tab opens inside the bounded browser viewport; app controls remain visible.
6. Switch to Dashboard and back: same page, cookies and form state retained.
7. Open/switch/close/detach/dock browser tabs safely; minimize, restore, maximize and multi-monitor resize.
8. Claim evidence and upload failures show true status; approval logic remains enforced.
9. AI Center and follow-ups display real backend/engine data.
10. Renderer/worker/browser crashes recover safely; uncertain filing isn't retried blindly.
11. Upgrade preserves sessions, local keys and existing data.
12. Measure startup, CPU, memory and responsiveness on actual target hardware.

Separate automated/mocked tests from operator-confirmed live portal and Windows GUI tests. No invented test outcomes or fabricated screenshots.

## 13. Documentation, review and delivery

Update `README.md`, `AGENTS.md` where rules changed, `docs/notes/agent-handoff.md`, desktop/renderer architecture, main-process/engine ownership, IPC, browser tab/session behavior, build and packaging steps, Windows installation and upgrade, security, tests, troubleshooting and known issues. Mark PR #50 merged. Reconcile stale historical handoff notes against code.

Create a separate feature branch/worktree from latest `main` to avoid conflict with ongoing M9 changes. Make reviewable commits; perform full diff and secret scans, run CI, request CodeAnt/independent reviews, fix findings and open a dedicated PR. Merge only after genuinely passing critical Windows GUI and security tests. Report code changes, screenshots, measurements, tests, unverified functionality, docs and PR status.

## Non-negotiable acceptance

- Packaged Electron renderer is independent of the local engine webpage.
- The app shell renders while engine/backend is down.
- Engine claim processing, job controls, AI Center and authorization are preserved.
- Native Chromium supplier tabs are bounded and have stable sessions.
- Production installer contains all essential assets and works on a clean Windows machine.
- No plaintext-secret regression, credential exposure or duplicate claim risk.
- Documentation reflects the shipped state and remaining gaps.

**Do not deliver another `BrowserWindow.loadURL(http://127.0.0.1:3005/)` dashboard wrapper.** The server can remain for APIs, but the desktop interface must be a proper packaged, maintained app.
