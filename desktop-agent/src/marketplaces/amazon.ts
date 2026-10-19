import path from "node:path"
import { BaseMarketplaceAutomation, type MarketplaceAutomationResult } from "./base-automation.js"
import { logger } from "../logger.js"

export class AmazonAutomation extends BaseMarketplaceAutomation {
  readonly marketplaceName = "Amazon"

  async execute(action: "prepare" | "submit"): Promise<MarketplaceAutomationResult> {
    const portalUrl = this.job.portalUrl || "https://sellercentral.amazon.in/"
    logger.info(`Starting Amazon claim automation for Job #${this.job.jobId} (Order: ${this.job.claim.orderNumber}, Action: ${action})...`)

    await this.browser.navigate(portalUrl)

    const challenge = await this.browser.detectCaptchaOrOtp()
    if (challenge.challengeDetected) {
      const screenshot = path.join(this.workDir, `challenge-amazon-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(screenshot)
      return {
        success: false,
        stage: "manual_intervention_required",
        screenshotPath: screenshot,
        manualActionReason: challenge.reason || "CAPTCHA or OTP challenge detected on Amazon Seller Central",
      }
    }

    const prepScreenshot = path.join(this.workDir, `prepared-amazon-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(prepScreenshot)

    if (action === "prepare" && this.job.requireApprovalBeforeSubmit) {
      return {
        success: true,
        stage: "prepared",
        screenshotPath: prepScreenshot,
      }
    }

    const confScreenshot = path.join(this.workDir, `submitted-amazon-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(confScreenshot)

    return {
      success: false,
      stage: "manual_intervention_required",
      screenshotPath: confScreenshot,
      manualActionReason: "Amazon did not show a case ID. Finish this claim in the open browser, then run it again.",
    }
  }
}
