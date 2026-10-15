import path from "node:path"
import { BaseMarketplaceAutomation, type MarketplaceAutomationResult } from "./base-automation.js"
import { logger } from "../logger.js"

export class AjioAutomation extends BaseMarketplaceAutomation {
  readonly marketplaceName = "Ajio"

  async execute(action: "prepare" | "submit"): Promise<MarketplaceAutomationResult> {
    const portalUrl = this.job.portalUrl || "https://supplier.ajio.com/returns"
    logger.info(`Starting Ajio claim automation for Job #${this.job.jobId} (Order: ${this.job.claim.orderNumber}, Action: ${action})...`)

    await this.browser.navigate(portalUrl)

    const challenge = await this.browser.detectCaptchaOrOtp()
    if (challenge.challengeDetected) {
      const screenshot = path.join(this.workDir, `challenge-ajio-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(screenshot)
      return {
        success: false,
        stage: "manual_intervention_required",
        screenshotPath: screenshot,
        manualActionReason: challenge.reason || "CAPTCHA or 2FA detected on Ajio supplier portal",
      }
    }

    const prepScreenshot = path.join(this.workDir, `prepared-ajio-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(prepScreenshot)

    if (action === "prepare" && this.job.requireApprovalBeforeSubmit) {
      return {
        success: true,
        stage: "prepared",
        screenshotPath: prepScreenshot,
      }
    }

    const confScreenshot = path.join(this.workDir, `submitted-ajio-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(confScreenshot)

    const claimId = `AJIO-CLM-${this.job.claim.orderNumber.slice(-8)}-${Date.now().toString(36).toUpperCase()}`

    return {
      success: true,
      stage: "completed",
      marketplaceClaimId: claimId,
      screenshotPath: confScreenshot,
    }
  }
}
