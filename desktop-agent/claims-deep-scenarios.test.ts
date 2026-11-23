// Deep 8-Scenario Claim Automation & Headless Verification Suite
// Tests 8 distinct real-world marketplace claim flows:
//   1. Meesho Customer Return: Wrong Product (Intact packet, 4 evidence uploads, suborder fill, exact ticket extraction)
//   2. Meesho Customer Return: Missing Items / Empty Box (Tampered packet, 3 evidence uploads, ticket extraction)
//   3. Meesho Customer Return: Damaged Product (Intact packet, damage photo, unboxing video, ticket extraction)
//   4. Meesho Courier Return: Wrong-Barcoded RTO (Courier Return tab, flyer barcode fill, ticket extraction)
//   5. Meesho Session Expired: Headless automatic claim detects expired session -> fail fast with loginRequired: true
//   6. Meesho Duplicate Claim: Support ticket pre-check detects existing order ticket -> duplicate_ticket_found abort
//   7. Flipkart SPF Claim: Wrong Return (Returns search, eligibility check, multi-file evidence upload, IN... Incident ID extraction)
//   8. Myntra SPF Claim: Missing Items / Tag Loop (Isolated account session, services navigation, MYN-SPF-... extraction)

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { JobExecutionBundle } from "./src/agent-client.ts"
import type { SupplierBrowserApi } from "./src/browser-adapter.ts"
import { MeeshoAutomation } from "./src/marketplaces/meesho.ts"
import { FlipkartAutomation } from "./src/marketplaces/flipkart.ts"
import { MyntraAutomation } from "./src/marketplaces/myntra.ts"

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function createDummyEvidenceFile(dir: string, name: string, sizeBytes: number = 1024): string {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, Buffer.alloc(sizeBytes, 0x61))
  return filePath
}

type BrowserFormState = {
  authenticated: boolean
  route: string
  subOrderId?: string
  orderNumber?: string
  awb?: string
  packetId?: string
  packetState?: string
  description?: string
  uploadedFiles: Record<string, string[]>
  ticketsBefore: string[]
  ticketRowsBefore?: string[][]
  ticketAfterSubmit?: string
  ticketRowsAfter?: string[][]
  formSubmitted: boolean
}

