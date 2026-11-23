import dotenv from "dotenv"
dotenv.config()
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { getPool } from "../db.js"
import { getJobExecutionBundle } from "../claim-automation-service.js"
import { MeeshoAutomation } from "../../desktop-agent/src/marketplaces/meesho.js"
import type { SupplierBrowserApi } from "../../desktop-agent/src/browser-adapter.js"

interface BrowserFormState {
  authenticated: boolean
  route: string
  uploadedFiles: Record<string, string[]>
  ticketAfterSubmit?: string
  ticketRowsAfter?: string[][]
  formSubmitted?: boolean
}

function createBrowser(state: BrowserFormState): SupplierBrowserApi {
  return {
    profileDirectory: "/tmp/fake-profile",
    async connectToPage() {},
    async send() {
      return {}
    },
    async navigate(url: string) {
      if (url.includes("login") && state.authenticated) {
        state.route = "https://supplier.meesho.com/panel/v3/new/experience/yqcue/home"
      } else {
        state.route = url
      }
    },
    async evaluate<T>(script: string): Promise<T> {
      if (script.includes("isPortalLoggedIn")) return state.authenticated as unknown as T
      if (script.includes("window.location.href") && script.includes("document.body.innerText")) {
        if (state.formSubmitted && state.ticketAfterSubmit) {
          return {
            href: `${state.route}/ticket/${state.ticketAfterSubmit}`,
            text: `Thank you! Your ticket ${state.ticketAfterSubmit} has been raised successfully.`,
          } as unknown as T
        }
        return { href: state.route, text: "" } as unknown as T
      }
      if (script.includes("location.href")) return state.route as unknown as T
      if (script.includes("extractVendorSlugFromUrl")) return "yqcue" as unknown as T
      if (script.includes("detectEarlyBlocker") || script.includes("readIneligibleMessage")) return false as unknown as T
      if (script.includes("readTicketTableRows") || script.includes("querySelectorAll('td, th')") || script.includes('querySelectorAll("tr")')) {
        return (state.formSubmitted ? (state.ticketRowsAfter || []) : []) as unknown as T
      }
      if (script.includes("tr td") || script.includes("RecentTicketIds")) {
        return (state.formSubmitted && state.ticketAfterSubmit ? [state.ticketAfterSubmit] : []) as unknown as T
      }
      if (script.includes("detectFileInputs") || script.includes('input[type="file"]')) {
        return ["file_box", "file_waybill", "file_product", "file_video"] as unknown as T
      }
      if (script.includes("hasName") || script.includes("hasThumb")) {
        return { files: 1, ack: true, error: "" } as unknown as T
      }
      if (
        script.includes("btn.classList.contains('disabled')") ||
        script.includes("btn.getAttribute('aria-disabled')") ||
        script.includes("submitDisabledJs")
      ) {
        return false as unknown as T
      }
      if (script.includes("label(target) !== 'Submit'")) {
        state.formSubmitted = true
        return true as unknown as T
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
    async humanType(): Promise<boolean> {
      return true
    },
    async humanClick(selector: string): Promise<boolean> {
      if (state.route.includes("login")) {
        state.route = "https://supplier.meesho.com/panel/v3/new/experience/yqcue/home"
      }
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

async function run() {
  const pool = getPool()
  const jobs = await pool.query(`
    SELECT j.id, j.claim_id
    FROM claim_automation_jobs j
    JOIN claims c ON c.id = j.claim_id
    ORDER BY j.id DESC
    LIMIT 10
  `)

  console.log(`\n======================================================`)
  console.log(`AUDITING & TESTING 10 REAL CLAIMS FROM DATABASE`)
  console.log(`======================================================\n`)
  const summary: Array<{
    jobId: number
    claimId: number
    subOrderId: string
    awb: string
    packetState: string
    issueCode: string
    mediaFiles: number
    success: boolean
    stage: string
    ticketId: string | null
    notes: string
  }> = []

  for (const row of jobs.rows) {
    const bundle = await getJobExecutionBundle(pool, Number(row.id))
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-real-claim-test-"))

    const evidenceMap = new Map<string, string[]>()
    for (const file of bundle.evidenceFiles) {
      const filePath = path.join(workDir, file.originalFilename || `file_${file.id}.dat`)
      fs.writeFileSync(filePath, "DUMMY EVIDENCE CONTENT")
      const existing = evidenceMap.get(file.fieldKey) || []
      existing.push(filePath)
      evidenceMap.set(file.fieldKey, existing)
    }

    const expectedTicket = `79421900${bundle.jobId}`
    const state: BrowserFormState = {
      authenticated: true,
      route: "https://supplier.meesho.com/panel/v3/new/experience/yqcue/support/1",
      uploadedFiles: {},
      ticketAfterSubmit: expectedTicket,
      ticketRowsAfter: [[expectedTicket, bundle.claim.subOrderId, "Open"]],
      formSubmitted: false,
    }
    const browser = createBrowser(state)

    const automation = new MeeshoAutomation(browser, bundle, evidenceMap, workDir)

    const execResult = await automation.execute("submit")

    summary.push({
      jobId: bundle.jobId,
      claimId: bundle.claimId,
      subOrderId: bundle.claim.subOrderId,
      awb: bundle.claim.trackingId,
      packetState: bundle.claim.packetState || "(empty)",
      issueCode: bundle.claim.marketplaceIssueCode,
      mediaFiles: bundle.evidenceFiles.length,
      success: execResult.success,
      stage: execResult.stage,
      ticketId: execResult.marketplaceClaimId || null,
      notes: execResult.manualActionReason || (execResult.success ? "Ready for automated submit" : ""),
    })

    fs.rmSync(workDir, { recursive: true, force: true })
  }

  console.table(summary)
  process.exit(0)
}

run().catch((e) => {
  console.error("Test failed:", e)
  process.exit(1)
})
