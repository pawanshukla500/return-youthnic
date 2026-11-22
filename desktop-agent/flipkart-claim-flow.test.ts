import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { JobExecutionBundle } from "./src/agent-client.js"
import type { SupplierBrowserApi } from "./src/browser-adapter.js"
import { FlipkartAutomation } from "./src/marketplaces/flipkart.js"

function makeEvidenceSet(rootDir: string): Map<string, string[]> {
  const dir = fs.mkdtempSync(path.join(rootDir, "SYN-flipkart-ev-"))
  const img = path.join(dir, "SYN-item.jpg")
  const waybill = path.join(dir, "SYN-waybill.jpg")
  const video = path.join(dir, "SYN-unbox.mp4")
  fs.writeFileSync(img, Buffer.alloc(512, 0x11))
  fs.writeFileSync(waybill, Buffer.alloc(512, 0x22))
  fs.writeFileSync(video, Buffer.alloc(1024, 0x33))
  return new Map([
    ["product_images", [img]],
    ["reverse_waybill", [waybill]],
    ["unboxing_video", [video]],
  ])
}

function makeBundle(overrides?: Partial<JobExecutionBundle["claim"]>, requireApproval = true): JobExecutionBundle {
  return {
    jobId: 501,
    claimId: 901,
    stage: "downloading_media",
    claimStatus: "ready_for_claim",
    marketplace: "Flipkart",
    accountName: "Flipkart",
    portalUrl: "https://seller.flipkart.com/index.html#dashboard/returns-v2",
    credentials: { username: "SYN-USER", password: "SYN-PASSWORD", authState: {} },
    automationMode: "assisted",
    requireApprovalBeforeSubmit: requireApproval,
    claim: {
      orderNumber: "OD9876543210123",
      subOrderId: "OD9876543210123-1",
      trackingId: "FMPC000111222333",
      packetId: "SYN-PKT-FLIP",
      sku: "SYN-SKU-01",
      customerName: "SYN Customer",
      totalPrice: 1299,
      packetState: "Tampered",
      marketplaceIssueCode: "wrong_return",
      claimReason: "Wrong item received",
      claimTitle: "Wrong item return",
      claimDescription: "Customer returned completely wrong product instead of saree.",
      claimContent: "",
      remarks: "",
      returnType: "Customer Return",
      ...overrides,
    },
    evidenceFiles: [],
  }
}

