# Desktop renderer — the bundled desktop UI

The Windows desktop app (1.3.0) ships a genuine bundled renderer: an independent
React 19 + TypeScript (strict) + Vite + Tailwind CSS application in
`desktop/renderer/`, served by the Electron main process over a privileged
custom scheme (`returnapp://desktop`). This replaced the pre-1.3.0 design where
the app window loaded the engine's server-rendered dashboard HTML from
`http://127.0.0.1:3005` — that wrapper design is gone.

The automation engine is not a defect and did not move: it still owns the only
claim worker loop, the only ticket follow-up loop, evidence downloads, browser
automation, AI calls and credential APIs. On a normal PC the Electron shell
embeds the engine in-process on `127.0.0.1:3005`; with `RETURN_ENGINE_URL` set
the shell is a client of a remote engine. In both modes the engine is the API
and worker service and the renderer is its UI. The engine still serves its
`GET /` dashboard HTML — headless Linux mode uses it in a browser — but the
desktop app never loads it in its own window.

Operator-facing behavior (install, panels, claims, follow-ups, recovery) is
documented in [DESKTOP-APP.md](DESKTOP-APP.md). This document is for the
renderer architecture: shell, routing, API client, the custom scheme, CORS, the
IPC bridge, the bounded supplier-browser workspace, offline behavior, theming,
build/packaging, security, tests, troubleshooting and known gaps.

## 1. Renderer structure

`desktop/renderer/` has its own `tsconfig.json` (strict, `noEmit`,
`moduleResolution: bundler`, covered by `npm run typecheck` as a fourth project)
and `vite.config.ts` (React plugin, Tailwind 4 plugin, `base: './'`, dev server
on port 5180 with `strictPort`). It has no separate `package.json`; its pinned
dependencies live in the root `package.json` (React 19.3, Vite 6.4, Tailwind
4.3, happy-dom 21 for tests). Marketplace logos under
`desktop/renderer/public/logos/` are copied into `dist/`; fonts are bundled
woff2 files, not runtime CDN.

```
desktop/renderer/
  index.html                 # CSP meta, mounts src/main.tsx
  vite.config.ts             # build → dist/, dev port 5180 (strictPort)
  tsconfig.json              # strict, jsx react-jsx, own typecheck project
  test-setup/register-dom.ts # happy-dom registration for node:test runs
  src/
    main.tsx                 # createRoot; ThemeProvider + SessionProvider; pre-paint theme
    App.tsx                  # shell, hash routing, login gate, offline page, update banner
    pages/
      Dashboard.tsx          # headline, panel strip, activity, log stream (SSE)
      Claims.tsx             # claims table, filters, detail + evidence viewer
      Browsers.tsx           # supplier tabs, toolbar, bounded viewport, detach/dock
      FollowUps.tsx          # ticket follow-ups table
      AiCenter.tsx           # six providers, routing, memory, usage, events
      Settings.tsx           # backend, credentials, notifications, diagnostics
      Updates.tsx            # update check + download links
      dashboard/             # dashboard-logic.ts (derived headline), useLogStream.ts
      ai-center/             # per-tab panels + format.ts helpers
    components/ui/           # Badge, DataTable, EmptyState, ErrorState, Modal,
                             # MarketplaceBadge, PanelStateDot, Spinner, StatCard
    hooks/
      useEngineStatus.ts     # polls GET /api/status (2s default)
      useEnginePolling.ts    # shared poll/refresh helper
      useBrowserWorkspaceRect.ts  # reports the native viewport rect over IPC
    services/
      engineApi.ts           # typed fetch client, EngineApiError, base resolution
      config.ts              # one-place re-export of the engine surface
    state/
      SessionContext.tsx     # global operator session; 401 clears it
      ThemeProvider.tsx      # light default / dark via data-theme, key ra-theme
    styles/index.css         # Tailwind 4 + design tokens + @font-face (local woff2)
    types/engine.ts          # wire types for the engine API
    types/global.d.ts        # window.desktopApp bridge contract (keep in sync with preload)
```

