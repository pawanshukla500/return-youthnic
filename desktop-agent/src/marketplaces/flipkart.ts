import path from "node:path"
import fs from "node:fs"
import {
  BaseMarketplaceAutomation,
  type ClaimStatusCheckResult,
  type MarketplaceAutomationResult,
} from "./base-automation.js"
import { isPortalLoggedIn, resolvePortalLoginUrl } from "../portal-login.js"
import { logger } from "../logger.js"

/**
 * Flipkart SPF (Seller Protection Fund) issue reason mapping.
 * Never invent an issue label: unmapped codes pause for manual review.
 */
export const FLIPKART_SPF_ISSUE_LABELS: Record<string, string> = {
  wrong_return: "Wrong Item Received",
  missing_items: "Item Missing / Partial Item Received",
  damaged_return: "Damaged Product Received",
  used_product: "Used / Old Product Received",
  wrong_barcode_rto: "Wrong Item in RTO / Courier Label Tampered",
}

export function resolveFlipkartIssueLabel(issueCode: string): string | null {
  return FLIPKART_SPF_ISSUE_LABELS[(issueCode || "").trim()] ?? null
}

export type FlipkartUploadField = "label_image" | "outer_box" | "product_image" | "unboxing_video" | "attachment"

export function resolveFlipkartUploadField(inputIdOrLabel: string): FlipkartUploadField | null {
  const norm = (inputIdOrLabel || "").toLowerCase()
  if (!norm) return null
  if (norm.includes("video") || norm.includes("unboxing") || norm.includes("opening")) {
    return "unboxing_video"
  }
  if (norm.includes("label") || norm.includes("awb") || norm.includes("waybill") || norm.includes("shipping")) {
    return "label_image"
  }
  if (norm.includes("outer") || norm.includes("box") || norm.includes("package") || norm.includes("packaging")) {
    return "outer_box"
  }
  if (norm.includes("product") || norm.includes("item") || norm.includes("sku")) {
    return "product_image"
  }
  if (norm.includes("attach") || norm.includes("proof") || norm.includes("document") || norm.includes("file")) {
    return "attachment"
  }
  return null
}

const FLIPKART_EARLY_BLOCKERS = [
  "spf claim already raised",
  "already raised an spf claim",
  "not eligible for spf",
  "claim window expired",
  "return not delivered",
  "in transit",
  "delivered more than 14 days ago",
  "claim rejected previously",
]

export function detectFlipkartEarlyBlocker(text: string): string | null {
  const raw = (text || "").trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  for (const phrase of FLIPKART_EARLY_BLOCKERS) {
    if (lower.includes(phrase)) {
      return raw.replace(/\s+/g, " ").slice(0, 400)
    }
  }
  return null
}

/**
 * Pure helper to extract Flipkart Incident ID / SPF Claim ID from confirmation text or URL.
 * Excludes known order number and AWB digits to prevent false matches.
 */