function createSimulatedSupplierBrowser(state: BrowserFormState, workDir: string): SupplierBrowserApi {
  return {
    profileDirectory: workDir,
    async connectToPage() {},
    async send() { return {} },
    async navigate(url: string) {
      state.route = url
      if ((url.includes("/root/login") || url === "https://supplier.meesho.com" || url === "https://supplier.meesho.com/") && state.authenticated) {
        state.route = "https://supplier.meesho.com/panel/v3/new/experience/syn-seller-slug/home"
      }
    },
    async evaluate<T>(script: string): Promise<T> {
      // Session status
      if (script.includes("isPortalLoggedIn")) {
        return (state.authenticated && !state.route.includes("/login")) as unknown as T
      }
      if (script.includes('input[type="password"]')) {
        return (!state.authenticated) as unknown as T
      }
      if (script.trim() === "window.location.href") {
        return state.route as unknown as T
      }
      if (script.includes("text.length > 40")) {
        return state.authenticated as unknown as T
      }

      // Ineligible & early blocker check (empty when eligible)
      if (script.includes("isErrorStyled") || script.includes("detectMeeshoEarlyBlocker")) {
        return "" as unknown as T
      }

      // Raise ticket button & category navigation
      if (script.includes("Raise a Ticket")) {
        return true as unknown as T
      }

      // Form presence check
      if (script.includes("Sub Order") || script.includes("suborder") || script.includes("subOrderInputSelector")) {
        return (!state.formSubmitted && state.route.includes("support")) as unknown as T
      }

      // Read support tickets snapshot
      if (script.includes('document.querySelectorAll("tr")')) {
        if (state.formSubmitted && state.ticketRowsAfter) return state.ticketRowsAfter as unknown as T
        if (state.ticketRowsBefore) return state.ticketRowsBefore as unknown as T
        return state.ticketsBefore.map((id) => [id, "12345678901", "Open"]) as unknown as T
      }
      if (script.includes('document.querySelectorAll(\'tr td\')')) {
        return (state.formSubmitted && state.ticketAfterSubmit
          ? [state.ticketAfterSubmit, ...state.ticketsBefore]
          : state.ticketsBefore) as unknown as T
      }

      // Packet state selection
      if (script.includes("state of the packet") || script.includes("State of the packet")) {
        return true as unknown as T
      }

      // Input elements search
      if (script.includes('input[type="file"]')) {
        return ["file_box", "file_waybill", "file_product", "file_video"] as unknown as T
      }

      // Upload acknowledgement check
      if (script.includes("hasName") || script.includes("hasThumb")) {
        return { files: 1, ack: true, error: "" } as unknown as T
      }

      // Submit disabled check
      if (script.includes("btn.classList.contains('disabled')") || script.includes("btn.getAttribute('aria-disabled')") || script.includes("submitDisabledJs") || (script.includes("isSubmitText") && script.includes("disabled"))) {
        return false as unknown as T
      }

      // Submit execution click (IIFE from meeshoSubmitClickScript, flipkartSubmitClickScript, or myntraSubmitClickScript)
      if (script.includes("isSubmitText") || (script.includes("target.click()") && script.includes("Submit"))) {
        state.formSubmitted = true
        return true as unknown as T
      }

      // Confirmation URL & text
      if (script.includes("innerText") && script.includes("location.href")) {
        if (state.formSubmitted && state.ticketAfterSubmit) {
          return {
            href: `${state.route}/ticket/${state.ticketAfterSubmit}`,
            text: `Thank you! Your ticket ${state.ticketAfterSubmit} has been raised successfully.`
          } as unknown as T
        }
        return { href: state.route, text: "" } as unknown as T
      }

      return true as unknown as T
    },
    async captureScreenshot(outputPath: string): Promise<string> {
      fs.writeFileSync(outputPath, Buffer.from("SYN_PNG_DATA"))
      return outputPath
    },
    async detectCaptchaOrOtp() {
      return { challengeDetected: false }
    },
    async delay() {},
    async humanType(selector: string, text: string): Promise<boolean> {
      if (selector.includes("suborder") || selector.includes("Sub Order")) state.subOrderId = text
      if (selector.includes("awb") || selector.includes("AWB")) state.awb = text
      if (selector.includes("packet") || selector.includes("Packet")) state.packetId = text
      if (selector.includes("description") || selector.includes("textarea")) state.description = text
      return true
    },
    async humanClick(): Promise<boolean> {
      return true
    },
    async clickByTextIncludes(): Promise<boolean> {
      return true
    },
    async clickByExactText(): Promise<boolean> {
      return true
    },
    async clickVisibleLabel(): Promise<boolean> {
      return true
    },
    async clickLabelInDom() {
      return { clicked: true, href: "" }
    },
    async uploadViaChooser() {
      return true
    },
    async setFileInputFiles(selector: string, filePaths: string[]): Promise<boolean> {
      state.uploadedFiles[selector] = filePaths
      return true
    },
    async close() {},
  }
}

type TestJobOverrides = Omit<Partial<JobExecutionBundle>, "claim" | "credentials"> & {
  credentials?: Partial<JobExecutionBundle["credentials"]>
  claim?: Partial<JobExecutionBundle["claim"]>
}

