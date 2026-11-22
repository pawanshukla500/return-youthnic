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
 * Myntra SPF (Seller Protection Fund) issue reason mapping.
 * Verified categories for PPMP (VB Export) and Ethnic Junction.
 */
export const MYNTRA_SPF_ISSUE_LABELS: Record<string, string> = {
  wrong_return: "Wrong Customer Return",
  missing_items: "Missing Item / Components",
  wrong_barcode_rto: "Wrong-Barcoded RTO",
  non_barcode_rto: "Non-Barcoded RTO",
  damaged_return: "Damaged Return",
  used_product: "Used Product / Tag Loop Broken",
}

export function resolveMyntraIssueLabel(issueCode: string): string | null {
  return MYNTRA_SPF_ISSUE_LABELS[(issueCode || "").trim()] ?? null
}

export type MyntraUploadField = "label_image" | "outer_package" | "tag_loop" | "product_image" | "unboxing_video" | "attachment"

export function resolveMyntraUploadField(inputIdOrLabel: string): MyntraUploadField | null {
  const norm = (inputIdOrLabel || "").toLowerCase()
  if (!norm) return null
  if (norm.includes("video") || norm.includes("unboxing") || norm.includes("opening")) {
    return "unboxing_video"
  }
  if (norm.includes("tag") || norm.includes("loop") || norm.includes("vms") || norm.includes("brand_tag")) {
    return "tag_loop"
  }
  if (norm.includes("label") || norm.includes("awb") || norm.includes("waybill") || norm.includes("shipping")) {
    return "label_image"
  }
  if (norm.includes("outer") || norm.includes("bag") || norm.includes("package") || norm.includes("packaging")) {
    return "outer_package"
  }
  if (norm.includes("product") || norm.includes("item") || norm.includes("sku")) {
    return "product_image"
  }
  if (norm.includes("attach") || norm.includes("proof") || norm.includes("document") || norm.includes("file")) {
    return "attachment"
  }
  return null
}

const MYNTRA_EARLY_BLOCKERS = [
  "spf claim already filed",
  "claim already raised",
  "already filed a claim",
  "return not delivered to seller",
  "in transit",
  "tat window expired",
  "claim window closed",
  "not eligible for spf",
]

export function detectMyntraEarlyBlocker(text: string): string | null {
  const raw = (text || "").trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  for (const phrase of MYNTRA_EARLY_BLOCKERS) {
    if (lower.includes(phrase)) {
      return raw.replace(/\s+/g, " ").slice(0, 400)
    }
  }
  return null
}

/**
 * Pure helper to extract Myntra Ticket / SPF Claim ID from confirmation text or URL.
 * Excludes known order number and AWB digits to prevent false matches.
 */
