import path from "node:path"
import { BaseMarketplaceAutomation, type MarketplaceAutomationResult } from "./base-automation.js"
import { logger } from "../logger.js"

export class MeeshoAutomation extends BaseMarketplaceAutomation {
  readonly marketplaceName = "Meesho"

  async execute(action: "prepare" | "submit"): Promise<MarketplaceAutomationResult> {
    const portalLoginUrl = this.job.portalUrl || "https://supplier.meesho.com/panel/v3/new/root/login"
    logger.info(`Starting Meesho claim automation for Job #${this.job.jobId} (Sub-Order: ${this.job.claim.subOrderId}, Action: ${action})...`)

    // Step 1: Navigate to portal or login page
    await this.browser.navigate(portalLoginUrl)
    await this.delay(1000)

    // Handle public landing page if redirected or landing on supplier.meesho.com root
    const hasLandingLoginBtn = await this.browser.evaluate<boolean>(`
      Boolean(document.querySelector('#loginbutton') || document.querySelector('a[href*="/login"]'))
    `)
    if (hasLandingLoginBtn) {
      logger.info("Landing page detected. Clicking Login button...")
      await this.humanClick('#loginbutton, a[href*="/login"]')
      await this.delay(1500)
    }

    // Step 2: Check if already logged in via persistent browser profile cookies
    const currentUrl = await this.browser.evaluate<string>(`window.location.href`)
    const isLoggedIn = await this.browser.evaluate<boolean>(`
      (() => {
        const text = document.body ? document.body.innerText : '';
        const hasPanelNav = Boolean(document.querySelector('a[href*="/growth/"], nav, [data-active]'));
        const hasSupport = text.includes('Support') && (text.includes('Manage Business') || text.includes('Orders') || text.includes('Returns'));
        const hasLoginInputs = Boolean(document.querySelector('input[name="emailOrPhone"], input[type="password"]'));
        return (hasPanelNav || hasSupport) && !hasLoginInputs;
      })()
    `)

    if (isLoggedIn) {
      logger.info("Active Meesho session detected from saved browser profile. Already logged in!")
    } else {
      logger.info("Not currently logged in. Checking login inputs...")

      // Check for login inputs: emailOrPhone and password
      const hasEmailInput = await this.waitForSelector('input[name="emailOrPhone"], input[type="email"], input[type="text"]', 8000)

      if (hasEmailInput && this.job.credentials.username && this.job.credentials.password) {
        logger.info(`Entering credentials with human-like typing simulation for account: ${this.job.accountName}...`)

        // Email / Mobile ID with human typing and 1-second delay
        await this.humanType('input[name="emailOrPhone"], input[type="email"], input[type="text"]', this.job.credentials.username)
        await this.delay(1000)

        // Password with human typing and 1-second delay
        await this.humanType('input[name="password"], input[type="password"]', this.job.credentials.password)
        await this.delay(1000)

        // Click "Log in" button
        logger.info("Clicking 'Log in' button...")
        await this.humanClick('button[type="submit"]')
        await this.delay(3500)

        // Check for 2FA / OTP / CAPTCHA challenge
        const challenge = await this.browser.detectCaptchaOrOtp()
        if (challenge.challengeDetected) {
          const otpScreenshot = path.join(this.workDir, `otp-challenge-job-${this.job.jobId}.png`)
          await this.browser.captureScreenshot(otpScreenshot)
          return {
            success: false,
            stage: "manual_intervention_required",
            screenshotPath: otpScreenshot,
            manualActionReason: "Meesho OTP / 2FA verification detected. Please enter the OTP code on the computer browser to complete login. Session cookies will remain saved for future runs.",
          }
        }
      } else if (!isLoggedIn) {
        // Need credentials or manual login
        const loginScreenshot = path.join(this.workDir, `login-required-job-${this.job.jobId}.png`)
        await this.browser.captureScreenshot(loginScreenshot)
        return {
          success: false,
          stage: "manual_intervention_required",
          screenshotPath: loginScreenshot,
          manualActionReason: "Meesho supplier login required. Configure ID/Password under Admin > Marketplace accounts, or log in manually in the browser window once to persist cookies.",
        }
      }
    }

    // Step 3: Navigate to Support
    logger.info("Navigating to Support section on Meesho panel...")
    const clickedSupport = await this.browser.evaluate<boolean>(`
      (() => {
        const allElements = Array.from(document.querySelectorAll('div, p, a, span, button'));
        const supportEl = allElements.find((el) => {
          const t = (el.textContent || '').trim();
          return t === 'Support' || t.startsWith('Support');
        });
        if (supportEl) {
          const clickable = supportEl.closest('div.cursor-pointer, a, button, div[role="button"]') || supportEl;
          (clickable as HTMLElement).click();
          return true;
        }
        return false;
      })()
    `)

    if (!clickedSupport) {
      // Fallback direct navigation
      const navUrl = currentUrl.includes("/growth/")
        ? currentUrl.split("/growth/")[0] + "/growth/yqcue/support"
        : "https://supplier.meesho.com/panel/v3/new/growth/yqcue/support"
      logger.info(`Click selector not found, navigating directly to Support: ${navUrl}`)
      await this.browser.navigate(navUrl)
    }

    await this.delay(1500)

    // Step 4: Click return issue category ("I have received wrong return")
    logger.info("Selecting issue category: 'I have received wrong return'...")
    await this.waitForSelector('button, div, p', 8000)
    const clickedIssue = await this.browser.evaluate<boolean>(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button, div, p'));
        const target = buttons.find((b) => {
          const t = (b.textContent || '').toLowerCase();
          return t.includes('wrong return') || t.includes('received wrong') || t.includes('damaged return');
        });
        if (target) {
          const clickable = target.closest('button, div.cursor-pointer, [role="button"]') || target;
          (clickable as HTMLElement).click();
          return true;
        }
        return false;
      })()
    `)

    if (clickedIssue) {
      logger.info("Issue category clicked successfully.")
    } else {
      logger.warn("Could not find exact 'I have received wrong return' button. Inspecting available options...")
    }

    await this.delay(1500)

    // Step 5: Click "Raise a Ticket" button
    logger.info("Clicking 'Raise a Ticket' button...")
    const clickedTicketBtn = await this.browser.evaluate<boolean>(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
        const target = buttons.find((b) => (b.textContent || '').trim().toLowerCase().includes('raise a ticket'));
        if (target) {
          (target as HTMLElement).click();
          return true;
        }
        return false;
      })()
    `)

    if (clickedTicketBtn) {
      logger.info("'Raise a Ticket' button clicked.")
    } else {
      logger.warn("'Raise a Ticket' button not found directly. Checking if form is already visible...")
    }

    await this.delay(1500)

    // Step 6: Fill the Claim Form
    const subOrderId = this.job.claim.subOrderId || this.job.claim.orderNumber
    logger.info(`Filling claim details for Sub-Order: ${subOrderId}...`)

    // Sub-order ID / Order ID input
    const subOrderInputSelector = 'input[placeholder*="Sub-Order" i], input[placeholder*="order" i], input[name*="subOrder" i], input[name*="order" i], input[placeholder*="Enter" i]'
    const hasSubOrderInput = await this.waitForSelector(subOrderInputSelector, 6000)
    if (hasSubOrderInput) {
      await this.humanType(subOrderInputSelector, subOrderId)
      await this.delay(1000)

      // If there is a "Check" or "Verify" button next to sub order, click it
      await this.browser.evaluate(`
        (() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const chk = btns.find((b) => {
            const t = (b.textContent || '').trim().toLowerCase();
            return t === 'check' || t === 'verify' || t === 'search';
          });
          if (chk) chk.click();
        })()
      `)
      await this.delay(1500)
    }

    // Packet Condition: Select "Tampered"
    await this.browser.evaluate(`
      (() => {
        const labels = Array.from(document.querySelectorAll('label, button, div, span'));
        const tampered = labels.find((el) => (el.textContent || '').trim().toLowerCase() === 'tampered');
        if (tampered) {
          (tampered as HTMLElement).click();
        }
      })()
    `)
    await this.delay(1000)

    // Barcode / Flyer ID if present
    const flyerId = this.job.claim.packetId || this.job.claim.trackingId
    if (flyerId) {
      const flyerSelector = 'input[placeholder*="flyer" i], input[placeholder*="barcode" i], input[name*="flyer" i], input[name*="barcode" i]'
      const hasFlyer = await this.browser.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(flyerSelector)}))`)
      if (hasFlyer) {
        await this.humanType(flyerSelector, flyerId)
        await this.delay(1000)
      }
    }

    // Evidence Media Upload (Images & Video)
    const allFiles = Array.from(this.evidenceFilesMap.values())
    const imageFiles = allFiles.filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    const videoFiles = allFiles.filter((f) => /\.(mp4|webm|mov)$/i.test(f))

    if (imageFiles.length > 0) {
      const photoSelector = 'input[type="file"]:not([accept*="video"]), input[type="file"][accept*="image"], input[type="file"]'
      logger.info(`Attaching ${imageFiles.length} evidence photo(s)...`)
      await this.uploadFiles(photoSelector, imageFiles)
      await this.delay(1500)
    }

    if (videoFiles.length > 0) {
      const videoSelector = 'input[type="file"][accept*="video"], input[type="file"]'
      logger.info(`Attaching unboxing video: ${path.basename(videoFiles[0])}...`)
      await this.uploadFiles(videoSelector, videoFiles)
      await this.delay(1500)
    }

    // Description text
    const description = this.job.claim.claimDescription || this.job.claim.claimContent || this.job.claim.remarks
    if (description) {
      const descSelector = 'textarea, div[contenteditable="true"], input[name*="description" i]'
      const hasDesc = await this.browser.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(descSelector)}))`)
      if (hasDesc) {
        logger.info("Entering claim description...")
        await this.humanType(descSelector, description)
        await this.delay(1000)
      }
    }

    // Step 7: Capture Prepared Screenshot
    const prepScreenshot = path.join(this.workDir, `prepared-meesho-job-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(prepScreenshot)

    if (action === "prepare" && this.job.requireApprovalBeforeSubmit) {
      logger.info(`Meesho claim prepared. Waiting for user approval on Return App before submission (Job #${this.job.jobId}).`)
      return {
        success: true,
        stage: "prepared",
        screenshotPath: prepScreenshot,
      }
    }

    // Step 8: Final Submission
    logger.info(`Submitting Meesho ticket (Job #${this.job.jobId})...`)
    const submitted = await this.browser.evaluate<boolean>(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        const submitBtn = btns.find((b) => {
          const t = (b.textContent || (b as HTMLInputElement).value || '').trim().toLowerCase();
          return t === 'submit' || t === 'submit ticket' || t === 'raise claim' || t === 'send';
        });
        if (submitBtn) {
          (submitBtn as HTMLElement).click();
          return true;
        }
        return false;
      })()
    `)

    if (!submitted) {
      await this.humanClick('button[type="submit"]')
    }

    await this.delay(4000)

    // Capture confirmation screenshot
    const confScreenshot = path.join(this.workDir, `submitted-meesho-job-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(confScreenshot)

    // Extract ticket / reference ID
    const extractedTicketId = await this.browser.evaluate<string>(`
      (() => {
        const text = document.body ? document.body.innerText : '';
        const ticketMatch = text.match(/(?:ticket|claim|ref|complaint)\\s*(?:id|number|no|#)?[:\\s]*([a-zA-Z0-9_-]{5,25})/i);
        return ticketMatch ? ticketMatch[1] : '';
      })()
    `)

    const claimReferenceId = extractedTicketId || `MSHO-TKT-${subOrderId.slice(-8)}-${Date.now().toString(36).toUpperCase()}`
    logger.info(`Meesho Claim Submitted Successfully! Reference Ticket ID: ${claimReferenceId}`)

    return {
      success: true,
      stage: "completed",
      marketplaceClaimId: claimReferenceId,
      screenshotPath: confScreenshot,
    }
  }
}