function buildTestJob(overrides: TestJobOverrides): JobExecutionBundle {
  const claimOverrides = overrides.claim || {}
  return {
    jobId: overrides.jobId || 101,
    claimId: overrides.claimId || 501,
    stage: overrides.stage || "submitting",
    checkpoint: overrides.checkpoint,
    claimStatus: overrides.claimStatus || "submitting",
    marketplace: overrides.marketplace || "meesho",
    accountName: overrides.accountName || "default",
    portalUrl: overrides.portalUrl || "https://supplier.meesho.com",
    credentials: {
      username: overrides.credentials?.username ?? "syn_seller",
      password: overrides.credentials?.password ?? "syn_password",
      authState: overrides.credentials?.authState ?? {},
    },
    automationMode: overrides.automationMode || "full_auto",
    requireApprovalBeforeSubmit: overrides.requireApprovalBeforeSubmit ?? false,
    claim: {
      orderNumber: claimOverrides.orderNumber || "12345678901",
      subOrderId: claimOverrides.subOrderId || "12345678901",
      trackingId: claimOverrides.trackingId || "AWB99887766",
      packetId: claimOverrides.packetId || "PKT112233",
      packetState: claimOverrides.packetState || "Intact",
      marketplaceIssueCode: claimOverrides.marketplaceIssueCode || "wrong_return",
      sku: claimOverrides.sku || "SYN-SKU-001",
      customerName: claimOverrides.customerName || "SYN Customer",
      totalPrice: claimOverrides.totalPrice || 999,
      claimReason: claimOverrides.claimReason || "Wrong item",
      claimTitle: claimOverrides.claimTitle || "Wrong item",
      claimDescription: claimOverrides.claimDescription || "Wrong item received",
      claimContent: claimOverrides.claimContent || "Wrong item received",
      remarks: claimOverrides.remarks || "",
      returnType: claimOverrides.returnType || "Customer Return",
    },
    evidenceFiles: overrides.evidenceFiles || [],
  }
}

test("Scenario 1: Meesho Customer Return - Wrong Product (Intact packet, 4 evidence uploads, exact ticket extracted)", async () => {
  const workDir = createTempDir("SYN-meesho-s1-")
  const imgBox = createDummyEvidenceFile(workDir, "box.jpg")
  const imgWaybill = createDummyEvidenceFile(workDir, "waybill.jpg")
  const imgProd = createDummyEvidenceFile(workDir, "wrong_product.jpg")
  const vidUnboxing = createDummyEvidenceFile(workDir, "unboxing.mp4", 5000)

  const evidenceMap = new Map<string, string[]>([
    ["product_images", [imgProd]],
    ["reverse_waybill", [imgWaybill]],
    ["unboxing_video", [vidUnboxing]],
    ["attachments", [imgBox]],
  ])

  const state: BrowserFormState = {
    authenticated: true,
    route: "https://supplier.meesho.com/panel/v3/new/experience/syn-seller-slug/home",
    uploadedFiles: {},
    ticketsBefore: ["9900000001", "9900000002"],
    ticketRowsBefore: [["9900000001", "OTHER_ORDER", "Open"], ["9900000002", "OTHER_ORDER_2", "Open"]],
    ticketAfterSubmit: "98765432101",
    ticketRowsAfter: [["98765432101", "12345678901", "Open"]],
    formSubmitted: false,
  }

  const browser = createSimulatedSupplierBrowser(state, workDir)
  const job = buildTestJob({
    jobId: 101,
    claimId: 501,
    marketplace: "meesho",
    portalUrl: "https://supplier.meesho.com",
    credentials: { username: "syn_seller", password: "syn_password", authState: {} },
    claim: {
      subOrderId: "12345678901",
      orderNumber: "12345678901",
      trackingId: "AWB99887766",
      packetId: "PKT112233",
      marketplaceIssueCode: "wrong_return",
      packetState: "Intact",
      returnType: "Customer Return",
      claimDescription: "Customer returned completely wrong generic item instead of ordered garment.",
    },
    requireApprovalBeforeSubmit: false,
  })

  const automation = new MeeshoAutomation(browser, job, evidenceMap, workDir)
  const result = await automation.execute("submit")

  assert.equal(result.success, true, `Claim execution should succeed, got reason: ${result.manualActionReason}`)
  assert.equal(result.stage, "completed", "Stage should be completed")
  assert.equal(result.marketplaceClaimId, "98765432101", "Exact Ticket ID should be extracted")
  assert.ok(fs.existsSync(result.screenshotPath || ""), "Confirmation screenshot should be saved")
  fs.rmSync(workDir, { recursive: true, force: true })
})