export function extractFlipkartIncidentId(url: string, text: string, orderNumber: string): string | null {
  const known = new Set<string>()
  for (const digits of String(orderNumber || "").match(/\d{9,16}/g) || []) {
    known.add(digits)
  }

  // Common Flipkart Incident patterns: IN1234567890, SPF-123456
  const incidentMatch = text.match(/\b(IN\d{8,16}|SPF[-_]?\d{6,14})\b/i) || url.match(/\b(IN\d{8,16}|SPF[-_]?\d{6,14})\b/i)
  if (incidentMatch && incidentMatch[1]) {
    return incidentMatch[1].toUpperCase()
  }

  // Labelled incident / claim / ticket numbers e.g. "Ticket: 98765432101", "Incident ID: 123456789", "Ticket # 456789"
  const labelledMatch =
    text.match(/(?:incident|claim|ticket)\s*(?:id|number|#)?\s*[:\-#]\s*([A-Z0-9_\-]{6,25})/i) ||
    text.match(/(?:incident|ticket)\s+(?:id|number|#)\s+([A-Z0-9_\-]{6,25})/i)
  if (labelledMatch && labelledMatch[1]) {
    const candidate = labelledMatch[1].trim()
    if (/\d/.test(candidate) && !known.has(candidate)) return candidate
  }

  return null
}

/**
 * Pure parser for Flipkart support/ticket table rows.
 */
export function parseFlipkartTicketRow(
  rows: string[][],
  ticketId: string,
): { statusText: string; normalizedStatus?: string } | null {
  const wanted = (ticketId || "").trim().toLowerCase()
  if (!wanted) return null
  for (const cells of rows) {
    if (!cells.some((cell) => cell.toLowerCase().includes(wanted))) continue
    const statusText = cells.filter((cell) => !cell.toLowerCase().includes(wanted)).join(" | ")
    if (!statusText) return { statusText: ticketId }
    const lower = statusText.toLowerCase()
    let normalizedStatus: string | undefined
    if (/approved|accept|settled|refunded|paid/.test(lower)) normalizedStatus = "approved"
    else if (/reject|denied|declined|cancelled|canceled/.test(lower)) normalizedStatus = "rejected"
    else if (/under review|investigat|in progress|open|pending/.test(lower)) normalizedStatus = "under_review"
    return normalizedStatus ? { statusText, normalizedStatus } : { statusText }
  }
  return null
}

/**
 * JavaScript click script for the enabled Flipkart Submit/Confirm button.
 * Uses exact text or valid CSS selectors without invalid pseudo-classes.
 */
export function flipkartSubmitClickScript(): string {
  return `(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
    const match = candidates.find((el) => {
      const isInput = el instanceof HTMLInputElement;
      const text = (isInput ? el.value : (el.textContent || '')).trim().toLowerCase();
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
      const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
      const isSubmitText = text === 'submit' || text === 'submit claim' || text === 'raise claim' || text === 'apply spf' || text === 'confirm';
      return visible && !disabled && isSubmitText;
    });
    if (match) {
      match.scrollIntoView({ block: 'center' });
      match.click();
      return true;
    }
    return false;
  })()`
}

export class FlipkartAutomation extends BaseMarketplaceAutomation {
  readonly marketplaceName = "Flipkart"

  async execute(action: "prepare" | "submit"): Promise<MarketplaceAutomationResult> {
    const issueLabel = resolveFlipkartIssueLabel(this.job.claim.marketplaceIssueCode)
    if (!issueLabel) {
      return {
        success: false,
        stage: "manual_intervention_required",
        manualActionReason: `Claim issue "${this.job.claim.marketplaceIssueCode || "missing"}" has no verified Flipkart SPF category. An operator must review this claim manually.`,
      }
    }

    const portalUrl = resolvePortalLoginUrl("Flipkart", this.job.portalUrl || "https://seller.flipkart.com/index.html#dashboard/returns-v2")
    logger.info(`Starting Flipkart SPF automation for Job #${this.job.jobId} (Order: ${this.job.claim.orderNumber}, Action: ${action})...`)

    await this.browser.navigate(portalUrl)
    await this.delay(2000)

    // Check challenge (OTP / CAPTCHA)
    const challenge = await this.browser.detectCaptchaOrOtp()
    if (challenge.challengeDetected) {
      const shot = path.join(this.workDir, `challenge-flipkart-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(shot)
      return {
        success: false,
        stage: "manual_intervention_required",
        screenshotPath: shot,
        loginRequired: true,
        checkpoint: "login_required",
        manualActionReason: challenge.reason || "CAPTCHA or 2FA detected on Flipkart Seller Hub.",
      }
    }

    // Check session login state
    const currentUrl = await this.browser.evaluate<string>(`window.location.href`).catch(() => "")
    const bodyText = await this.browser.evaluate<string>(`document.body ? document.body.innerText : ''`).catch(() => "")
    const hasPassword = await this.browser.evaluate<boolean>(`Boolean(document.querySelector('input[type="password"]'))`).catch(() => false)
    const loggedIn = isPortalLoggedIn("Flipkart", currentUrl, bodyText, hasPassword)

    if (!loggedIn) {
      if (this.job.credentials.username && this.job.credentials.password) {
        logger.info("Attempting auto-fill of Flipkart seller credentials...")
        const userSelector = 'input[type="text"][name*="login" i], input[name="username" i], input[type="text"]'
        await this.humanType(userSelector, this.job.credentials.username)
        await this.humanType('input[type="password"]', this.job.credentials.password)
        await this.humanClick('button[type="submit"]')
        await this.delay(5000)
      } else {
        const shot = path.join(this.workDir, `login-needed-flipkart-${this.job.jobId}.png`)
        await this.browser.captureScreenshot(shot)
        return {
          success: false,
          stage: "manual_intervention_required",
          screenshotPath: shot,
          loginRequired: true,
          checkpoint: "login_required",
          manualActionReason: "Please sign in to Flipkart Seller Hub in the open browser window.",
        }
      }
    }

    await this.reportCheckpoint("portal_authenticated", "Signed in to Flipkart Seller Hub.")

    // Step 2: Navigate to Returns Dashboard & search order
    logger.info(`Searching for return order ${this.job.claim.orderNumber}...`)
    const searchSelector = 'input[placeholder*="Order" i], input[placeholder*="Tracking" i], input[placeholder*="Return" i], input[type="search"]'
    const hasSearch = await this.waitForSelector(searchSelector, 10000)
    if (hasSearch) {
      await this.humanType(searchSelector, this.job.claim.orderNumber)
      await this.delay(1000)
      // Press Enter or click search button
      await this.browser.evaluate(`
        (() => {
          const inp = document.querySelector(${JSON.stringify(searchSelector)});
          if (inp) {
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
          }
          const btn = Array.from(document.querySelectorAll('button')).find(b => /search|find/i.test(b.textContent || ''));
          if (btn) btn.click();
        })()
      `)
      await this.delay(2500)
    }

    // Step 3: Check eligibility / early blockers
    const pageText = await this.browser.evaluate<string>(`document.body ? document.body.innerText : ''`).catch(() => "")
    const blocker = detectFlipkartEarlyBlocker(pageText)
    if (blocker) {
      const shot = path.join(this.workDir, `not-eligible-flipkart-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(shot)
      logger.warn(`Flipkart says return is not eligible: ${blocker}`)
      return {
        success: false,
        stage: "not_eligible",
        screenshotPath: shot,
        manualActionReason: `Not eligible on Flipkart SPF: ${blocker}`,
      }
    }

    // Step 4: Click "Raise SPF Claim" / "Apply SPF" / "File Claim"
    logger.info("Looking for 'Raise SPF Claim' button...")
    let spfFormOpen = await this.browser.evaluate<boolean>(`
      (() => {
        const triggers = Array.from(document.querySelectorAll('button, a, [role="button"]'))
          .filter(el => {
            const t = (el.textContent || '').trim().toLowerCase();
            return t.includes('raise spf') || t.includes('apply spf') || t.includes('file claim') || t.includes('claim spf');
          });
        const visible = triggers.find(el => el.getBoundingClientRect().width > 0);
        if (visible) {
          visible.click();
          return true;
        }
        return false;
      })()
    `).catch(() => false)

    if (spfFormOpen) {
      await this.delay(2000)
    }

    await this.reportCheckpoint("category_opened", `Opened Flipkart SPF claim section. Category: ${issueLabel}`)

    // Step 5: Fill description and select reason
    const description = this.job.claim.claimDescription ||
      `Team,\n\nOrder ID: ${this.job.claim.orderNumber}\nAWB: ${this.job.claim.trackingId || "NA"}\n` +
      `Issue: ${issueLabel}\nPackage received in damaged/tampered condition with mismatched contents. ` +
      `Please approve SPF claim compensation.\n\nRegards,\nReturn Team`

    const descSelector = 'textarea, input[name*="description" i], input[placeholder*="remarks" i]'
    const hasDesc = await this.waitForSelector(descSelector, 5000)
    if (hasDesc) {
      await this.humanType(descSelector, description)
      await this.delay(500)
    }

    // Step 6: Evidence upload
    const allFiles = Array.from(this.evidenceFilesMap.values()).flat()
    const imageFiles = allFiles.filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    const videoFiles = allFiles.filter((f) => /\.(mp4|webm|mov)$/i.test(f))

    const fileInputs = await this.browser.evaluate<string[]>(`
      Array.from(document.querySelectorAll('input[type="file"]')).map(el => el.id || el.name || 'file-input')
    `).catch(() => [])

    if (fileInputs.length > 0 && allFiles.length > 0) {
      logger.info(`Attaching evidence to ${fileInputs.length} Flipkart upload boxes...`)
      for (const inputKey of fileInputs) {
        const selector = inputKey.startsWith("#") ? inputKey : `input[type="file"]`
        const field = resolveFlipkartUploadField(inputKey)
        const chosen = field === "unboxing_video"
          ? (this.evidenceFilesMap.get("unboxing_video") || videoFiles)
          : field === "label_image"
            ? (this.evidenceFilesMap.get("reverse_waybill") || imageFiles)
            : (this.evidenceFilesMap.get("product_images") || imageFiles)

        if (chosen.length > 0) {
          await this.uploadFiles(selector, chosen)
          await this.delay(1000)
        }
      }
    }

    await this.reportCheckpoint("details_filled", "Filled Flipkart SPF claim details and evidence.")

    // Step 7: Capture Prepared Screenshot
    const prepScreenshot = path.join(this.workDir, `prepared-flipkart-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(prepScreenshot)

    if (action === "prepare" && this.job.requireApprovalBeforeSubmit) {
      logger.info(`Flipkart SPF claim prepared for Job #${this.job.jobId}. Awaiting operator review.`)
      return {
        success: true,
        stage: "prepared",
        screenshotPath: prepScreenshot,
        checkpoint: "details_filled",
      }
    }

    // Step 8: Submission
    logger.info(`Submitting Flipkart SPF claim (Job #${this.job.jobId})...`)
    const submitted = await this.browser.evaluate<boolean>(flipkartSubmitClickScript()).catch(() => false)
    await this.delay(3000)

    const confScreenshot = path.join(this.workDir, `submitted-flipkart-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(confScreenshot)

    const postUrl = await this.browser.evaluate<string>(`window.location.href`).catch(() => "")
    const postText = await this.browser.evaluate<string>(`document.body ? document.body.innerText : ''`).catch(() => "")
    const incidentId = extractFlipkartIncidentId(postUrl, postText, this.job.claim.orderNumber)

    if (incidentId) {
      logger.info(`Flipkart SPF claim successfully submitted! Incident ID: ${incidentId}`)
      await this.reportCheckpoint("ticket_extracted", `Incident raised: ${incidentId}`)
      return {
        success: true,
        stage: "completed",
        marketplaceClaimId: incidentId,
        screenshotPath: confScreenshot,
        checkpoint: "ticket_extracted",
      }
    }

    // If no verified ticket ID was extracted, require operator review to confirm
    return {
      success: false,
      stage: "manual_intervention_required",
      screenshotPath: confScreenshot,
      checkpoint: "ticket_id_missing",
      manualActionReason: "Flipkart SPF claim submitted or prepared, but Incident ID could not be automatically confirmed. Please check the open browser window to verify or complete.",
    }
  }

  async checkClaimStatus(_marketplaceClaimId: string): Promise<ClaimStatusCheckResult> {
    return {
      supported: false,
      reason: `Automated ticket status check is not implemented for ${this.marketplaceName} yet (live verification pending).`,
    }
  }
}
