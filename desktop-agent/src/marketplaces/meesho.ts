import path from "node:path"
import { BaseMarketplaceAutomation, type ClaimStatusCheckResult, type MarketplaceAutomationResult } from "./base-automation.js"
import { completePortalLogin } from "../portal-login.js"
import { logger } from "../logger.js"

/**
 * Portal issue labels behind the Meesho "Raise a Ticket" categories.
 * Authority is server/meesho-claims.ts MEESHO_ISSUES. The desktop never invents
 * a label: an unmapped claim issue code stops for human review instead of
 * silently substituting a wrong-return claim.
 */
export const MEESHO_PORTAL_ISSUE_LABELS: Record<string, string> = {
  wrong_return: "I have received wrong return",
  missing_items: "Item/s are missing in my return",
  wrong_barcode_rto: "I have received a wrong barcoded package in RTO",
  damaged_return: "I have received damaged return",
  used_product: "I have received used product as return",
}

/** Portal category for a claim issue code, or null when no verified mapping exists. */
export function resolveMeeshoIssueLabel(issueCode: string): string | null {
  return MEESHO_PORTAL_ISSUE_LABELS[(issueCode || "").trim()] ?? null
}

/**
 * Portal "State of the packet" choice for a verified shipment condition, or null
 * when the condition is missing or unverified (Intact/Tampered only; never infer).
 */
export function resolveMeeshoPacketLabel(packetState: string): "Intact" | "Tampered" | null {
  const norm = (packetState || "").trim().toLowerCase()
  if (norm === "intact") return "Intact"
  if (norm === "tampered") return "Tampered"
  return null
}

/**
 * Matches one row of the Meesho Support ticket table against a ticket reference.
 * Pure: takes table rows as cell arrays so fixtures can test it without a browser.
 * Returns the row's non-reference cells as the portal status text, plus a
 * normalized hint only for unambiguous paid/rejected/approved wording. The server
 * normalizes everything else; nothing is inferred when the row is absent.
 */
export function parseMeeshoTicketRow(
  rows: string[][],
  ticketId: string,
): { statusText: string; normalizedStatus?: string } | null {
  const wanted = (ticketId || "").trim()
  if (!wanted) return null
  for (const cells of rows) {
    if (!cells.some((cell) => cell.includes(wanted))) continue
    const statusText = cells.filter((cell) => !cell.includes(wanted)).join(" | ")
    if (!statusText) return { statusText: wanted }
    const lowered = statusText.toLowerCase()
    let normalizedStatus: string | undefined
    if (/paid|settled|credited/.test(lowered)) normalizedStatus = "paid"
    else if (/reject|denied|declined|cancelled|canceled/.test(lowered)) normalizedStatus = "rejected"
    else if (/approv|accept|resolv|completed/.test(lowered)) normalizedStatus = "approved"
    return normalizedStatus ? { statusText, normalizedStatus } : { statusText }
  }
  return null
}

export class MeeshoAutomation extends BaseMarketplaceAutomation {
  readonly marketplaceName = "Meesho"