test("Scenario 2: Meesho Customer Return - Missing Items / Empty Box (Tampered packet, 3 evidence uploads)", async () => {
  const workDir = createTempDir("SYN-meesho-s2-")
  const imgBox = createDummyEvidenceFile(workDir, "empty_box.jpg")
  const imgWaybill = createDummyEvidenceFile(workDir, "waybill.jpg")
  const vidUnboxing = createDummyEvidenceFile(workDir, "unboxing.mp4", 4000)

  const evidenceMap = new Map<string, string[]>([
    ["reverse_waybill", [imgWaybill]],
    ["unboxing_video", [vidUnboxing]],
    ["attachments", [imgBox]],
  ])

  const state: BrowserFormState = {
    authenticated: true,
    route: "https://supplier.meesho.com/panel/v3/new/experience/syn-seller-slug/home",
    uploadedFiles: {},
    ticketsBefore: ["9900000001"],
    ticketRowsBefore: [["9900000001", "OTHER_ORDER", "Open"]],
    ticketAfterSubmit: "98765432102",
    ticketRowsAfter: [["98765432102", "12345678902", "Open"]],
    formSubmitted: false,
  }

  const browser = createSimulatedSupplierBrowser(state, workDir)
  const job = buildTestJob({
    jobId: 102,
    claimId: 502,
    marketplace: "meesho",
    portalUrl: "https://supplier.meesho.com",
    credentials: { username: "syn_seller", password: "syn_password", authState: {} },
    claim: {
      subOrderId: "12345678902",
      orderNumber: "12345678902",
      trackingId: "AWB99887767",
      packetId: "PKT112234",
      marketplaceIssueCode: "missing_items",
      packetState: "Tampered",
      returnType: "Customer Return",
      claimDescription: "Parcel arrived cut open and completely empty. Inner item stolen.",
    },
    requireApprovalBeforeSubmit: false,
  })

  const automation = new MeeshoAutomation(browser, job, evidenceMap, workDir)
  const result = await automation.execute("submit")

  assert.equal(result.success, true, `Claim execution should succeed, got reason: ${result.manualActionReason}`)
  assert.equal(result.stage, "completed")
  assert.equal(result.marketplaceClaimId, "98765432102")
  fs.rmSync(workDir, { recursive: true, force: true })
})

test("Scenario 3: Meesho Customer Return - Damaged Product (Intact packet, damage photo + unboxing video)", async () => {
  const workDir = createTempDir("SYN-meesho-s3-")
  const imgDamage = createDummyEvidenceFile(workDir, "damaged_item.jpg")
  const imgWaybill = createDummyEvidenceFile(workDir, "waybill.jpg")
  const vidUnboxing = createDummyEvidenceFile(workDir, "unboxing.mp4", 4000)

  const evidenceMap = new Map<string, string[]>([
    ["product_images", [imgDamage]],
    ["reverse_waybill", [imgWaybill]],
    ["unboxing_video", [vidUnboxing]],
  ])

  const state: BrowserFormState = {
    authenticated: true,
    route: "https://supplier.meesho.com/panel/v3/new/experience/syn-seller-slug/home",
    uploadedFiles: {},
    ticketsBefore: [],
    ticketRowsBefore: [],
    ticketAfterSubmit: "98765432103",
    ticketRowsAfter: [["98765432103", "12345678903", "Open"]],
    formSubmitted: false,
  }

  const browser = createSimulatedSupplierBrowser(state, workDir)
  const job = buildTestJob({
    jobId: 103,
    claimId: 503,
    marketplace: "meesho",
    portalUrl: "https://supplier.meesho.com",
    credentials: { username: "syn_seller", password: "syn_password", authState: {} },
    claim: {
      subOrderId: "12345678903",
      orderNumber: "12345678903",
      trackingId: "AWB99887768",
      packetId: "PKT112235",
      marketplaceIssueCode: "damaged_return",
      packetState: "Intact",
      returnType: "Customer Return",
      claimDescription: "Product received torn and crushed inside unopened plastic seal.",
    },
    requireApprovalBeforeSubmit: false,
  })

  const automation = new MeeshoAutomation(browser, job, evidenceMap, workDir)
  const result = await automation.execute("submit")

  assert.equal(result.success, true, `Claim execution should succeed, got reason: ${result.manualActionReason}`)
  assert.equal(result.stage, "completed")
  assert.equal(result.marketplaceClaimId, "98765432103")
  fs.rmSync(workDir, { recursive: true, force: true })
})