## 2. App shell and routing

`src/App.tsx` renders the whole shell:

- **Sidebar** — fixed 200px, seven buttons (Dashboard, Claims, Browsers,
  Follow-ups, AI Center, Settings, Updates) with arrow-key focus movement and
  `aria-current`. The supplier browser never covers it.
- **Top bar** — page title, a live worker pill (Processing / Bot running /
  Bot paused / Bot idle) fed by `useEngineStatus`, the signed-in operator name
  and role, and the theme toggle. The shell uses the native window frame, so
  there are no custom min/max/close buttons.
- **Routing** — hand-rolled hash routing (`#dashboard`, `#claims`, …), no
  router library, matching the repo convention. The active tab persists in
  `localStorage` (`ra-side-tab`) and unknown hashes fall back to Dashboard.
- **Login gate** — before any engine session exists the app renders a sign-in
  form that POSTs `/api/operator/login`. The engine answers 403 for roles that
  cannot run the claim bot (Admin/Supervisor only); those messages surface in
  the form. The password is cleared from state as soon as the engine accepts it.
- **Update banner** — polls `/api/updates/check` every 30 minutes once signed
  in; a newer `desktop-v*` release shows a dismissible banner ("Later" is
  remembered per release tag).
- **Full-page states** — when the engine cannot be reached the entire window
  renders a connecting/offline page (spinner, engine URL, error, Retry now);
  see §9.

## 3. Engine API client and the auth model

`src/services/engineApi.ts` is the single typed fetch client every page uses.

- **Base URL** — resolved once per renderer lifetime from the preload bridge
  (`window.desktopApp.getEngineTarget()` → `{ kind, url }`); a plain browser
  (Vite dev without the shell) falls back to `http://127.0.0.1:3005`.
  `invalidateEngineBase()` re-resolves after a shell retarget.
- **Errors** — `EngineApiError(status, message, body)`. `status === 0` means
  the engine was unreachable (connection refused, DNS, offline);
  `isSessionError()` is a 401; `isNetworkError()` is status 0. Pages branch on
  these instead of guessing.
- **Global operator session** — `SessionContext` holds the signed-in operator
  profile. A 401 from any engine call clears it (`handleAuthError`), and the
  shell drops back to the login gate. Session bootstrap is
  `GET /api/operator/session`: only a definite 200 may set or clear the
  session, so a network blip never signs the operator out.
- **Remote bearer auth** — for a remote (non-loopback) engine, the Electron
  main process injects `Authorization: Bearer <ENGINE_TOKEN>` through a
  `webRequest.onBeforeSendHeaders` hook on the engine origin before any request
  leaves the app. The token intentionally never reaches the renderer: the
  client must never add an `Authorization` header and never read a token from
  renderer-visible state. `desktop:get-engine-target` returns the URL and kind
  only.

The pages call the same engine routes the headless dashboard documents
(`GET /api/status`, `/api/jobs`, `/api/panels`, `/api/follow-ups`,
`/api/portal-browser*`, `/api/evidence/:claimId[/:fileName]`,
`/api/operator/*`, `/api/updates/check`, `/api/security`, `/api/portal-logins`,
`/api/logs/stream` over EventSource, and the AI Center family). All non-health
routes keep their existing operator/engine authorization; the renderer added no
new privileged path.

## 4. The `returnapp://desktop` scheme

A custom scheme gives the packaged renderer a real, stable origin. That one
decision is what makes the security model exact:

- **CORS** — the engine can allow precisely `returnapp://desktop` (see §5)
  instead of a wildcard, so only this app's renderer can read engine responses
  from a page.
- **CSP** — `index.html` ships a `<meta http-equiv="Content-Security-Policy">`
  (`default-src 'self'`, engine hosts only in `img/media/connect-src`, no CDN
  fonts), and Chromium enforces it because the scheme is registered with
  `bypassCSP: false`.

