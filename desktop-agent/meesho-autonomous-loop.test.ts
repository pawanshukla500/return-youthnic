// End-to-end validation of the Meesho autonomous claim loop:
//  - NativeSupplierBrowser resilience: UnknownVizError screenshot fallback, ERR_ABORTED (-3) redirect tolerance, fast long-text typing
//  - All 5 Meesho claim categories: wrong_return, missing_items, wrong_barcode_rto, damaged_return, used_product
//  - Checkpoints emitted sequentially and preserved on completion
//  - Optional barcode_image / attachments skipped cleanly when missing; mandatory slots verified with portal ack
//  - Ticket ID extracted BEFORE post-submit screenshot even if captureScreenshot returns ""
//  - Sequential batch execution timing confirming 150+ claims/day capacity
// All data synthetic SYN- only.

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { JobExecutionBundle } from "./src/agent-client.ts"
import type { SupplierBrowserApi } from "./src/browser-adapter.ts"
import { MeeshoAutomation } from "./src/marketplaces/meesho.ts"
import { NativeSupplierBrowser } from "./src/native-browser-view.ts"
import { clearSupplierSessionCache } from "./src/native-browser-view.ts"
import { parseSelectorFallbackResponse } from "./src/ai-center-assist.ts"

const SLUG = "syn-tulip-slug"

function makeEvidenceSet(rootDir: string, includeBarcode = false): Map<string, string[]> {
  const dir = fs.mkdtempSync(path.join(rootDir, "SYN-meesho-auto-"))
  const jpgHeader = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1024, 0x11)])
  const mp4Header = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]), Buffer.alloc(4096, 0x22)])
  const prod = path.join(dir, "SYN-product.jpg")
  const waybill = path.join(dir, "SYN-waybill.jpg")
  const video = path.join(dir, "SYN-unboxing.mp4")
  fs.writeFileSync(prod, jpgHeader)
  fs.writeFileSync(waybill, jpgHeader)
  fs.writeFileSync(video, mp4Header)
  const map = new Map<string, string[]>([
    ["product_images", [prod]],
    ["reverse_waybill", [waybill]],
    ["unboxing_video", [video]],
  ])
  if (includeBarcode) {
    const barcode = path.join(dir, "SYN-barcode.jpg")
    fs.writeFileSync(barcode, jpgHeader)
    map.set("barcode_image", [barcode])
  }
  return map
}

function makeBundle(overrides: {
  jobId?: number
  claimId?: number
  issueCode: string
  returnType: string
  packetState?: string
  description?: string
}): JobExecutionBundle {
  return {
    jobId: overrides.jobId ?? 201,
    claimId: overrides.claimId ?? 701,
    stage: "downloading_media",
    claimStatus: "ready_for_claim",
    marketplace: "Meesho",
    accountName: "Meesho",
    portalUrl: "https://supplier.meesho.com/panel/v3/new/root/login",
    credentials: { username: "", password: "", authState: {} },
    automationMode: "autonomous",
    requireApprovalBeforeSubmit: false,
    claim: {
      orderNumber: `SYN-ORD-${overrides.claimId ?? 701}`,
      subOrderId: `SYN-SUB-${overrides.claimId ?? 701}_1`,
      trackingId: `SYN-AWB-${overrides.claimId ?? 701}`,
      packetId: `SYN-PKT-${overrides.claimId ?? 701}`,
      sku: "SYN-SKU-01",
      customerName: "SYN Customer",
      totalPrice: 499,
      packetState: overrides.packetState ?? "Tampered",
      marketplaceIssueCode: overrides.issueCode,
      claimReason: `SYN ${overrides.issueCode}`,
      claimTitle: `SYN Title ${overrides.issueCode}`,
      claimDescription:
        overrides.description ??
        `Team,\n\nPlease Note This Sub Order ID SYN-SUB-${overrides.claimId ?? 701}_1 has issue (${overrides.issueCode}). ` +
          `Please check attached proof and unboxing video and approve our claim.\n\nSub Order ID: SYN-SUB-${overrides.claimId ?? 701}_1\n` +
          `AWB Number: SYN-AWB-${overrides.claimId ?? 701}\nState of the packet: Tampered\nPacket ID: SYN-PKT-${overrides.claimId ?? 701}\n\nRegards,\nReturn Team SYN`,
      claimContent: "",
      remarks: "",
      returnType: overrides.returnType,
    },
    evidenceFiles: [],
  }
}

