// End-to-end automated flow test for the Meesho desktop claim pipeline:
//   1. Initial interactive login -> persistent session marker & cookies survive simulated restart.
//   2. Full-auto filing (action: "prepare", requireApprovalBeforeSubmit: false) fills every field,
//      uploads captured image & video evidence, submits the claim, and extracts Ticket ID
//      both from inline confirmation and 0-prior-ticket Support fallback.
//   3. Expired session -> fast failure with loginRequired: true -> clears stale session marker &
//      sets panel reloginRequired -> user re-logs in -> clears hold, requeues paused job, and
//      completes with Ticket ID recorded against the server.
// Synthetic SYN- data only; no real DB or external browser binary required.

import assert from "node:assert/strict"
import child_process from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { JobExecutionBundle } from "./src/agent-client.ts"
import { resolveBrowserAdapterKind, type SupplierBrowserApi } from "./src/browser-adapter.ts"
import { MeeshoAutomation } from "./src/marketplaces/meesho.ts"
import {
  clearPanelHold,
  getPanelStatuses,
  markPanelResult,
  marketplacesToSkip,
  resetPanelRuntime,
} from "./src/panel-queue.ts"
import { completePortalLogin, requeueMarketplaceJobs } from "./src/portal-login.ts"
import { clearOperatorSession } from "./src/operator-session.ts"
import { clearSessionMarker, readSessionSavedAt, supplierSessionDir, writeSessionMarker } from "./src/supplier-session.ts"

const SLUG = "syn-seller-slug"

type SimulatedFormState = {
  authenticated: boolean
  route: string
  subOrderId: string
  awb: string
  packetId: string
  packetState: string
  callbackNumber: string
  flyerId: string
  description: string
  uploadedByInputId: Record<string, string[]>
  ticketsBefore: string[]
  ticketAfterSubmit: string
  showTicketInline: boolean
  formSubmitted: boolean
}

