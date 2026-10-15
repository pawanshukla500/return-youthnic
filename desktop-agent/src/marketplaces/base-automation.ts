import type { BrowserRunner } from "../browser-runner.js"
import type { JobExecutionBundle } from "../agent-client.js"
import { logger } from "../logger.js"

export type MarketplaceAutomationResult = {
  success: boolean
  stage: "prepared" | "completed" | "manual_intervention_required" | "failed"
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

  protected async waitForSelector(selector: string, timeoutMs = 15000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const exists = await this.browser.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
      if (exists) return true
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  protected async typeText(selector: string, text: string): Promise<void> {
    await this.browser.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `)
  }

  protected async clickElement(selector: string): Promise<void> {
    await this.browser.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.click();
        }
      })()
    `)
  }
}