test("Scenario 4: Meesho Courier Return - Wrong-Barcoded RTO (Courier Return tab & flyer ID)", async () => {
  const workDir = createTempDir("SYN-meesho-s4-")
  const imgFlyer = createDummyEvidenceFile(workDir, "flyer_barcode.jpg")
  const imgWaybill = createDummyEvidenceFile(workDir, "waybill.jpg")
  const vidUnboxing = createDummyEvidenceFile(workDir, "unboxing.mp4", 3500)

  const evidenceMap = new Map<string, string[]>([
    ["product_images", [imgFlyer]],
    ["reverse_waybill", [imgWaybill]],
    ["unboxing_video", [vidUnboxing]],
  ])

  const state: BrowserFormState = {
    authenticated: true,
    route: "https://supplier.meesho.com/panel/v3/new/experience/syn-seller-slug/home",
    uploadedFiles: {},
    ticketsBefore: ["9900000005"],
    ticketRowsBefore: [["9900000005", "OTHER_ORDER", "Open"]],
    ticketAfterSubmit: "98765432104",
    ticketRowsAfter: [["98765432104", "12345678904", "Open"]],
    formSubmitted: false,
  }

  const browser = createSimulatedSupplierBrowser(state, workDir)
  const job = buildTestJob({
    jobId: 104,
    claimId: 504,
    marketplace: "meesho",
    portalUrl: "https://supplier.meesho.com",
    credentials: { username: "syn_seller", password: "syn_password", authState: {} },
    claim: {
      subOrderId: "12345678904",
      orderNumber: "12345678904",
      trackingId: "AWB99887769",
      packetId: "FL-998811",
      marketplaceIssueCode: "wrong_barcode_rto",
      packetState: "Intact",
      returnType: "Courier Return / RTO",
      claimDescription: "RTO flyer has mismatched tracking barcode that belongs to another seller.",
    },
    requireApprovalBeforeSubmit: false,
  })

  const automation = new MeeshoAutomation(browser, job, evidenceMap, workDir)
  const result = await automation.execute("submit")

  assert.equal(result.success, true, `Claim execution should succeed, got reason: ${result.manualActionReason}`)
  assert.equal(result.stage, "completed")
  assert.equal(result.marketplaceClaimId, "98765432104")
  fs.rmSync(workDir, { recursive: true, force: true })
})

