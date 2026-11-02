// Operator login-chain integration test: a stub backend plus the real engine
// in a child process, driven over HTTP. No database, no real browser, no
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
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-engine-login-"))
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

test("the served dashboard has no broken inline script", async () => {
  const res = await fetch(`${engineBase}/`)
  assert.equal(res.status, 200)
  const html = await res.text()
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.ok(scripts.length > 0, "expected at least one inline dashboard script")
  // Compiling catches a quoting slip that would otherwise kill every
  // dashboard handler (including sign-in) in the installed app. The code is
  // never executed here.
  for (const code of scripts) {
    if (!code.trim()) continue
    new Function(code)
  }
})

test("invalid credentials are refused with the backend message", async () => {
  const res = await engineFetch("/api/operator/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: VALID.email, password: "wrong" }),
  })
  assert.equal(res.status, 401)
  assert.match(String(res.data.error || ""), /incorrect/i)
})

test("a signed-out operator can ping the backend", async () => {
  const res = await engineFetch("/api/test-connection")
  assert.equal(res.status, 200)
  assert.equal(res.data.ok, true)
})

test("a signed-out operator can change the backend URL, which signs the PC out", async () => {
  const res = await engineFetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backendUrl: `http://127.0.0.1:${stub!.port}` }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.data.signedOut, true)
  const session = await engineFetch("/api/operator/session")
  assert.equal(session.data.signedIn, false)
})

test("an untrusted backend URL is refused with a message", async () => {
  const res = await engineFetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backendUrl: "http://evil.example:9/" }),
  })
  assert.equal(res.status, 400)
  assert.match(String(res.data.error || ""), /configured/i)
})

test("a valid login signs in, and a backend change signs back out", async () => {
  const login = await engineFetch("/api/operator/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: VALID.email, password: VALID.password }),
  })
  assert.equal(login.status, 200)
  assert.equal((login.data.user as { role?: string } | undefined)?.role, "Admin")
  const before = await engineFetch("/api/operator/session")
  assert.equal(before.data.signedIn, true)
  const change = await engineFetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backendUrl: `http://127.0.0.1:${stub!.port}` }),
  })
  assert.equal(change.status, 200)
  assert.equal(change.data.signedOut, true)
  const after = await engineFetch("/api/operator/session")
  assert.equal(after.data.signedIn, false)
})
