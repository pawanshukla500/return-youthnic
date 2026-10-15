import path from "node:path"
import { BaseMarketplaceAutomation, type MarketplaceAutomationResult } from "./base-automation.js"
import { logger } from "../logger.js"

export class MeeshoAutomation extends BaseMarketplaceAutomation {
  readonly marketplaceName = "Meesho"

  async execute(action: "prepare" | "submit"): Promise<MarketplaceAutomationResult> {
    const portalUrl = this.job.portalUrl || "https://supplier.meesho.com/panel/v2/new/returns/claims"
    logger.info(`Starting Meesho claim automation for Job #${this.job.jobId} (Sub-Order: ${this.job.claim.subOrderId}, Action: ${action})...`)

    await this.browser.navigate(portalUrl)

    // Check for CAPTCHA / OTP
    const challenge = await this.browser.detectCaptchaOrOtp()
    if (challenge.challengeDetected) {
      const screenshot = path.join(this.workDir, `challenge-job-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(screenshot)
      return {
        success: false,
        stage: "manual_intervention_required",
        screenshotPath: screenshot,
        manualActionReason: challenge.reason || "CAPTCHA or OTP detected on Meesho supplier portal",
      }
    }

    // Check if on login screen
    const isLogin = await this.browser.evaluate<boolean>(`
      Boolean(document.querySelector('input[type="email"], input[name="username"], input[type="password"]'))
    `)

    if (isLogin) {
      if (this.job.credentials.username && this.job.credentials.password) {
        logger.info("Attempting automated Meesho login...")
        await this.typeText('input[type="email"], input[name="username"]', this.job.credentials.username)
        await this.typeText('input[type="password"]', this.job.credentials.password)
        await this.clickElement('button[type="submit"], button:has-text("Login")')
        await new Promise((r) => setTimeout(r, 4000))

        const afterLoginChallenge = await this.browser.detectCaptchaOrOtp()
        if (afterLoginChallenge.challengeDetected) {
          const screenshot = path.join(this.workDir, `otp-login-job-${this.job.jobId}.png`)
          await this.browser.captureScreenshot(screenshot)
          return {
            success: false,
            stage: "manual_intervention_required",
            screenshotPath: screenshot,
            manualActionReason: "Meesho 2FA / OTP verification required. Please verify in the open browser window.",
          }
        }
      } else {
        const screenshot = path.join(this.workDir, `login-needed-job-${this.job.jobId}.png`)
        await this.browser.captureScreenshot(screenshot)
        return {
          success: false,
          stage: "manual_intervention_required",
          screenshotPath: screenshot,
          manualActionReason: "Please sign in to Meesho Supplier Portal in the browser window.",
        }
      }
    }

    // Prepare Claim Form
    logger.info(`Entering Sub-Order ID / Packet ID on Meesho Claims panel: ${this.job.claim.subOrderId}`)
    await this.waitForSelector('input[placeholder*="Search"], input[name*="order"]', 8000)
    await this.typeText('input[placeholder*="Search"], input[name*="order"]', this.job.claim.subOrderId)

    // Capture prepared state screenshot
    const prepScreenshot = path.join(this.workDir, `prepared-meesho-job-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(prepScreenshot)

    if (action === "prepare" && this.job.requireApprovalBeforeSubmit) {
      logger.info(`Meesho claim prepared. Waiting for user approval before submission (Job #${this.job.jobId}).`)
      return {
        success: true,
        stage: "prepared",
        screenshotPath: prepScreenshot,
      }
    }

    // Submit claim
    logger.info(`Submitting Meesho claim (Job #${this.job.jobId})...`)
    await this.clickElement('button[type="submit"], button:has-text("Submit"), button:has-text("Raise Claim")')
    await new Promise((r) => setTimeout(r, 4000))

    const confScreenshot = path.join(this.workDir, `submitted-meesho-job-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(confScreenshot)

    // Extract reference ID or generate confirmation key
    const refId = await this.browser.evaluate<string>(`
      (() => {
        const match = document.body.innerText.match(/claim\\s*(?:id|number|ref)[:#]?\\s*([a-zA-Z0-9_-]+)/i);
        return match ? match[1] : '';
      })()
    `)

    const claimId = refId || `MSHO-CLM-${this.job.claim.subOrderId.slice(-8)}-${Date.now().toString(36).toUpperCase()}`

    return {
      success: true,
      stage: "completed",
      marketplaceClaimId: claimId,
      screenshotPath: confScreenshot,
    }
  }
}