test("Scenario 5: Meesho Session Expired - Headless claim detects expired session -> fails fast with loginRequired: true", async () => {
  const workDir = createTempDir("SYN-meesho-s5-")
  const state: BrowserFormState = {
    authenticated: false,
    route: "https://supplier.meesho.com/panel/v3/new/root/login",
    uploadedFiles: {},
    ticketsBefore: [],
    formSubmitted: false,
  }

  const browser = createSimulatedSupplierBrowser(state, workDir)
  const job = buildTestJob({
    jobId: 105,
    claimId: 505,
    marketplace: "meesho",
    portalUrl: "https://supplier.meesho.com",
    credentials: { username: "", password: "", authState: {} },
    claim: {
      subOrderId: "12345678905",
      orderNumber: "12345678905",
      marketplaceIssueCode: "wrong_return",
      packetState: "Intact",
      returnType: "Customer Return",
    },
    requireApprovalBeforeSubmit: false,
  })

  const automation = new MeeshoAutomation(browser, job, new Map(), workDir)
  const result = await automation.execute("submit")

  assert.equal(result.success, false, "Execution should pause gracefully")
  assert.equal(result.stage, "manual_intervention_required")
  assert.equal(result.loginRequired, true, "loginRequired must be flagged so desktop prompts operator")
  assert.equal(result.checkpoint, "login_required")
  assert.ok(fs.existsSync(result.screenshotPath || ""), "Screenshot must be captured")
  fs.rmSync(workDir, { recursive: true, force: true })
})

test("Scenario 6: Meesho Duplicate Claim - Support ticket pre-check detects existing order ticket", async () => {
  const workDir = createTempDir("SYN-meesho-s6-")
  const state: BrowserFormState = {
    authenticated: true,
    route: "https://supplier.meesho.com/panel/v3/new/experience/syn-seller-slug/home",
    uploadedFiles: {},
    ticketsBefore: ["98765432106"],
    ticketRowsBefore: [["98765432106", "12345678906", "Open"]],
    formSubmitted: false,
  }

  const browser = createSimulatedSupplierBrowser(state, workDir)
  const job = buildTestJob({
    jobId: 106,
    claimId: 506,
    marketplace: "meesho",
    portalUrl: "https://supplier.meesho.com",
    credentials: { username: "syn_seller", password: "syn_password", authState: {} },
    claim: {
      subOrderId: "12345678906",
      orderNumber: "12345678906",
      trackingId: "AWB99887771",
      packetId: "PKT112238",
      marketplaceIssueCode: "wrong_return",
      packetState: "Intact",
      returnType: "Customer Return",
    },
    requireApprovalBeforeSubmit: false,
  })

  const automation = new MeeshoAutomation(browser, job, new Map(), workDir)
  const result = await automation.execute("submit")

  assert.equal(result.success, false)
  assert.equal(result.stage, "manual_intervention_required")
  assert.equal(result.checkpoint, "duplicate_ticket_found")
  assert.match(result.manualActionReason || "", /already shows ticket 98765432106/i)
  fs.rmSync(workDir, { recursive: true, force: true })
})

test("Scenario 7: Flipkart SPF Claim - Wrong Return (Returns-v2 search, eligibility, multi-file upload, Incident ID extraction)", async () => {
  const workDir = createTempDir("SYN-flipkart-s7-")
  const imgBox = createDummyEvidenceFile(workDir, "outer_box.jpg")
  const imgLabel = createDummyEvidenceFile(workDir, "shipping_label.jpg")
  const imgDamage = createDummyEvidenceFile(workDir, "damaged_prod.jpg")

  const evidenceMap = new Map<string, string[]>([
    ["product_images", [imgDamage]],
    ["reverse_waybill", [imgLabel]],
    ["attachments", [imgBox]],
  ])

  const state: BrowserFormState = {
    authenticated: true,
    route: "https://seller.flipkart.com/index.html#dashboard/returns-v2",
    uploadedFiles: {},
    ticketsBefore: [],
    formSubmitted: false,
  }

  const browser = createSimulatedSupplierBrowser(state, workDir)
  const originalEvaluate = browser.evaluate.bind(browser)
  browser.evaluate = async function<T>(script: string): Promise<T> {
    if (script.includes("isPortalLoggedIn")) return true as unknown as T
    if (script.includes("detectFlipkartEarlyBlocker") || script.includes("document.body.innerText")) {
      return (state.formSubmitted
        ? "SPF Claim Applied Successfully. Incident ID: IN8877665544. We will review your claim."
        : "Order 404-998877-1122 Delivered Return. Eligible for SPF claim.") as unknown as T
    }
    if (script.includes("isSubmitText") || script.includes("submit claim") || script.includes("confirm")) {
      state.formSubmitted = true
      return true as unknown as T
    }
    return originalEvaluate(script)
  }

  const job = buildTestJob({
    jobId: 107,
    claimId: 507,
    marketplace: "flipkart",
    portalUrl: "https://seller.flipkart.com",
    credentials: { username: "syn_flipkart_seller", password: "syn_password", authState: {} },
    claim: {
      orderNumber: "OD4049988771122",
      trackingId: "FMPC99887766",
      marketplaceIssueCode: "wrong_return",
      packetState: "Intact",
      claimDescription: "Received fake duplicate product in return. Requesting full SPF settlement.",
    },
    requireApprovalBeforeSubmit: false,
  })

  const automation = new FlipkartAutomation(browser, job, evidenceMap, workDir)
  const result = await automation.execute("submit")

  assert.equal(result.success, true, `Flipkart claim should succeed, got: ${result.manualActionReason}`)
  assert.equal(result.stage, "completed")
  assert.equal(result.marketplaceClaimId, "IN8877665544", "Must extract Flipkart IN-prefixed Incident ID")
  fs.rmSync(workDir, { recursive: true, force: true })
})

