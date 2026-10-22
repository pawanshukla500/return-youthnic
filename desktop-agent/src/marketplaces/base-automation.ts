import type { BrowserRunner } from "../browser-runner.js"
import type { JobExecutionBundle } from "../agent-client.js"
import { logger } from "../logger.js"

export type MarketplaceAutomationResult = {
  success: boolean
  // not_eligible: the marketplace refuses this order for a claim (for example Meesho's packaging policy). The bot does
  // not claim it, keeps it for manual review, and moves on to the next job.
  stage: "prepared" | "completed" | "manual_intervention_required" | "not_eligible" | "failed"
  marketplaceClaimId?: string
  screenshotPath?: string
  errorMessage?: string
  manualActionReason?: string
}

/**
 * Result of reading a filed ticket's state on a supplier portal.
 *
 * `supported: false` means this marketplace has no status reader yet. The engine
 * reports it back, and the server stops chasing that ticket instead of opening the
 * portal every two days for nothing.
 */
export type ClaimStatusCheckResult =
  | { supported: false; reason: string }
  | {
      supported: true
      /** Exactly what the portal shows for the ticket state. The server normalizes it. */
      statusText: string
      /** Optional normalized state when the portal wording is ambiguous. */
      normalizedStatus?: string
      screenshotPath?: string
      note?: string
    }

export abstract class BaseMarketplaceAutomation {
  abstract readonly marketplaceName: string

  constructor(
    protected browser: BrowserRunner,
    protected job: JobExecutionBundle,
    protected evidenceFilesMap: Map<string, string[]>,
    protected workDir: string,
  ) {}

  abstract execute(action: "prepare" | "submit"): Promise<MarketplaceAutomationResult>

  /**
   * Read the state of a ticket that was filed on this marketplace earlier.
   *
   * The follow-up worker calls this with the supplier browser already open on the
   * panel's saved profile, so the stored session carries the sign-in. `statusText`
   * is whatever the portal shows; the server normalizes it and decides whether the
   * ticket is finished.
   *
   * The default says "not supported", which stops the follow-up for that
   * marketplace: the engine will not keep opening a portal every two days for a
   * check that does not exist. Implement it in a marketplace class to turn ticket
   * tracking on for that marketplace.
   */
  async checkClaimStatus(_marketplaceClaimId: string): Promise<ClaimStatusCheckResult> {
    return {
      supported: false,
      reason: `Automated ticket status check is not implemented for ${this.marketplaceName} yet.`,
    }
  }

  protected async delay(ms = 1000): Promise<void> {
    await this.browser.delay(ms)
  }

  protected async waitForSelector(selector: string, timeoutMs = 15000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const exists = await this.browser.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
      if (exists) return true
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  protected async waitForContent(timeoutMs = 15000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const ready = await this.browser.evaluate<boolean>(`
        (() => {
          const text = document.body ? document.body.innerText.trim() : '';
          return text.length > 40;
        })()
      `)
      if (ready) return true
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return false
  }

  protected async humanType(selector: string, text: string): Promise<boolean> {
    logger.info(`[Human Type] Typing ${text.length} characters into: ${selector}`)
    return this.browser.humanType(selector, text)
  }

  protected async humanClick(selector: string): Promise<boolean> {
    logger.info(`[Human Click] Clicking element: ${selector}`)
    return this.browser.humanClick(selector)
  }

  protected async uploadFiles(selector: string, filePaths: string[]): Promise<boolean> {
    logger.info(`[File Upload] Attaching ${filePaths.length} files to input: ${selector}`)
    return this.browser.setFileInputFiles(selector, filePaths)
  }

  protected async typeText(selector: string, text: string): Promise<void> {
    await this.humanType(selector, text)
  }

  protected async clickElement(selector: string): Promise<void> {
    await this.humanClick(selector)
  }
}