  async execute(action: "prepare" | "submit"): Promise<MarketplaceAutomationResult> {
    // Fail fast: never substitute a wrong-return claim and never infer the parcel condition.
    const issueLabel = resolveMeeshoIssueLabel(this.job.claim.marketplaceIssueCode)
    if (!issueLabel) {
      return {
        success: false,
        stage: "manual_intervention_required",
        manualActionReason: `Claim issue "${this.job.claim.marketplaceIssueCode || "missing"}" has no verified Meesho portal category. An operator must pick the category by hand; the bot will not substitute a wrong-return claim.`,
      }
    }
    const packetState = resolveMeeshoPacketLabel(this.job.claim.packetState)
    if (!packetState) {
      return {
        success: false,
        stage: "manual_intervention_required",
        manualActionReason: `Parcel condition is "${this.job.claim.packetState || "unknown"}", not a verified Intact/Tampered observation. An operator must confirm the shipment condition before Meesho filing.`,
      }
    }
    const portalLoginUrl = this.job.portalUrl || "https://supplier.meesho.com/panel/v3/new/root/login"
    logger.info(`Starting Meesho claim automation for Job #${this.job.jobId} (Sub-Order: ${this.job.claim.subOrderId}, Action: ${action})...`)

    const login = await completePortalLogin(this.browser, {
      marketplace: "Meesho",
      portalUrl: portalLoginUrl,
      username: this.job.credentials.username,
      password: this.job.credentials.password,
    })
    if (!login.ok) {
      const loginScreenshot = path.join(this.workDir, `login-required-job-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(loginScreenshot)
      return {
        success: false,
        stage: "manual_intervention_required",
        screenshotPath: loginScreenshot,
        manualActionReason: login.message,
      }
    }

    logger.info("Opening the Meesho Support page for this seller...")
    const panelUrl = await this.browser.evaluate<string>(`window.location.href`)
    const slug = panelUrl.match(/\/(?:growth|experience)\/([^/]+)/)?.[1]
    if (!slug) {
      const blockedScreenshot = path.join(this.workDir, `support-missing-job-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(blockedScreenshot)
      return {
        success: false,
        stage: "manual_intervention_required",
        screenshotPath: blockedScreenshot,
        manualActionReason: "Meesho is signed in, but the seller panel address was not found. Open Support in the browser, then run this claim again.",
      }
    }
    const supportUrl = `https://supplier.meesho.com/panel/v3/new/experience/${slug}/support`
    await this.browser.navigate(supportUrl)
    await this.waitForContent()
    const ticketsBefore = await this.readRecentTicketIds(15000)
    logger.info(`Meesho shows ${ticketsBefore.length} recent tickets before this claim.`)

    logger.info("Selecting issue category: `${issueLabel}`...")
    let openedIssue = false
    const issueOpen = async () => {
      const href = await this.browser.evaluate<string>(`window.location.href`)
      const raiseVisible = await this.browser.evaluate<boolean>(
        `Array.from(document.querySelectorAll('button, a, div, span')).some((el) => (el.textContent || '').trim() === 'Raise a Ticket' && el.getBoundingClientRect().width > 0)`,
      )
      return href.includes("/support/1/") || Boolean(raiseVisible)
    }
    for (let attempt = 0; attempt < 6 && !openedIssue; attempt++) {
      if (attempt % 2 === 0) {
        await this.browser.clickVisibleLabel(issueLabel)
      } else {
        const dom = await this.browser.clickLabelInDom(issueLabel)
        await this.delay(1500)
        if (dom.href && !(await issueOpen())) {
          await this.browser.navigate(dom.href)
          await this.waitForContent()
        }
      }
      await this.delay(2000)
      openedIssue = await issueOpen()
    }
    if (!openedIssue) {
      const href = await this.browser.evaluate<string>(`window.location.href`)
      return {
        success: false,
        stage: "manual_intervention_required",
        manualActionReason: `The Meesho issue page for "${issueLabel}" did not open (page: ${href}). An operator must navigate to the right category by hand.`,
      }
    }

    logger.info("Clicking 'Raise a Ticket'...")
    let openedForm = false
    for (let attempt = 0; attempt < 6 && !openedForm; attempt++) {
      if (attempt % 2 === 0) {
        await this.browser.clickVisibleLabel("Raise a Ticket")
      } else {
        await this.browser.clickLabelInDom("Raise a Ticket")
      }
      await this.delay(2000)
      openedForm = await this.browser.evaluate<boolean>(`Boolean(document.querySelector('input[placeholder="Sub Order Number"]'))`)
    }
    if (!openedForm) {
      return {
        success: false,
        stage: "manual_intervention_required",
        manualActionReason: "The Meesho Raise a Ticket form did not open. An operator must open it in the browser window, then run this claim again.",
      }
    }

    // Step 6: Fill the Claim Form
    const subOrderId = this.job.claim.subOrderId || this.job.claim.orderNumber
    logger.info(`Filling claim details for Sub-Order: ${subOrderId}...`)

    // Sub-order ID / Order ID input
    const subOrderInputSelector = 'input[placeholder="Sub Order Number"]'
    const hasSubOrderInput = await this.waitForSelector(subOrderInputSelector, 12000)
    if (!hasSubOrderInput) {
      const blockedScreenshot = path.join(this.workDir, `login-required-job-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(blockedScreenshot)
      return {
        success: false,
        stage: "manual_intervention_required",
        screenshotPath: blockedScreenshot,
        manualActionReason: "Meesho claim form is not open. Finish the supplier login in the browser window, then run this claim again.",
      }
    }

    await this.humanType(subOrderInputSelector, subOrderId)
    await this.delay(1000)

    if (this.job.claim.trackingId) {
      const hasAwb = await this.browser.evaluate<boolean>(`Boolean(document.querySelector('input[placeholder="AWB Number"]'))`)
      if (hasAwb) {
        await this.humanType('input[placeholder="AWB Number"]', this.job.claim.trackingId)
        await this.delay(1000)
      }
    }
    if (this.job.claim.packetId) {
      const hasPacket = await this.browser.evaluate<boolean>(`Boolean(document.querySelector('input[placeholder="Packet ID"]'))`)
      if (hasPacket) {
        await this.humanType('input[placeholder="Packet ID"]', this.job.claim.packetId)
        await this.delay(1000)
      }
    }

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

    // Meesho checks the AWB against its packaging policy and shows "not eligible" under the field. Such an order is
    // never claimed: it is kept for manual review and the bot moves on.
    const ineligible = await this.readIneligibleMessage()
    if (ineligible) {
      const shot = path.join(this.workDir, `not-eligible-job-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(shot)
      logger.warn(`Meesho says this order is not eligible for a claim: ${ineligible}`)
      return {
        success: false,
        stage: "not_eligible",
        screenshotPath: shot,
        manualActionReason: `Not eligible on Meesho: ${ineligible.slice(0, 400)}`,
      }
    }

    // Packet condition: Meesho uses a listbox dropdown labelled "State of the packet". packetState is the verified claim condition (fail-fast above).
    let packetSelected = false
    for (let attempt = 0; attempt < 3 && !packetSelected; attempt++) {
      packetSelected = await this.browser.evaluate<boolean>(`
        (async () => {
          const wanted = ${JSON.stringify(packetState)}.toLowerCase();
          const label = Array.from(document.querySelectorAll('label')).find((el) => /state of the packet/i.test(el.textContent || ''));
          const button = label && label.parentElement && label.parentElement.querySelector('button[aria-haspopup="listbox"]');
          if (!button) return false;
          if ((button.textContent || '').trim().toLowerCase() === wanted) return true;
          button.scrollIntoView({ block: 'center' });
          if (button.getAttribute('aria-expanded') !== 'true') button.click();
          await new Promise((resolve) => setTimeout(resolve, 700));
          const option = Array.from(document.querySelectorAll('[role="option"], li'))
            .find((el) => (el.textContent || '').trim().toLowerCase() === wanted);
          if (!option) return false;
          option.click();
          await new Promise((resolve) => setTimeout(resolve, 500));
          return (button.textContent || '').trim().toLowerCase() === wanted;
        })()
      `)
      if (!packetSelected) await this.delay(1000)
    }
    if (packetSelected) {
      logger.info(`Selected packet state: ${packetState}.`)
    } else {
      logger.warn(`Could not select packet state '${packetState}' on the Meesho form.`)
    }

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
    const allFiles = Array.from(this.evidenceFilesMap.values()).flat()
    if (!allFiles.length) {
      const shot = path.join(this.workDir, `no-evidence-job-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(shot)
      return {
        success: false,
        stage: "manual_intervention_required",
        screenshotPath: shot,
        manualActionReason: "No evidence files were downloaded for this claim. Nothing was filed on Meesho; re-run after the evidence syncs.",
      }
    }
    const imageFiles = allFiles.filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    const videoFiles = allFiles.filter((f) => /\.(mp4|webm|mov)$/i.test(f))
    const inputIds = await this.browser.evaluate<string[]>(`Array.from(document.querySelectorAll('input[type="file"]')).map((el) => el.id).filter(Boolean)`)
    const attachedFiles = new Set<string>()
    logger.info(`Attaching evidence to ${inputIds.length} Meesho upload boxes.`)
    for (let index = 0; index < inputIds.length; index++) {
      const id = inputIds[index].toLowerCase()
      const chosen = id.includes("video")
        ? (this.evidenceFilesMap.get("unboxing_video") || videoFiles)
        : id.includes("waybill") || id.includes("reverse")
          ? (this.evidenceFilesMap.get("reverse_waybill") || imageFiles.filter((file) => file.toLowerCase().includes("waybill")))
          : id.includes("product")
            ? (this.evidenceFilesMap.get("product_images") || imageFiles.filter((file) => file.toLowerCase().includes("product")))
            : id.includes("barcode")
              ? (this.evidenceFilesMap.get("barcode_image") || imageFiles.filter((file) => file.toLowerCase().includes("barcode")))
              : imageFiles.filter((file) => !attachedFiles.has(file)).slice(0, 1)
      if (!chosen.length) continue
      const attached = await this.uploadFiles(`#${inputIds[index]}`, chosen)
      if (attached) chosen.forEach((file) => attachedFiles.add(file))
      logger.info(`${attached ? "Attached" : "Could not attach"} ${chosen.length} file(s) to ${inputIds[index]}.`)
      await this.delay(1000)
    }

    // Description text
    const description = this.job.claim.claimDescription || this.job.claim.claimContent || this.job.claim.remarks
    if (description) {
      const descReady = await this.browser.evaluate<boolean>(`
        (() => {
          const areas = Array.from(document.querySelectorAll('textarea'));
          const target = areas[areas.length - 1];
          if (!target) return false;
          target.id = 'return-claim-description';
          return true;
        })()
      `)
      if (descReady) {
        logger.info("Entering claim description...")
        await this.humanType("#return-claim-description", description)
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
    const submitDisabledJs = `Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === 'Submit' && b.disabled)`
    const waitStarted = Date.now()
    while ((await this.browser.evaluate<boolean>(submitDisabledJs)) && Date.now() - waitStarted < 20000) {
      await this.delay(1000)
    }
    if (await this.browser.evaluate<boolean>(submitDisabledJs)) {
      const emptyFields = await this.browser.evaluate<string[]>(`
        Array.from(document.querySelectorAll('input[type="text"], textarea'))
          .filter((el) => !el.value)
          .map((el) => el.placeholder || el.id || el.tagName.toLowerCase())
      `)
      const fieldErrors = await this.browser.evaluate<string[]>(`
        Array.from(document.querySelectorAll('*'))
          .filter((el) => el.childElementCount === 0 && el.getBoundingClientRect().width > 0)
          .filter((el) => /error/i.test(String(el.className || '')) || /not eligible|invalid|is required/i.test(el.textContent || ''))
          .map((el) => (el.textContent || '').trim().replace(/\\s+/g, ' '))
          .filter((text) => text.length > 8)
          .slice(0, 3)
      `)
      const disabledShot = path.join(this.workDir, `submit-disabled-job-${this.job.jobId}.png`)
      await this.browser.captureScreenshot(disabledShot)
      const meeshoSays = (fieldErrors || []).join(" | ")
      logger.warn(`Meesho kept Submit disabled. ${meeshoSays ? `Meesho says: ${meeshoSays}` : `Empty fields: ${(emptyFields || []).join(", ") || "none found"}`}`)
      if (/not eligible/i.test(meeshoSays)) {
        return {
          success: false,
          stage: "not_eligible",
          screenshotPath: disabledShot,
          manualActionReason: `Not eligible on Meesho: ${meeshoSays.slice(0, 400)}`,
        }
      }
      return {
        success: false,
        stage: "manual_intervention_required",
        screenshotPath: disabledShot,
        manualActionReason: meeshoSays
          ? `Meesho blocked this claim: ${meeshoSays.slice(0, 400)}`
          : `Meesho kept Submit disabled. Empty fields: ${(emptyFields || []).join(", ") || "check the uploads"}. Finish the form in the open browser.`,
      }
    }

    logger.info(`Submitting Meesho ticket (Job #${this.job.jobId})...`)
    const submitted = await this.browser.clickVisibleLabel("Submit")

    if (!submitted) {
      const clickedFallback = await this.humanClick('button[type="submit"]')
      if (!clickedFallback) {
        return {
          success: false,
          stage: "manual_intervention_required",
          screenshotPath: prepScreenshot,
          manualActionReason: "Meesho did not submit the claim. Finish the form in the open browser, then run this claim again.",
        }
      }
    }

    await this.delay(4000)

    const confScreenshot = path.join(this.workDir, `submitted-meesho-job-${this.job.jobId}.png`)
    await this.browser.captureScreenshot(confScreenshot)

    const formErrors = await this.browser.evaluate<string[]>(`
      Array.from(document.querySelectorAll('*'))
        .filter((el) => el.childElementCount === 0 && el.getBoundingClientRect().width > 0)
        .map((el) => (el.textContent || '').trim())
        .filter((text) => text.length > 8 && text.length < 140 && /required|invalid|please|error|failed|exceed|limit/i.test(text))
        .slice(0, 8)
    `)
    if (formErrors.length) logger.warn(`Meesho form messages after Submit: ${formErrors.join(" | ")}`)

    // A ticket counts only when Meesho shows a new numeric ticket ID that was not listed before this claim.
    const known = new Set(ticketsBefore)
    for (const value of [this.job.claim.subOrderId, this.job.claim.orderNumber, this.job.claim.trackingId, this.job.claim.packetId]) {
      for (const digits of String(value || "").match(/\d{9,15}/g) || []) known.add(digits)
    }
    let extractedTicketId = ""
    const started = Date.now()
    while (!extractedTicketId && Date.now() - started < 12000) {
      const shown = await this.browser.evaluate<string[]>(`
        Array.from(((document.body && document.body.innerText) || '').matchAll(/ticket[^0-9]{0,40}(\\d{9,15})\\b/gi)).map((m) => m[1])
      `)
      extractedTicketId = (shown || []).find((id) => !known.has(id)) || ""
      if (!extractedTicketId) await this.delay(1500)
    }
    const formStillOpen = await this.browser.evaluate<boolean>(`Boolean(document.querySelector('input[placeholder="Sub Order Number"]'))`)
    if (formErrors.length && formStillOpen) {
      return {
        success: false,
        stage: "manual_intervention_required",
        screenshotPath: confScreenshot,
        manualActionReason: `Meesho kept the claim form open with errors: ${formErrors.slice(0, 3).join(" | ").slice(0, 400)}`,
      }
    }
    if (!extractedTicketId && !formStillOpen && ticketsBefore.length) {
      await this.browser.navigate(supportUrl)
      await this.waitForContent()
      const after = await this.readRecentTicketIds(20000)
      extractedTicketId = after.find((id) => !known.has(id)) || ""
    }

    if (!extractedTicketId) {
      return {
        success: false,
        stage: "manual_intervention_required",
        screenshotPath: confScreenshot,
        manualActionReason: formErrors.length
          ? `Meesho did not raise the ticket: ${formErrors.slice(0, 3).join(" | ")}`
          : "Meesho did not show a new ticket after Submit. Check the open browser, then run this claim again.",
      }
    }

    logger.info(`Meesho claim submitted. Ticket ID: ${extractedTicketId}`)

    return {
      success: true,
      stage: "completed",
      marketplaceClaimId: extractedTicketId,
      screenshotPath: confScreenshot,
    }
  }

  /** Meesho's "not eligible" message under a form field, waiting briefly for its AWB check. Empty when there is none. */
  private async readIneligibleMessage(): Promise<string> {
    const started = Date.now()
    while (Date.now() - started < 5000) {
      const message = await this.browser.evaluate<string>(`
        (() => {
          const isErrorStyled = (el) => {
            if (/error/i.test(String(el.className || '')) || /error/i.test(String((el.parentElement && el.parentElement.className) || ''))) return true;
            const m = getComputedStyle(el).color.match(/\\d+/g);
            return Boolean(m && Number(m[0]) > 170 && Number(m[1]) < 110 && Number(m[2]) < 110);
          };
          const hit = Array.from(document.querySelectorAll('*'))
            .filter((el) => el.childElementCount === 0 && el.getBoundingClientRect().width > 0)
            .find((el) => /not eligible/i.test(el.textContent || '') && (el.textContent || '').length < 600 && isErrorStyled(el));
          return hit ? (hit.textContent || '').trim().replace(/\\s+/g, ' ') : '';
        })()
      `)
      if (message) return message
      await this.delay(1000)
    }
    return ""
  }

  /**
   * Reads a filed ticket state from the Meesho Support ticket table.
   * Live-portal verification is still pending: the reader is DOM-driven, returns
   * the raw portal text, and infers nothing when the row is absent.
   */
  async checkClaimStatus(marketplaceClaimId: string): Promise<ClaimStatusCheckResult> {
    const ticketId = (marketplaceClaimId || "").trim()
    if (!ticketId) return { supported: true, statusText: "", note: "Empty marketplace ticket reference; nothing to read." }
    try {
      const panelUrl = await this.browser.evaluate<string>(`window.location.href`)
      const slug = panelUrl.match(/\/(?:growth|experience)\/([^/]+)/)?.[1]
        || this.job.portalUrl.match(/\/(?:growth|experience)\/([^/]+)/)?.[1]
      if (!slug) {
        return { supported: true, statusText: "", note: "Meesho panel address not found; open the supplier panel first." }
      }
      await this.browser.navigate(`https://supplier.meesho.com/panel/v3/new/experience/${slug}/support`)
      await this.waitForContent()
      let parsed = await this.readTicketRow(ticketId)
      if (!parsed) {
        const myTickets = await this.browser.evaluate<boolean>(`
          (() => {
            const target = Array.from(document.querySelectorAll('a, button')).find((el) => /my tickets/i.test(el.textContent || ''));
            if (target && target.getBoundingClientRect().width > 0) { target.click(); return true; }
            return false;
          })()
        `)
        if (myTickets) {
          await this.delay(2500)
          parsed = await this.readTicketRow(ticketId)
        }
      }
      const safeId = ticketId.replace(/[^0-9a-z]+/gi, "")
      const shot = path.join(this.workDir, `ticket-status-${safeId}.png`)
      await this.browser.captureScreenshot(shot)
      if (!parsed) {
        return { supported: true, statusText: "", screenshotPath: shot, note: `Ticket ${ticketId} was not found on the Meesho Support page.` }
      }
      return { supported: true, statusText: parsed.statusText, normalizedStatus: parsed.normalizedStatus, screenshotPath: shot, note: `Ticket ${ticketId} read from the Meesho Support page.` }
    } catch (error) {
      return { supported: true, statusText: "", note: `Ticket read failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) }
    }
  }

  private async readTicketRow(ticketId: string): Promise<{ statusText: string; normalizedStatus?: string } | null> {
    const rows = await this.browser.evaluate<string[][]>(`
      Array.from(document.querySelectorAll("tr")).map((tr) =>
        Array.from(tr.querySelectorAll('td, th')).map((cell) => (cell.textContent || '').trim()).filter(Boolean),
      ).filter((cells) => cells.length > 1)
    `)
    return parseMeeshoTicketRow(rows || [], ticketId)
  }

  /** Reads the numeric ticket IDs in Meesho's "Recently raised tickets" table on the Support page. */
  private async readRecentTicketIds(timeoutMs: number): Promise<string[]> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const ids = await this.browser.evaluate<string[]>(`
        Array.from(document.querySelectorAll('tr td'))
          .map((td) => (td.textContent || '').trim())
          .filter((text) => /^\\d{9,15}$/.test(text))
      `)
      if (ids && ids.length) return ids
      await this.delay(1000)
    }
    return []
  }
}