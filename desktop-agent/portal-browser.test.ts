// Supplier-browser tab routes: the dashboard's Show/Hide supplier browser
// controls hit these engine endpoints. Tested against the real engine in a
// child process plus a stub backend: no database, no real browser, no
// production traffic. The engine child is killed afterwards so its worker
// timers can never keep the test runner alive.

import test from "node:test"
import assert from "node:assert/strict"
import child_process from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

const VALID = { email: "syn-operator@example.com", password: "SYN-Pass-1", token: "SYN-TOKEN-1" }

function startStubBackend(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => {
        body += chunk
      })
      req.on("end", () => {
        const url = new URL(req.url || "/", "http://stub")
        const json = (code: number, obj: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" })
          res.end(JSON.stringify(obj))
        }
        if (url.pathname === "/api/auth/login" && req.method === "POST") {
          const data = JSON.parse(body || "{}") as { email?: string; password?: string }
          if (String(data.email || "").toLowerCase() === VALID.email && data.password === VALID.password) {
            return json(200, { token: VALID.token, user: { name: "SYN Op", email: VALID.email, role: "Admin" } })
          }
          return json(401, { error: "Incorrect email or password." })
        }
        if (url.pathname === "/api/auth/me") {
          if (req.headers.authorization === `Bearer ${VALID.token}`) {
            return json(200, { user: { name: "SYN Op", email: VALID.email, role: "Admin" } })
          }
          return json(401, { error: "Unauthorized." })
        }
        if (url.pathname === "/api/auth/logout") return json(200, { ok: true })
        if (url.pathname === "/api/health") return json(200, { ok: true })
        if (url.pathname === "/api/automation/agent/register") {
          return json(200, { agentId: 7, apiKey: "SYN-AGENT-KEY", authorized: true })
        }
        return json(404, { error: "stub: not implemented" })
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      resolve({ port, close: () => new Promise((done) => server.close(() => done())) })
    })
  })
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = http.createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

let stub: { port: number; close: () => Promise<void> } | null = null
let engine: child_process.ChildProcess | null = null
let engineBase = ""

async function engineFetch(pathname: string, init?: RequestInit): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${engineBase}${pathname}`, init)
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

test.before(async () => {
  stub = await startStubBackend()
  const enginePort = await freePort()
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-engine-portal-browser-"))
  // Plain path on purpose: the tsx CLI mangles file:// URLs that contain spaces.
  const boot = path.join(process.cwd(), "desktop-agent", "test-helpers", "engine-boot.ts")
  const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs")
  engine = child_process.spawn(process.execPath, [tsx, boot], {
    env: {
      ...process.env,
      AGENT_DATA_DIR: agentDir,
      BACKEND_URL: `http://127.0.0.1:${stub.port}`,
      ENGINE_PORT: String(enginePort),
      POLL_INTERVAL_MS: "3600000",
      FOLLOWUP_INTERVAL_MS: "3600000",
    },
    stdio: "ignore",
  })
  engineBase = `http://127.0.0.1:${enginePort}`
  const deadline = Date.now() + 60000
  for (;;) {
    try {
      const res = await fetch(`${engineBase}/api/status`)
      if (res.ok) return
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error("The test engine did not start.")
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
})

test.after(async () => {
  if (engine) engine.kill("SIGKILL")
  if (stub) await stub.close()
})

test("the supplier browser routes require sign-in", async () => {
  const status = await engineFetch("/api/portal-browser")
  assert.equal(status.status, 401)
  const hide = await engineFetch("/api/portal-browser/hide", { method: "POST" })
  assert.equal(hide.status, 401)
  const show = await engineFetch("/api/portal-browser/show", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketplace: "Meesho" }),
  })
  assert.equal(show.status, 401)
})

test("the served dashboard wires the supplier browser tab controls", async () => {
  const res = await fetch(`${engineBase}/`)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes('id="supplier-browser-row"'), "expected the supplier browser tab row")
  assert.ok(html.includes("function showSupplierBrowser()"), "expected the show handler")
  assert.ok(html.includes("function hideSupplierBrowser()"), "expected the hide handler")
  assert.ok(html.includes("function loadSupplierBrowser()"), "expected the status poller")
  assert.ok(html.includes("/api/portal-browser/show"), "expected the show endpoint call")
  assert.ok(html.includes("/api/portal-browser/hide"), "expected the hide endpoint call")
})