`desktop/main.ts` registers the scheme with
`protocol.registerSchemesAsPrivileged` (`standard: true, secure: true,
supportFetchAPI: true, stream: true`) before `app.whenReady`, then serves it
with `protocol.handle`:

- Files resolve inside `desktop/renderer/dist` only; normalized paths that
  escape the dist root are rejected with 404.
- Extensionless paths (SPA routes) fall back to `index.html`; missing real
  assets answer 404.
- If the dist folder does not exist at all, every request answers a minimal
  503 page telling the developer to run the renderer build (§14).
- Production loads `returnapp://desktop/index.html`; development
  (`!app.isPackaged`) loads `http://localhost:5180` (overridable with
  `DESKTOP_RENDERER_URL`).

The window's `will-navigate` allows only the renderer origin — the engine
origin, `file:`, `https:` and `data:` navigations are all blocked. A failed
renderer load retries once after 3s; a dead renderer process reloads the
window. Neither touches the engine: engine connectivity appears inside the
renderer as failed API calls, not as a load failure.

## 5. CORS contract

The engine's CORS lives in `desktop-agent/src/cors.ts` and is applied in
`desktop-agent/src/desktop-app-server.ts` before every route:

- **Allowlist** — exactly `returnapp://desktop` in production. Outside
  production (`NODE_ENV !== 'production'`) the Vite dev origins
  (`http://localhost:5180`, `http://127.0.0.1:5180`) join. `ENGINE_CORS_ORIGINS`
  may add exact http(s) origins (comma-separated, normalized; junk and `*` are
  skipped). Anything else — including a missing or `null` Origin — gets no CORS
  headers at all, so non-browser clients behave exactly as before CORS existed.
- **Never `*`** — the allow-origin echoes only the matched allowlist entry,
  `Access-Control-Allow-Credentials` stays `false`, and `Vary: Origin` is set.
- **Preflight before auth** — `OPTIONS` to `/api/*` is answered with 204 at the
  top of the request handler, before the remote bearer-token gate, because a
  preflight carries no `Authorization` header. A disallowed origin still gets
  the 204 but no allow headers, so its browser blocks the real call.
- Allowed methods: `GET,POST,DELETE,OPTIONS`; allowed headers:
  `Content-Type, Authorization`.

## 6. IPC bridge contract

The bridge is `desktop/preload.cjs`, exposed to the renderer as
`window.desktopApp` with `contextIsolation` (no `nodeIntegration`, no raw
`ipcRenderer`, no env/secret access). Its TypeScript mirror is
`desktop/renderer/src/types/global.d.ts` — **the two files are one contract and
must be changed together** (AGENTS.md rule 19). Every member is optional so the
renderer also runs in a plain browser; all call sites guard with
`window.desktopApp?.…`.

| Channel | Direction | Payload | Main-process handler |
|---|---|---|---|
| `desktop:get-app-info` | renderer → invoke → reply | none → `{ version, platform, isPackaged }` | `ipcMain.handle` reading `app.getVersion()` |
| `desktop:get-engine-target` | invoke | none → `{ kind: 'local'\|'remote', url }` — the token is never returned | `ipcMain.handle` reading the shell's engine target |
| `desktop:get-bot-status` | invoke | none → `ShellStatus` | `ipcMain.handle` → `shellStatus()` (local engine or remote control API, 5s timeout) |
| `desktop:toggle-bot` | invoke | none → `ShellStatus` | `ipcMain.handle` → `toggleWorker()`; sends an explicit start/pause for remote engines |
| `desktop:bot-status-changed` | main → renderer push | `ShellStatus` every 5s | `startBotStatusPush()` broadcast; subscription returns an unsubscribe so a reload never leaves a duplicate listener |
| `desktop:notify` | renderer → main send | `{ title, body }` | `ipcMain.on` → OS `Notification` |
| `desktop:browser-rect` | renderer → main send | `{ x, y, width, height }` in DIPs relative to the window content area, or `null` to hide | `ipcMain.on` → `setBrowserWorkspaceRect()` after validating finite, non-negative numbers |
| `desktop:browser-fullscreen` | renderer → main send | `boolean` — true only from the Expand button, false from Exit/Esc | `ipcMain.on` → `setFullscreenSupplierView()` |

