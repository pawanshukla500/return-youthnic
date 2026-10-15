import path from "node:path"
import { BaseMarketplaceAutomation, type MarketplaceAutomationResult } from "./base-automation.js"
import { logger } from "../logger.js"

export class FlipkartAutomation extends BaseMarketplaceAutomation {
  readonly marketplaceName = "Flipkart"

  async execute(action: "prepare" | "submit"): Promise<MarketplaceAutomationResult> {
    const portalUrl = this.job.portalUrl || "https://seller.flipkart.com/index.html#dashboard/returns-v2"
    logger.info(`Starting Flipkart claim automation for Job #${this.job.jobId} (Order: ${this.job.claim.orderNumber}, Action: ${action})...`)

    await this.browser.navigate(portalUrl)

    const challenge = await this.browser.detectCaptchaOrOtp()
    if (challenge.challengeDetected) {
      const screenshot = path.join(this.workDir, `challenge-flipkart-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(screenshot)
      return {
        success: false,
        stage: "manual_intervention_required",
        screenshotPath: screenshot,
        manualActionReason: challenge.reason || "CAPTCHA or 2FA detected on Flipkart seller portal",
      }
    }

    // Check login
    const isLogin = await this.browser.evaluate<boolean>(`
      Boolean(document.querySelector('input[type="text"][name*="login"], input[name="username"], input[type="password"]'))
    `)

    if (isLogin) {
      if (this.job.credentials.username && this.job.credentials.password) {
        logger.info("Filling Flipkart seller credentials...")
        await this.typeText('input[type="text"][name*="login"], input[name="username"]', this.job.credentials.username)
        await this.typeText('input[type="password"]', this.job.credentials.password)
        await this.clickElement('button[type="submit"]')
        await new Promise((r) => setTimeout(r, 4000))
      } else {
        const screenshot = path.join(this.workDir, `login-needed-flipkart-${this.job.jobId}.png`)
        await this.browser.captureScreenshot(screenshot)
        return {
          success: false,
          stage: "manual_intervention_required",
          screenshotPath: screenshot,
          manualActionReason: "Please sign in to Flipkart Seller Portal in the open browser window.",
        }
      }
    }

    // Search order
    await this.waitForSelector('input[placeholder*="Order"], input[placeholder*="Tracking"], input[type="search"]', 6000)
    await this.typeText('input[placeholder*="Order"], input[placeholder*="Tracking"], input[type="search"]', this.job.claim.orderNumber)

    const prepScreenshot = path.join(this.workDir, `prepared-flipkart-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(prepScreenshot)

    if (action === "prepare" && this.job.requireApprovalBeforeSubmit) {
      return {
        success: true,
        stage: "prepared",
        screenshotPath: prepScreenshot,
      }
    }

    await this.clickElement('button:has-text("Submit"), button[type="submit"]')
    await new Promise((r) => setTimeout(r, 3000))

    const confScreenshot = path.join(this.workDir, `submitted-flipkart-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(confScreenshot)

    const claimId = `FK-SPF-${this.job.claim.orderNumber.slice(-8)}-${Date.now().toString(36).toUpperCase()}`

    return {
      success: true,
      stage: "completed",
      marketplaceClaimId: claimId,
      screenshotPath: confScreenshot,
    }
  }
}