test("the dashboard has a dedicated Browsers sidebar tab with a bounded workspace", async () => {
  const res = await fetch(`${engineBase}/`)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes('data-side="browsers"'), "expected the Browsers sidebar button")
  assert.ok(html.includes("'browsers':"), "expected the browsers SIDE_TABS entry")
  assert.ok(html.includes('id="browsers-panel"'), "expected the Browsers workspace panel")
  assert.ok(html.includes('id="browser-workspace"'), "expected the bounded browser workspace")
  assert.ok(html.includes('id="browser-workspace-viewport"'), "expected the bounded viewport")
  assert.ok(html.includes('id="browser-tab-strip"'), "expected the marketplace tab strip")
  assert.ok(html.includes('id="browser-nav-toolbar"'), "expected the navigation toolbar")
  assert.ok(html.includes('id="browser-back-btn"'), "expected the Back toolbar button")
  assert.ok(html.includes('id="browser-partition-badge"'), "expected the session partition badge")
  assert.ok(html.includes('id="browser-claim-control-bar"'), "expected the claim control bar")
  assert.ok(html.includes('id="browser-exit-bar"'), "expected the fullscreen exit bar")
  assert.ok(!html.includes("left: 10px"), "the workspace must not use fixed overlay CSS")
  // #browser-workspace lives inside the Browsers panel, which sits in the
  // main content column after the sidebar.
  const sidebarAt = html.indexOf('id="sidebar"')
  const panelAt = html.indexOf('id="browsers-panel"')
  const workspaceAt = html.indexOf('id="browser-workspace"')
  assert.ok(sidebarAt >= 0 && panelAt > sidebarAt, "expected the Browsers panel after the sidebar")
  assert.ok(workspaceAt > panelAt, "expected #browser-workspace inside the Browsers panel")
})

test("the 2-second poll never clears browser layout state before the fetch resolves", async () => {
  const res = await fetch(`${engineBase}/`)
  assert.equal(res.status, 200)
  const html = await res.text()
  const poller = html.slice(html.indexOf("async function loadSupplierBrowser()"))
  const pollerBody = poller.slice(0, poller.indexOf("async function showSupplierBrowser()"))
  const firstRemove = pollerBody.indexOf("classList.remove('supplier-browser-open')")
  const firstFetch = pollerBody.indexOf("fetch('/api/portal-browser')")
  assert.ok(firstFetch >= 0, "expected the poller to fetch /api/portal-browser")
  assert.ok(firstRemove < 0 || firstRemove > firstFetch, "the poller must not clear layout state before the fetch resolves")
  assert.ok(!pollerBody.includes("bridge(null)"), "the poller must not dispatch null rects on its own")
})

test("the viewport reports bounds through ResizeObserver and window/DPI events", async () => {
  const res = await fetch(`${engineBase}/`)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes("ResizeObserver"), "expected a ResizeObserver on the browser viewport")
  assert.ok(html.includes("matchMedia('(resolution:"), "expected DPI change handling")
  assert.ok(html.includes("browserWorkspaceFullscreen") || html.includes("exitBrowserFullscreen"), "expected explicit fullscreen controls")
})

test("a signed-in operator sees an empty browser registry without opening a window", async () => {
  const login = await engineFetch("/api/operator/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: VALID.email, password: VALID.password }),
  })
  assert.equal(login.status, 200)
  const status = await engineFetch("/api/portal-browser")
  assert.equal(status.status, 200)
  assert.deepEqual(status.data.views, [])
  const hide = await engineFetch("/api/portal-browser/hide", { method: "POST" })
  assert.equal(hide.status, 200)
  assert.deepEqual(hide.data.hidden, [])
  // Showing a panel opens its isolated tab: the engine no longer 404s on
  // headless/test instances without an attached Electron window. The tab is
  // open with its persistent session, just not visible on screen.
  const show = await engineFetch("/api/portal-browser/show", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketplace: "Meesho" }),
  })
  assert.equal(show.status, 200)
  assert.equal(show.data.panelKey, "meesho")
  assert.equal(show.data.visible, false)
})