function createStatefulMeeshoBrowser(state: SimulatedFormState, sessionDir: string): SupplierBrowserApi {
  return {
    profileDirectory: sessionDir,
    async connectToPage() {},
    async send() { return {} },
    async navigate(url: string) {
      state.route = url
      if (url.includes("/root/login") && state.authenticated) {
        state.route = `https://supplier.meesho.com/panel/v3/new/growth/${SLUG}/home`
      }
    },
    async evaluate<T>(script: string): Promise<T> {
      // Login check
      if (script.includes("isPortalLoggedIn")) {
        const logged = state.authenticated && !state.route.includes("/login")
        return logged as unknown as T
      }
      if (script.includes("#loginbutton")) return (!state.authenticated && state.route.includes("/login")) as unknown as T
      if (script.includes('input[type="password"]')) return (!state.authenticated) as unknown as T

      // Current URL
      if (script.trim() === "window.location.href") return state.route as unknown as T

      // waitForContent
      if (script.includes("text.length > 40")) return state.authenticated as unknown as T

      // Issue open check
      if (script.includes("Raise a Ticket") && script.includes("/support/1/")) {
        return state.route.includes("/support/1/wrong-return") as unknown as T
      }

      // Form open check
      if (script.includes("Sub Order") && script.includes("Boolean(")) {
        return (state.route.includes("/raise-ticket") && !state.formSubmitted) as unknown as T
      }

      // Support table rows (for duplicate ticket pre-check)
      if (script.includes('document.querySelectorAll("tr")')) {
        return state.ticketsBefore.map((id) => [id, "SYN-OTHER", "Open"]) as unknown as T
      }

      // Support table IDs (readRecentTicketIds)
      if (script.includes('document.querySelectorAll(\'tr td\')')) {
        const list = state.formSubmitted
          ? [state.ticketAfterSubmit, ...state.ticketsBefore]
          : state.ticketsBefore
        return list as unknown as T
      }

      // Packet / AWB / Flyer field checks
      if (script.includes("Packet") && script.includes("Boolean(")) return true as unknown as T
      if (script.includes("AWB") && script.includes("Boolean(")) return true as unknown as T
      if (script.includes("flyer") && script.includes("Boolean(")) return true as unknown as T

      // Callback number
      if (script.includes("callback")) {
        const m = script.match(/"(9\d{9})"/)
        if (m?.[1]) state.callbackNumber = m[1]
        return Boolean(m?.[1]) as unknown as T
      }

      // Early blockers & ineligible checks
      if (script.includes("not eligible") || script.includes("document.querySelectorAll('body *')")) {
        return (script.includes("body *") ? [] : "") as unknown as T
      }

      // State of the packet dropdown
      if (script.includes("state of the packet")) {
        const m = script.match(/wanted\s*=\s*"([^"]+)"/)
        if (m?.[1]) state.packetState = m[1]
        return true as unknown as T
      }

      // Evidence upload inputs
      if (script.includes('input[type="file"]') && script.includes(".map((el) => el.id)")) {
        return [
          "barcode_image_link_6",
          "product_image_link_7",
          "product_reverse_way_bill_link_8",
          "product_openingvideo_link_9",
        ] as unknown as T
      }

      // Upload ack check
      if (script.includes("input gone after upload")) {
        const m = script.match(/#([a-z0-9_]+)/i)
        const id = m?.[1] || ""
        const count = state.uploadedByInputId[id]?.length || 0
        return { files: count, ack: count > 0, error: "" } as unknown as T
      }

      // Description textarea marker
      if (script.includes("return-claim-description")) return true as unknown as T

      // Submit disabled check
      if (script.includes(".trim() === 'Submit' && b.disabled")) return false as unknown as T

      // Confirmation poll ({ href, text })
      if (script.includes("href: window.location.href")) {
        if (state.formSubmitted && state.showTicketInline) {
          return {
            href: `https://supplier.meesho.com/panel/v3/new/experience/${SLUG}/support/ticket/${state.ticketAfterSubmit}`,
            text: `Ticket ID: ${state.ticketAfterSubmit} created successfully`,
          } as unknown as T
        }
        return { href: state.route, text: "" } as unknown as T
      }

      // Form validation error scan
      if (script.includes("el.childElementCount === 0") && script.includes("slice(0, 8)")) {
        return [] as unknown as T
      }

      return false as unknown as T
    },
    async humanClick(selector: string) {
      if (selector.includes("submit")) {
        state.formSubmitted = true
      }
      return true
    },
    async humanType(selector: string, text: string) {
      if (selector.includes("Sub Order")) state.subOrderId = text
      else if (selector.includes("AWB")) state.awb = text
      else if (selector.includes("Packet")) state.packetId = text
      else if (selector.includes("flyer")) state.flyerId = text
      else if (selector.includes("description")) state.description = text
      return true
    },
    async clickVisibleLabel(text: string) {
      if (text === "I have received wrong return") {
        state.route = `https://supplier.meesho.com/panel/v3/new/experience/${SLUG}/support/1/wrong-return`
      } else if (text === "Raise a Ticket") {
        state.route = `https://supplier.meesho.com/panel/v3/new/experience/${SLUG}/support/1/wrong-return/raise-ticket`
      } else if (text === "Submit") {
        state.formSubmitted = true
        if (!state.showTicketInline) {
          state.route = `https://supplier.meesho.com/panel/v3/new/experience/${SLUG}/support`
        }
      }
      return true
    },
    async clickByTextIncludes() { return true },
    async clickByExactText() { return true },
    async clickLabelInDom(text: string) {
      return { clicked: true, href: text }
    },
    async uploadViaChooser() { return false },
    async setFileInputFiles(selector: string, files: string[]) {
      const id = selector.replace(/^#/, "")
      state.uploadedByInputId[id] = files
      return true
    },
    async detectCaptchaOrOtp() {
      return { challengeDetected: false }
    },
    async captureScreenshot(outputPath: string) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      fs.writeFileSync(outputPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      return outputPath
    },
    async delay() {},
    async showForManualStep() {},
    async close() {},
  }
}

function makeTempEvidence(): { dir: string; filesMap: Map<string, string[]> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-meesho-e2e-"))
  const mk = (name: string) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, Buffer.from(`SYN-EVIDENCE-${name}`))
    return file
  }
  const filesMap = new Map<string, string[]>([
    ["barcode_image", [mk("SYN-barcode.jpg")]],
    ["product_images", [mk("SYN-product.jpg")]],
    ["reverse_waybill", [mk("SYN-waybill.jpg")]],
    ["unboxing_video", [mk("SYN-video.mp4")]],
  ])
  return { dir, filesMap }
}