## 7. Bounded supplier-browser workspace

Supplier pages run in Electron `WebContentsView`s owned by the main process
(`desktop-agent/src/native-browser-view.ts`), never iframes; each panel keeps
its own persistent session. The renderer and shell cooperate to keep the native
view inside a measured placeholder and never over the sidebar or controls:

1. **Measure** — `useBrowserWorkspaceRect` observes the Browsers page's
   `#browser-workspace-viewport` div with `ResizeObserver` plus window
   resize/scroll (throttled ~100ms, unchanged rects are not re-sent) and sends
   the rect over `desktop:browser-rect` in device-independent pixels relative
   to the content area.
2. **Report only while valid** — the hook sends `null` whenever the Browsers
   route is inactive, the tab is detached, fullscreen is on, or the element
   unmounts. A null rect hides the native view but keeps its session.
3. **Validate twice** — the preload validates the payload (finite numbers,
   non-negative) before it crosses the bridge, and the main handler validates
   again.
4. **Fail-closed** — `MIN_SUPPLIER_VIEW_SIZE` is 120: a rect smaller than
   120×120 DIPs (or no rect at all) hides the view instead of defaulting to
   full-window.
5. **Fullscreen is explicit** — entered only by the Expand button (which sends
   `desktop:browser-fullscreen: true` and adds a body class), exited by the
   Exit Fullscreen button or Esc; leaving the page always clears it. Polling
   and worker steps never toggle it.
6. **Detach/dock** — Detach moves the live view into its own hardened
   `BrowserWindow` (`contextIsolation`, no Node, Chromium sandbox on) via
   `POST /api/portal-browser/detach`; cookies, DOM state and the worker lease
   ride with the view, OTP/CAPTCHA popups ride along, and closing the detached
   window docks the tab back before teardown (`POST /api/portal-browser/dock`).
   A tab that a worker owns cannot be closed or detached (the UI disables it
   with a title saying why).
7. **Tab switching preserves sessions** — tabs are server-side engine state
   (`GET /api/portal-browser` snapshot); switching tabs, hiding to the tray,
   minimizing and restoring never reload a portal, drop cookies or double-start
   worker runs. Window geometry changes (resize, move, maximize, DPI,
  display-metrics-changed) re-fit the view through
   `notifyWindowGeometryChanged`.

Known limitation: while a `WebContentsView` has keyboard focus, its Esc keypress
is consumed by the embedded page and is not forwarded to the renderer, so the
renderer-level Esc-to-exit-fullscreen shortcut does not fire — use the Exit
Fullscreen button (§15).

## 8. Pages in brief

- **Dashboard** — one derived headline (**All panels green** / **Action
  required** naming what to do), per-panel chips, worker status, recent
  activity and a live log terminal streamed over `GET /api/logs/stream`
  (EventSource).
- **Claims** — filterable claims table with real statuses, a detail view with
  copy buttons and an evidence viewer served by the local evidence endpoints
  (works while the backend is down).
- **Browsers** — tab strip, Back/Forward/Reload, open/close/detach/dock,
  bounded native viewport, claim control strip, expand/fullscreen.
- **Follow-ups** — the ticket follow-ups table (marketplace ticket ID, last
  check, next due, outcome), never guessing a status a panel cannot read.
- **AI Center** — the six-provider configuration, routing, approved memory,
  usage and events, served by the engine's AI Center routes.