export function extractMyntraTicketId(url: string, text: string, orderNumber: string): string | null {
  const known = new Set<string>()
  for (const digits of String(orderNumber || "").match(/\d{8,16}/g) || []) {
    known.add(digits)
  }

  // Common Myntra patterns: MYN-SPF-123456, SPF-123456, TKT-12345678, or INC1234567
  const codeMatch =
    text.match(/\b(MYN[-_]?SPF[-_]?\d{6,14}|SPF[-_]?\d{6,14}|TKT[-_]?\d{6,14}|INC\d{6,14})\b/i) ||
    url.match(/\b(MYN[-_]?SPF[-_]?\d{6,14}|SPF[-_]?\d{6,14}|TKT[-_]?\d{6,14}|INC\d{6,14})\b/i)
  if (codeMatch && codeMatch[1]) {
    return codeMatch[1].toUpperCase()
  }

  // Explicit label: Ticket ID: 12345678 or Claim Number: 12345678
  const labelledMatch =
    text.match(/(?:ticket|claim|incident)\s*(?:id|number|#)?\s*[:\-#]\s*([A-Z0-9_\-]{6,25})/i) ||
    text.match(/(?:ticket|claim)\s+(?:id|number|#)\s+([A-Z0-9_\-]{6,25})/i)
  if (labelledMatch && labelledMatch[1]) {
    const candidate = labelledMatch[1].trim()
    if (/\d/.test(candidate) && !known.has(candidate)) return candidate
  }

  return null
}

/**
 * Pure parser for Myntra support/ticket table rows.
 */
export function parseMyntraTicketRow(
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
    if (/approved|accept|settled|refunded|paid|credit/.test(lower)) normalizedStatus = "approved"
    else if (/reject|denied|declined|cancelled|canceled/.test(lower)) normalizedStatus = "rejected"
    else if (/under review|investigat|in progress|open|pending/.test(lower)) normalizedStatus = "under_review"
    return normalizedStatus ? { statusText, normalizedStatus } : { statusText }
  }
  return null
}

/**
 * JavaScript click script for enabled Myntra Submit/Confirm button.
 */
export function myntraSubmitClickScript(): string {
  return `(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
    const match = candidates.find((el) => {
      const isInput = el instanceof HTMLInputElement;
      const text = (isInput ? el.value : (el.textContent || '')).trim().toLowerCase();
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
      const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
      const isSubmitText = text === 'submit' || text === 'submit claim' || text === 'raise claim' || text === 'confirm' || text === 'file spf';
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

export class MyntraAutomation extends BaseMarketplaceAutomation {
  readonly marketplaceName: string

  constructor(
    browser: import("../browser-adapter.js").SupplierBrowserApi,
    job: import("../agent-client.js").JobExecutionBundle,
    evidenceFilesMap: Map<string, string[]> = new Map(),
    workDir: string = "",
  ) {
    super(browser, job, evidenceFilesMap, workDir)
    const isEj = (job.accountName || job.marketplace || "").toLowerCase().includes("ej")
    this.marketplaceName = isEj ? "Myntra EJ" : "Myntra VB"
  }

  async execute(action: "prepare" | "submit"): Promise<MarketplaceAutomationResult> {
    const issueLabel = resolveMyntraIssueLabel(this.job.claim.marketplaceIssueCode)
    if (!issueLabel) {
      return {
        success: false,
        stage: "manual_intervention_required",
        manualActionReason: `Claim issue "${this.job.claim.marketplaceIssueCode || "missing"}" has no verified Myntra portal category. An operator must review this claim manually.`,
      }
    }

    const defaultPortal = "https://partners.myntrainfo.com/returns"
    const portalUrl = resolvePortalLoginUrl(this.marketplaceName, this.job.portalUrl || defaultPortal)
    logger.info(`Starting ${this.marketplaceName} SPF automation for Job #${this.job.jobId} (Order: ${this.job.claim.orderNumber}, Action: ${action})...`)

    await this.browser.navigate(portalUrl)
    await this.delay(2000)

    // Check challenge (OTP / CAPTCHA)
    const challenge = await this.browser.detectCaptchaOrOtp()
    if (challenge.challengeDetected) {
      const shot = path.join(this.workDir, `challenge-myntra-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(shot)
      return {
        success: false,
        stage: "manual_intervention_required",
        screenshotPath: shot,
        loginRequired: true,
        checkpoint: "login_required",
        manualActionReason: challenge.reason || `CAPTCHA or 2FA detected on ${this.marketplaceName} partner portal.`,
      }
    }

    // Check login state
    const currentUrl = await this.browser.evaluate<string>(`window.location.href`).catch(() => "")
    const bodyText = await this.browser.evaluate<string>(`document.body ? document.body.innerText : ''`).catch(() => "")
    const hasPassword = await this.browser.evaluate<boolean>(`Boolean(document.querySelector('input[type="password"]'))`).catch(() => false)
    const loggedIn = isPortalLoggedIn(this.marketplaceName, currentUrl, bodyText, hasPassword)

    if (!loggedIn) {
      if (this.job.credentials.username && this.job.credentials.password) {
        logger.info(`Attempting auto-fill of ${this.marketplaceName} credentials...`)
        const userSelector = 'input[type="text"][name*="email" i], input[type="text"][name*="user" i], input[name="username" i], input[type="text"]'
        await this.humanType(userSelector, this.job.credentials.username)
        await this.humanType('input[type="password"]', this.job.credentials.password)
        await this.humanClick('button[type="submit"]')
        await this.delay(5000)
      } else {
        const shot = path.join(this.workDir, `login-needed-myntra-${this.job.jobId}.png`)
        await this.browser.captureScreenshot(shot)
        return {
          success: false,
          stage: "manual_intervention_required",
          screenshotPath: shot,
          loginRequired: true,
          checkpoint: "login_required",
          manualActionReason: `Please sign in to ${this.marketplaceName} Partner Portal in the open browser window.`,
        }
      }
    }

    await this.reportCheckpoint("portal_authenticated", `Signed in to ${this.marketplaceName} Partner Portal.`)

    // Step 2: Search for Return / Order
    logger.info(`Searching for Myntra return order ${this.job.claim.orderNumber}...`)
    const searchSelector = 'input[placeholder*="Order" i], input[placeholder*="Return" i], input[placeholder*="Tracking" i], input[type="search"]'
    const hasSearch = await this.waitForSelector(searchSelector, 10000)
    if (hasSearch) {
      await this.humanType(searchSelector, this.job.claim.orderNumber)
      await this.delay(1000)
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
    const blocker = detectMyntraEarlyBlocker(pageText)
    if (blocker) {
      const shot = path.join(this.workDir, `not-eligible-myntra-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(shot)
      logger.warn(`Myntra says return is not eligible: ${blocker}`)
      return {
        success: false,
        stage: "not_eligible",
        screenshotPath: shot,
        manualActionReason: `Not eligible on Myntra SPF: ${blocker}`,
      }
    }

    // Step 4: Open SPF / Claim Form
    logger.info("Looking for 'Raise SPF Claim' / 'File Claim' button...")
    await this.browser.evaluate(`
      (() => {
        const triggers = Array.from(document.querySelectorAll('button, a, [role="button"]'))
          .filter(el => {
            const t = (el.textContent || '').trim().toLowerCase();
            return t.includes('raise spf') || t.includes('file claim') || t.includes('claim spf') || t.includes('apply spf');
          });
        const visible = triggers.find(el => el.getBoundingClientRect().width > 0);
        if (visible) visible.click();
      })()
    `).catch(() => false)
    await this.delay(2000)

    await this.reportCheckpoint("category_opened", `Opened Myntra SPF section. Reason: ${issueLabel}`)

    // Step 5: Fill description & details (include Tag Loop / VMS info)
    const tagInfo = this.job.claim.packetState ? `Tag Loop / Packet Condition: ${this.job.claim.packetState}` : "Tag Loop: Verified"
    const description = this.job.claim.claimDescription ||
      `Team,\n\nOrder ID: ${this.job.claim.orderNumber}\nReturn Tracking / AWB: ${this.job.claim.trackingId || "NA"}\n` +
      `Category: ${issueLabel}\n${tagInfo}\nReceived package has mismatched contents / condition. ` +
      `Please verify attached unboxing video and photos and approve SPF claim.\n\nRegards,\nReturn Team (${this.marketplaceName})`

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
      logger.info(`Attaching evidence to ${fileInputs.length} Myntra upload boxes...`)
      for (const inputKey of fileInputs) {
        const selector = inputKey.startsWith("#") ? inputKey : `input[type="file"]`
        const field = resolveMyntraUploadField(inputKey)
        const chosen = field === "unboxing_video"
          ? (this.evidenceFilesMap.get("unboxing_video") || videoFiles)
          : field === "tag_loop"
            ? (this.evidenceFilesMap.get("product_images") || imageFiles)
            : field === "label_image"
              ? (this.evidenceFilesMap.get("reverse_waybill") || imageFiles)
              : (this.evidenceFilesMap.get("product_images") || imageFiles)

        if (chosen.length > 0) {
          await this.uploadFiles(selector, chosen)
          await this.delay(1000)
        }
      }
    }

    await this.reportCheckpoint("details_filled", `Filled ${this.marketplaceName} SPF details and evidence.`)

    // Step 7: Capture Prepared Screenshot
    const prepScreenshot = path.join(this.workDir, `prepared-myntra-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(prepScreenshot)

    if (action === "prepare" && this.job.requireApprovalBeforeSubmit) {
      logger.info(`${this.marketplaceName} SPF claim prepared for Job #${this.job.jobId}. Awaiting operator review.`)
      return {
        success: true,
        stage: "prepared",
        screenshotPath: prepScreenshot,
        checkpoint: "details_filled",
      }
    }

    // Step 8: Submission
    logger.info(`Submitting ${this.marketplaceName} SPF claim (Job #${this.job.jobId})...`)
    const submitted = await this.browser.evaluate<boolean>(myntraSubmitClickScript()).catch(() => false)
    await this.delay(3000)

    const confScreenshot = path.join(this.workDir, `submitted-myntra-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(confScreenshot)

    const postUrl = await this.browser.evaluate<string>(`window.location.href`).catch(() => "")
    const postText = await this.browser.evaluate<string>(`document.body ? document.body.innerText : ''`).catch(() => "")
    const ticketId = extractMyntraTicketId(postUrl, postText, this.job.claim.orderNumber)

    if (ticketId) {
      logger.info(`${this.marketplaceName} SPF claim successfully submitted! Ticket ID: ${ticketId}`)
      await this.reportCheckpoint("ticket_extracted", `Ticket raised: ${ticketId}`)
      return {
        success: true,
        stage: "completed",
        marketplaceClaimId: ticketId,
        screenshotPath: confScreenshot,
        checkpoint: "ticket_extracted",
      }
    }

    return {
      success: false,
      stage: "manual_intervention_required",
      screenshotPath: confScreenshot,
      checkpoint: "ticket_id_missing",
      manualActionReason: `${this.marketplaceName} SPF claim submitted or prepared, but Ticket ID could not be automatically confirmed. Please check the open browser to verify or complete.`,
    }
  }

  async checkClaimStatus(_marketplaceClaimId: string): Promise<ClaimStatusCheckResult> {
    return {
      supported: false,
      reason: `Automated ticket status check is not implemented for ${this.marketplaceName} yet (live verification pending).`,
    }
  }
}