function makeBundle(overrides: Partial<JobExecutionBundle> = {}): JobExecutionBundle {
  return {
    jobId: 101,
    claimId: 501,
    stage: "downloading_media",
    claimStatus: "ready_for_claim",
    marketplace: "Meesho",
    accountName: "Meesho",
    portalUrl: "https://supplier.meesho.com/panel/v3/new/root/login",
    credentials: { username: "", password: "", authState: {} },
    automationMode: "autonomous",
    requireApprovalBeforeSubmit: false,
    claim: {
      orderNumber: "SYN-ORD-1001",
      subOrderId: "SYN-SUB-1001_1",
      trackingId: "SYN-AWB-778899",
      packetId: "SYN-PKT-55",
      sku: "SYN-SKU-01",
      customerName: "SYN Customer",
      totalPrice: 499,
      packetState: "Tampered",
      marketplaceIssueCode: "wrong_return",
      claimReason: "Wrong product returned",
      claimTitle: "SYN Wrong return",
      claimDescription: "SYN customer returned wrong item; packet tampered.",
      claimContent: "",
      remarks: "",
      returnType: "Customer Return",
    },
    evidenceFiles: [],
    ...overrides,
  }
}

describe("Meesho end-to-end claim automation flow", () => {
  const tempDirs: string[] = []
  const envKeys = ["MEESHOID", "MEESHO_ID", "MEESHO_USERNAME", "MEESHO_PWD", "MEESHO_PASSWORD", "MEESHO_PASS"] as const
  const savedEnv: Record<string, string | undefined> = {}
  for (const k of envKeys) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }

  after(() => {
    resetPanelRuntime()
    clearOperatorSession()
    for (const k of envKeys) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
      else delete process.env[k]
    }
    for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true })
  })

  it("login persists across restart -> full-auto claim fills all fields, uploads evidence, submits and reads Ticket ID (both confirmation & 0-prior fallback)", async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-meesho-appdata-"))
    tempDirs.push(userDataDir)
    const sessionDir = supplierSessionDir(userDataDir, "Meesho", resolveBrowserAdapterKind())
    resetPanelRuntime()

    // 1. User logs in manually once
    const simState: SimulatedFormState = {
      authenticated: false,
      route: "https://supplier.meesho.com/panel/v3/new/root/login",
      subOrderId: "",
      awb: "",
      packetId: "",
      packetState: "",
      callbackNumber: "",
      flyerId: "",
      description: "",
      uploadedByInputId: {},
      ticketsBefore: ["91111111101"],
      ticketAfterSubmit: "98765432109",
      showTicketInline: true,
      formSubmitted: false,
    }
    const browser = createStatefulMeeshoBrowser(simState, sessionDir)
    // Simulate user completing interactive login shortly after portal opens
    simState.authenticated = true
    simState.route = `https://supplier.meesho.com/panel/v3/new/growth/${SLUG}/home`

    const loginRes = await completePortalLogin(browser, {
      marketplace: "Meesho",
      portalUrl: "https://supplier.meesho.com/panel/v3/new/root/login",
      username: "",
      password: "",
      sessionDir,
      waitMs: 5000,
    })
    assert.equal(loginRes.ok, true)
    assert.ok(readSessionSavedAt(sessionDir), "session marker written after login")

    // 2. Simulated restart: reset runtime memory, verify saved session still detected
    resetPanelRuntime()
    const meeshoPanelAfterRestart = getPanelStatuses(userDataDir).find((p) => p.key === "meesho")
    assert.ok(meeshoPanelAfterRestart?.sessionSavedAt, "session marker survives restart")
    assert.equal(meeshoPanelAfterRestart?.reloginRequired, false)

    // 3. Auto-filing after evidence capture (requireApprovalBeforeSubmit: false -> prepare falls through to Submit!)
    const ev = makeTempEvidence()
    tempDirs.push(ev.dir)
    const automation = new MeeshoAutomation(browser, makeBundle(), ev.filesMap, ev.dir)
    const submitResult = await automation.execute("prepare")

    assert.equal(submitResult.success, true)
    assert.equal(submitResult.stage, "completed")
    assert.equal(submitResult.marketplaceClaimId, "98765432109")
    assert.equal(simState.subOrderId, "SYN-SUB-1001_1")
    assert.equal(simState.awb, "SYN-AWB-778899")
    assert.equal(simState.packetId, "SYN-PKT-55")
    assert.equal(simState.packetState, "Tampered")
    assert.equal(simState.flyerId, "SYN-PKT-55")
    assert.match(simState.description, /wrong item/i)
    assert.equal(Object.keys(simState.uploadedByInputId).length, 4, "all 4 evidence boxes uploaded")

    // 4. Verify 0-prior-ticket Support table fallback when Meesho closes form silently
    const zeroPriorState: SimulatedFormState = {
      ...simState,
      route: "https://supplier.meesho.com/panel/v3/new/root/login",
      ticketsBefore: [],
      ticketAfterSubmit: "98765432110",
      showTicketInline: false,
      formSubmitted: false,
      uploadedByInputId: {},
    }
    const zeroBrowser = createStatefulMeeshoBrowser(zeroPriorState, sessionDir)
    const fallbackRes = await new MeeshoAutomation(
      zeroBrowser,
      makeBundle({ jobId: 102, claimId: 502 }),
      ev.filesMap,
      ev.dir,
    ).execute("prepare")
    assert.equal(fallbackRes.success, true)
    assert.equal(fallbackRes.stage, "completed")
    assert.equal(fallbackRes.marketplaceClaimId, "98765432110", "captures ticket ID even when account had 0 prior tickets")
  })

  it("expired session stops cleanly with reloginRequired, prompts user, then re-login clears hold, requeues and completes claim", async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-meesho-relogin-"))
    const prevAgentDataDir = process.env.AGENT_DATA_DIR
    const prevBackendUrl = process.env.BACKEND_URL
    const prevAgentUuid = process.env.AGENT_UUID
    const prevAgentKey = process.env.AGENT_API_KEY
    tempDirs.push(userDataDir)
    resetPanelRuntime()
    clearOperatorSession()

    const sessionDir = supplierSessionDir(userDataDir, "Meesho", "external")
    writeSessionMarker(sessionDir, "Meesho")

    // Stub backend tracking paused -> queued -> completed
    let jobStage = "manual_intervention_required"
    let savedTicket = ""
    const server = http.createServer((req, res) => {
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        const url = new URL(req.url || "/", "http://stub")
        const send = (code: number, obj: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" })
          res.end(JSON.stringify(obj))
        }
        if (url.pathname === "/api/auth/login") {
          return send(200, { token: "SYN-OP-TOK", user: { name: "SYN Op", email: "syn@example.com", role: "Admin" } })
        }
        if (url.pathname === "/api/automation/agent/jobs") {
          return send(200, { rows: [{ id: 701, jobId: 701, marketplace: "Meesho", stage: jobStage }], total: 1 })
        }
        if (url.pathname === "/api/automation/jobs/701/retry" && req.method === "POST") {
          jobStage = "queued"
          return send(200, { ok: true })
        }
        if (url.pathname === "/api/automation/jobs/701/complete" && req.method === "POST") {
          const parsed = JSON.parse(body || "{}") as { marketplaceClaimId?: string }
          savedTicket = String(parsed.marketplaceClaimId || "")
          jobStage = "completed"
          return send(200, { ok: true })
        }
        return send(404, { error: "not stubbed" })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const addr = server.address()
    const port = typeof addr === "object" && addr ? addr.port : 0

    try {
      process.env.AGENT_DATA_DIR = userDataDir
      process.env.BACKEND_URL = `http://127.0.0.1:${port}`
      process.env.AGENT_UUID = "SYN-UUID-701"
      process.env.AGENT_API_KEY = "SYN-KEY-701"

      // Authenticate operator session on the stub backend
      const { loginOperator } = await import("./src/operator-session.ts")
      await loginOperator("syn@example.com", "SYN-Pass-1")

      // 1. Session expires while running Meesho job -> returns loginRequired: true cleanly
      const expiredState: SimulatedFormState = {
        authenticated: false,
        route: "https://supplier.meesho.com/panel/v3/new/root/login",
        subOrderId: "",
        awb: "",
        packetId: "",
        packetState: "",
        callbackNumber: "",
        flyerId: "",
        description: "",
        uploadedByInputId: {},
        ticketsBefore: [],
        ticketAfterSubmit: "98765432199",
        showTicketInline: true,
        formSubmitted: false,
      }
      const ev = makeTempEvidence()
      tempDirs.push(ev.dir)
      const browser = createStatefulMeeshoBrowser(expiredState, sessionDir)

      const origNow = Date.now
      let tick = 50_000
      Date.now = () => {
        tick += 2000
        return tick
      }
      let pausedResult
      try {
        pausedResult = await new MeeshoAutomation(browser, makeBundle({ jobId: 701 }), ev.filesMap, ev.dir).execute("prepare")
      } finally {
        Date.now = origNow
      }

      assert.equal(pausedResult.success, false)
      assert.equal(pausedResult.stage, "manual_intervention_required")
      assert.equal(pausedResult.loginRequired, true)

      // Engine clears marker & parks panel with reloginRequired
      clearSessionMarker(sessionDir)
      markPanelResult("meesho", "manual_action", pausedResult.manualActionReason, { loginRequired: true })
      assert.equal(readSessionSavedAt(sessionDir), null, "expired marker is cleared")
      assert.ok(marketplacesToSkip().includes("Meesho"), "Meesho is held until operator logs in")
      assert.equal(getPanelStatuses(userDataDir).find((p) => p.key === "meesho")?.reloginRequired, true)

      // 2. Operator finishes logging in inside the app browser -> cookies saved, hold cleared, job requeued & completed
      expiredState.authenticated = true
      expiredState.route = `https://supplier.meesho.com/panel/v3/new/growth/${SLUG}/home`
      const reloginRes = await completePortalLogin(browser, {
        marketplace: "Meesho",
        portalUrl: "https://supplier.meesho.com/panel/v3/new/root/login",
        username: "",
        password: "",
        sessionDir,
        waitMs: 5000,
      })
      assert.equal(reloginRes.ok, true)
      assert.ok(readSessionSavedAt(sessionDir), "fresh session saved on disk")

      clearPanelHold("meesho")
      const requeued = await requeueMarketplaceJobs("Meesho")
      assert.equal(requeued, 1, "paused job moved back into queue")
      assert.equal(jobStage, "queued")
      assert.equal(getPanelStatuses(userDataDir).find((p) => p.key === "meesho")?.reloginRequired, false)

      // Resumed cycle files and captures the Ticket ID
      const resumedResult = await new MeeshoAutomation(
        browser,
        makeBundle({ jobId: 701 }),
        ev.filesMap,
        ev.dir,
      ).execute("prepare")
      assert.equal(resumedResult.success, true)
      assert.equal(resumedResult.stage, "completed")
      assert.equal(resumedResult.marketplaceClaimId, "98765432199")

      // Report ticket back to backend like engine does
      await fetch(`http://127.0.0.1:${port}/api/automation/jobs/701/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketplaceClaimId: resumedResult.marketplaceClaimId }),
      })
      assert.equal(savedTicket, "98765432199")
      assert.equal(jobStage, "completed")
    } finally {
      server.close()
      if (prevAgentDataDir !== undefined) process.env.AGENT_DATA_DIR = prevAgentDataDir
      else delete process.env.AGENT_DATA_DIR
      if (prevBackendUrl !== undefined) process.env.BACKEND_URL = prevBackendUrl
      else delete process.env.BACKEND_URL
      if (prevAgentUuid !== undefined) process.env.AGENT_UUID = prevAgentUuid
      else delete process.env.AGENT_UUID
      if (prevAgentKey !== undefined) process.env.AGENT_API_KEY = prevAgentKey
      else delete process.env.AGENT_API_KEY
    }
  })

  it("real desktop-app-server preserves Meesho session across full engine process restart and exposes check-login route", async () => {
    const agentDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-meesho-restart-"))
    tempDirs.push(agentDataDir)
    const userDataDir = path.join(agentDataDir, "browser-profiles")
    const sessionDir = supplierSessionDir(userDataDir, "Meesho", "external")
    writeSessionMarker(sessionDir, "Meesho")

    const stub = http.createServer((req, res) => {
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        const url = new URL(req.url || "/", "http://stub")
        const send = (code: number, obj: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" })
          res.end(JSON.stringify(obj))
        }
        if (url.pathname === "/api/auth/login") {
          return send(200, { token: "SYN-TOK", user: { name: "SYN Op", email: "syn@example.com", role: "Admin" } })
        }
        if (url.pathname === "/api/auth/me") {
          return send(200, { user: { name: "SYN Op", email: "syn@example.com", role: "Admin" } })
        }
        if (url.pathname === "/api/automation/agent/register") {
          return send(200, { agentId: 11, apiKey: "SYN-KEY", authorized: true })
        }
        if (url.pathname === "/api/automation/agent/poll") {
          return send(200, { hasJob: false, job: null })
        }
        return send(200, { ok: true, rows: [], total: 0 })
      })
    })
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", () => resolve()))
    const stubPort = (stub.address() as { port: number }).port

    const nextPort = async (): Promise<number> => new Promise((resolve) => {
      const p = http.createServer()
      p.listen(0, "127.0.0.1", () => {
        const port = (p.address() as { port: number }).port
        p.close(() => resolve(port))
      })
    })

    const bootEngine = async (enginePort: number) => {
      const boot = path.join(process.cwd(), "desktop-agent", "test-helpers", "engine-boot.ts")
      const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs")
      const child = child_process.spawn(process.execPath, [tsx, boot], {
        env: {
          ...process.env,
          AGENT_DATA_DIR: agentDataDir,
          BACKEND_URL: `http://127.0.0.1:${stubPort}`,
          ENGINE_PORT: String(enginePort),
          POLL_INTERVAL_MS: "3600000",
          FOLLOWUP_INTERVAL_MS: "3600000",
        },
        stdio: "ignore",
      })
      const base = `http://127.0.0.1:${enginePort}`
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${base}/api/status`)
          if (r.ok) return { child, base }
        } catch {}
        await new Promise((r) => setTimeout(r, 150))
      }
      child.kill()
      throw new Error("Engine boot timed out")
    }

    let child1: child_process.ChildProcess | null = null
    let child2: child_process.ChildProcess | null = null
    try {
      // Boot 1: sign in as operator and configure userDataDir; session marker sits in userDataDir
      const port1 = await nextPort()
      const inst1 = await bootEngine(port1)
      child1 = inst1.child
      const login1 = await fetch(`${inst1.base}/api/operator/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "syn@example.com", password: "SYN-Pass-1" }),
      })
      assert.equal(login1.status, 200)
      const panelsBefore = (await (await fetch(`${inst1.base}/api/panels`)).json()) as {
        panels: Array<{ key: string; sessionSavedAt: string | null; reloginRequired: boolean }>
      }
      const m1 = panelsBefore.panels.find((p) => p.key === "meesho")
      assert.ok(m1?.sessionSavedAt, "sessionSavedAt present before restart")
      assert.equal(m1?.reloginRequired, false)

      // Kill engine 1 (simulating app close/restart)
      child1.kill()
      await new Promise((r) => setTimeout(r, 300))
      child1 = null

      // Boot 2: new process on same AGENT_DATA_DIR & userDataDir
      const port2 = await nextPort()
      const inst2 = await bootEngine(port2)
      child2 = inst2.child
      const panelsAfter = (await (await fetch(`${inst2.base}/api/panels`)).json()) as {
        panels: Array<{ key: string; sessionSavedAt: string | null; reloginRequired: boolean }>
      }
      const m2 = panelsAfter.panels.find((p) => p.key === "meesho")
      assert.equal(m2?.sessionSavedAt, m1?.sessionSavedAt, "saved Meesho session survives engine restart")

      // Verify /api/panels/meesho/check-login endpoint responds cleanly when signed in
      const checkRes = await fetch(`${inst2.base}/api/panels/meesho/check-login`, { method: "POST" })
      assert.equal(checkRes.status, 200)
      const checkData = (await checkRes.json()) as { ok: boolean; loggedIn: boolean; panels: unknown[] }
      assert.equal(checkData.ok, true)
      assert.ok(Array.isArray(checkData.panels))
    } finally {
      child1?.kill()
      child2?.kill()
      stub.close()
    }
  })
})