describe("FlipkartAutomation execution flow", () => {
  it("stops at prepared stage with screenshot when requireApprovalBeforeSubmit is true", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-fk-test-"))
    const bundle = makeBundle({}, true)
    const evidence = makeEvidenceSet(tmpDir)

    let navigatedUrl = ""
    let capturedScreenshot = ""
    const checkpoints: string[] = []

    const mockBrowser: SupplierBrowserApi = {
      profileDirectory: tmpDir,
      async connectToPage() {},
      async send() { return {} },
      async navigate(url: string) { navigatedUrl = url },
      async evaluate<T>(script: string): Promise<T> {
        if (script.includes("Boolean(document.querySelector")) {
          return true as unknown as T
        }
        if (script.includes("window.location.href")) {
          return "https://seller.flipkart.com/index.html#dashboard/returns-v2" as unknown as T
        }
        if (script.includes("document.body.innerText") || script.includes("document.body ? document.body.innerText : ''")) {
          return "Seller Hub Dashboard\nReturns\nOrders\nOD9876543210123 Delivered" as unknown as T
        }
        if (script.includes('input[type="password"]')) {
          return false as unknown as T
        }
        if (script.includes("querySelectorAll('input[type=\"file\"]')")) {
          return ["outer_box_photo", "shipping_label_file"] as unknown as T
        }
        if (script.includes("raise spf") || script.includes("apply spf")) {
          return true as unknown as T
        }
        return false as unknown as T
      },
      async captureScreenshot(outputPath: string) {
        capturedScreenshot = outputPath
        fs.writeFileSync(outputPath, Buffer.alloc(100))
        return outputPath
      },
      async detectCaptchaOrOtp() {
        return { challengeDetected: false }
      },
      async delay() {},
      async humanType() { return true },
      async humanClick() { return true },
      async clickByTextIncludes() { return true },
      async clickByExactText() { return true },
      async clickVisibleLabel() { return true },
      async clickLabelInDom() { return { clicked: true, href: "" } },
      async uploadViaChooser() { return true },
      async setFileInputFiles() { return true },
      async close() {},
    }

    const fk = new FlipkartAutomation(mockBrowser, bundle, evidence, tmpDir)
    fk.setProgressReporter(async (chk) => { checkpoints.push(chk) })

    const result = await fk.execute("prepare")
    assert.equal(result.success, true)
    assert.equal(result.stage, "prepared")
    assert.ok(capturedScreenshot.includes("prepared-flipkart-501.png"))
    assert.ok(checkpoints.includes("portal_authenticated"))
    assert.ok(checkpoints.includes("details_filled"))
  })

  it("submits and extracts incident ID when action is submit", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-fk-submit-"))
    const bundle = makeBundle({}, false)
    const evidence = makeEvidenceSet(tmpDir)

    const mockBrowser: SupplierBrowserApi = {
      profileDirectory: tmpDir,
      async connectToPage() {},
      async send() { return {} },
      async navigate() {},
      async evaluate<T>(script: string): Promise<T> {
        if (script.includes("Boolean(document.querySelector")) {
          return true as unknown as T
        }
        if (script.includes("window.location.href")) {
          return "https://seller.flipkart.com/index.html#dashboard/returns-v2/claim-success" as unknown as T
        }
        if (script.includes("document.body.innerText") || script.includes("document.body ? document.body.innerText : ''")) {
          return "SPF Claim Submitted. Incident ID: IN202611229988. Our team will review within 48 hours." as unknown as T
        }
        if (script.includes('input[type="password"]')) return false as unknown as T
        if (script.includes("isSubmitText")) return true as unknown as T
        return false as unknown as T
      },
      async captureScreenshot(outputPath: string) {
        fs.writeFileSync(outputPath, Buffer.alloc(100))
        return outputPath
      },
      async detectCaptchaOrOtp() { return { challengeDetected: false } },
      async delay() {},
      async humanType() { return true },
      async humanClick() { return true },
      async clickByTextIncludes() { return true },
      async clickByExactText() { return true },
      async clickVisibleLabel() { return true },
      async clickLabelInDom() { return { clicked: true, href: "" } },
      async uploadViaChooser() { return true },
      async setFileInputFiles() { return true },
      async close() {},
    }

    const fk = new FlipkartAutomation(mockBrowser, bundle, evidence, tmpDir)
    const result = await fk.execute("submit")

    assert.equal(result.success, true)
    assert.equal(result.stage, "completed")
    assert.equal(result.marketplaceClaimId, "IN202611229988")
  })

  it("identifies not_eligible returns when portal shows early blocker", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-fk-inelig-"))
    const bundle = makeBundle({}, false)
    const evidence = makeEvidenceSet(tmpDir)

    const mockBrowser: SupplierBrowserApi = {
      profileDirectory: tmpDir,
      async connectToPage() {},
      async send() { return {} },
      async navigate() {},
      async evaluate<T>(script: string): Promise<T> {
        if (script.includes("document.body.innerText") || script.includes("document.body ? document.body.innerText : ''")) {
          return "Order OD9876543210123: SPF claim already raised for this return." as unknown as T
        }
        if (script.includes("window.location.href")) return "https://seller.flipkart.com/returns" as unknown as T
        return false as unknown as T
      },
      async captureScreenshot(outputPath: string) {
        fs.writeFileSync(outputPath, Buffer.alloc(100))
        return outputPath
      },
      async detectCaptchaOrOtp() { return { challengeDetected: false } },
      async delay() {},
      async humanType() { return true },
      async humanClick() { return true },
      async clickByTextIncludes() { return true },
      async clickByExactText() { return true },
      async clickVisibleLabel() { return true },
      async clickLabelInDom() { return { clicked: true, href: "" } },
      async uploadViaChooser() { return true },
      async setFileInputFiles() { return true },
      async close() {},
    }

    const fk = new FlipkartAutomation(mockBrowser, bundle, evidence, tmpDir)
    const result = await fk.execute("submit")

    assert.equal(result.success, false)
    assert.equal(result.stage, "not_eligible")
    assert.ok(result.manualActionReason?.includes("SPF claim already raised"))
  })
})
