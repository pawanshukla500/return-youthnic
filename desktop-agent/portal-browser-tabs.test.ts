// Multi-tab session manager + navigation toolbar + close guard + legacy
// backward compatibility (VAL-TABS-001..005). TDD-first: these tests run
// against the real engine in a child process plus a stub backend, with no
// database, no real browser window, and no production traffic.

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
let agentDir = ""

async function engineFetch(pathname: string, init?: RequestInit): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${engineBase}${pathname}`, init)
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

async function postJson(pathname: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  return engineFetch(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

test.before(async () => {
  stub = await startStubBackend()
  const enginePort = await freePort()
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-engine-portal-tabs-"))
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
      if (res.ok) break
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error("The test engine did not start.")
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const login = await postJson("/api/operator/login", { email: VALID.email, password: VALID.password })
  assert.equal(login.status, 200)
})

test.after(async () => {
  if (engine) engine.kill("SIGKILL")
  if (stub) await stub.close()
  if (agentDir) fs.rmSync(agentDir, { recursive: true, force: true })
})

const REQUIRED_TAB_FIELDS = [
  "tabId",
  "panelKey",
  "label",
  "accountName",
  "partition",
  "url",
  "title",
  "loading",
  "canGoBack",
  "canGoForward",
  "mode",
  "workerOwned",
  "activeClaim",
] as const

function getTabs(data: Record<string, unknown>): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(data.tabs), "expected a tabs[] array")
  return data.tabs as Array<Record<string, unknown>>
}

test("VAL-TABS-001: per-tab registry uses isolated persistent partitions", async () => {
  const meesho = await postJson("/api/portal-browser/open", { marketplace: "Meesho" })
  assert.equal(meesho.status, 200)
  const flipkart = await postJson("/api/portal-browser/open", { marketplace: "Flipkart" })
  assert.equal(flipkart.status, 200)

  const status = await engineFetch("/api/portal-browser")
  assert.equal(status.status, 200)
  const tabs = getTabs(status.data)
  assert.ok(tabs.length >= 2, "expected at least the two opened tabs")
  for (const tab of tabs) {
    for (const field of REQUIRED_TAB_FIELDS) {
      assert.ok(field in tab, `tab is missing field ${field}`)
    }
    assert.match(String(tab.partition), /^persist:supplier-[a-z0-9_]+$/)
    assert.match(String(tab.tabId), /^tab-[a-z0-9_]+$/)
    assert.ok(["active", "background", "detached", "closed"].includes(String(tab.mode)))
  }
  const partitions = new Set(tabs.filter((t) => t.mode !== "closed").map((t) => String(t.partition)))
  assert.ok(partitions.has("persist:supplier-meesho"), "expected the Meesho partition")
  assert.ok(partitions.has("persist:supplier-flipkart"), "expected the Flipkart partition")
  assert.equal(partitions.size, tabs.filter((t) => t.mode !== "closed").length, "partitions must not collide")
})

test("VAL-TABS-002: switching and reopening tabs preserves live session state", async () => {
  await postJson("/api/portal-browser/open", { marketplace: "Meesho" })
  await postJson("/api/portal-browser/open", { marketplace: "Amazon" })
  const switched = await postJson("/api/portal-browser/switch", { tabId: "tab-meesho" })
  assert.equal(switched.status, 200)
  assert.equal(switched.data.activeTabId, "tab-meesho")

  const before = await engineFetch("/api/portal-browser")
  assert.equal(before.status, 200)
  const tabsBefore = getTabs(before.data)
  const meeshoBefore = tabsBefore.find((t) => t.tabId === "tab-meesho")
  assert.ok(meeshoBefore, "expected the Meesho tab")
  assert.equal(meeshoBefore.mode, "active")
  assert.ok(
    tabsBefore.filter((t) => t.mode === "active").length === 1,
    "exactly one tab is active after a switch",
  )

  // Closing an idle manual tab keeps the partition and records it for reopen.
  const closed = await postJson("/api/portal-browser/close-tab", { tabId: "tab-amazon" })
  assert.equal(closed.status, 200)
  const afterClose = await engineFetch("/api/portal-browser")
  const amazonClosed = getTabs(afterClose.data).find((t) => t.tabId === "tab-amazon")
  assert.ok(amazonClosed, "expected the closed tab to stay in the registry")
  assert.equal(amazonClosed.mode, "closed")
  assert.equal(amazonClosed.partition, "persist:supplier-amazon")

  const reopened = await postJson("/api/portal-browser/reopen", {})
  assert.equal(reopened.status, 200)
  assert.equal(reopened.data.tabId, "tab-amazon")
  const afterReopen = await engineFetch("/api/portal-browser")
  const amazon = getTabs(afterReopen.data).find((t) => t.tabId === "tab-amazon")
  assert.ok(amazon && amazon.mode !== "closed", "expected the reopened tab to leave closed mode")
})

test("VAL-TABS-003: navigation toolbar executes on the active tab with titled buttons", async () => {
  await postJson("/api/portal-browser/open", { marketplace: "Meesho" })
  for (const action of ["back", "forward", "reload", "stop"]) {
    const nav = await postJson("/api/portal-browser/nav", { action })
    assert.equal(nav.status, 200, `expected nav ${action} to answer 200`)
  }
  const bad = await postJson("/api/portal-browser/nav", { action: "sideways" })
  assert.equal(bad.status, 400)

  const res = await fetch(`${engineBase}/`)
  assert.equal(res.status, 200)
  const html = await res.text()
  for (const id of ["browser-back-btn", "browser-forward-btn", "browser-reload-btn", "browser-stop-btn"]) {
    assert.ok(html.includes(`id="${id}"`), `expected toolbar button ${id}`)
  }
  // Every toolbar button carries a title, including while disabled (Rule 10).
  const toolbar = html.slice(html.indexOf('id="browser-nav-toolbar"'))
  const toolbarBody = toolbar.slice(0, toolbar.indexOf('id="browser-workspace-viewport"'))
  const buttons = toolbarBody.match(/<button[^>]*>/g) || []
  assert.ok(buttons.length >= 6, "expected the toolbar buttons")
  for (const button of buttons) {
    assert.ok(button.includes("title="), `toolbar button is missing a title: ${button}`)
  }
  assert.ok(html.includes('id="browser-url-pill"'), "expected the safe URL/title/account pill")
  assert.ok(html.includes("persist:supplier-"), "expected the partition badge")
  assert.ok(html.includes('id="browser-expand-btn"'), "expected the Expand button")
  assert.ok(html.includes('id="browser-detach-btn"'), "expected the Detach/Dock button")
})

test("VAL-TABS-004: closing a worker-owned tab needs a paused worker (409)", async () => {
  await postJson("/api/portal-browser/open", { marketplace: "Meesho" })
  const claimed = await postJson("/api/portal-browser/test-claim", {
    tabId: "tab-meesho",
    claim: { claimId: "SYN-CLAIM-001", orderId: "SYN-ORD-101", awb: "SYN-AWB-101" },
  })
  assert.equal(claimed.status, 200)

  const blocked = await postJson("/api/portal-browser/close-tab", { tabId: "tab-meesho" })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.data.code, "WORKER_ACTIVE_PAUSE_REQUIRED")

  const stillThere = await engineFetch("/api/portal-browser")
  const tab = getTabs(stillThere.data).find((t) => t.tabId === "tab-meesho")
  assert.ok(tab && tab.mode !== "closed", "a guarded close must keep the tab open")

  const forced = await postJson("/api/portal-browser/close-tab", { tabId: "tab-meesho", force: true })
  assert.equal(forced.status, 409, "force must not bypass an unpaused worker")

  const paused = await postJson("/api/portal-browser/test-claim", { tabId: "tab-meesho", paused: true })
  assert.equal(paused.status, 200)
  const closed = await postJson("/api/portal-browser/close-tab", { tabId: "tab-meesho" })
  assert.equal(closed.status, 200)

  // The warning also surfaces in the UI close path.
  const html = await (await fetch(`${engineBase}/`)).text()
  assert.ok(html.includes("WORKER_ACTIVE_PAUSE_REQUIRED"), "expected the UI to explain the pause-first warning")
})

test("VAL-TABS-005: legacy GET and close routes stay backward compatible", async () => {
  await postJson("/api/portal-browser/open", { marketplace: "Meesho" })
  const status = await engineFetch("/api/portal-browser")
  assert.equal(status.status, 200)
  for (const field of ["open", "panelKey", "label", "url", "title", "held", "reason"]) {
    assert.ok(field in status.data, `legacy GET is missing top-level field ${field}`)
  }
  assert.ok(Array.isArray(status.data.tabs), "expected tabs[] alongside legacy fields")
  assert.ok(typeof status.data.activeTabId === "string", "expected activeTabId alongside legacy fields")

  const legacy = await postJson("/api/portal-browser/close", {})
  assert.equal(legacy.status, 200)
  assert.ok("ok" in legacy.data, "expected the legacy close acknowledgement")
})

test("VAL-WIN-005: detach, focus, and dock routes preserve the tab session", async () => {
  const opened = await postJson("/api/portal-browser/open", { marketplace: "Meesho" })
  assert.equal(opened.status, 200)

  const detached = await postJson("/api/portal-browser/detach", { tabId: "tab-meesho" })
  assert.equal(detached.status, 200)
  const afterDetach = await engineFetch("/api/portal-browser")
  const det = getTabs(afterDetach.data).find((t) => t.tabId === "tab-meesho")
  assert.ok(det && det.mode === "detached", "expected the tab to report detached mode")
  assert.equal(det.partition, "persist:supplier-meesho", "detach must keep the session partition")

  const focused = await postJson("/api/portal-browser/focus", { tabId: "tab-meesho" })
  assert.equal(focused.status, 200)

  const docked = await postJson("/api/portal-browser/dock", { tabId: "tab-meesho" })
  assert.equal(docked.status, 200)
  const afterDock = await engineFetch("/api/portal-browser")
  const dock = getTabs(afterDock.data).find((t) => t.tabId === "tab-meesho")
  assert.ok(dock && dock.mode !== "detached", "expected the tab to leave detached mode after dock")
  assert.equal(dock.partition, "persist:supplier-meesho", "dock must keep the session partition")

  const hidden = await postJson("/api/window-control", { action: "hide-to-tray" })
  assert.equal(hidden.status, 200)
  const restored = await postJson("/api/window-control", { action: "restore-from-tray" })
  assert.equal(restored.status, 200)
  const afterLifecycle = await engineFetch("/api/portal-browser")
  assert.ok(
    getTabs(afterLifecycle.data).find((t) => t.tabId === "tab-meesho"),
    "window lifecycle must preserve the tab registry",
  )
})