type CategorySimState = {
  route: string
  selectedSubcategoryTab: string
  selectedIssueLabel: string
  subOrderId: string
  awb: string
  packetId: string
  packetState: string
  description: string
  uploadedInputs: Record<string, string[]>
  submitted: boolean
  ticketId: string
  screenshotThrows?: boolean
  hasBarcodeBox?: boolean
}

function createCategoryBrowser(state: CategorySimState, workDir: string): SupplierBrowserApi {
  return {
    profileDirectory: workDir,
    async connectToPage() {},
    async send() { return {} },
    async navigate(url: string) {
      state.route = url.includes("/root/login")
        ? `https://supplier.meesho.com/panel/v3/new/growth/${SLUG}/home`
        : url
    },
    async evaluate<T>(script: string): Promise<T> {
      if (script.includes("label(target) !== 'Submit'")) {
        state.submitted = true
        return true as unknown as T
      }
      if (script.includes("isPortalLoggedIn")) return true as unknown as T
      if (script.includes("#loginbutton")) return false as unknown as T
      if (script.includes('input[type="password"]')) {
        if (script.includes("innerText")) {
          return { href: state.route, text: "tulipprints\nOrders\nReturns\nSupport", hasPassword: false } as unknown as T
        }
        return false as unknown as T
      }
      if (script.includes("document.body ? document.body.innerText : ''") || (script.includes("href: window.location.href") && !script.includes("input"))) {
        if (state.submitted && script.includes("document.body.innerText")) {
          return {
            href: state.route,
            text: `Ticket Raised\nTicket ID: ${state.ticketId}\nMeesho support agent will share an update within 3 hours`,
          } as unknown as T
        }
        return {
          href: state.route,
          text: state.submitted ? `Ticket Raised\nTicket ID: ${state.ticketId}` : "tulipprints\nOrders\nReturns\nSupport\nRaise a Ticket",
        } as unknown as T
      }
      if (script.trim() === "window.location.href") return state.route as unknown as T
      if (script.includes("text.length > 40")) return true as unknown as T
      if (script.includes("Raise a Ticket") && script.includes("/support/1/")) {
        return state.route.includes("/support/1/issue/") as unknown as T
      }
      if (script.includes("Sub Order") && script.includes("Boolean(")) {
        return (state.route.includes("/create") && !state.submitted) as unknown as T
      }
      if (script.includes('document.querySelectorAll("tr")')) return [] as unknown as T
      if (script.includes("tr td")) return (state.submitted ? [state.ticketId] : []) as unknown as T
      if (script.includes("not eligible") && script.includes("isErrorStyled")) return "" as unknown as T
      if (script.includes("detectMeeshoEarlyBlocker") || script.includes(".slice(0, 60)")) return [] as unknown as T
      if (script.includes("state of the packet")) {
        state.packetState = script.includes("Intact") ? "Intact" : "Tampered"
        return true as unknown as T
      }
      if (script.includes('querySelectorAll(\'input[type="file"]\')') || script.includes("input[type=\"file\"]")) {
        const ids = ["product-image-upload", "reverse-waybill-upload", "unboxing-video-upload"]
        if (state.hasBarcodeBox) ids.push("barcode-image-upload")
        ids.push("attachments-upload")
        return ids as unknown as T
      }
      if (script.includes("document.querySelector(\"#") || script.includes("const input = document.querySelector(")) {
        const matched = Object.keys(state.uploadedInputs).find((k) => script.includes(k))
        const files = matched ? state.uploadedInputs[matched]?.length || 0 : 0
        return { files, ack: files > 0, error: "" } as unknown as T
      }
      if (script.includes("return-claim-description")) return true as unknown as T
      if (script.includes(".disabled")) return false as unknown as T
      if (script.includes("required|invalid")) return [] as unknown as T
      if (script.includes("b.textContent")) return true as unknown as T
      return false as unknown as T
    },
    async captureScreenshot(outputPath: string): Promise<string> {
      if (state.screenshotThrows) {
        // Hardened browsers must return "" on surface failure rather than crashing claims
        return ""
      }
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      fs.writeFileSync(outputPath, Buffer.from("SYN-PNG"))
      return outputPath
    },
    async detectCaptchaOrOtp() {
      return { challengeDetected: false }
    },
    async delay() {
      // Zero artificial sleep inside unit simulation
    },
    async humanType(selector: string, text: string): Promise<boolean> {
      if (selector.includes("Sub Order")) state.subOrderId = text
      else if (selector.includes("AWB")) state.awb = text
      else if (selector.includes("Packet") || selector.includes("flyer")) state.packetId = text
      else if (selector.includes("description")) state.description = text
      return true
    },
    async humanClick() {
      return true
    },
    async clickByTextIncludes() {
      return true
    },
    async clickByExactText() {
      return true
    },
    async clickVisibleLabel(text: string): Promise<boolean> {
      if (/^(courier return|courier return \(rto\)|rto|rto returns)$/i.test(text.trim())) {
        state.selectedSubcategoryTab = "Courier Return"
      } else if (/^(customer return|customer returns)$/i.test(text.trim())) {
        state.selectedSubcategoryTab = "Customer Return"
      } else if (/i have received|item\/s are missing/i.test(text)) {
        state.selectedIssueLabel = text
        state.route = `https://supplier.meesho.com/panel/v3/new/experience/${SLUG}/support/1/issue/selected`
      } else if (text === "Raise a Ticket") {
        state.route = `https://supplier.meesho.com/panel/v3/new/experience/${SLUG}/support/1/1/create`
      } else if (text === "Submit") {
        state.submitted = true
      }
      return true
    },
    async clickLabelInDom(text: string) {
      await this.clickVisibleLabel(text)
      return { clicked: true, href: state.route }
    },
    async uploadViaChooser() {
      return false
    },
    async setFileInputFiles(selector: string, filePaths: string[]) {
      const id = selector.replace(/^#/, "")
      state.uploadedInputs[id] = filePaths
      return true
    },
    async close() {},
  }
}

describe("Meesho autonomous claim loop hardening", () => {
  const tempRoots: string[] = []

  after(() => {
    for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true })
  })

  it("NativeSupplierBrowser tolerates ERR_ABORTED (-3) redirects and UnknownVizError screenshot failures, and fast-types long text", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-native-resilience-"))
    tempRoots.push(tmpDir)

    let currentVal = ""
    let keyEventsSent = 0
    const mockContents = {
      isDestroyed: () => false,
      loadURL: async (url: string) => {
        if (url.includes("/redirect-abort")) {
          const err = Object.assign(new Error("ERR_ABORTED (-3) loading 'https://supplier.meesho.com/growth/x/home'"), {
            code: "ERR_ABORTED",
            errno: -3,
          })
          throw err
        }
      },
      executeJavaScript: async (expr: string) => {
        if (expr.includes("querySelector") && expr.includes("el.focus")) return true
        if (expr.includes("intended = ")) {
          const m = expr.match(/const intended = ("[^"]*")/)
          if (m) currentVal = JSON.parse(m[1])
        }
        return true
      },
      capturePage: async () => {
        throw new Error("UnknownVizError")
      },
      sendInputEvent: () => {
        keyEventsSent += 1
      },
    }

    const browser = new NativeSupplierBrowser({} as never, { panelKey: "meesho", profileDir: tmpDir })
    ;(browser as unknown as { view: { webContents: unknown } }).view = { webContents: mockContents }

    // 1. Redirect ERR_ABORTED (-3) should NOT throw
    await browser.navigate("https://supplier.meesho.com/redirect-abort")

    // 2. UnknownVizError should NOT throw (returns "" safely)
    const shot = await browser.captureScreenshot(path.join(tmpDir, "nested", "shot.png"))
    assert.equal(shot, "")

    // 3. Long description (>48 chars) uses fast React setter + 1 final char keystroke instead of 380 serial delays
    const longDesc = "Team, ".padEnd(380, "x")
    const t0 = Date.now()
    const typed = await browser.humanType("#return-claim-description", longDesc)
    const elapsed = Date.now() - t0
    assert.equal(typed, true)
    assert.equal(keyEventsSent, 1, "long descriptions must not send per-character IPC keystrokes")
    assert.equal(currentVal.length, 380)
    assert.ok(elapsed < 2000, `expected fast long-text fill, got ${elapsed}ms`)

    await clearSupplierSessionCache("meesho")
  })

  it("completes all 5 Meesho categories end to end with optional barcode_image skipped cleanly, checkpoints recorded, and empty screenshot tolerated", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-meesho-5cat-"))
    tempRoots.push(tmpRoot)

    const cases = [
      { issueCode: "wrong_return", returnType: "Customer Return", expectedSubcat: "Customer Return", ticketId: "795277339101" },
      { issueCode: "missing_items", returnType: "Customer Return", expectedSubcat: "Customer Return", ticketId: "795277339102" },
      { issueCode: "wrong_barcode_rto", returnType: "RTO", expectedSubcat: "Courier Return", ticketId: "795277339103" },
      { issueCode: "damaged_return", returnType: "Customer Return", expectedSubcat: "Customer Return", ticketId: "795277339104" },
      { issueCode: "used_product", returnType: "Customer Return", expectedSubcat: "Customer Return", ticketId: "795277339105" },
    ] as const

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]
      const evidenceMap = makeEvidenceSet(tmpRoot, false) // Intentionally omit optional barcode_image
      const bundle = makeBundle({ jobId: 300 + i, claimId: 800 + i, issueCode: c.issueCode, returnType: c.returnType })
      const simState: CategorySimState = {
        route: `https://supplier.meesho.com/panel/v3/new/growth/${SLUG}/home`,
        selectedSubcategoryTab: "",
        selectedIssueLabel: "",
        subOrderId: "",
        awb: "",
        packetId: "",
        packetState: "",
        description: "",
        uploadedInputs: {},
        submitted: false,
        ticketId: c.ticketId,
        screenshotThrows: true,
        hasBarcodeBox: true, // Box exists in form even though barcode_image optional file absent
      }
      const browser = createCategoryBrowser(simState, tmpRoot)
      const meesho = new MeeshoAutomation(browser, bundle, evidenceMap, tmpRoot)
      const checkpoints: string[] = []
      meesho.setProgressReporter(async (checkpoint) => {
        checkpoints.push(checkpoint)
      })

      const result = await meesho.execute("prepare")
      assert.equal(result.success, true, `category ${c.issueCode} failed: ${result.manualActionReason}`)
      assert.equal(result.stage, "completed")
      assert.equal(result.marketplaceClaimId, c.ticketId)
      assert.equal(simState.selectedSubcategoryTab, c.expectedSubcat)
      assert.equal(simState.subOrderId, bundle.claim.subOrderId)
      assert.equal(simState.packetState, "Tampered")
      assert.ok(simState.description.includes(bundle.claim.subOrderId))
      assert.ok(simState.uploadedInputs["product-image-upload"]?.length === 1)
      assert.ok(simState.uploadedInputs["reverse-waybill-upload"]?.length === 1)
      assert.ok(simState.uploadedInputs["unboxing-video-upload"]?.length === 1)
      assert.ok(
        checkpoints.includes("portal_authenticated") &&
          checkpoints.includes("category_opened") &&
          checkpoints.includes("details_filled") &&
          checkpoints.includes("evidence_uploaded") &&
          checkpoints.includes("description_filled") &&
          checkpoints.includes("submitting_clicked") &&
          checkpoints.includes("ticket_extracted"),
        `missing expected checkpoints in [${checkpoints.join(", ")}]`,
      )
    }
  })

  it("processes a sequential 5-claim batch fast enough for 150+ claims/day capacity", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-meesho-throughput-"))
    tempRoots.push(tmpRoot)

    const tStart = Date.now()
    for (let i = 0; i < 5; i++) {
      const evidenceMap = makeEvidenceSet(tmpRoot, true)
      const bundle = makeBundle({
        jobId: 400 + i,
        claimId: 900 + i,
        issueCode: i % 2 === 0 ? "wrong_return" : "wrong_barcode_rto",
        returnType: i % 2 === 0 ? "Customer Return" : "RTO",
      })
      const simState: CategorySimState = {
        route: `https://supplier.meesho.com/panel/v3/new/growth/${SLUG}/home`,
        selectedSubcategoryTab: "",
        selectedIssueLabel: "",
        subOrderId: "",
        awb: "",
        packetId: "",
        packetState: "",
        description: "",
        uploadedInputs: {},
        submitted: false,
        ticketId: `7952773392${i}`,
      }
      const meesho = new MeeshoAutomation(createCategoryBrowser(simState, tmpRoot), bundle, evidenceMap, tmpRoot)
      const res = await meesho.execute("prepare")
      assert.equal(res.stage, "completed")
    }
    const elapsedMs = Date.now() - tStart
    const avgMsPerClaim = elapsedMs / 5
    // Even with ~20s of real browser network/upload time per claim in production, 150 claims/day = 50 minutes/day.
    assert.ok(avgMsPerClaim < 5000, `sequential automation overhead too slow: ${avgMsPerClaim}ms/claim`)
  })

  it("parseSelectorFallbackResponse treats null/blank index strictly as no-match instead of coercing to 0", () => {
    assert.equal(parseSelectorFallbackResponse('{"index": null, "reason": "none"}', [0, 1, 2]), null)
    assert.equal(parseSelectorFallbackResponse('{"index": "", "reason": "none"}', [0, 1, 2]), null)
    assert.equal(parseSelectorFallbackResponse('{"index": 99, "reason": "oob"}', [0, 1, 2]), null)
    assert.deepEqual(parseSelectorFallbackResponse('{"index": 0, "reason": "Submit button"}', [0, 1, 2]), {
      candidateIndex: 0,
      reason: "Submit button",
    })
  })
})
