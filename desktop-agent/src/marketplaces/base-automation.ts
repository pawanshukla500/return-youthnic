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

export abstract class BaseMarketplaceAutomation {
  abstract readonly marketplaceName: string

  constructor(
    protected browser: BrowserRunner,
    protected job: JobExecutionBundle,
    protected evidenceFilesMap: Map<string, string>,
    protected workDir: string,
  ) {}

  abstract execute(action: "prepare" | "submit"): Promise<MarketplaceAutomationResult>

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