- **Settings** — backend URL and diagnostics, credential-storage mode, worker
  controls, appearance.
- **Updates** — manual and automatic update checks with download links.

## 9. Offline and connecting behavior

The shell renders its own disconnected state; it does not depend on the engine
to paint a window:

- On startup the main process always creates the window — even when the engine
  failed to start (a placeholder `127.0.0.1:3005` target) — so the renderer's
  connecting page is visible while the shell's engine retry loop (every 30s, up
  to 20 attempts) keeps trying. A successful retry rebuilds the window against
  the same renderer URL (only the engine-side bearer wiring changes).
- The renderer probes `GET /api/operator/session`; a network failure renders
  the full-page Connecting state with the engine URL and retries every 5s, and
  a manual Retry now re-runs the probe. Only a real 401/403 response drops the
  app to the login gate.
- Engine outages after sign-in degrade page by page: tables show their error
  states, the worker pill disappears, and recovery is automatic when the engine
  answers again. The engine keeps filing throughout a window/renderer outage.

## 10. Theming

Light is the default; dark is opt-in per operator. `ThemeProvider` persists the
choice in `localStorage` under `ra-theme` and applies it as
`data-theme="dark"` on `<html>`; `initThemeBeforePaint()` in `main.tsx` applies
the stored theme before first paint so there is no flash. Design tokens live in
`src/styles/index.css` (`:root` for light, `[data-theme="dark"]` overrides) and
are consumed by Tailwind 4 utilities.

## 11. Build and packaging

- `npm run desktop:renderer:dev` — Vite dev server on port 5180 (`strictPort`);
  the unpackaged shell loads it automatically.
- `npm run desktop:renderer:build` — production build into
  `desktop/renderer/dist` (hashed local assets, bundled woff2 fonts, CSP meta).
- `npm run desktop:build` — esbuild bundle of `desktop/main.ts` to
  `desktop/dist/main.cjs` (external: electron, ws).
- `npm run desktop:dist` — **renderer build first**, then the main bundle, then
  electron-builder NSIS → `dist-electron/Return.App.Setup.<version>.exe`
  (version 1.3.0). The installer behavior is unchanged (per-machine NSIS,
  `ReturnAppClaimBot` Scheduled Task, session data preserved under
  `~/.taskflow-claim-agent` across upgrades).
- The electron-builder `files` list ships `desktop/dist/**/*`,
  `desktop/renderer/dist/**/*`, `desktop/preload.cjs` and `public/**/*`, and
  explicitly excludes `tsx`/`esbuild` from the asar. The preload is resolved as
  `desktop/dist/../preload.cjs`, which fixes the old packaged-build defect where
  the preload sat outside the shipped files.
- CI: `.github/workflows/desktop-release.yml` triggers on `desktop/**`
  (including `desktop/renderer/**`), typechecks, builds, runs `npm test`,
  builds the renderer, then the installer, and publishes a `desktop-v*` GitHub
  release keeping only the newest two.

## 12. Security notes

- **No token in the renderer.** The remote `ENGINE_TOKEN` and any non-loopback
  local bind token stay in the main process and are injected only for the
  engine origin. `getEngineTarget` returns `{ kind, url }`; the renderer cannot
  request the token.
- **Exact origins.** The window navigates only within the renderer origin; the
  engine origin is an API base, never a page. `window.open` is denied; an
  http(s) popup is treated as an update-installer download and saved to
  Downloads.
- **Key material is never rendered.** AI provider keys and supplier passwords
  stay server-encrypted or OS-store encrypted; the UI shows modes and statuses,
  not values.
- **Evidence endpoints are traversal-safe.** `GET /api/evidence/:claimId` and
  `GET /api/evidence/:claimId/:fileName` (`desktop-app-server.ts`) are
  operator-gated, validate the claim ID and file name
  (`desktop-agent/src/evidence-files.ts`), stream from the local evidence cache
  only, and never call the backend — they keep working while the backend is
  down.
