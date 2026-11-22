import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { JobExecutionBundle } from "./src/agent-client.js"
import type { SupplierBrowserApi } from "./src/browser-adapter.js"
import { MyntraAutomation } from "./src/marketplaces/myntra.js"

function makeEvidenceSet(rootDir: string): Map<string, string[]> {
  const dir = fs.mkdtempSync(path.join(rootDir, "SYN-myntra-ev-"))
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

function makeJob(accountName: "Myntra VB" | "Myntra EJ", requireApproval = true): JobExecutionBundle {
  return {
    jobId: 701,
    claimId: 980,
    stage: "downloading_media",
    claimStatus: "ready_for_claim",
    marketplace: accountName,
    accountName,
    portalUrl: "https://partners.myntrainfo.com/returns",
    credentials: { username: "SYN-USER", password: "SYN-PASSWORD", authState: {} },
    automationMode: "assisted",
    requireApprovalBeforeSubmit: requireApproval,
    claim: {
      orderNumber: "MYN987654321",
      subOrderId: "MYN987654321-1",
      trackingId: "MYNAWB123456",
      packetId: "SYN-PKT-MYN",
      sku: "SYN-KURTI-01",
      customerName: "SYN Customer",
      totalPrice: 1599,
      packetState: "Tampered",
      marketplaceIssueCode: "wrong_return",
      claimReason: "Wrong item received",
      claimTitle: "Wrong item return",
      claimDescription: "Customer returned completely wrong dress with tag loop broken.",
      claimContent: "",
      remarks: "",
      returnType: "Customer Return",
    },
    evidenceFiles: [],
  }
}

describe("MyntraAutomation execution flow", () => {
  it("executes Myntra VB workflow and stops at prepared stage with screenshot when approval required", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-myntra-vb-"))
    const bundle = makeJob("Myntra VB", true)
    const evidence = makeEvidenceSet(tmpDir)

    let capturedScreenshot = ""
    const checkpoints: string[] = []

    const mockBrowser: SupplierBrowserApi = {
      profileDirectory: tmpDir,
      async connectToPage() {},
      async send() { return {} },
      async navigate() {},
      async evaluate<T>(script: string): Promise<T> {
        if (script.includes("Boolean(document.querySelector")) return true as unknown as T
        if (script.includes("window.location.href")) {
          return "https://partners.myntrainfo.com/returns" as unknown as T
        }
        if (script.includes("document.body.innerText") || script.includes("document.body ? document.body.innerText : ''")) {
          return "Partner Portal\nReturns Dashboard\nOrders\nMYN987654321 Delivered" as unknown as T
        }
        if (script.includes('input[type="password"]')) return false as unknown as T
        if (script.includes("querySelectorAll('input[type=\"file\"]')")) {
          return ["outer_package_photo", "shipping_label_input"] as unknown as T
        }
        return false as unknown as T
      },
      async captureScreenshot(outputPath: string) {
        capturedScreenshot = outputPath
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

    const myntra = new MyntraAutomation(mockBrowser, bundle, evidence, tmpDir)
    assert.equal(myntra.marketplaceName, "Myntra VB")
    myntra.setProgressReporter(async (chk) => { checkpoints.push(chk) })

    const result = await myntra.execute("prepare")
    assert.equal(result.success, true)
    assert.equal(result.stage, "prepared")
    assert.ok(capturedScreenshot.includes("prepared-myntra-701.png"))
    assert.ok(checkpoints.includes("portal_authenticated"))
    assert.ok(checkpoints.includes("details_filled"))
  })

  it("executes Myntra EJ workflow and extracts ticket ID upon submission", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-myntra-ej-"))
    const bundle = makeJob("Myntra EJ", false)
    const evidence = makeEvidenceSet(tmpDir)

    const mockBrowser: SupplierBrowserApi = {
      profileDirectory: tmpDir,
      async connectToPage() {},
      async send() { return {} },
      async navigate() {},
      async evaluate<T>(script: string): Promise<T> {
        if (script.includes("Boolean(document.querySelector")) return true as unknown as T
        if (script.includes("window.location.href")) {
          return "https://partners.myntrainfo.com/returns/spf/confirmation" as unknown as T
        }
        if (script.includes("document.body.innerText") || script.includes("document.body ? document.body.innerText : ''")) {
          return "SPF Claim Submitted. Ticket ID: MYN-SPF-554433. Our team will review your claim." as unknown as T
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

    const myntra = new MyntraAutomation(mockBrowser, bundle, evidence, tmpDir)
    assert.equal(myntra.marketplaceName, "Myntra EJ")

    const result = await myntra.execute("submit")
    assert.equal(result.success, true)
    assert.equal(result.stage, "completed")
    assert.equal(result.marketplaceClaimId, "MYN-SPF-554433")
  })
})