test("Scenario 8: Myntra SPF Claim - Missing Items / Tag Loop (Isolated account, returns services navigation, Ticket extraction)", async () => {
  const workDir = createTempDir("SYN-myntra-s8-")
  const imgTag = createDummyEvidenceFile(workDir, "tag_loop.jpg")
  const imgLabel = createDummyEvidenceFile(workDir, "myntra_label.jpg")

  const evidenceMap = new Map<string, string[]>([
    ["product_images", [imgTag]],
    ["reverse_waybill", [imgLabel]],
  ])

  const state: BrowserFormState = {
    authenticated: true,
    route: "https://partners.myntrainfo.com/returns/services",
    uploadedFiles: {},
    ticketsBefore: [],
    formSubmitted: false,
  }

  const browser = createSimulatedSupplierBrowser(state, workDir)
  const originalEvaluate = browser.evaluate.bind(browser)
  browser.evaluate = async function<T>(script: string): Promise<T> {
    if (script.includes("isPortalLoggedIn")) return true as unknown as T
    if (script.includes("document.body.innerText")) {
      return (state.formSubmitted
        ? "SPF Ticket Created: MYN-SPF-77665544. Team will evaluate within 48 hours."
        : "Order 19882233 returned without brand tag. VMS inspection logged.") as unknown as T
    }
    if (script.includes("isSubmitText") || script.includes("file spf") || script.includes("raise claim")) {
      state.formSubmitted = true
      return true as unknown as T
    }
    return originalEvaluate(script)
  }

  const job = buildTestJob({
    jobId: 108,
    claimId: 508,
    marketplace: "myntra_vb",
    accountName: "VB Export PPMP",
    portalUrl: "https://partners.myntrainfo.com/returns",
    credentials: { username: "syn_myntra_seller", password: "syn_password", authState: {} },
    claim: {
      orderNumber: "19882233",
      trackingId: "MYNTRA_AWB_11",
      marketplaceIssueCode: "missing_items",
      packetState: "Tampered",
      claimDescription: "Tag loop missing and one set of product pieces omitted by customer.",
    },
    requireApprovalBeforeSubmit: false,
  })

  const automation = new MyntraAutomation(browser, job, evidenceMap, workDir)
  const result = await automation.execute("submit")

  assert.equal(result.success, true, `Myntra claim should succeed, got: ${result.manualActionReason}`)
  assert.equal(result.stage, "completed")
  assert.equal(result.marketplaceClaimId, "MYN-SPF-77665544", "Must extract Myntra MYN-SPF ticket ID")
  fs.rmSync(workDir, { recursive: true, force: true })
})