- **Rect payload validated** in both preload and main; fail-closed under
  120×120 DIPs (§7).
- **CORS never `*`** and preflight is answered before the bearer gate (§5).
- The supplier browser keeps Chromium's renderer sandbox (`--no-sandbox` only
  via `browserSandboxArgs()`), and detached supplier windows run with no Node
  and the sandbox on.

## 13. Testing

The repo runner stays `node:test` through `tsx` (no vitest/jsdom). Renderer
component tests run against **happy-dom** registered by
`desktop/renderer/test-setup/register-dom.ts`, which the component test files
import themselves, so both `npm test` (which lists every renderer test) and a
direct `node --import tsx --import
./desktop/renderer/test-setup/register-dom.ts --test <file>` run work. The
setup also provides the React global the classic JSX fallback expects and an
inert `EventSource` (matching the engine-offline reality the tests model).

Coverage wired into `npm test`:

- `desktop-agent/cors.test.ts` — allowlist, dev origins, `*` rejection,
  preflight behavior.
- `desktop-agent/evidence-files.test.ts` — evidence validators and resolvers.
- `desktop/renderer/src/app.component.test.tsx` — the real App against a
  stubbed fetch (connecting state, login gate, shell).
- `desktop/renderer/src/pages/{Dashboard,Claims,FollowUps,Browsers,Settings,
  Updates}.test.{ts,tsx}` and `desktop/renderer/src/pages/ai-center/format.test.ts`.
- `desktop/renderer/src/services/engineApi.test.ts` — base resolution, error
  classes, 401/network detection.

`npm run typecheck` covers four projects, including
`desktop/renderer/tsconfig.json`.

## 14. Troubleshooting

- **"Desktop renderer not built" (503 page)** — `desktop/renderer/dist` is
  missing. Run `npm run desktop:renderer:build` (or `npm run desktop:dist`) and
  restart. Packaged installs never see this because the asar ships the dist.
- **Connecting page that never clears** — the engine is not answering at the
  shown URL. If the app just started, the shell may still be in its 30s retry
  loop (watch the log); otherwise start the engine / check the tray. The
  renderer retries on its own every 5s.
- **CORS errors in dev** — the dev origin must be `http://localhost:5180` (or
  `127.0.0.1:5180`) and `NODE_ENV` must not be `production`; a production
  engine allows only `returnapp://desktop`. Check `ENGINE_CORS_ORIGINS` for a
  deliberate extra origin — it only accepts real http(s) origins, never `*`.
- **Every engine call answers 401 in remote mode** — `ENGINE_TOKEN` mismatch;
  the shell injects the token, so fix the environment and relaunch. Do not
  try to add the token in renderer code — it is not reachable there by design.
- **Supplier browser not visible on the Browsers page** — the workspace rect is
  below the 120×120 DIPs fail-closed floor, the tab is detached/fullscreen, or
  the page is not the active route; all of these hide the view by design.
- **Renderer window died** — it reloads itself after ~2s; the engine and filing
  are unaffected.

## 15. Known gaps

- **Esc is not forwarded from a focused WebContentsView** — the embedded page
  consumes the key, so exit fullscreen with the Exit Fullscreen button.
- **Live portal verification is still pending** for the renderer-era flows:
  Meesho portal mapping/ticket parsing and `checkClaimStatus()` are
  fixture-tested (`desktop-agent/meesho-issues.test.ts`), and no live claim has
  been filed from this exact build yet. See [DESKTOP-APP.md](DESKTOP-APP.md)
  §11 for the operator-visible list.
- **Assisted panels (Flipkart, Amazon, Myntra VB/EJ, Ajio)** run the assisted
  prepare flow only; their full auto-filing and `checkClaimStatus()` readers
  remain future work, so parts of Claims/Browsers that depend on live portal
  behavior are verified against fixtures and engine state, not a live portal.
