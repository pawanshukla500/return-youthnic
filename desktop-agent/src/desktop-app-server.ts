import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import child_process from "node:child_process"
import { loadAgentConfig, saveAgentConfig, type AgentConfig } from "./config.js"
import { bearerTokenFromHeader, engineTokenMatches, localEngineUrl, resolveEngineBind, type EngineBind } from "./engine-config.js"
import { installCrashGuards } from "./crash-guard.js"
import { engineBusy as engineBusyWith, shouldRunPollCycle, supplierProfileInUse as supplierProfileInUseWith } from "./poll-guard.js"
import { agentDataDir } from "./paths.js"
import { logger } from "./logger.js"
import { AgentBackendClient } from "./agent-client.js"
import { BrowserRunner, findSystemBrowser } from "./browser-runner.js"
import { getAutomationEngine, isMarketplaceSupported } from "./marketplaces/registry.js"
import { currentOperator, loginOperator, logoutOperator } from "./operator-session.js"
import { closePortalLoginBrowser, holdPortalBrowser, listPortalLogins, PORTAL_CHANNELS, queueOneClaim, savePortalLogin, testPortalLogin } from "./portal-login.js"
import { hideSupplierViews, showSupplierView, supplierViewStatus } from "./native-browser-view.js"
import { clearPanelHold, getPanelStatuses, markPanelBusy, markPanelResult, panelKeyForMarketplace } from "./panel-queue.js"
import { localEncryptionAvailable } from "./local-secrets.js"
import { checkForUpdates } from "./update-check.js"
import { followUpExecutionBundle } from "./follow-up-bundle.js"
import { isSafeToSubmitBundle } from "./submit-guard.js"
import { describeBrowserAdapter, openSupplierBrowser, resolveBrowserAdapterKind } from "./browser-adapter.js"
import { profileDirFor, readSessionSavedAt, supplierSessionDir } from "./supplier-session.js"
import { aiUsageSnapshot, buildDiagnosticPrompt, decideFollowUpAssist, loadAiAssistConfig, providerFromConfig, requestAiProposal, validateAiProposal, type AssistanceContext } from "./ai-assistant.js"
import { findApprovedProcedure, isCacheStale, loadLocalMemory, markSynced, pruneLocalEvents, recordLocalEvent, saveLocalMemory, upsertCachedProcedure } from "./ai-memory-cache.js"
import type { CachedProcedure } from "./ai-memory-cache.js"
import type { OperatorTaskKind } from "./agent-client.js"
import { normalizeErrorSignature } from "../../server/ai-memory.js"
import { buildAiMemoryPayload, disableLocalProcedure } from "./ai-memory-panel.js"
import { nightlyFollowUpOnly, nightlyWindowStatus, shouldSkipFollowUpCycle } from "./follow-up-window.js"
import { runRoutedAssist } from "./ai-center-assist.js"
import { handleAiCenterRoute } from "./ai-center-routes.js"

/**
 * The engine owns exactly one worker loop. The Electron shell embeds this
 * module in-process and drives it through engineStart/enginePause/engineRunOnceNow;
 * a remote client drives the same state over the HTTP routes below. There is no
 * second copy of the loop anywhere.
 */
let engineBind: EngineBind | null = null

let config: AgentConfig = loadAgentConfig()
let client = new AgentBackendClient(config)

let isWorkerRunning = false
let isCurrentlyProcessing = false
/**
 * A poll cycle is in flight (from pollJob() through job completion).
 *
 * This is separate from isCurrentlyProcessing, which is only set *after*
 * pollJob() returns a job. Without this lock two overlapping cycles could both
 * see an empty queue, both lease a job, and launch two supplier browsers at
 * once. It is released in a finally block so a thrown error cannot wedge it.
 */
let pollInFlight = false
/**
 * A supplier login test is open.
 *
 * A login test pauses the poller and drives the supplier profile itself, so it
 * sets neither isCurrentlyProcessing nor pollInFlight. Without this flag two
 * concurrent tests would both pass the busy check and then fight over the same
 * browser profile and debug port.
 */
let portalTestInFlight = false
/**
 * A follow-up ticket check is open.
 *
 * The check opens the same supplier profile the filing worker uses, so the two
 * must never overlap. Poll cycles and the routes that would start a supplier
 * browser test this through poll-guard.ts.
 */
let followUpInFlight = false
let activeJobInfo: any = null
let lastHeartbeatTime: string = ""
let lastPollTime: string = ""
let nextPollCountdown = config.pollIntervalMs / 1000
let pollTimer: NodeJS.Timeout | null = null
let countdownTimer: NodeJS.Timeout | null = null

// Server-Sent Events subscribers for live logs
const sseClients = new Set<http.ServerResponse>()

logger.onLog((entry) => {
  const data = `data: ${JSON.stringify(entry)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(data)
    } catch {
      sseClients.delete(res)
    }
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Automation Worker Loop
// ---------------------------------------------------------------------------------------------------------------

/**
 * True while a claim cycle is in flight or a job is being processed.
 *
 * `isCurrentlyProcessing` alone is not enough. It is only set *after* pollJob()
 * returns, so during the lease window a caller would believe the engine is idle
 * and could open a second browser on the same supplier profile just as a claim
 * launches. `pollInFlight` covers the whole cycle, from the poll through job
 * completion and browser teardown, so routes that would start a browser on a
 * supplier profile must test this instead. See poll-guard.ts for the tested rule.
 */
function engineBusy(): boolean {
  return engineBusyWith({ isCurrentlyProcessing, pollInFlight, portalTestInFlight, followUpInFlight })
}

/**
 * True when a browser already owns a supplier profile.
 *
 * Used by routes that would queue work for a profile: a claim queued while the
 * manual-login browser is still open cannot be picked up, because the poll cycle
 * refuses to run until that browser closes.
 */
function supplierProfileInUse(): boolean {
  return supplierProfileInUseWith({
    isCurrentlyProcessing,
    pollInFlight,
    portalTestInFlight,
    followUpInFlight,
    portalBrowserHeld: holdPortalBrowser(),
  })
}

async function pollAndProcessJob(manual = false): Promise<boolean> {
  // `manual` is the "Poll Now" one-shot. It must run even while the worker is
  // paused, so the running-state check is skipped for it. The other two guards
  // still apply: a manual cycle must not overlap one already in flight, and it
  // must not run while a supplier login browser holds the profile.
  if (!shouldRunPollCycle({ workerRunning: isWorkerRunning, pollInFlight, portalBrowserHeld: holdPortalBrowser(), portalTestInFlight, followUpInFlight, manual })) return false
  pollInFlight = true
  lastPollTime = new Date().toLocaleTimeString("en-IN")
  let submissionOutcomeUnknown = false

  try {
    const poll = await client.pollJob()
    if (!poll.hasJob || !poll.job) return false

    isCurrentlyProcessing = true
    const jobHeader = poll.job
    activeJobInfo = jobHeader
    const panelKey = panelKeyForMarketplace(String(jobHeader.marketplace || ""))

    logger.info(`=== Received Claim Job #${jobHeader.jobId} (${jobHeader.marketplace} · AWB/Order: ${jobHeader.trackingId || jobHeader.orderNumber} · Stage: ${jobHeader.stage}) ===`)
    await client.sendHeartbeat("busy", { activeJobId: jobHeader.jobId, marketplace: jobHeader.marketplace })
    markPanelBusy(panelKey, jobHeader.jobId, String(jobHeader.stage || ""))

    const bundle = await client.getExecutionBundle(jobHeader.jobId)
    if (!bundle) {
      logger.error(`Could not retrieve bundle for job #${jobHeader.jobId}. Skipping.`)
      isCurrentlyProcessing = false
      activeJobInfo = null
      return false
    }

    // M9: a run holding the submitting lease must keep that stage. Reporting
    // downloading_media here would overwrite the backend's submission
    // authorization with a prepare-stage value (and the F4 gate plus the
    // completion endpoint both require the submitting stage to be intact).
    // The lease itself still expires on its own 15-minute clock.
    if (jobHeader.stage !== "submitting") {
      await client.updateProgress(jobHeader.jobId, {
        stage: "downloading_media",
        logMessage: "Agent downloading evidence photos and unboxing videos from cloud storage...",
      })
    }

    const evidenceFilesMap = await client.downloadEvidenceFiles(bundle.claimId, bundle.evidenceFiles)
    logger.info(`Downloaded ${evidenceFilesMap.size} evidence files for Claim #${bundle.claimId}.`)

    // Open the supplier browser through the shared adapter (bundled browser in
    // the desktop app, system browser everywhere else).
    const supplierBrowser = await openSupplierBrowser({
      panelKey,
      profileDir: profileDirFor(config.userDataDir, bundle.marketplace),
      headless: config.browserMode === "headless" || bundle.automationMode === "headless",
    })
    const browserRunner = supplierBrowser.browser

    let keepBrowserOpen = false
    try {
      const engine = getAutomationEngine(
        bundle.marketplace,
        browserRunner,
        bundle,
        evidenceFilesMap,
        path.join(config.workDir, `claim-${bundle.claimId}`),
      )

      // M9: a saved supplier login NEVER authorizes submission. Only the
      // backend-issued `submitting` lease (granted when an approved job is
      // leased) selects the submit path; cookie state is not consulted.
      const action = jobHeader.stage === "submitting" ? "submit" : "prepare"
      // Prepare runs on auto-submit accounts fall through to portal submission
      // inside the engine, so they get the same revalidation (without the
      // submitting-stage requirement, which only the approval path satisfies).
      if (action === "submit" || bundle.requireApprovalBeforeSubmit === false) {
        // F4: minutes passed since the lease while evidence downloaded. Re-read the
        // job and claim before the portal is touched; a retry, a second filing,
        // a missing approval, or a recorded claim outcome stops this run instead
        // of filing a duplicate.
        const fresh = await client.getExecutionBundle(jobHeader.jobId)
        const gate = isSafeToSubmitBundle(fresh?.stage, fresh?.claimStatus, bundle.requireApprovalBeforeSubmit)
        if (!gate.ok) {
          logger.warn(`Pre-submit revalidation stopped Job #${jobHeader.jobId}: ${gate.reason}`)
          markPanelResult(panelKey, "manual_action", gate.reason)
          return false
        }
      }
      const result = await engine.execute(action)

      if (result.stage === "prepared") {
        markPanelResult(panelKey, "prepared", "Prepared on the supplier panel. Waiting for approval.")
        await client.updateProgress(jobHeader.jobId, {
          stage: "prepared",
          logMessage: "Claim prepared on seller portal. Waiting for user approval before submission.",
          screenshotPath: result.screenshotPath,
        })
      } else if (result.stage === "completed" && result.marketplaceClaimId) {
        submissionOutcomeUnknown = true
        await client.completeJob(jobHeader.jobId, {
          marketplaceClaimId: result.marketplaceClaimId,
          screenshotPath: result.screenshotPath,
        })
        submissionOutcomeUnknown = false
        markPanelResult(panelKey, "completed", `Filed · ref ${result.marketplaceClaimId}`)
        // Clean up local downloaded evidence files so they don't occupy disk space, keeping the
        // submission screenshot the job references for operator inspection.
        await client.cleanClaimEvidenceFiles(bundle.claimId, result.screenshotPath ? [result.screenshotPath] : [])
      } else if (result.stage === "manual_intervention_required") {
        keepBrowserOpen = true
        holdPortalBrowser(browserRunner)
        await browserRunner.showForManualStep?.()
        await client.createOperatorTask({ claimId: bundle.claimId, marketplace: bundle.marketplace, kind: "pending_approval", title: `${bundle.marketplace}: manual approval needed for claim #${bundle.claimId}`, note: "Filing paused for an operator action." })
        markPanelResult(panelKey, "manual_action", result.manualActionReason || "Manual action required on portal.")
        await client.updateProgress(jobHeader.jobId, {
          stage: "manual_intervention_required",
          logMessage: result.manualActionReason || "Manual action required on portal.",
          screenshotPath: result.screenshotPath,
          manualActionReason: result.manualActionReason,
        })
      } else if (result.stage === "not_eligible") {
        logger.warn(`Job #${jobHeader.jobId} is not eligible for a claim. Kept for manual review; moving to the next job.`)
        markPanelResult(panelKey, "not_eligible", result.manualActionReason || "Marketplace says this order is not eligible.")
        await client.updateProgress(jobHeader.jobId, {
          stage: "not_eligible",
          logMessage: result.manualActionReason || "The marketplace says this order is not eligible for a claim.",
          screenshotPath: result.screenshotPath,
          manualActionReason: result.manualActionReason,
        })
        await client.cleanClaimEvidenceFiles(bundle.claimId, result.screenshotPath ? [result.screenshotPath] : [])
      }
    } finally {
      if (!keepBrowserOpen) await supplierBrowser.close()
    }
  } catch (err: any) {
    logger.error("Error processing automation job:", err)
    if (activeJobInfo?.jobId) {
      const failedPanel = panelKeyForMarketplace(String(activeJobInfo.marketplace || ""))
      markPanelResult(
        failedPanel,
        submissionOutcomeUnknown ? "manual_action" : "failed",
        err instanceof Error ? err.message : "Desktop automation failed.",
      )
      await client.updateProgress(activeJobInfo.jobId, {
        stage: submissionOutcomeUnknown ? "manual_intervention_required" : "failed",
        logMessage: err instanceof Error ? err.message : "Desktop automation failed.",
        manualActionReason: submissionOutcomeUnknown
          ? "Meesho returned a ticket, but the server acknowledgement was lost. Verify the ticket before retrying."
          : err instanceof Error ? err.message : "Desktop automation failed.",
      }).catch(() => undefined)
    }
  } finally {
    isCurrentlyProcessing = false
    activeJobInfo = null
    pollInFlight = false
    await client.sendHeartbeat("online", { status: "idle" })
  }
  return true
}

let schedulerStarted = false
let idlePolls = 0

// ---------------------------------------------------------------------------------------------------------------
// Follow-up Ticket Worker
//
// Filing a claim is not the end of the job: the marketplace ticket is not final for days. This worker runs on its
// own, much slower cadence than filing. On each cycle it asks the server for the next ticket that is due, opens
// that panel's saved session, reads the ticket state, and reports it back. The server reschedules the next check
// (every 2 days by default) and stops the ticket once it reaches a final state.
//
// It never runs while filing is in flight, and filing never runs while it is in flight, because both drive the
// same supplier browser profile. It also never runs while the worker is paused: re-opening supplier portals is
// exactly what a pause must stop.
// ---------------------------------------------------------------------------------------------------------------

let followUpTimer: NodeJS.Timeout | null = null
let lastFollowUpCheckTime = ""
let followUpChecksRun = 0
let lastFollowUpResult = ""

const ASSIST_SYSTEM_PROMPT =
  "You assist a warehouse claim bot. Propose one safe, evidence-grounded recovery step. " +
  + "Never invent ticket IDs, evidence, or credentials. Reply with the proposed action text only."

/**
 * Assistance pass after one follow-up check: approved memory first, a bounded AI
 * draft second, human review otherwise. Advisory only â€” it never changes what was
 * reported to the server and never executes a marketplace action. Best-effort: any
 * failure is logged and the worker moves on.
 */
/**
 * Worker-side hooks for the assistance pass: approved-procedure sync from the
 * server (null when the sync fails, so the local cache is kept) and operator-task
 * filing scoped to the leased claim. Both degrade silently; reporting already happened.
 */
function assistClientHooks(client: AgentBackendClient, claimId: number, marketplace: string) {
  return {
    refreshProcedures: async (): Promise<CachedProcedure[] | null> => {
      const rows = await client.getApprovedProcedures()
      if (!rows) return null
      const valid = rows.filter((r) => r.status === "approved" || r.status === "disabled")
      return valid.map((r) => ({ id: String(r.id), marketplace: String(r.marketplace || ""), errorSignature: String(r.errorSignature || ""), title: String(r.title || ""), steps: (Array.isArray(r.steps) ? r.steps : []).map(String), status: r.status as "approved" | "disabled", updatedAt: String(r.updatedAt || new Date().toISOString()) }))
    },
    fileTask: (kind: OperatorTaskKind, title: string, note: string) => client.createOperatorTask({ claimId, marketplace, kind, title, note }),
  }
}

async function runFollowUpAssist(input: {
  followUpId: number
  claimId: number
  marketplace: string
  marketplaceClaimId: string
  outcome: string
  note: string
  statusText: string
  normalizedStatus: string
  statusChanged: boolean
  refreshProcedures: () => Promise<CachedProcedure[] | null>
  fileTask: (kind: OperatorTaskKind, title: string, note: string) => Promise<number | null>
}): Promise<void> {
  try {
    const step = "follow-up-check"
    const signature =
      input.outcome === "status_read"
        ? normalizeErrorSignature(`ticket status ${input.normalizedStatus || input.statusText} ${input.marketplace}`)
        : normalizeErrorSignature(`${input.marketplace} follow-up ${input.outcome} ${input.note}`.slice(0, 200))
    const dir = agentDataDir()
    let memory = pruneLocalEvents(loadLocalMemory(dir), Date.now())
    if (isCacheStale(memory, Date.now()) || memory.procedures.length === 0) {
      try {
        const fresh = await input.refreshProcedures()
        if (fresh) {
          for (const p of fresh) memory = upsertCachedProcedure(memory, p)
          memory = markSynced(memory, Date.now())
          saveLocalMemory(dir, memory)
        }
      } catch (syncError) {
        logger.warn(`Follow-up #${input.followUpId}: memory sync skipped (${syncError instanceof Error ? syncError.message : syncError}).`)
      }
    }
    const hit = findApprovedProcedure(memory, input.marketplace, signature)
    const assistConfig = loadAiAssistConfig()
    const provider = providerFromConfig(assistConfig)
    const decision = decideFollowUpAssist({
      outcome: input.outcome,
      statusChanged: input.statusChanged,
      memoryHit: hit ? { procedureId: hit.id, title: hit.title, steps: hit.steps } : null,
      aiEnabled: provider !== null,
    })
    if (decision.action === "no-action") return
    const stamp = new Date().toISOString()
    if (decision.action === "memory-hit") {
      logger.info(`Follow-up #${input.followUpId}: approved recovery "${decision.procedure.title}". Review it on the engine dashboard before the next window.`)
      saveLocalMemory(dir, recordLocalEvent(memory, { at: stamp, claimId: input.claimId, marketplace: input.marketplace, step, outcome: "memory_hit", note: decision.procedure.title.slice(0, 200) }))
      lastFollowUpResult = `${input.marketplace}: approved recovery available`
      return
    }
    // AI Center routing first: the operator's own provider keys with cost-aware
    // routing and budget guard. The legacy authenticated gateway stays below as
    // an optional fallback, and human review remains the final fallback.
    if (decision.action === "ai-needed") {
      const routed = await runRoutedAssist({
        dir, task: "worker_diagnosis", agentFunction: "follow-up-check",
        ctx: { marketplace: input.marketplace, claimId: input.claimId, knownTicketId: input.marketplaceClaimId, step, errorSignature: signature },
        note: input.note, claimId: input.claimId, marketplace: input.marketplace,
        escalate: false,
        fileTask: input.fileTask,
        reportToServer: async (row) => {
          await client.reportAgentRun(row).catch(() => undefined)
        },
      })
      if (routed.handled) {
        if (routed.outcome === "ai_proposal") {
          logger.info(`Follow-up #${input.followUpId}: AI draft ready for operator review (not sent).`)
          saveLocalMemory(dir, recordLocalEvent(memory, { at: stamp, claimId: input.claimId, marketplace: input.marketplace, step, outcome: "ai_proposal", note: routed.summary.slice(0, 200) }))
        } else {
          saveLocalMemory(dir, recordLocalEvent(memory, { at: stamp, claimId: input.claimId, marketplace: input.marketplace, step, outcome: "human_review", note: routed.summary.slice(0, 200) }))
        }
        lastFollowUpResult = routed.summary
        return
      }
      if (!provider) {
        logger.info(`Follow-up #${input.followUpId}: no AI provider configured; needs operator review (${input.outcome}).`)
        saveLocalMemory(dir, recordLocalEvent(memory, { at: stamp, claimId: input.claimId, marketplace: input.marketplace, step, outcome: "human_review", note: input.outcome.slice(0, 200) }))
        lastFollowUpResult = `${input.marketplace}: needs operator review`
        return
      }
      const ctx: AssistanceContext = { marketplace: input.marketplace, claimId: input.claimId, knownTicketId: input.marketplaceClaimId, step, errorSignature: signature }
      const answered = await requestAiProposal(provider, { prompt: buildDiagnosticPrompt(ctx, input.note), system: ASSIST_SYSTEM_PROMPT, maxTokens: 400 }, assistConfig.maxCallsPerJob)
      const proposal = answered && answered.text ? { kind: "draft_response", summary: answered.text, ticketRef: input.marketplaceClaimId } : null
      if (proposal && validateAiProposal(proposal, ctx)) {
        logger.info(`Follow-up #${input.followUpId}: AI draft ready for operator review (not sent).`)
        saveLocalMemory(dir, recordLocalEvent(memory, { at: stamp, claimId: input.claimId, marketplace: input.marketplace, step, outcome: "ai_proposal", note: proposal.summary.slice(0, 200) }))
        lastFollowUpResult = `${input.marketplace}: AI draft ready for review`
      } else {
        logger.info(`Follow-up #${input.followUpId}: AI proposal failed validation; needs a human.`)
        saveLocalMemory(dir, recordLocalEvent(memory, { at: stamp, claimId: input.claimId, marketplace: input.marketplace, step, outcome: "human_review", note: "AI proposal rejected" }))
        lastFollowUpResult = `${input.marketplace}: needs operator review`
      }
      return
    }
    logger.info(`Follow-up #${input.followUpId}: needs operator review (${input.outcome}).`)
    saveLocalMemory(dir, recordLocalEvent(memory, { at: stamp, claimId: input.claimId, marketplace: input.marketplace, step, outcome: "human_review", note: input.outcome.slice(0, 200) }))
    const kind: OperatorTaskKind = input.outcome === "login_required" ? "expired_session" : input.outcome === "status_read" ? "operator_action" : "tracking_failure"
    const taskId = await input.fileTask(kind, `${input.marketplace}: ${input.outcome} needs review`, input.note.slice(0, 500))
    lastFollowUpResult = taskId ? `${input.marketplace}: needs operator review (task #${taskId})` : `${input.marketplace}: needs operator review`
  } catch (err) {
    logger.warn(`Follow-up #${input.followUpId}: assistance pass skipped (${err instanceof Error ? err.message : err}).`)
  }
}

/**
 * Run one follow-up cycle. Returns true when a ticket was actually checked.
 *
 * On any failure after the server handed out a ticket, the outcome is reported as an error so the ticket is
 * rescheduled rather than left leased until the lease expires.
 */
async function pollAndProcessFollowUp(): Promise<boolean> {
  if (!isWorkerRunning) return false
  if (engineBusy() || holdPortalBrowser()) return false
  if (shouldSkipFollowUpCycle(new Date(), nightlyFollowUpOnly())) {
    lastFollowUpResult = "Next nightly tracking window 01:00-02:00 IST"
    return false
  }
  followUpInFlight = true
  lastFollowUpCheckTime = new Date().toLocaleTimeString("en-IN")

  let leased: { followUpId: number; claimId: number; marketplace: string; accountName: string; marketplaceClaimId: string; portalUrl: string } | null = null
  try {
    const poll = await client.pollFollowUp()
    if (!poll.hasFollowUp || !poll.followUp) return false
    leased = poll.followUp
    const followUp = poll.followUp
    const panelKey = panelKeyForMarketplace(String(followUp.marketplace || ""))
    logger.info(
      `=== Follow-up check #${followUp.followUpId} (${followUp.marketplace} · panel ${panelKey} · ticket ${followUp.marketplaceClaimId} · claim #${followUp.claimId}) ===`,
    )

    const sessionDir = supplierSessionDir(config.userDataDir, followUp.marketplace, resolveBrowserAdapterKind())
    if (!readSessionSavedAt(sessionDir)) {
      const note = `No saved ${followUp.marketplace} sign-in on this PC. Connect the panel from the dashboard.`
      logger.warn(`Follow-up #${followUp.followUpId}: ${note}`)
      await client.reportFollowUp(followUp.followUpId, { outcome: "login_required", note })
      lastFollowUpResult = `${followUp.marketplace}: waiting for panel sign-in`
      await runFollowUpAssist({ followUpId: followUp.followUpId, claimId: followUp.claimId, marketplace: followUp.marketplace, marketplaceClaimId: followUp.marketplaceClaimId, ...assistClientHooks(client, followUp.claimId, followUp.marketplace), outcome: "login_required", note, statusText: "", normalizedStatus: "", statusChanged: false })
      return true
    }

    // A marketplace with no automation entry is not a failed check: it has no
    // reader either, so it is reported as unsupported and stopped, exactly like a
    // marketplace whose checkClaimStatus() default says "not implemented". No browser
    // is opened for it, so an unknown panel can never flash a window or burn a check.
    if (!isMarketplaceSupported(followUp.marketplace)) {
      const note = `Automation is not enabled for ${followUp.marketplace}.`
      logger.warn(`Follow-up #${followUp.followUpId}: ${note}`)
      await client.reportFollowUp(followUp.followUpId, { outcome: "not_supported", note })
      lastFollowUpResult = `${followUp.marketplace}: automation not enabled`
      return true
    }

    // One adapter for filing and follow-ups: the bundled browser in the desktop
    // app, the system browser everywhere else (BROWSER_ADAPTER=external forces it).
    const supplierBrowser = await openSupplierBrowser({
      panelKey,
      profileDir: profileDirFor(config.userDataDir, followUp.marketplace),
      headless: config.browserMode === "headless",
    })
    const browserRunner = supplierBrowser.browser
    let engine: ReturnType<typeof getAutomationEngine>
    try {
      engine = getAutomationEngine(
        followUp.marketplace,
        browserRunner,
        followUpExecutionBundle({
          claimId: followUp.claimId,
          marketplace: followUp.marketplace,
          accountName: followUp.accountName,
          portalUrl: followUp.portalUrl,
        }),
        new Map(),
        path.join(config.workDir, `follow-up-${followUp.followUpId}`),
      )
    } catch (engineError) {
      await supplierBrowser.close().catch(() => undefined)
      const note = engineError instanceof Error ? engineError.message : `Automation is not enabled for ${followUp.marketplace}.`
      logger.warn(`Follow-up #${followUp.followUpId}: ${note}`)
      await client.reportFollowUp(followUp.followUpId, { outcome: "not_supported", note })
      lastFollowUpResult = `${followUp.marketplace}: automation not enabled`
      return true
    }
    try {
      const result = await engine.checkClaimStatus(followUp.marketplaceClaimId)
      if (!result.supported) {
        logger.info(`Follow-up #${followUp.followUpId}: ${result.reason}`)
        await client.reportFollowUp(followUp.followUpId, { outcome: "not_supported", note: result.reason })
        lastFollowUpResult = `${followUp.marketplace}: status check not implemented`
      } else {
        const statusText = String(result.statusText || "").trim()
        if (!statusText) {
          await client.reportFollowUp(followUp.followUpId, {
            outcome: "not_found",
            note: "The panel opened but no ticket state was found for this reference.",
            screenshotPath: result.screenshotPath,
          })
          lastFollowUpResult = `${followUp.marketplace}: ticket state not found`
          await runFollowUpAssist({ followUpId: followUp.followUpId, claimId: followUp.claimId, marketplace: followUp.marketplace, marketplaceClaimId: followUp.marketplaceClaimId, ...assistClientHooks(client, followUp.claimId, followUp.marketplace), outcome: "not_found", note: "ticket state not found on panel", statusText: "", normalizedStatus: "", statusChanged: false })
        } else {
          const followUpReport = await client.reportFollowUp(followUp.followUpId, {
            outcome: "status_read",
            statusText,
            normalizedStatus: result.normalizedStatus,
            note: result.note,
            screenshotPath: result.screenshotPath,
          })
          lastFollowUpResult = `${followUp.marketplace}: ${statusText}`
          await runFollowUpAssist({ followUpId: followUp.followUpId, claimId: followUp.claimId, marketplace: followUp.marketplace, marketplaceClaimId: followUp.marketplaceClaimId, ...assistClientHooks(client, followUp.claimId, followUp.marketplace), outcome: "status_read", note: result.note || "", statusText, normalizedStatus: result.normalizedStatus || "", statusChanged: followUpReport.statusChanged })
        }
      }
    } finally {
      await supplierBrowser.close()
    }
    followUpChecksRun += 1
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : "Follow-up check failed."
    logger.error("Follow-up check failed:", err)
    lastFollowUpResult = message.slice(0, 200)
    if (leased) {
      await client
        .reportFollowUp(leased.followUpId, { outcome: "error", note: message.slice(0, 400) })
      await runFollowUpAssist({ followUpId: leased.followUpId, claimId: leased.claimId, marketplace: leased.marketplace, marketplaceClaimId: leased.marketplaceClaimId, ...assistClientHooks(client, leased.claimId, leased.marketplace), outcome: "error", note: message.slice(0, 200), statusText: "", normalizedStatus: "", statusChanged: false })
        .catch(() => undefined)
    }
    return false
  } finally {
    followUpInFlight = false
  }
}

/**
 * Schedule the next follow-up look-up. Like the filing chain, the timer is cleared when the worker pauses and
 * restarted by engineStart(), so a pause cannot leave a follow-up check running behind it.
 */
function scheduleNextFollowUp(delayMs: number): void {
  if (followUpTimer) clearTimeout(followUpTimer)
  followUpTimer = setTimeout(() => {
    void (async () => {
      try {
        await pollAndProcessFollowUp()
      } catch (err) {
        logger.error("Follow-up cycle failed.", err)
      }
      if (isWorkerRunning) scheduleNextFollowUp(config.followUpCheckIntervalMs)
      else followUpTimer = null
    })()
  }, delayMs)
}

/**
 * Poll cadence. Claims are picked up quickly while work is flowing and the
 * interval backs off while the queue is empty, so an idle warehouse PC or
 * server stays well under the low-spec CPU budget (AGENTS.md rule 13).
 */
function pollDelayMs(processedJob: boolean): number {
  if (processedJob) {
    idlePolls = 0
    return Math.max(5000, Math.round(config.pollIntervalMs / 2))
  }
  idlePolls += 1
  if (idlePolls > 10) return config.pollIntervalMs * 3
  if (idlePolls > 4) return config.pollIntervalMs * 2
  return config.pollIntervalMs
}

/**
 * Schedule the next poll. `pollTimer` stays non-null for the whole life of the
 * poll chain and is cleared only when the worker is paused, so a resume cannot
 * start a second chain. `pollInFlight` in pollAndProcessJob() is the second
 * guard: even if two timers fired, only one cycle can lease work.
 */
function scheduleNextPoll(delayMs: number): void {
  if (pollTimer) clearTimeout(pollTimer)
  nextPollCountdown = Math.max(1, Math.round(delayMs / 1000))
  pollTimer = setTimeout(() => {
    void (async () => {
      let processed = false
      try {
        processed = await pollAndProcessJob()
      } catch (err) {
        logger.error("Poll cycle failed.", err)
      }
      if (isWorkerRunning) {
        scheduleNextPoll(pollDelayMs(processed))
      } else {
        pollTimer = null
        nextPollCountdown = 0
      }
    })()
  }, delayMs)
}

/**
 * Serialized one-shot poll cycles.
 *
 * In paused mode there is no scheduled next poll, so a "run this claim" request
 * that arrives while another one-shot is still running would be dropped by the
 * pollInFlight guard and its claim would sit in the queue with nothing to pick it
 * up. Chaining the requests gives each one its own cycle.
 */
let manualRunChain: Promise<void> = Promise.resolve()

/**
 * Run one poll cycle now without resuming a paused worker.
 *
 * This is what "Poll Now" / "Check for Claims Now" uses. A one-shot check must
 * not silently switch continuous filing back on: the operator pauses the bot for
 * a reason, and a manual check is not consent to resume it. If the worker is
 * running, the current chain is nudged forward; if it is paused, only this single
 * cycle runs and no next poll is scheduled.
 */
export function engineRunOnceNow(): Promise<void> {
  if (!operatorSignedIn) return Promise.resolve()
  idlePolls = 0
  if (isWorkerRunning) {
    scheduleNextPoll(1000)
    return Promise.resolve()
  }
  manualRunChain = manualRunChain
    .then(async () => {
      // Only stand the scheduler down if the worker is *still* paused. It can
      // have been resumed while this link waited its turn, and clearing the
      // timer then would stop polling for good: the link finishes without
      // scheduling a next poll, so the engine would report running while idle.
      if (!isWorkerRunning) {
        if (pollTimer) {
          clearTimeout(pollTimer)
          pollTimer = null
        }
        nextPollCountdown = 0
      }
      try {
        // `true` = manual, so this single cycle runs even though the worker may
        // be paused. No next poll is scheduled on this path, so the pause holds.
        await pollAndProcessJob(true)
      } catch (err) {
        logger.error("Manual poll cycle failed.", err)
      }
    })
    // A rejected link must not wedge the chain for every later request.
    .catch(() => undefined)
  return manualRunChain
}

function startScheduler(): void {
  isWorkerRunning = true
  if (!schedulerStarted) {
    schedulerStarted = true

    if (countdownTimer) clearInterval(countdownTimer)
    countdownTimer = setInterval(() => {
      if (nextPollCountdown > 0) nextPollCountdown--
    }, 1000)

    // Send periodic heartbeat while the bot is signed in and running.
    setInterval(async () => {
      lastHeartbeatTime = new Date().toLocaleTimeString("en-IN")
      const status = isWorkerRunning ? "online" : "offline"
      await client.sendHeartbeat(status, { status: isCurrentlyProcessing ? "busy" : "idle", uptime: process.uptime() })
    }, config.heartbeatIntervalMs)
  }

  if (!pollTimer) scheduleNextPoll(config.pollIntervalMs)
  // The follow-up chain runs on its own timer so a slow ticket check never delays filing.
  if (!followUpTimer) scheduleNextFollowUp(config.followUpCheckIntervalMs)
}

// ---------------------------------------------------------------------------------------------------------------
// Desktop App Web Dashboard UI HTML
// ---------------------------------------------------------------------------------------------------------------

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Return App · 24/7 Desktop Claim Processing Bot</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root, [data-theme="light"] {
      --bg: #edf1ee;
      --card-bg: #ffffff;
      --card-border: #d9e2dd;
      --card-hover: #f2f7f4;
      --primary: #059669;
      --primary-dark: #047857;
      --primary-light: rgba(5, 150, 105, 0.12);
      --text: #10201a;
      --muted: #5c7169;
      --line: #d9e2dd;
      --border: #d9e2dd;
      --danger: #dc2626;
      --warning: #d97706;
      --blue: #2563eb;
      --purple: #7c3aed;
    }
    [data-theme="dark"] {
      --bg: #0b1311;
      --card-bg: #111e1b;
      --card-border: #1a2f2a;
      --card-hover: #162622;
      --primary: #10b981;
      --primary-dark: #059669;
      --primary-light: rgba(16, 185, 129, 0.12);
      --text: #f0fdf4;
      --muted: #84a99d;
      --line: #1c332d;
      --danger: #ef4444;
      --warning: #f59e0b;
      --blue: #3b82f6;
      --purple: #8b5cf6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; overflow-x: hidden; }
    header { background: #080f0d; border-bottom: 1px solid var(--line); padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 50; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-icon { width: 36px; height: 36px; border-radius: 9px; background: linear-gradient(135deg, #10b981, #047857); display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 800; color: white; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.35); }
    .brand-title { font-size: 15px; font-weight: 700; letter-spacing: -0.2px; }
    .brand-subtitle { font-size: 11px; color: var(--muted); }
    .status-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; background: var(--primary-light); color: var(--primary); border: 1px solid rgba(16, 185, 129, 0.3); }
    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); animation: pulse 2s infinite; }
    @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.2); } 100% { opacity: 1; transform: scale(1); } }

    .top-toolbar { background: var(--card-bg); border-bottom: 1px solid var(--card-border); padding: 10px 24px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
    .backend-picker { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
    .backend-select, .form-control { background: #080f0d; border: 1px solid var(--line); color: var(--text); padding: 6px 10px; border-radius: 6px; font-size: 12px; outline: none; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; border: none; transition: all 0.15s ease; text-decoration: none; }
    .btn-primary { background: var(--primary); color: #052e16; }
    .btn-primary:hover { background: #34d399; }
    .btn-secondary { background: #162b25; color: #a7f3d0; border: 1px solid var(--line); }
    .btn-secondary:hover { background: #1f3d34; }
    .btn-danger { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); }
    .btn-danger:hover { background: rgba(239, 68, 68, 0.25); }

    main { padding: 20px 24px; display: grid; gap: 20px; flex: 1; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
    .kpi-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 14px 16px; position: relative; overflow: hidden; }
    .kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); font-weight: 600; }
    .kpi-val { font-size: 26px; font-weight: 800; margin-top: 4px; display: flex; align-items: baseline; gap: 6px; }
    .kpi-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }

    .content-split { display: grid; grid-template-columns: 1fr 380px; gap: 20px; }
    @media (max-width: 1080px) { .content-split { grid-template-columns: 1fr; } }

    .panel { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
    .panel-header { padding: 14px 18px; border-bottom: 1px solid var(--card-border); display: flex; justify-content: space-between; align-items: center; background: #0e1916; }
    .panel-title { font-size: 14px; font-weight: 700; color: #e2e8f0; display: flex; align-items: center; gap: 8px; }

    .tabs { display: flex; gap: 4px; padding: 4px 12px; background: #080f0d; border-bottom: 1px solid var(--line); }
    .tab { padding: 6px 12px; font-size: 12px; font-weight: 600; color: var(--muted); border-radius: 6px; cursor: pointer; transition: all 0.15s; }
    .tab.active { background: var(--card-border); color: var(--text); }

    .table-container { overflow-x: auto; flex: 1; max-height: 480px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; }
    th { background: #0c1714; color: var(--muted); font-weight: 600; padding: 10px 14px; border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 10; font-size: 11px; text-transform: uppercase; }
    td { padding: 10px 14px; border-bottom: 1px solid rgba(28, 51, 45, 0.5); vertical-align: middle; }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }

    .badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .badge-meesho { background: #e0246a; color: white; }
    .badge-flipkart { background: #2874f0; color: white; }
    .badge-amazon { background: #f59e0b; color: #18181b; }
    .badge-myntra { background: #e11d48; color: white; }
    .badge-ajio { background: #1e293b; color: #f8fafc; border: 1px solid #475569; }

    .stage-queued { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .stage-downloading, .stage-submitting, .stage-opening_portal, .stage-filling_form { background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.3); }
    .stage-completed { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.3); }
    .stage-prepared { background: rgba(139, 92, 246, 0.15); color: #c4b5fd; border: 1px solid rgba(139, 92, 246, 0.3); }
    .stage-manual, .stage-failed { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); }

    .terminal-box { background: #060b09; border-radius: 0 0 12px 12px; padding: 12px; font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #cbd5e1; height: 420px; overflow-y: auto; line-height: 1.5; }
    .log-line { margin-bottom: 4px; display: flex; gap: 8px; word-break: break-all; }
    .log-time { color: #52756a; flex-shrink: 0; }
    .log-info { color: #34d399; }
    .log-warn { color: #fbbf24; }
    .log-error { color: #f87171; }
    .log-debug { color: #94a3b8; }

    [hidden] { display: none !important; }
    .login-gate { position: fixed; inset: 0; z-index: 80; background: #060b09; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .server-box { margin-top: 14px; font-size: 12px; color: var(--muted); }
    .server-box summary { cursor: pointer; }
    .server-row { display: flex; gap: 6px; margin-top: 8px; }
    .server-row .form-control { flex: 1; min-width: 0; }
    .server-note { margin-top: 6px; }
    .login-card { width: min(420px, 100%); background: #111e1b; border: 1px solid var(--card-border); border-radius: 16px; padding: 28px 26px; box-shadow: 0 24px 48px rgba(0,0,0,0.45); }
    .login-card h1 { font-size: 22px; margin: 8px 0 8px; }
    .login-card p { color: var(--muted); font-size: 13px; line-height: 1.55; margin-bottom: 18px; }
    .login-card label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
    .login-card input { width: 100%; margin-bottom: 14px; padding: 10px 12px; }
    .login-error { min-height: 18px; color: #fca5a5; font-size: 12px; margin-bottom: 10px; }
    .login-card .btn { width: 100%; justify-content: center; padding: 11px 14px; }
    .portal-row { display: grid; grid-template-columns: 140px 1fr 1fr auto; gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); }
    .portal-row input { width: 100%; }
    @media (max-width: 900px) { .portal-row { grid-template-columns: 1fr; } }
    /* Browsers workspace: a bounded flex column inside the main content
       column, to the right of .sidebar. Never fixed, never over the sidebar
       or the top header. The native WebContentsView is fitted to
       #browser-workspace-viewport through desktop:browser-rect. */
    #browser-workspace { display: none; flex-direction: column; gap: 10px; min-height: 560px; }
    body.supplier-browser-open #browser-workspace { display: flex; }
    #browser-exit-bar { display: none; align-items: center; justify-content: space-between; gap: 10px;
      background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px;
      padding: 8px 12px; font-size: 12px; font-weight: 700; }
    body.browser-fullscreen #browser-exit-bar { display: flex; position: sticky; top: 0; z-index: 5; }
    body.browser-fullscreen .sidebar, body.browser-fullscreen header, body.browser-fullscreen .top-toolbar { display: none; }
    #browser-tab-strip { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .browser-tab-pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line);
      border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 600; background: var(--card-bg); }
    .browser-tab-pill.active { border-color: var(--primary); color: var(--primary-dark); }
    [data-theme="dark"] .browser-tab-pill.active { color: var(--primary); }
    #browser-nav-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
      background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 8px 12px; }
    #browser-nav-toolbar .btn { font-size: 11px; padding: 4px 10px; }
    #browser-url-pill { flex: 1; min-width: 180px; font-size: 12px; color: var(--muted);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #browser-workspace-viewport { flex: 1; min-height: 420px; border: 1px solid var(--card-border);
      border-radius: 10px; background: #060b09; display: flex; align-items: center; justify-content: center;
      color: #6ee7b7; font-size: 12px; text-align: center; padding: 16px; }
    [data-theme="light"] #browser-workspace-viewport { background: #f2f7f4; color: #047857; }
    #browser-claim-control-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
      background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px;
      padding: 8px 12px; font-size: 12px; }
    /* Light-theme surface overrides (hardcoded dark surfaces + inline JS colors). */
    [data-theme="light"] header { background: #ffffff; }
    [data-theme="light"] .panel-header { background: #f2f7f4; }
    [data-theme="light"] .panel-title { color: #10201a; }
    [data-theme="light"] th { background: #f2f7f4; }
    [data-theme="light"] tr:hover td { background: rgba(5, 150, 105, 0.06); }
    [data-theme="light"] .tabs { background: #e6ece9; }
    [data-theme="light"] .tab.active { background: #ffffff; box-shadow: inset 0 0 0 1px var(--line); color: var(--text); }
    [data-theme="light"] .btn-secondary { background: #e9f1ed; color: #065f46; }
    [data-theme="light"] .btn-secondary:hover { background: #dce8e2; }
    [data-theme="light"] .btn-primary { color: #ffffff; }
    [data-theme="light"] .backend-select, [data-theme="light"] .form-control { background: #ffffff; }
    [data-theme="light"] .login-gate { background: #edf1ee; }
    [data-theme="light"] .login-card { background: #ffffff; }
    [data-theme="light"] .stage-queued { color: #b45309; }
    [data-theme="light"] .stage-downloading, [data-theme="light"] .stage-submitting,
    [data-theme="light"] .stage-opening_portal, [data-theme="light"] .stage-filling_form { color: #1d4ed8; }
    [data-theme="light"] .stage-completed { color: #047857; }
    [data-theme="light"] .stage-prepared { color: #6d28d9; }
    [data-theme="light"] .stage-manual, [data-theme="light"] .stage-failed { color: #b91c1c; }
    [data-theme="light"] #countdown, [data-theme="light"] #portal-status,
    [data-theme="light"] #supplier-browser-status, [data-theme="light"] #portal-browser-message,
    [data-theme="light"] #update-result, [data-theme="light"] #updates-current,
    [data-theme="light"] #updates-checked-line, [data-theme="light"] #ping-result,
    [data-theme="light"] #aimemory-message, [data-theme="light"] #aicenter-message { color: #047857 !important; }
    [data-theme="light"] #portal-message, [data-theme="light"] #login-error,
    [data-theme="light"] #gate-result { color: #b91c1c !important; }

    /* App shell: sidebar + segregated content. */
    main { display: block; padding: 0; }
    .app-shell { display: flex; align-items: flex-start; }
    .sidebar { width: 198px; flex-shrink: 0; position: sticky; top: 118px; background: var(--card-bg);
      border: 1px solid var(--card-border); border-radius: 12px; padding: 10px; margin: 20px 0 20px 24px;
      display: flex; flex-direction: column; gap: 2px; }
    .side-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted);
      font-weight: 700; padding: 6px 10px 4px; }
    .side-btn { text-align: left; background: transparent; border: none; border-radius: 8px; padding: 8px 10px;
      font-size: 13px; font-weight: 600; color: var(--muted); cursor: pointer; }
    .side-btn:hover { background: var(--card-hover); color: var(--text); }
    .side-btn.active { background: var(--primary-light); color: var(--primary-dark); }
    [data-theme="dark"] .side-btn.active { color: var(--primary); }
    .side-content { flex: 1; min-width: 0; display: grid; gap: 20px; padding: 20px 24px 20px 16px; align-content: start; }
    .update-banner { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between;
      background: var(--primary-light); border-bottom: 1px solid var(--primary);
      color: var(--text); font-size: 12px; font-weight: 600; padding: 8px 24px; }
    .update-banner a { color: var(--primary-dark); font-weight: 800; }
    [data-theme="dark"] .update-banner a { color: var(--primary); }
    @media (max-width: 900px) {
      .app-shell { flex-direction: column; }
      .sidebar { position: static; width: auto; margin: 12px 12px 0; flex-direction: row; overflow-x: auto; align-items: center; }
      .side-title { display: none; }
      .side-btn { white-space: nowrap; }
      .side-content { padding: 12px; }
    }
  </style>
<script>
try { var __t = localStorage.getItem('ra-theme'); document.documentElement.setAttribute('data-theme', __t === 'dark' ? 'dark' : 'light'); }
catch (e) { document.documentElement.setAttribute('data-theme', 'light'); }
</script>
</head>
<body>
  <header inert>
    <div class="brand">
      <div class="brand-icon">R</div>
      <div>
        <div class="brand-title">Return App · 24/7 Claim Bot</div>
        <div class="brand-subtitle">Files marketplace claims while this app is running. Scanning stays on the warehouse web and phone.</div>
      </div>
    </div>
    <div style="display: flex; align-items: center; gap: 12px;">
      <span id="operator-name" style="font-size: 12px; color: var(--muted);"></span>
      <div class="status-pill" id="agent-status-pill">
        <span class="pulse-dot"></span>
        <span id="agent-status-text">Waiting for sign-in</span>
      </div>
      <button class="btn btn-secondary" id="theme-btn" type="button" onclick="toggleTheme()" title="Switch between light and dark">Theme</button>
      <button class="btn btn-secondary" id="sign-out-btn" type="button" onclick="signOut()" title="Stops the 24/7 claim bot until someone signs in again" hidden>Sign out</button>
    </div>
  </header>

  <div class="login-gate" id="login-gate">
    <form class="login-card" onsubmit="submitLogin(event)">
      <div class="brand-subtitle">CLAIM BOT</div>
      <h1>Sign in to start claims</h1>
      <p>This desktop app does not open return scanning. After you sign in, it keeps picking up queued claims for as long as the app is running, including when the window is closed to the tray.</p>
      <label for="login-email">Email or login ID</label>
      <input id="login-email" class="form-control" type="text" autocomplete="username" required />
      <label for="login-password">Password</label>
      <input id="login-password" class="form-control" type="password" autocomplete="current-password" required />
      <div class="login-error" id="login-error"></div>
      <button class="btn btn-primary" id="login-submit" type="submit">Sign in and run the bot</button>
      <details class="server-box">
        <summary>Server: <span id="gate-backend-url">${config.backendUrl}</span> <span id="gate-ping"></span></summary>
        <div class="server-row">
          <input id="gate-backend-url-input" class="form-control" type="text" value="${config.backendUrl}" />
          <button class="btn btn-secondary" type="button" onclick="gateApplyBackendUrl()">Apply</button>
          <button class="btn btn-secondary" type="button" onclick="gateTestConnection()">Test</button>
        </div>
        <div class="server-note" id="gate-result"></div>
        <div class="server-note">Changing the server signs this PC out. Sign in again to the new server.</div>
      </details>
    </form>
  </div>

  <div id="update-banner" class="update-banner" hidden>
    <span id="update-banner-text"></span>
    <span style="display:flex;gap:8px;align-items:center;">
      <a id="update-banner-link" href="#" target="_blank" rel="noopener">Download update</a>
      <button class="btn btn-secondary" type="button" style="font-size:11px;padding:2px 8px;" onclick="dismissUpdateBanner()">Later</button>
    </span>
  </div>

  <div class="top-toolbar" inert>
    <div class="backend-picker">
      <strong>Backend Server:</strong>
      <input type="text" id="backend-url-input" class="form-control" style="width: 250px;" value="${config.backendUrl}" />
      <button class="btn btn-secondary" onclick="updateBackendUrl()">Apply</button>
      <button class="btn btn-secondary" onclick="testBackendConnection()">⚡ Test Ping</button>
      <span id="ping-result" style="margin-left: 6px; font-size: 11px;"></span>
    </div>

    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="font-size: 12px; color: var(--muted);">
        Next poll in: <strong id="countdown" style="color: #6ee7b7;">${nextPollCountdown}s</strong>
      </div>
      <button class="btn btn-secondary" onclick="pollNow()">↻ Poll Now</button>
      <button class="btn btn-primary" id="toggle-worker-btn" onclick="toggleWorker()">⏸ Pause Bot</button>
      <button class="btn btn-secondary" onclick="focusLogin()">Set up supplier login</button>
    </div>
  </div>

  <main inert>
  <div class="app-shell">
    <aside class="sidebar" id="sidebar">
      <div class="side-title">Claim bot</div>
      <button class="side-btn" type="button" data-side="status" onclick="showSideTab('status')">Dashboard</button>
      <button class="side-btn" type="button" data-side="claims" onclick="showSideTab('claims')">Claims</button>
      <button class="side-btn" type="button" data-side="browsers" onclick="showSideTab('browsers')">Browsers</button>
      <button class="side-btn" type="button" data-side="follow-ups" onclick="showSideTab('follow-ups')">Follow-ups</button>
      <button class="side-btn" type="button" data-side="ai" onclick="showSideTab('ai')">AI Center</button>
      <button class="side-btn" type="button" data-side="setup" onclick="showSideTab('setup')">Settings</button>
      <button class="side-btn" type="button" data-side="updates" onclick="showSideTab('updates')">Updates</button>
    </aside>
    <div class="side-content">
    <section class="panel" id="overall-status" style="padding: 16px 18px;">
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:12px;">
          <span id="overall-dot" style="width:14px;height:14px;border-radius:50%;background:#64748b;display:inline-block;"></span>
          <div>
            <div id="overall-title" style="font-size:16px;font-weight:800;">Checking status…</div>
            <div id="overall-detail" style="font-size:12px;color:var(--muted);margin-top:2px;">Reading panel sessions, the bot state, and ticket follow-ups.</div>
          </div>
        </div>
        <div id="overall-chips" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
      </div>
    </section>

    <section class="panel" id="onboarding" style="padding: 16px 18px;">
      <div class="panel-title" style="margin-bottom: 4px;">First-time setup — connect each supplier panel <span id="onboarding-count" style="font-size: 11px; font-weight: normal; color: var(--muted);"></span></div>
      <p style="color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 12px;">Do one panel at a time. For each marketplace, save the supplier ID and password, then sign in: the supplier page opens inside this app window. Complete any OTP or CAPTCHA there yourself — the cookies are saved on this PC so sign-in sticks across restarts. A panel whose session expires drops back to Connect here.</p>
      <div id="onboarding-steps" style="display: grid; gap: 8px;"></div>
      <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 12px; font-size: 12px; color: var(--muted);">
        <span id="security-line">Checking credential storage…</span>
        <span style="color: var(--muted);">App updates moved to the Updates tab.</span>
      </div>
    </section>

    <section class="panel" id="portal-setup" style="padding: 16px 18px;">
      <div class="panel-title" style="margin-bottom: 6px;">Supplier login, then one claim</div>
      <p style="color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 12px;">Do one marketplace at a time. Leave the ID and password blank to use the bot login already saved on the web. Test login opens the supplier browser window built into this app (no Edge or Chrome needed), signs in, and stores the cookies on this PC. If a code appears, type it in that window before closing it.</p>
      <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: end;">
        <label style="font-size: 12px; font-weight: 600;">Marketplace<br>
          <select id="portal-marketplace" class="form-control" style="min-width: 140px; margin-top: 4px;">
            ${PORTAL_CHANNELS.map((channel) => `<option value="${channel.name}">${channel.name}</option>`).join("")}
          </select>
        </label>
        <label style="font-size: 12px; font-weight: 600;">Supplier ID<br>
          <input id="portal-username" class="form-control" type="text" autocomplete="off" style="min-width: 220px; margin-top: 4px;" />
        </label>
        <label style="font-size: 12px; font-weight: 600;">Password<br>
          <input id="portal-password" class="form-control" type="password" autocomplete="off" style="min-width: 180px; margin-top: 4px;" />
        </label>
        <button class="btn btn-secondary" type="button" onclick="savePortal()">Save login</button>
        <button class="btn btn-primary" type="button" onclick="testPortal()">Sign in and save cookies</button>
      </div>
      <div id="portal-status" style="margin-top: 10px; font-size: 12px; color: #a7f3d0;"></div>
      <div id="portal-message" style="margin-top: 6px; font-size: 12px; color: #fca5a5;"></div>
      <div id="supplier-browser-row" style="display: none; margin-top: 10px; font-size: 12px; align-items: center; gap: 10px; flex-wrap: wrap;">
        <span id="supplier-browser-status" style="color: #a7f3d0;">Supplier browser: dashboard</span>
        <button class="btn btn-secondary" type="button" style="font-size: 11px; padding: 2px 8px;" onclick="showSupplierBrowser()">Show supplier browser</button>
        <button class="btn btn-secondary" type="button" style="font-size: 11px; padding: 2px 8px;" onclick="hideSupplierBrowser()">Hide supplier browser</button>
      </div>
      <div id="portal-browser-message" style="margin-top: 6px; font-size: 12px; color: #fca5a5;"></div>
      <div id="browser-workspace-note" style="margin-top: 6px; font-size: 12px; color: var(--muted);">Supplier pages open in the <button class="btn btn-secondary" type="button" style="font-size: 11px; padding: 2px 8px;" onclick="openBrowsersWorkspace()">Browsers workspace</button> tab.</div>
    </section>

    <section class="panel" id="browsers-panel" style="padding: 16px 18px;">
      <div class="panel-title" style="margin-bottom: 4px;">Browsers</div>
      <p style="color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 12px;">Marketplace supplier pages open inside this app window, bounded below. The sidebar and these controls stay visible while a page is open. Sessions are preserved when you switch tabs.</p>
      <div id="browser-exit-bar">
        <span id="browser-exit-label">Supplier browser expanded</span>
        <button class="btn btn-secondary" type="button" style="font-size: 11px; padding: 4px 10px;" onclick="exitBrowserFullscreen()" title="Return the supplier browser to the bounded workspace">Exit Fullscreen (Esc)</button>
      </div>
      <div id="browser-workspace">
        <div id="browser-tab-strip" role="tablist" aria-label="Marketplace browser tabs"></div>
        <div id="browser-nav-toolbar">
          <button class="btn btn-secondary" type="button" id="browser-back-btn" disabled title="Back navigation arrives with the multi-tab manager">← Back</button>
          <button class="btn btn-secondary" type="button" id="browser-forward-btn" disabled title="Forward navigation arrives with the multi-tab manager">Forward →</button>
          <button class="btn btn-secondary" type="button" id="browser-reload-btn" disabled title="Reload arrives with the multi-tab manager">↻ Reload</button>
          <span id="browser-url-pill" title="Supplier page address">No supplier page open</span>
          <button class="btn btn-secondary" type="button" onclick="expandBrowserFullscreen()" title="Expand the supplier browser to the full window">Expand</button>
          <button class="btn btn-secondary" type="button" onclick="showSupplierBrowser()" title="Show the supplier browser in this workspace">Dock</button>
          <button class="btn btn-secondary" type="button" onclick="hideSupplierBrowser()" title="Hide the supplier browser; the session stays saved">Hide</button>
        </div>
        <div id="browser-workspace-viewport">No supplier browser is open. Use Settings to sign in to a marketplace, then open it here.</div>
        <div id="browser-claim-control-bar">
          <span id="browser-claim-status" style="color: var(--muted);">Idle — no supplier page open.</span>
        </div>
      </div>
    </section>

    <section class="panel" id="updates" style="padding: 16px 18px;">
      <div class="panel-title" style="margin-bottom: 4px;">App updates</div>
      <p style="color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 12px;">This app checks for a newer release after install and while it runs. When one is found you get a banner here with a download link; install it over this version, supplier cookies are kept.</p>
      <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 12px;">
        <span id="updates-current" style="color: var(--muted);">This app: checking…</span>
        <button class="btn btn-secondary" type="button" onclick="checkUpdates()">Check now</button>
        <label style="display: inline-flex; gap: 6px; align-items: center; color: var(--muted);"><input id="updates-auto" type="checkbox" checked onchange="toggleAutoUpdates()" /> Check automatically</label>
      </div>
      <div id="update-result" style="margin-top: 8px; font-size: 12px;"></div>
      <div id="updates-checked-line" style="margin-top: 4px; font-size: 11px; color: var(--muted);"></div>
    </section>

    <section class="panel" id="panel-queue" style="padding: 16px 18px;">
      <div class="panel-title" style="margin-bottom: 4px;">Panel-wise continuous filing</div>
      <p style="color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 12px;">Each supplier panel keeps its own login cookies and queue. The bot rotates through the ready panels, so one panel waiting on OTP or cooling down never stops the others.</p>
      <div id="panel-strip" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px;"></div>
    </section>

    <section class="panel" id="follow-ups" style="padding: 16px 18px;">
      <div class="panel-title" style="margin-bottom: 4px;">Ticket follow-ups <span id="followup-count" style="font-size: 11px; font-weight: normal; color: var(--muted);"></span></div>
      <p style="color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 12px;">After a claim is filed, the bot re-opens that panel on its own in the nightly 01:00-02:00 IST window once the ticket is 48 hours old, reads the ticket status, and records it here until the ticket is approved or rejected. The ticket ID is the marketplace's own reference number.</p>
      <div class="table-container" style="max-height: 280px;">
        <table>
          <thead>
            <tr>
              <th>Marketplace</th>
              <th>Ticket ID</th>
              <th>Claim status</th>
              <th>Last check</th>
              <th>Next check</th>
              <th>Checks</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody id="followups-table-body">
            <tr><td colspan="7" style="text-align: center; padding: 20px; color: var(--muted);">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel" id="ai-memory" style="padding: 16px 18px;">
      <div class="panel-title" style="margin-bottom: 4px;">Approved AI memory <span id="aimemory-count" style="font-size: 11px; font-weight: normal; color: var(--muted);"></span></div>
      <p style="color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 12px;">Only approved recovery procedures drive the worker without a new AI call. AI suggestions stay pending until an operator approves them. Disable is a local safety kill-switch for this PC.</p>
      <div class="table-container" style="max-height: 240px;">
        <table>
          <thead>
            <tr>
              <th>Marketplace</th>
              <th>Procedure</th>
              <th>Error signature</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="aimemory-table-body">
            <tr><td colspan="5" style="text-align: center; padding: 20px; color: var(--muted);">Loading…</td></tr>
          </tbody>
        </table>
      </div>
      <div id="ai-usage-line" style="font-size: 11px; color: var(--muted); margin-top: 10px;"></div>
      <div id="aimemory-message" style="font-size: 12px; margin-top: 6px;"></div>
    </section>

    <section class="panel" id="ai-center" style="padding: 16px 18px;">
      <div class="panel-title" style="margin-bottom: 4px;">AI Center <span id="aicenter-status" style="font-size: 11px; font-weight: normal; color: var(--muted);"></span></div>
      <p style="color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 12px;">Your own provider keys, model routing, agent activity, and usage costs. Keys are encrypted with the OS credential store on this PC, never shown again, and never sent anywhere except the provider API. The claim worker stays deterministic: memory first, then a low-cost model, then human review.</p>
      <div style="display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap;">
        <button class="btn btn-secondary" type="button" id="aic-tabbtn-providers" style="font-size: 11px; padding: 4px 10px;" onclick="aiCenterTab('providers')">Providers</button>
        <button class="btn btn-secondary" type="button" id="aic-tabbtn-routing" style="font-size: 11px; padding: 4px 10px;" onclick="aiCenterTab('routing')">Routing</button>
        <button class="btn btn-secondary" type="button" id="aic-tabbtn-agents" style="font-size: 11px; padding: 4px 10px;" onclick="aiCenterTab('agents')">Agents</button>
        <button class="btn btn-secondary" type="button" id="aic-tabbtn-usage" style="font-size: 11px; padding: 4px 10px;" onclick="aiCenterTab('usage')">Usage &amp; Costs</button>
        <button class="btn btn-secondary" type="button" id="aic-tabbtn-memory" style="font-size: 11px; padding: 4px 10px;" onclick="aiCenterTab('memory')">Learning &amp; Memory</button>
      </div>
      <div id="aic-tab-providers">
        <div class="table-container" style="max-height: 320px;">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Key</th>
                <th>Default model</th>
                <th>Last success</th>
                <th>Last error</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="aic-providers-body">
              <tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--muted);">Loading…</td></tr>
            </tbody>
          </table>
        </div>
        <div id="aic-key-editor" style="display: none; margin-top: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;">
          <div style="font-size: 12px; font-weight: 600; margin-bottom: 8px;" id="aic-key-title">Save API key</div>
          <input id="aic-key-input" type="password" autocomplete="off" placeholder="Paste key — it is encrypted on save and never shown again" style="width: 100%; max-width: 460px; font-size: 12px; padding: 6px 8px; margin-bottom: 8px;" />
          <div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">
            <button class="btn" type="button" style="font-size: 11px; padding: 4px 10px;" onclick="saveAiKey()">Save key</button>
            <button class="btn btn-secondary" type="button" style="font-size: 11px; padding: 4px 10px;" onclick="testAiConnection()">Test connection</button>
            <button class="btn btn-secondary" type="button" style="font-size: 11px; padding: 4px 10px;" onclick="closeAiKeyEditor()">Cancel</button>
            <span id="aic-key-message" style="font-size: 11px;"></span>
          </div>
          <div style="font-size: 11px; color: var(--muted); margin-top: 8px;">Test connection makes one genuine low-cost model request (a few tokens). Manual model IDs are allowed; discovery lists what the provider reports.</div>
          <div style="display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center;">
            <select id="aic-model-select" style="font-size: 11px; padding: 4px 6px; max-width: 280px;"></select>
            <input id="aic-manual-model" type="text" placeholder="Or type a model ID" style="font-size: 11px; padding: 4px 6px; max-width: 220px;" />
            <button class="btn btn-secondary" type="button" style="font-size: 11px; padding: 4px 10px;" onclick="refreshAiModels()">Discover models</button>
            <button class="btn btn-secondary" type="button" style="font-size: 11px; padding: 4px 10px;" onclick="saveAiPrefs()">Save model</button>
          </div>
        </div>
      </div>
      <div id="aic-tab-routing" style="display: none;">
        <div class="table-container" style="max-height: 320px;">
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Mode</th>
                <th>Primary</th>
                <th>Fallback</th>
                <th>Tokens</th>
                <th>Timeout</th>
              </tr>
            </thead>
            <tbody id="aic-routing-body">
              <tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--muted);">Loading…</td></tr>
            </tbody>
          </table>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: center; font-size: 12px;">
          <label>Monthly budget (USD, empty = none) <input id="aic-budget" type="text" inputmode="decimal" style="font-size: 11px; padding: 4px 6px; width: 90px;" /></label>
          <button class="btn" type="button" style="font-size: 11px; padding: 4px 10px;" onclick="saveAiRouting()">Save routing</button>
          <span id="aic-routing-message" style="font-size: 11px;"></span>
        </div>
        <div style="font-size: 11px; color: var(--muted); margin-top: 6px;">Automatic mode picks the cheapest healthy provider per task and escalates only inside your budget. Manual mode pins a primary and optional fallback. Reasoning options are sent only to models that advertise support.</div>
      </div>
      <div id="aic-tab-agents" style="display: none;">
        <div class="table-container" style="max-height: 320px;">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Claim</th>
                <th>Function</th>
                <th>Provider / model</th>
                <th>Stage</th>
                <th>Result</th>
                <th>Approval</th>
              </tr>
            </thead>
            <tbody id="aic-activity-body">
              <tr><td colspan="7" style="text-align: center; padding: 20px; color: var(--muted);">Loading…</td></tr>
            </tbody>
          </table>
        </div>
        <div style="font-size: 11px; color: var(--muted); margin-top: 6px;">Read-only ledger of real worker executions. Nothing here is active unless the worker actually ran it; interrupted rows mark an application restart.</div>
      </div>
      <div id="aic-tab-usage" style="display: none;">
        <div id="aic-usage-summary" style="font-size: 12px; margin-bottom: 10px; line-height: 1.7;"></div>
        <div style="display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; align-items: center; font-size: 12px;">
          <label>From <input id="aic-usage-from" type="text" placeholder="YYYY-MM-DD" style="font-size: 11px; padding: 4px 6px; width: 100px;" /></label>
          <label>To <input id="aic-usage-to" type="text" placeholder="YYYY-MM-DD" style="font-size: 11px; padding: 4px 6px; width: 100px;" /></label>
          <button class="btn btn-secondary" type="button" style="font-size: 11px; padding: 4px 10px;" onclick="loadAiUsage()">Filter</button>
          <span style="font-size: 11px; color: var(--muted);">Costs are estimates from provider-reported tokens and public pricing; the provider bill is authoritative. Unknown means no public pricing was confirmed.</span>
        </div>
        <div class="table-container" style="max-height: 280px;">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Task</th>
                <th>Tokens in/out</th>
                <th>Est. USD</th>
                <th>Latency</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="aic-usage-body">
              <tr><td colspan="8" style="text-align: center; padding: 20px; color: var(--muted);">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div id="aic-tab-memory" style="display: none;">
        <div id="aic-memory-line" style="font-size: 12px; line-height: 1.7;">Loading…</div>
        <div style="font-size: 11px; color: var(--muted); margin-top: 6px;">Authoritative approvals live in PostgreSQL and follow pending to approved; this PC mirrors approved and disabled procedures only. See the Approved AI memory panel below for the procedure list and local kill-switch.</div>
      </div>
      <div id="aicenter-message" style="font-size: 12px; margin-top: 8px;"></div>
    </section>
    <script>
    var aicProviders = [];
    var aicCatalog = null;
    var aicRouting = null;
    var aicEditProvider = null;
    function aiCenterTab(name) {
      var tabs = ['providers', 'routing', 'agents', 'usage', 'memory'];
      for (var i = 0; i < tabs.length; i++) {
        document.getElementById('aic-tab-' + tabs[i]).style.display = tabs[i] === name ? '' : 'none';
      }
      if (name === 'usage') loadAiUsage();
      if (name === 'agents') loadAiActivity();
      if (name === 'memory') loadAiMemoryLine();
    }
    function aicEsc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function aicFmtTime(iso) {
      if (!iso) return '—';
      try { return new Date(iso).toLocaleString('en-IN', { hour12: false }); } catch (e) { return String(iso); }
    }
    async function loadAiCenter() {
      try {
        var res = await fetch('/api/v1/ai-center/providers');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        aicProviders = data.providers || [];
        var withKey = aicProviders.filter(function (p) { return p.hasKey; }).length;
        document.getElementById('aicenter-status').textContent = '(' + withKey + ' of ' + aicProviders.length + ' providers configured)';
        renderAiProviders();
        var rres = await fetch('/api/v1/ai-center/routing');
        if (rres.ok) {
          var rdata = await rres.json();
          aicRouting = rdata.routing;
          renderAiRouting();
        }
        loadAiActivity();
        loadAiUsage();
        loadAiMemoryLine();
      } catch (e) {
        document.getElementById('aicenter-status').textContent = '(unavailable)';
        document.getElementById('aic-providers-body').innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#fbbf24;">AI Center could not be read.</td></tr>';
      }
    }
    function renderAiProviders() {
      var body = document.getElementById('aic-providers-body');
      body.innerHTML = aicProviders.map(function (p) {
        var keyLabel = p.hasKey ? 'Saved (encrypted)' : 'No key';
        var lastErr = p.lastError ? (aicEsc(p.lastErrorCategory || 'error') + ': ' + aicEsc(p.lastError).slice(0, 80)) : '—';
        return '<tr><td>' + aicEsc(p.name) + '</td><td>' + keyLabel + '</td><td>' + aicEsc(p.defaultModel || '—') + '</td><td>' + aicFmtTime(p.lastSuccessAt) + '</td><td>' + lastErr + '</td>' +
          '<td style="white-space:nowrap;"><button class="btn btn-secondary" type="button" style="font-size:11px;padding:2px 8px;" onclick="openAiKeyEditor(\\'' + p.id + '\\')">Key</button> ' +
          '<button class="btn btn-secondary" type="button" style="font-size:11px;padding:2px 8px;" onclick="quickTestAiConnection(\\'' + p.id + '\\')">Test</button>' +
          (p.hasKey ? ' <button class="btn btn-secondary" type="button" style="font-size:11px;padding:2px 8px;" onclick="removeAiKey(\\'' + p.id + '\\')">Remove</button>' : '') + '</td></tr>';
      }).join('');
    }
    function openAiKeyEditor(id) {
      aicEditProvider = id;
      var p = null;
      for (var i = 0; i < aicProviders.length; i++) if (aicProviders[i].id === id) p = aicProviders[i];
      document.getElementById('aic-key-title').textContent = 'API key for ' + (p ? p.name : id) + (p && p.hasKey ? ' (replace)' : '');
      document.getElementById('aic-key-input').value = '';
      document.getElementById('aic-key-message').textContent = '';
      document.getElementById('aic-key-editor').style.display = '';
      refreshAiModels();
      document.getElementById('aic-key-input').focus();
    }
    function closeAiKeyEditor() {
      document.getElementById('aic-key-editor').style.display = 'none';
      document.getElementById('aic-key-input').value = '';
      aicEditProvider = null;
    }
    async function saveAiKey() {
      var input = document.getElementById('aic-key-input');
      var msg = document.getElementById('aic-key-message');
      var key = input.value;
      input.value = '';
      if (!key) { msg.textContent = 'Paste a key first.'; return; }
      msg.textContent = 'Saving…';
      try {
        var res = await fetch('/api/v1/ai-center/providers/' + aicEditProvider + '/key', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key })
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        msg.textContent = data.encrypted ? 'Saved (OS-encrypted).' : 'Saved.';
        loadAiCenter();
      } catch (e) { msg.textContent = 'Save failed: ' + e.message; }
    }
    async function removeAiKey(id) {
      if (!window.confirm('Remove the stored key for this provider?')) return;
      await fetch('/api/v1/ai-center/providers/' + id + '/key', { method: 'DELETE' });
      loadAiCenter();
    }
    async function quickTestAiConnection(id) {
      openAiKeyEditor(id);
      await testAiConnection();
    }
    async function testAiConnection() {
      var msg = document.getElementById('aic-key-message');
      var model = document.getElementById('aic-manual-model').value.trim() || document.getElementById('aic-model-select').value;
      msg.textContent = 'Testing with a real low-cost request…';
      try {
        var res = await fetch('/api/v1/ai-center/providers/' + aicEditProvider + '/test', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model })
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error((data.category ? data.category + ': ' : '') + (data.error || ('HTTP ' + res.status)));
        msg.textContent = 'Connection OK (' + data.latencyMs + ' ms).';
        loadAiCenter();
      } catch (e) { msg.textContent = 'Test failed: ' + e.message; }
    }
    async function refreshAiModels() {
      var sel = document.getElementById('aic-model-select');
      sel.innerHTML = '<option>Loading…</option>';
      try {
        var res = await fetch('/api/v1/ai-center/providers/' + aicEditProvider + '/models');
        var data = await res.json();
        var models = data.models || [];
        sel.innerHTML = models.map(function (m) { return '<option value="' + aicEsc(m) + '">' + aicEsc(m) + '</option>'; }).join('');
      } catch (e) { sel.innerHTML = '<option>Discovery failed</option>'; }
    }
    async function saveAiPrefs() {
      var msg = document.getElementById('aic-key-message');
      var manual = document.getElementById('aic-manual-model').value.trim();
      var model = manual || document.getElementById('aic-model-select').value;
      if (!model) { msg.textContent = 'Pick or type a model first.'; return; }
      var res = await fetch('/api/v1/ai-center/providers/' + aicEditProvider + '/prefs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultModel: model })
      });
      msg.textContent = res.ok ? 'Default model saved: ' + model : 'Save failed (HTTP ' + res.status + ').';
      document.getElementById('aic-manual-model').value = '';
      loadAiCenter();
    }
    function renderAiRouting() {
      if (!aicRouting) return;
      var body = document.getElementById('aic-routing-body');
      var tasks = aicRouting.tasks || {};
      body.innerHTML = Object.keys(tasks).map(function (t) {
        var r = tasks[t];
        var fb = r.fallback ? (aicEsc(r.fallback.provider) + ' / ' + aicEsc(r.fallback.model)) : '—';
        return '<tr><td>' + aicEsc(t) + '</td><td>' + aicEsc(r.mode) + '</td><td>' + aicEsc(r.primary.provider) + ' / ' + aicEsc(r.primary.model) + '</td><td>' + fb + '</td><td>' + r.maxTokens + '</td><td>' + (r.timeoutMs / 1000) + 's</td></tr>';
      }).join('');
      document.getElementById('aic-budget').value = aicRouting.monthlyBudgetUsd == null ? '' : aicRouting.monthlyBudgetUsd;
    }
    async function saveAiRouting() {
      var msg = document.getElementById('aic-routing-message');
      if (!aicRouting) { msg.textContent = 'Routing not loaded yet.'; return; }
      var raw = document.getElementById('aic-budget').value.trim();
      var routing = JSON.parse(JSON.stringify(aicRouting));
      routing.monthlyBudgetUsd = raw === '' ? null : Number(raw);
      msg.textContent = 'Saving…';
      try {
        var res = await fetch('/api/v1/ai-center/routing', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ routing: routing })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        msg.textContent = 'Routing saved.';
        loadAiCenter();
      } catch (e) { msg.textContent = 'Save failed: ' + e.message; }
    }
    async function loadAiActivity() {
      var body = document.getElementById('aic-activity-body');
      try {
        var res = await fetch('/api/v1/ai-center/activity');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        var rows = data.activity || [];
        if (rows.length === 0) { body.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted);">No agent executions yet. The worker records here only when it actually runs AI assistance.</td></tr>'; return; }
        body.innerHTML = rows.map(function (a) {
          var pm = (a.provider ? aicEsc(a.provider) + ' / ' : '') + aicEsc(a.model || 'memory');
          var mm = a.memoryHit ? 'memory' : 'model';
          return '<tr><td>' + aicFmtTime(a.at) + '</td><td>' + aicEsc(a.marketplace) + ' #' + a.claimId + '</td><td>' + aicEsc(a.agentFunction) + '</td><td>' + pm + '</td><td>' + aicEsc(a.stage) + ' (' + mm + (a.fallback ? ', fallback' : '') + ')' + (a.errorCategory ? ' [' + aicEsc(a.errorCategory) + ']' : '') + '</td><td>' + aicEsc(String(a.result || '').slice(0, 120)) + '</td><td>' + aicEsc(a.approval) + '</td></tr>';
        }).join('');
      } catch (e) { body.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:#fbbf24;">Activity could not be read.</td></tr>'; }
    }
    async function loadAiUsage() {
      var body = document.getElementById('aic-usage-body');
      var sum = document.getElementById('aic-usage-summary');
      try {
        var q = '';
        var from = document.getElementById('aic-usage-from').value.trim();
        var to = document.getElementById('aic-usage-to').value.trim();
        if (from) q += (q ? '&' : '?') + 'from=' + encodeURIComponent(from);
        if (to) q += (q ? '&' : '?') + 'to=' + encodeURIComponent(to);
        var res = await fetch('/api/v1/ai-center/usage' + q);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        var s = data.summary || {};
        var cost = (s.estimatedUsd != null && s.estimatedUsd !== 0) ? ('$' + s.estimatedUsd) : 'Unknown';
        sum.innerHTML = 'Requests <b>' + s.total + '</b> (ok ' + s.successful + ' / failed ' + s.failed + ') · in ' + s.inputTokens + ' / out ' + s.outputTokens + ' tokens' +
          (s.cachedTokens ? ' (cached ' + s.cachedTokens + ')' : '') + (s.reasoningTokens ? ' (reasoning ' + s.reasoningTokens + ')' : '') +
          ' · est. cost <b>' + cost + '</b>' + (s.unknownPricing ? ' (' + s.unknownPricing + ' without pricing)' : '') +
          ' · avg latency ' + (s.avgLatencyMs == null ? '—' : s.avgLatencyMs + ' ms');
        var rows = data.records || [];
        if (rows.length === 0) { body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--muted);">No usage records in this range.</td></tr>'; return; }
        body.innerHTML = rows.map(function (r) {
          var tok = (r.inputTokens == null ? '?' : r.inputTokens) + ' / ' + (r.outputTokens == null ? '?' : r.outputTokens);
          var usd = r.estimatedUsd == null ? 'Unknown' : ('$' + r.estimatedUsd);
          var st = r.ok ? 'ok' : ('failed [' + aicEsc(r.errorCategory || 'error') + ']');
          return '<tr><td>' + aicFmtTime(r.at) + '</td><td>' + aicEsc(r.provider) + '</td><td>' + aicEsc(r.model) + '</td><td>' + aicEsc(r.task) + '</td><td>' + tok + '</td><td>' + usd + '</td><td>' + r.latencyMs + ' ms</td><td>' + st + '</td></tr>';
        }).join('');
      } catch (e) {
        body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:#fbbf24;">Usage could not be read.</td></tr>';
        sum.textContent = '';
      }
    }
    async function loadAiMemoryLine() {
      var el = document.getElementById('aic-memory-line');
      try {
        var res = await fetch('/api/v1/ai-memory');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        var procs = data.procedures || [];
        var approved = procs.filter(function (p) { return p.status === 'approved'; }).length;
        var disabled = procs.filter(function (p) { return p.status === 'disabled'; }).length;
        var events = data.events || [];
        el.innerHTML = 'Local mirror: <b>' + approved + '</b> approved, <b>' + disabled + '</b> disabled · ' + events.length + ' recent events · AI assistance ' + (data.assistEnabled ? 'on' : 'off') +
          '. Approvals stay pending until an operator approves them in PostgreSQL.'
      } catch (e) { el.textContent = 'Memory status unavailable.'; }
    }
    </script>


    <!-- KPI Overview -->
    <div class="kpi-grid" id="kpi-overview">
      <div class="kpi-card">
        <div class="kpi-label">Total Claims Tracked</div>
        <div class="kpi-val" id="kpi-total">0</div>
        <div class="kpi-sub">Across all marketplace channels</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Done (Completed)</div>
        <div class="kpi-val" style="color: #10b981;" id="kpi-completed">0</div>
        <div class="kpi-sub">Filed with official ticket ID</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Queued (Waiting)</div>
        <div class="kpi-val" style="color: #f59e0b;" id="kpi-queued">0</div>
        <div class="kpi-sub">Ready for 24/7 bot pickup</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">In Progress</div>
        <div class="kpi-val" style="color: #3b82f6;" id="kpi-inprogress">0</div>
        <div class="kpi-sub" id="active-task-label">Idle / Polling</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Action Required</div>
        <div class="kpi-val" style="color: #ef4444;" id="kpi-failed">0</div>
        <div class="kpi-sub">OTP, CAPTCHA, or Portal Review</div>
      </div>
    </div>

    <!-- Main Content: Claims Table & Live Logs -->
    <div class="content-split" id="claims-pipeline">
      <!-- Claims Table Panel -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">
            <span>Claims Queue Pipeline</span>
            <span style="font-size: 11px; font-weight: normal; color: var(--muted); margin-left: 6px;">(Live synchronization)</span>
          </div>
          <div style="display: flex; gap: 8px;">
            <input type="text" id="search-input" class="form-control" placeholder="Filter Order / AWB..." oninput="filterJobs()" style="width: 170px;" />
            <button class="btn btn-secondary" onclick="loadJobs()">↻ Refresh</button>
          </div>
        </div>

        <div class="tabs">
          <div class="tab active" data-tab="all" onclick="setTab('all')">All Claims</div>
          <div class="tab" data-tab="queued" onclick="setTab('queued')">Queued (<span id="tab-cnt-queued">0</span>)</div>
          <div class="tab" data-tab="processing" onclick="setTab('processing')">In Progress (<span id="tab-cnt-prog">0</span>)</div>
          <div class="tab" data-tab="completed" onclick="setTab('completed')">Done / Completed (<span id="tab-cnt-done">0</span>)</div>
          <div class="tab" data-tab="action" onclick="setTab('action')">Attention Needed</div>
        </div>

        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Order / AWB</th>
                <th>Reason</th>
                <th>Status / Stage</th>
                <th>Marketplace Ticket Ref</th>
                <th>Updated</th>
                <th>Next</th>
              </tr>
            </thead>
            <tbody id="jobs-table-body">
              <tr>
                <td colspan="7" style="text-align: center; padding: 30px; color: var(--muted);">Loading marketplace claims queue...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Live Terminal / Logs Panel -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">
            <span>24/7 Bot Activity &amp; Automation Log</span>
          </div>
          <button class="btn btn-secondary" style="font-size: 11px; padding: 2px 8px;" onclick="clearLogs()">Clear</button>
        </div>
        <div class="terminal-box" id="terminal">
          <div class="log-line">
            <span class="log-time">[Init]</span>
            <span class="log-info">TaskFlow Pro Desktop Bot Initialized. Connecting to live stream...</span>
          </div>
        </div>
      </div>
    </div>
    </div>
  </div>
  </main>

  <script>
    let currentTab = 'all';
    let allJobs = [];
    let panelCache = [];
    let panelsLoaded = false;
    let statusCache = {};
    let followUpData = { loaded: true, rows: [], summary: {} };
    let isRunning = true;

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function setWorkspaceLocked(locked) {
      document.querySelectorAll('header, .top-toolbar, main').forEach((el) => {
        el.inert = locked;
      });
    }

    function showSignedIn(user) {
      document.getElementById('login-gate').hidden = true;
      document.getElementById('sign-out-btn').hidden = false;
      document.getElementById('operator-name').textContent = user && user.name ? user.name : '';
      setWorkspaceLocked(false);
      void loadPortalLogins();
    }

    function showSignedOut() {
      document.getElementById('login-gate').hidden = false;
      document.getElementById('sign-out-btn').hidden = true;
      document.getElementById('operator-name').textContent = '';
      setWorkspaceLocked(true);
    }

    async function loadOperator() {
      try {
        const res = await fetch('/api/operator/session');
        if (!res.ok) {
          showSignedOut();
          return;
        }
        const data = await res.json();
        if (data.signedIn && data.user) showSignedIn(data.user);
        else showSignedOut();
      } catch (err) {
        console.error(err);
      }
    }

    async function submitLogin(event) {
      event.preventDefault();
      const button = document.getElementById('login-submit');
      const error = document.getElementById('login-error');
      error.textContent = '';
      button.disabled = true;
      try {
        const res = await fetch('/api/operator/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(30000),
          body: JSON.stringify({
            email: document.getElementById('login-email').value,
            password: document.getElementById('login-password').value,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          error.textContent = data.error || 'Sign-in failed.';
          return;
        }
        document.getElementById('login-password').value = '';
        showSignedIn(data.user);
        await loadStatus();
      } catch (err) {
        error.textContent = (err && err.name === 'TimeoutError')
          ? 'Sign-in timed out. Check the server connection and try again.'
          : 'Sign-in failed. Check that the claim bot is still running.';
      } finally {
        button.disabled = false;
      }
    }

    async function signOut() {
      if (!confirm('Sign out stops the 24/7 claim bot until someone signs in again. Sign out?')) return;
      await fetch('/api/operator/logout', { method: 'POST' });
      showSignedOut();
      await loadStatus();
    }

    async function loadStatus() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) return;
        const data = await res.json();
        isRunning = data.isRunning;
        statusCache = data;
        document.getElementById('toggle-worker-btn').innerText = isRunning ? '⏸ Pause Bot' : '▶ Start Bot';
        const statusText = !data.signedIn
          ? 'Waiting for sign-in'
          : isRunning
            ? (data.isCurrentlyProcessing ? 'Filing a claim' : '24/7 bot running')
            : 'Bot paused';
        document.getElementById('agent-status-text').innerText = statusText;
        document.getElementById('agent-status-pill').style.background = isRunning ? 'var(--primary-light)' : 'rgba(239, 68, 68, 0.12)';
        document.getElementById('agent-status-pill').style.color = isRunning ? 'var(--primary)' : 'var(--danger)';
        document.getElementById('countdown').innerText = data.nextPollCountdown + 's';
        if (data.activeSummary) {
          document.getElementById('active-task-label').innerText = data.activeSummary;
        } else if (data.activeJobInfo) {
          document.getElementById('active-task-label').innerText = data.activeJobInfo.marketplace + ' #' + data.activeJobInfo.jobId;
        } else {
          document.getElementById('active-task-label').innerText = data.signedIn ? (isRunning ? 'Idle / waiting for the next claim' : 'Paused') : 'Sign in to start';
        }
        renderOverall();
        void loadSupplierBrowser();
      } catch (err) {
        console.error(err);
      }
    }

    async function loadJobs() {
      try {
        const res = await fetch('/api/jobs');
        if (!res.ok) return;
        const data = await res.json();
        allJobs = data.rows || [];
        renderJobs();
      } catch (err) {
        console.error(err);
      }
    }

    async function loadPanels() {
      try {
        const res = await fetch('/api/panels');
        if (!res.ok) return;
        const data = await res.json();
        panelCache = data.panels || [];
        panelsLoaded = true;
        const strip = document.getElementById('panel-strip');
        const dot = { idle: '#10b981', preparing: '#3b82f6', submitting: '#3b82f6', manual_action: '#f59e0b', cooldown: '#ef4444', disabled: '#64748b' };
        const label = { idle: 'Ready', preparing: 'Preparing', submitting: 'Filing', manual_action: 'Needs you', cooldown: 'Cooling down', disabled: 'Off' };
        strip.innerHTML = (data.panels || []).map(p =>
          '<div style="background:#080f0d;border:1px solid ' + (p.sessionSavedAt ? 'rgba(16,185,129,0.45)' : 'var(--line)') + ';border-radius:8px;padding:10px 12px;">' +
          '<div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:' + (dot[p.state] || '#64748b') + ';display:inline-block;"></span>' +
          '<span>' + p.name + '</span>' +
          (p.automated ? '<span style="font-size:10px;color:#6ee7b7;border:1px solid var(--line);border-radius:4px;padding:0 4px;">auto</span>' : '<span style="font-size:10px;color:#fbbf24;border:1px solid var(--line);border-radius:4px;padding:0 4px;">assisted</span>') +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:4px;">' + (label[p.state] || p.state) +
          (p.activeJobId ? ' · job #' + p.activeJobId : '') +
          (p.sessionSavedAt ? ' · cookies ✓' : ' · no cookies') + '</div>' +
          (p.lastResult ? '<div style="font-size:11px;color:#a7f3d0;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + escapeHtml(p.lastResult) + '">' + escapeHtml(p.lastResult) + '</div>' : '') +
          ((p.state === 'manual_action' || p.state === 'cooldown') ? '<button class="btn btn-secondary" style="margin-top:6px;" data-key="' + p.key + '" onclick="clearPanelHold(this.dataset.key)">Rejoin rotation</button>' : '') +
          '</div>'
        ).join('');
        renderOverall();
      } catch (err) {
        console.error(err);
      }
    }

    async function clearPanelHold(key) {
      try {
        await fetch('/api/panels/' + encodeURIComponent(key) + '/clear', { method: 'POST' });
        await loadPanels();
      } catch (err) {
        console.error(err);
      }
    }

    async function loadFollowUps() {
      const body = document.getElementById('followups-table-body');
      try {
        const res = await fetch('/api/follow-ups?pageSize=100');
        if (!res.ok) {
          // Distinguish "sign in" from "could not read". Either way the table must not pretend the ticket list
          // is empty, and the headline must not claim everything is green.
          const payload = await res.json().catch(() => ({}));
          const message = payload.error || ('Ticket follow-ups could not be read (HTTP ' + res.status + ').');
          followUpData = { loaded: false, rows: [], summary: {}, error: message };
          document.getElementById('followup-count').textContent = '(unavailable)';
          body.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:#fbbf24;">' + escapeHtml(message) + '</td></tr>';
          renderOverall();
          return;
        }
        followUpData = await res.json();
        followUpData.loaded = true;
        renderFollowUps();
        renderOverall();
      } catch (err) {
        followUpData = { loaded: false, rows: [], summary: {}, error: 'Ticket follow-ups could not be read.' };
        document.getElementById('followup-count').textContent = '(unavailable)';
        body.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:#fbbf24;">Ticket follow-ups could not be read.</td></tr>';
        renderOverall();
      }
    }

    function followUpState(row) {
      if (row.isActive) {
        if (row.errorStreak > 0) return { text: 'Retrying after a failed check', color: '#fbbf24' };
        return { text: 'Checking every ' + Math.round((row.checkIntervalHours || 48) / 24) + ' day(s)', color: '#6ee7b7' };
      }
      const reasons = {
        ticket_resolved: { text: 'Finished — ticket resolved', color: '#10b981' },
        check_not_supported: { text: 'Paused — this panel has no automatic check yet', color: '#94a3b8' },
        repeated_errors: { text: 'Stopped — the check kept failing', color: '#f87171' },
        max_checks_reached: { text: 'Stopped — check limit reached', color: '#fbbf24' }
      };
      return reasons[row.stopReason] || { text: 'Stopped', color: '#94a3b8' };
    }

    function whenText(iso) {
      if (!iso) return '—';
      const then = new Date(iso).getTime();
      if (!then) return '—';
      const diffMin = Math.round((then - Date.now()) / 60000);
      const abs = Math.abs(diffMin);
      const amount = abs < 60 ? abs + ' min' : (abs < 2880 ? Math.round(abs / 60) + ' h' : Math.round(abs / 1440) + ' d');
      return diffMin >= 0 ? 'in ' + amount : amount + ' ago';
    }

    function renderFollowUps() {
      const rows = followUpData.rows || [];
      const summary = followUpData.summary || {};
      const body = document.getElementById('followups-table-body');
      document.getElementById('followup-count').textContent =
        '(' + (summary.active || 0) + ' tracking · ' + (summary.due || 0) + ' due now · ' + (summary.resolved || 0) + ' resolved)';
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted);">No followed-up tickets yet. A ticket appears here as soon as a claim is filed.</td></tr>';
        return;
      }
      body.innerHTML = rows.map(r => {
        const state = followUpState(r);
        return '<tr>' +
          '<td><strong>' + (r.marketplace || '—') + '</strong><div style="font-size:11px;color:var(--muted);">' + (r.accountName || '') + (r.orderNumber ? ' · ' + r.orderNumber : '') + '</div></td>' +
          '<td><span class="badge" style="background:var(--primary-light);color:var(--primary);font-family:monospace;">' + (r.marketplaceClaimId || '—') + '</span></td>' +
          '<td>' + (r.claimStatus || '—') + (r.statusAtLastCheck ? '<div style="font-size:11px;color:var(--muted);">' + r.statusAtLastCheck + '</div>' : '') + '</td>' +
          '<td>' + whenText(r.lastCheckedAt) + '</td>' +
          '<td>' + (r.isActive ? whenText(r.nextCheckAt) : '—') + '</td>' +
          '<td>' + (r.checkCount || 0) + '</td>' +
          '<td><span style="font-size:11px;color:' + state.color + ';">' + state.text + '</span>' +
          (r.lastError ? '<div style="font-size:11px;color:var(--muted);" title="' + r.lastError.replace(/"/g, '&quot;') + '">' + r.lastError + '</div>' : '') +
          '</td>' +
          '</tr>';
      }).join('');
    }

    let aiMemoryData = { procedures: [], events: [], usage: {}, assistEnabled: false };

    async function loadAiMemory() {
      const body = document.getElementById('aimemory-table-body');
      try {
        const res = await fetch('/api/v1/ai-memory');
        if (!res.ok) {
          document.getElementById('aimemory-count').textContent = '(unavailable)';
          body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#fbbf24;">AI memory could not be read.</td></tr>';
          return;
        }
        aiMemoryData = await res.json();
        renderAiMemory();
      } catch (err) {
        document.getElementById('aimemory-count').textContent = '(unavailable)';
        body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#fbbf24;">AI memory could not be read.</td></tr>';
      }
    }

    function renderAiMemory() {
      const rows = aiMemoryData.procedures || [];
      const usage = aiMemoryData.usage || {};
      const body = document.getElementById('aimemory-table-body');
      document.getElementById('aimemory-count').textContent =
        '(' + rows.filter(r => r.status === 'approved').length + ' approved · ' + rows.length + ' total)';
      document.getElementById('ai-usage-line').textContent =
        'AI assistance ' + (aiMemoryData.assistEnabled ? 'on' : 'off') +
        ' · model calls ' + (usage.calls || 0) + ' · failures ' + (usage.failures || 0) +
        (usage.lastLatencyMs != null ? ' · last call ' + usage.lastLatencyMs + ' ms' : '');
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted);">No approved procedures yet. The worker records verified fixes here after an operator approves them.</td></tr>';
        return;
      }
      const dot = { approved: '#10b981', pending: '#f59e0b', disabled: '#64748b' };
      body.innerHTML = rows.map(r => {
        const color = dot[r.status] || '#94a3b8';
        const canDisable = r.status !== 'disabled';
        return '<tr>' +
          '<td><strong>' + escapeHtml(r.marketplace) + '</strong></td>' +
          '<td>' + escapeHtml(r.title) + '<div style="font-size:11px;color:var(--muted);">' + r.steps.length + ' step(s)</div></td>' +
          '<td style="font-family:monospace;font-size:11px;">' + escapeHtml(r.errorSignature) + '</td>' +
          '<td><span style="font-size:11px;color:' + color + ';">' + escapeHtml(r.status) + '</span></td>' +
          '<td>' + (canDisable ? '<button class="btn btn-danger" type="button" style="padding:4px 10px;" data-id="' + escapeHtml(String(r.id)) + '" onclick="disableAiProcedure(this.dataset.id)">Disable</button>' : '') + '</td>' +
          '</tr>';
      }).join('');
    }

    async function disableAiProcedure(id) {
      const message = document.getElementById('aimemory-message');
      message.style.color = '#a7f3d0';
      message.textContent = 'Updating that procedure...';
      try {
        const res = await fetch('/api/v1/ai-memory/disable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          message.style.color = '#fca5a5';
          message.textContent = data.error || 'Could not disable that procedure.';
          return;
        }
        message.style.color = '#6ee7b7';
        message.textContent = 'Procedure disabled on this PC.';
      } catch (err) {
        message.style.color = '#fca5a5';
        message.textContent = 'Could not reach the claim bot. Check the connection and try again.';
      }
      loadAiMemory();
    }

    function renderOverall() {
      const panels = panelCache || [];
      const follow = followUpData.summary || {};
      const reasons = [];
      if (!statusCache.signedIn) reasons.push('sign in to start the bot');
      else if (!isRunning) reasons.push('the bot is paused');
      const notConnected = panels.filter(p => !p.sessionSavedAt);
      if (notConnected.length) reasons.push('connect ' + notConnected.length + ' panel(s): ' + notConnected.map(p => p.name).join(', '));
      const needsYou = panels.filter(p => p.state === 'manual_action');
      if (needsYou.length) reasons.push(needsYou.map(p => p.name).join(', ') + ' need(s) you in the supplier browser');
      const cooling = panels.filter(p => p.state === 'cooldown');
      if (cooling.length) reasons.push(cooling.map(p => p.name).join(', ') + ' stopped after repeated failures');
      if (follow.withErrors) reasons.push(follow.withErrors + ' ticket check(s) failing');
      if (followUpData && followUpData.loaded === false) reasons.push('ticket follow-ups could not be loaded');
      if (!panelsLoaded && statusCache.signedIn) reasons.push('panel status could not be loaded');

      const dot = document.getElementById('overall-dot');
      const title = document.getElementById('overall-title');
      const detail = document.getElementById('overall-detail');
      if (!panels.length && !statusCache.signedIn) {
        dot.style.background = '#64748b';
        title.textContent = 'Waiting for sign-in';
        detail.textContent = 'Sign in to start the 24/7 claim bot.';
      } else if (reasons.length) {
        dot.style.background = '#f59e0b';
        title.textContent = 'Action required';
        detail.textContent = 'Please ' + reasons.join(' · ') + '.';
      } else {
        dot.style.background = '#10b981';
        title.textContent = 'All panels green';
        detail.textContent = 'Every panel is connected and the bot is ' + (isRunning ? 'running' : 'ready') + '. ' +
          (follow.active || 0) + ' ticket(s) being followed up' + (follow.due ? ', ' + follow.due + ' due now' : '') + '.';
      }

      document.getElementById('overall-chips').innerHTML = panels.map(p => {
        const ready = Boolean(p.sessionSavedAt) && p.state === 'idle';
        const color = ready ? '#10b981' : (!p.sessionSavedAt || p.state === 'manual_action' || p.state === 'cooldown' ? '#f59e0b' : '#3b82f6');
        const text = !p.sessionSavedAt ? 'Connect' : (p.state === 'idle' ? 'Ready' : (p.state === 'manual_action' ? 'Needs you' : (p.state === 'cooldown' ? 'Cooling down' : 'Working')));
        return '<span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;border:1px solid ' + color + '55;background:' + color + '1a;color:' + color + ';">' +
          '<span style="width:7px;height:7px;border-radius:50%;background:' + color + ';display:inline-block;"></span>' + p.name + ' · ' + text + '</span>';
      }).join('');
    }

    function setTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === tab));
      renderJobs();
    }

    function filterJobs() {
      renderJobs();
    }

    function renderJobs() {
      const q = document.getElementById('search-input').value.toLowerCase().trim();
      let filtered = allJobs.filter(j => {
        if (q) {
          const match = (j.orderNumber || '').toLowerCase().includes(q) ||
                        (j.trackingId || '').toLowerCase().includes(q) ||
                        (j.marketplaceClaimId || '').toLowerCase().includes(q) ||
                        (j.marketplace || '').toLowerCase().includes(q);
          if (!match) return false;
        }
        if (currentTab === 'queued') return j.stage === 'queued';
        if (currentTab === 'processing') return ['downloading_media', 'opening_portal', 'filling_form', 'submitting'].includes(j.stage);
        if (currentTab === 'completed') return j.stage === 'completed';
        if (currentTab === 'action') return ['manual_intervention_required', 'failed', 'prepared'].includes(j.stage);
        return true;
      });

      // Update KPI counters
      const total = allJobs.length;
      const completed = allJobs.filter(j => j.stage === 'completed').length;
      const queued = allJobs.filter(j => j.stage === 'queued').length;
      const inprog = allJobs.filter(j => ['downloading_media', 'opening_portal', 'filling_form', 'submitting'].includes(j.stage)).length;
      const failed = allJobs.filter(j => ['manual_intervention_required', 'failed', 'prepared'].includes(j.stage)).length;

      document.getElementById('kpi-total').innerText = total;
      document.getElementById('kpi-completed').innerText = completed;
      document.getElementById('kpi-queued').innerText = queued;
      document.getElementById('kpi-inprogress').innerText = inprog;
      document.getElementById('kpi-failed').innerText = failed;

      document.getElementById('tab-cnt-queued').innerText = queued;
      document.getElementById('tab-cnt-prog').innerText = inprog;
      document.getElementById('tab-cnt-done').innerText = completed;

      const tbody = document.getElementById('jobs-table-body');
      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--muted);">No claims match current filter.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(j => {
        const mpClass = 'badge-' + (j.marketplace || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        let stageClass = 'stage-queued';
        if (j.stage === 'completed') stageClass = 'stage-completed';
        else if (['downloading_media', 'opening_portal', 'filling_form', 'submitting'].includes(j.stage)) stageClass = 'stage-' + j.stage;
        else if (j.stage === 'prepared') stageClass = 'stage-prepared';
        else if (['manual_intervention_required', 'failed'].includes(j.stage)) stageClass = 'stage-manual';

        const jobId = Number(j.id) || 0;
        const reason = String(j.manualActionReason || '').toLowerCase();
        let nextStep = '';
        if (j.stage !== 'completed' && jobId) {
          nextStep += '<button class="btn btn-primary" style="margin: 2px;" onclick="runOneClaim(' + jobId + ')">Run this claim</button>';
        }
        if (reason.includes('login') || reason.includes('otp') || reason.includes('password')) {
          nextStep += '<button class="btn btn-secondary" style="margin: 2px;" data-market="' + String(j.marketplace || "Meesho").replace(/[^a-zA-Z0-9 ]/g, "") + '" onclick="focusLogin(this.dataset.market)">Set up login</button>';
        }
        return '<tr>' +
          '<td><span class="badge ' + mpClass + '">' + escapeHtml(j.marketplace || 'Channel') + '</span></td>' +
          '<td><strong>' + escapeHtml(j.trackingId || j.orderNumber || '—') + '</strong><br><small style="color: var(--muted); font-family: monospace;">' + escapeHtml(j.orderNumber || '') + '</small></td>' +
          '<td>' + escapeHtml(j.claimReason || 'Damaged / Wrong') + '</td>' +
          '<td><span class="badge ' + stageClass + '">' + escapeHtml(j.stage) + '</span>' + (j.manualActionReason ? '<br><small style="color: #fca5a5;">' + escapeHtml(j.manualActionReason) + '</small>' : '') + '</td>' +
          '<td>' + (j.marketplaceClaimId ? '<strong style="color: #34d399; font-family: monospace;">' + escapeHtml(j.marketplaceClaimId) + '</strong>' : '<span style="color: var(--muted);">Pending Submit</span>') + '</td>' +
          '<td><small style="color: var(--muted);">' + (j.updatedAt ? new Date(j.updatedAt).toLocaleTimeString('en-IN') : '—') + '</small></td>' +
          '<td>' + (nextStep || '—') + '</td>' +
        '</tr>';
      }).join('');
    }

    let workerBusy = false;
    async function toggleWorker() {
      // Send the desired action, not a blind toggle, so the server sets the state the operator saw
      // when they clicked, even if another client changed it in between.
      if (workerBusy) return;
      workerBusy = true;
      try {
        const action = isRunning ? 'pause' : 'start';
        const res = await fetch('/api/scheduler/toggle?action=' + action, { method: 'POST' });
        if (!res.ok) {
          document.getElementById('agent-status-text').innerText = 'Worker control failed (HTTP ' + res.status + ').';
        }
      } catch (err) {
        document.getElementById('agent-status-text').innerText = 'Worker control failed (offline?).';
      } finally {
        workerBusy = false;
        await loadStatus();
      }
    }

    async function pollNow() {
      if (workerBusy) return;
      workerBusy = true;
      try {
        const res = await fetch('/api/scheduler/poll-now', { method: 'POST' });
        if (!res.ok) {
          document.getElementById('agent-status-text').innerText = 'Poll failed (HTTP ' + res.status + ').';
        }
      } catch (err) {
        document.getElementById('agent-status-text').innerText = 'Poll failed (offline?).';
      } finally {
        workerBusy = false;
        await loadStatus();
        await loadJobs();
      }
    }

    async function updateBackendUrl() {
      const url = document.getElementById('backend-url-input').value.trim();
      if (!url) return;
      const resultSpan = document.getElementById('ping-result');
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ backendUrl: url })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          resultSpan.innerText = '[X] ' + (data.error || 'Server was not changed.');
          resultSpan.style.color = '#f87171';
          return;
        }
        document.getElementById('gate-backend-url-input').value = data.config.backendUrl;
        document.getElementById('gate-backend-url').innerText = data.config.backendUrl;
        if (data.signedOut) {
          resultSpan.innerText = '[OK] Server changed. Sign in again to the new server.';
          resultSpan.style.color = '#34d399';
          showSignedOut();
          await loadStatus();
          return;
        }
        testBackendConnection();
      } catch (err) {
        resultSpan.innerText = '[X] Connection failed';
        resultSpan.style.color = '#f87171';
      }
    }
    async function gateTestConnection() {
      const out = document.getElementById('gate-result');
      out.innerText = 'Pinging...';
      try {
        const res = await fetch('/api/test-connection');
        const data = await res.json();
        out.innerText = data.ok ? '[OK] Connected (' + data.latencyMs + 'ms)' : '[X] ' + (data.message || 'No connection');
      } catch (err) {
        out.innerText = '[X] Connection failed';
      }
    }
    async function gateApplyBackendUrl() {
      const input = document.getElementById('gate-backend-url-input');
      const out = document.getElementById('gate-result');
      const url = input.value.trim();
      if (!url) return;
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ backendUrl: url })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          out.innerText = '[X] ' + (data.error || 'Server was not changed.');
          return;
        }
        document.getElementById('backend-url-input').value = data.config.backendUrl;
        input.value = data.config.backendUrl;
        document.getElementById('gate-backend-url').innerText = data.config.backendUrl;
        showSignedOut();
        await loadStatus();
        await gateTestConnection();
        out.innerText = '[OK] Server changed. Sign in to the new server above.';
      } catch (err) {
        out.innerText = '[X] Connection failed';
      }
    }

    async function testBackendConnection() {
      const resultSpan = document.getElementById('ping-result');
      resultSpan.innerText = 'Pinging...';
      resultSpan.style.color = 'var(--muted)';
      try {
        const res = await fetch('/api/test-connection');
        const data = await res.json();
        if (data.ok) {
          resultSpan.innerText = '✓ Connected (' + data.latencyMs + 'ms)';
          resultSpan.style.color = '#34d399';
        } else {
          resultSpan.innerText = '✕ ' + data.message;
          resultSpan.style.color = '#f87171';
        }
      } catch (err) {
        resultSpan.innerText = '✕ Connection Failed';
        resultSpan.style.color = '#f87171';
      }
    }

    function focusLogin(marketplace) {
      showSideTab('setup');
      const panel = document.getElementById('portal-setup');
      if (marketplace) {
        const select = document.getElementById('portal-marketplace');
        const match = Array.from(select.options).find((option) => marketplace.toLowerCase().includes(option.value.toLowerCase()));
        if (match) select.value = match.value;
      }
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.getElementById('portal-username').focus();
    }

    async function loadPortalLogins() {
      const status = document.getElementById('portal-status');
      try {
        const res = await fetch('/api/portal-logins');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          status.textContent = data.error || 'Supplier login status is unavailable.';
          return;
        }
        status.textContent = (data.channels || []).map((channel) => channel.name + ': ' + (channel.configured ? 'ID saved' : 'no ID') + (channel.sessionSavedAt ? ', cookies saved' : ', cookies not saved')).join(' · ');
        renderOnboarding(data.channels || []);
      } catch (err) {
        status.textContent = '';
      }
    }

    function renderOnboarding(channels) {
      const section = document.getElementById('onboarding');
      const box = document.getElementById('onboarding-steps');
      if (!channels.length) {
        section.style.display = 'none';
        return;
      }
      const done = channels.filter((c) => c.sessionSavedAt).length;
      document.getElementById('onboarding-count').textContent = '(' + done + ' of ' + channels.length + ' connected)';
      if (done === channels.length) {
        box.innerHTML = '<div style="font-size:12px;color:#6ee7b7;">✓ All panels connected. If a panel signs out or its cookies expire, its Connect button reappears here.</div>';
        return;
      }
      box.innerHTML = channels.map((c, i) => {
        const ready = Boolean(c.sessionSavedAt);
        const state = ready ? '✓ Connected — cookies saved' : (c.configured ? 'ID saved — sign in again to refresh the session' : 'Not connected');
        const color = ready ? '#6ee7b7' : (c.configured ? '#fbbf24' : 'var(--muted)');
        return '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:#080f0d;border:1px solid var(--line);border-radius:8px;padding:8px 12px;">' +
          '<span style="font-size:12px;font-weight:700;min-width:150px;">' + (i + 1) + '. ' + c.name + '</span>' +
          '<span style="font-size:11px;color:' + color + ';flex:1;min-width:200px;">' + state + '</span>' +
          (ready
            ? '<button class="btn btn-secondary" type="button" data-name="' + c.name + '" onclick="wizardSelect(this.dataset.name, true)">Reconnect</button>'
            : '<button class="btn btn-primary" type="button" data-name="' + c.name + '" data-configured="' + (c.configured ? '1' : '') + '" onclick="wizardSelect(this.dataset.name, this.dataset.configured)">Connect</button>') +
          '</div>';
      }).join('');
    }

    async function wizardSelect(name, configured) {
      const select = document.getElementById('portal-marketplace');
      const match = Array.from(select.options).find((option) => name.toLowerCase().includes(option.value.toLowerCase()));
      if (match) select.value = match.value;
      if (configured) {
        await testPortal();
        await loadPortalLogins();
      } else {
        focusLogin(name);
      }
    }

    async function loadSecurityLine() {
      const line = document.getElementById('security-line');
      try {
        const res = await fetch('/api/security');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return;
        line.textContent = (data.osCredentialStore ? '🔒 Credentials encrypted (OS store). ' : '⚠️ Credentials in local files (OS store unavailable). ') + (data.detail || '');
      } catch {
        line.textContent = '';
      }
    }

    function updateDownloadPick(list) {
      const wantExt = '.exe';
      return (list.find((d) => (d.name || '').toLowerCase().endsWith(wantExt)) || list[0]) || null;
    }
    function renderUpdateState(data) {
      const out = document.getElementById('update-result');
      const cur = document.getElementById('updates-current');
      if (cur) cur.textContent = 'This app: ' + (data.currentVersion || '?');
      const line = document.getElementById('updates-checked-line');
      if (line) line.textContent = 'Last checked: ' + new Date().toLocaleString('en-IN', { hour12: false });
      if (!data.updateAvailable) {
        out.textContent = 'Up to date (this app: ' + (data.currentVersion || '?') + ').';
        hideUpdateBanner();
        return;
      }
      const best = updateDownloadPick(data.downloads || []);
      out.innerHTML = 'Update available: ' + data.latestTag +
        (best ? ' — <a href="' + best.url + '" target="_blank" rel="noopener" style="color:var(--primary);font-weight:700;">Download ' + best.name + '</a>' : '') +
        ' (install it over this version; supplier cookies are kept).';
      showUpdateBanner(data.latestTag, best);
    }
    function showUpdateBanner(tag, best) {
      try {
        if (localStorage.getItem('ra-update-dismissed') === String(tag)) return;
      } catch {}
      const bar = document.getElementById('update-banner');
      const txt = document.getElementById('update-banner-text');
      const link = document.getElementById('update-banner-link');
      if (!bar || !txt || !link) return;
      txt.textContent = 'Update available: ' + tag + ' — install it over this version; supplier cookies are kept.';
      if (best) { link.href = best.url; link.textContent = 'Download ' + (best.name || tag); link.style.display = ''; }
      else link.style.display = 'none';
      bar.hidden = false;
    }
    function hideUpdateBanner() {
      const bar = document.getElementById('update-banner');
      if (bar) bar.hidden = true;
    }
    function dismissUpdateBanner() {
      try {
        const txt = document.getElementById('update-banner-text').textContent || '';
        const m = txt.match(/Update available: (\\S+)/);
        if (m) localStorage.setItem('ra-update-dismissed', m[1]);
      } catch {}
      hideUpdateBanner();
    }
    function autoUpdatesOn() {
      try { return localStorage.getItem('ra-auto-updates') !== '0'; } catch { return true; }
    }
    function toggleAutoUpdates() {
      try { localStorage.setItem('ra-auto-updates', document.getElementById('updates-auto').checked ? '1' : '0'); } catch {}
    }
    async function fetchUpdateState() {
      const res = await fetch('/api/updates/check');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Update check needs sign-in.');
      return data;
    }
    async function checkUpdates() {
      const out = document.getElementById('update-result');
      out.textContent = 'Checking…';
      try {
        renderUpdateState(await fetchUpdateState());
      } catch {
        out.textContent = 'Update check failed (offline?).';
      }
    }
    async function checkUpdatesQuiet() {
      if (!autoUpdatesOn()) return;
      try {
        renderUpdateState(await fetchUpdateState());
      } catch {
        /* silent: manual Check now surfaces errors */
      }
    }
    function bootUpdateChecker() {
      try {
        const box = document.getElementById('updates-auto');
        if (box) box.checked = autoUpdatesOn();
      } catch {}
      paintThemeLabel();
      setTimeout(checkUpdatesQuiet, 30000);
      setInterval(checkUpdatesQuiet, 6 * 60 * 60 * 1000);
    }
    function toggleTheme() {
      try {
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('ra-theme', next);
      } catch {}
      paintThemeLabel();
    }
    function paintThemeLabel() {
      const btn = document.getElementById('theme-btn');
      if (btn) btn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? 'Light' : 'Dark';
    }
    var SIDE_TABS = {
      'status': ['overall-status', 'kpi-overview'],
      'claims': ['panel-queue', 'claims-pipeline'],
      'browsers': ['browsers-panel'],
      'follow-ups': ['follow-ups'],
      'ai': ['ai-memory', 'ai-center'],
      'setup': ['onboarding', 'portal-setup'],
      'updates': ['updates']
    };
    function sideTabFromHash() {
      const h = (location.hash || '').replace(/^#\\/?/, '');
      return SIDE_TABS[h] ? h : null;
    }
    var browserWorkspaceFullscreen = false;
    function isBrowsersTabActive() {
      var btn = document.querySelector('#sidebar .side-btn[data-side="browsers"]');
      return Boolean(btn && btn.classList.contains('active'));
    }
    function openBrowsersWorkspace() {
      showSideTab('browsers');
    }
    function expandBrowserFullscreen() {
      // Explicit user trigger only: fullscreen is never entered by polling.
      browserWorkspaceFullscreen = true;
      try {
        var bridge = window.desktopApp && window.desktopApp.setBrowserFullscreen;
        if (typeof bridge === 'function') bridge(true);
      } catch {}
      syncBrowserFullscreen();
      reportBrowserWorkspace();
    }
    function exitBrowserFullscreen() {
      browserWorkspaceFullscreen = false;
      try {
        var bridge = window.desktopApp && window.desktopApp.setBrowserFullscreen;
        if (typeof bridge === 'function') bridge(false);
      } catch {}
      syncBrowserFullscreen();
      reportBrowserWorkspace();
    }
    function syncBrowserFullscreen() {
      document.body.classList.toggle('browser-fullscreen', browserWorkspaceFullscreen);
      var label = document.getElementById('browser-exit-label');
      if (label) label.textContent = browserWorkspaceFullscreen ? 'Supplier browser expanded — press Esc or Exit Fullscreen to return' : 'Supplier browser expanded';
    }
    function showSideTab(name, skipHash) {
      if (!SIDE_TABS[name]) name = 'status';
      Object.keys(SIDE_TABS).forEach(function (tab) {
        const on = tab === name;
        SIDE_TABS[tab].forEach(function (id) {
          const el = document.getElementById(id);
          if (el) el.style.display = on ? '' : 'none';
        });
      });
      document.querySelectorAll('#sidebar .side-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-side') === name);
      });
      try { localStorage.setItem('ra-side-tab', name); } catch {}
      if (!skipHash) { try { history.replaceState(null, '', '#' + name); } catch {} }
      // Leaving Browsers hides the native view (session preserved); returning
      // re-measures the viewport and restores it at bounded coordinates.
      if (name !== 'browsers' && browserWorkspaceFullscreen) exitBrowserFullscreen();
      else reportBrowserWorkspace();
    }
    async function savePortal() {
      const message = document.getElementById('portal-message');
      message.style.color = '#a7f3d0';
      message.textContent = 'Saving the supplier login...';
      try {
      const res = await fetch('/api/portal-logins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplace: document.getElementById('portal-marketplace').value,
          username: document.getElementById('portal-username').value,
          password: document.getElementById('portal-password').value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        message.textContent = data.error || 'Could not save the supplier login.';
        return;
      }
      document.getElementById('portal-password').value = '';
      message.style.color = '#6ee7b7';
      message.textContent = 'Supplier login saved. Test it, then run the waiting claim.';
      await loadPortalLogins();
      } catch (err) {
        message.style.color = '#fca5a5';
        message.textContent = 'Could not reach the claim bot. Check the connection and try again.';
      }
    }

    async function testPortal() {
      const message = document.getElementById('portal-message');
      message.style.color = '#a7f3d0';
      message.textContent = 'Opening the supplier login...';
      try {
      const res = await fetch('/api/portal-logins/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplace: document.getElementById('portal-marketplace').value,
          username: document.getElementById('portal-username').value,
          password: document.getElementById('portal-password').value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      message.style.color = res.ok ? '#6ee7b7' : '#fca5a5';
      message.textContent = data.message || data.error || 'Could not open the supplier login.';
      } catch (err) {
        message.style.color = '#fca5a5';
        message.textContent = 'Could not reach the claim bot. Check the connection and try again.';
      }
    }

    // The native supplier view shares the window with the dashboard. The shell
    // fits the view to the Browsers viewport rect; null hides the view while
    // preserving its session. Only the Browsers sidebar tab reports a rect.
    function reportBrowserWorkspace() {
      try {
        const bridge = window.desktopApp && window.desktopApp.setBrowserWorkspaceRect;
        if (typeof bridge !== 'function') return;
        if (!isBrowsersTabActive()) { bridge(null); return; }
        if (browserWorkspaceFullscreen) return;
        if (!document.body.classList.contains('supplier-browser-open')) { bridge(null); return; }
        const el = document.getElementById('browser-workspace-viewport');
        if (!el) { bridge(null); return; }
        const r = el.getBoundingClientRect();
        if (r.width < 120 || r.height < 120) { bridge(null); return; }
        bridge({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
      } catch { /* the dashboard must never break on IPC */ }
    }

    function renderBrowserTabs(views) {
      var strip = document.getElementById('browser-tab-strip');
      if (!strip) return;
      if (!views || views.length === 0) {
        strip.innerHTML = '<span style="font-size:12px;color:var(--muted);">No supplier pages open.</span>';
        return;
      }
      strip.innerHTML = views.map(function (v) {
        return '<span class="browser-tab-pill' + (v.visible ? ' active' : '') + '" role="tab">' +
          escapeHtml(v.panelKey) + (v.visible ? ' · open' : '') + '</span>';
      }).join('');
    }

    // Flicker-free poll: layout state is updated in place only after
    // fetch('/api/portal-browser') resolves — never cleared beforehand.
    async function loadSupplierBrowser() {
      const row = document.getElementById('supplier-browser-row');
      const status = document.getElementById('supplier-browser-status');
      const viewport = document.getElementById('browser-workspace-viewport');
      const claimBar = document.getElementById('browser-claim-status');
      try {
        const res = await fetch('/api/portal-browser');
        if (!res.ok) {
          if (row) row.style.display = 'none';
          renderBrowserTabs([]);
          reportBrowserWorkspace();
          return;
        }
        const data = await res.json();
        const views = data.views || [];
        if (row) row.style.display = views.length === 0 ? 'none' : 'flex';
        if (status) {
          const visible = views.filter((v) => v.visible);
          status.textContent = views.length === 0
            ? 'Supplier browser: dashboard'
            : visible.length > 0
              ? 'Supplier browser: ' + visible.map((v) => v.panelKey).join(', ') + ' (inside this window)'
              : 'Supplier browser: hidden (sessions kept)';
        }
        renderBrowserTabs(views);
        const open = views.filter((v) => v.visible);
        if (viewport) {
          viewport.textContent = open.length > 0
            ? 'Supplier browser is shown in this area: ' + open.map((v) => v.panelKey).join(', ')
            : (views.length > 0 ? 'Supplier browser is hidden. Show it to continue, or switch back to Browsers.' : 'No supplier browser is open. Use Settings to sign in to a marketplace, then open it here.');
        }
        if (claimBar) {
          claimBar.textContent = open.length > 0
            ? 'Open: ' + open.map((v) => v.panelKey).join(', ') + ' — session preserved across tabs.'
            : 'Idle — no supplier page open.';
        }
        document.body.classList.toggle('supplier-browser-open', views.length > 0);
        reportBrowserWorkspace();
      } catch {
        if (row) row.style.display = 'none';
        renderBrowserTabs([]);
        reportBrowserWorkspace();
      }
    }

    async function showSupplierBrowser() {
      const message = document.getElementById('portal-browser-message');
      message.style.color = '#a7f3d0';
      message.textContent = 'Opening the supplier browser inside this window...';
      try {
      const res = await fetch('/api/portal-browser/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketplace: document.getElementById('portal-marketplace').value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        message.style.color = '#fca5a5';
        message.textContent = data.error || 'No open supplier browser for that marketplace.';
        return;
      }
      message.style.color = '#6ee7b7';
      message.textContent = 'Supplier browser is open inside this window.';
      await loadSupplierBrowser();
      } catch (err) {
        message.style.color = '#fca5a5';
        message.textContent = 'Could not reach the claim bot. Check the connection and try again.';
      }
    }

    async function hideSupplierBrowser() {
      const message = document.getElementById('portal-browser-message');
      try {
      const res = await fetch('/api/portal-browser/hide', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      message.style.color = '#6ee7b7';
      message.textContent = (data.hidden || []).length > 0 ? 'Supplier browser hidden; the session stays saved.' : 'No supplier browser is open.';
      await loadSupplierBrowser();
      } catch (err) {
        message.style.color = '#fca5a5';
        message.textContent = 'Could not reach the claim bot. Check the connection and try again.';
      }
    }

    async function runOneClaim(jobId) {
      const message = document.getElementById('portal-message');
      message.style.color = '#a7f3d0';
      message.textContent = 'Queuing that one claim...';
      const res = await fetch('/api/jobs/run-one', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json().catch(() => ({}));
      message.style.color = res.ok ? '#6ee7b7' : '#fca5a5';
      message.textContent = data.message || data.error || (res.ok ? 'That claim is running.' : 'Could not run that claim.');
      await loadJobs();
      await loadStatus();
    }

    function clearLogs() {
      document.getElementById('terminal').innerHTML = '';
    }

    function appendLog(entry) {
      const term = document.getElementById('terminal');
      const div = document.createElement('div');
      div.className = 'log-line';
      const timeStr = entry.timestamp ? entry.timestamp.split('T')[1].split('.')[0] : '';
      const safeLevel = ['info', 'warn', 'error', 'debug'].includes(entry.level) ? entry.level : 'info';
      div.innerHTML = '<span class="log-time">[' + escapeHtml(timeStr) + ']</span> <span class="log-' + safeLevel + '">' + escapeHtml(entry.message) + '</span>';
      term.appendChild(div);
      term.scrollTop = term.scrollHeight;
    }

    // Connect SSE for live logs
    function connectSse() {
      const evt = new EventSource('/api/logs/stream');
      evt.onmessage = function(e) {
        try {
          const entry = JSON.parse(e.data);
          appendLog(entry);
        } catch {}
      };
      evt.onerror = function() {
        setTimeout(connectSse, 5000);
      };
    }

    // Initial load
    showSideTab(sideTabFromHash() || (function () { try { return localStorage.getItem('ra-side-tab'); } catch (e) { return null; } })() || 'status', true);
    loadOperator();
    loadPortalLogins();
    loadSecurityLine();
    loadStatus();
    loadJobs();
    loadPanels();
    loadFollowUps();
    loadAiMemory();
    loadAiCenter();
    loadSupplierBrowser();
    // Keep the native view aligned with the bounded viewport across window
    // resizes, moves, maximize/restore transitions, and DPI scaling.
    window.addEventListener('resize', reportBrowserWorkspace);
    window.addEventListener('scroll', reportBrowserWorkspace, true);
    if (typeof ResizeObserver !== 'undefined') {
      var viewportEl = document.getElementById('browser-workspace-viewport');
      if (viewportEl) {
        var viewportObserver = new ResizeObserver(function () { reportBrowserWorkspace(); });
        viewportObserver.observe(viewportEl);
      }
    }
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && browserWorkspaceFullscreen) exitBrowserFullscreen();
    });
    document.addEventListener('fullscreenchange', function () { reportBrowserWorkspace(); });
    try {
      var mediaQuery = window.matchMedia('(resolution: 1dppx)');
      if (mediaQuery && typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', function () { reportBrowserWorkspace(); });
      }
    } catch {}
    connectSse();
    bootUpdateChecker();
    setInterval(loadStatus, 2000);
    setInterval(loadJobs, 10000);
    setInterval(loadPanels, 5000);
    setInterval(loadPortalLogins, 30000);
    setInterval(loadFollowUps, 60000);
    setInterval(loadAiMemory, 60000);
    setInterval(loadAiCenter, 60000);
  </script>
</body>
</html>`
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP API & Static Server
// ---------------------------------------------------------------------------------------------------------------

let operatorSignedIn = false
let portalLoginBusy = false

function canRunClaimBot(role: string): boolean {
  const normalized = role.trim().toLowerCase()
  return normalized === "admin" || normalized === "supervisor"
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk: Buffer | string) => {
      body += chunk
      if (body.length > 20_000) {
        reject(new Error("Body too large"))
        req.destroy()
      }
    })
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })
}

async function beginClaimWork(): Promise<void> {
  operatorSignedIn = true
  await client.register()
  try {
    const { recoverInterruptedActivity } = await import("./ai-center-store.js")
    const interrupted = recoverInterruptedActivity(agentDataDir())
    if (interrupted > 0) logger.info(`AI Center: marked ${interrupted} unfinished task(s) as interrupted after restart.`)
  } catch {
  }
  startScheduler()
}

export async function resumeClaimBotIfSignedIn(): Promise<boolean> {
  const user = await currentOperator()
  if (!user) {
    operatorSignedIn = false
    logger.info("Claim bot is waiting for sign-in. Return scanning is not opened in this window.")
    return false
  }
  if (!canRunClaimBot(user.role)) {
    operatorSignedIn = false
    logger.warn("The saved user is not an Admin or Supervisor. The claim bot remains paused.")
    return false
  }
  logger.info(`Operator ${user.name} is already signed in. The 24/7 claim bot is starting.`)
  await beginClaimWork()
  return true
}

// ---------------------------------------------------------------------------------------------------------------
// Engine control surface
//
// The Electron shell embeds this module and calls these functions directly.
// A remote client (desktop app pointed at a Linux server) reaches the same
// state through the HTTP routes below. Both read one set of variables, so the
// worker loop, the tray and the dashboard can never disagree.
// ---------------------------------------------------------------------------------------------------------------

export type EngineStatusSnapshot = {
  workerRunning: boolean
  isCurrentlyProcessing: boolean
  activeSummary: string | null
  signedIn: boolean
  backendUrl: string
  agentUuid: string
  agentName: string
  nextPollCountdown: number
  lastHeartbeatTime: string
  lastPollTime: string
  lastFollowUpCheckTime: string
  followUpChecksRun: number
  lastFollowUpResult: string
  activeJobInfo: unknown
  browserAdapter: string
  aiAssist: { enabled: boolean; calls: number; failures: number; lastLatencyMs: number | null; lastModel: string }
  nightlyWindow: { nightlyOnly: boolean; inWindow: boolean; nextWindowStartIso: string; msUntilWindow: number }
}

export function engineStatus(): EngineStatusSnapshot {
  return {
    workerRunning: isWorkerRunning,
    isCurrentlyProcessing,
    activeSummary: activeJobInfo ? `${activeJobInfo.marketplace} #${activeJobInfo.jobId}` : null,
    signedIn: operatorSignedIn,
    backendUrl: config.backendUrl,
    agentUuid: config.agentUuid,
    agentName: config.agentName,
    nextPollCountdown,
    lastHeartbeatTime,
    lastPollTime,
    lastFollowUpCheckTime,
    followUpChecksRun,
    lastFollowUpResult,
    activeJobInfo,
    browserAdapter: describeBrowserAdapter(),
    aiAssist: { enabled: loadAiAssistConfig().enabled, ...aiUsageSnapshot() },
    nightlyWindow: nightlyWindowStatus(new Date()),
  }
}

/** Resume the worker. A no-op until an Admin/Supervisor is signed in. */
export function engineStart(): void {
  if (!operatorSignedIn) return
  startScheduler()
}

/** Pause the worker. It stays resident and resumes on engineStart(). */
export function enginePause(): void {
  isWorkerRunning = false
}

export function engineSetBackendUrl(url: string): void {
  config = saveAgentConfig({ backendUrl: url })
  client = new AgentBackendClient(config)
}

export function engineBindInfo(): EngineBind | null {
  return engineBind
}

export function startDesktopAppServer(bind: EngineBind = resolveEngineBind()): Promise<http.Server> {
  engineBind = bind
  // Long-running process: install the crash guards before anything can throw, so
  // one failed request cannot take the bot down and a fatal error exits cleanly
  // for the supervisor to restart.
  installCrashGuards()
  // Prune the local evidence cache once at startup so an installed engine and a
  // server engine both honour the 24-hour cache rule (AGENTS.md rule 13).
  void client.pruneOldEvidenceFiles().catch(() => undefined)
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)

      // The health probe is the only route that never needs the engine token, so
      // Docker, systemd and load balancers can check liveness without a secret.
      // Keep it to liveness only: on a non-loopback bind anyone who can reach the
      // port sees this, so it must not disclose the backend URL, the operator's
      // sign-in state, or the exact runtime and platform version. Those live on
      // the authenticated /api/v1/engine/info route instead.
      if (url.pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          status: isCurrentlyProcessing ? "busy" : isWorkerRunning ? "running" : "idle",
          uptimeSeconds: Math.round(process.uptime()),
        })
        return
      }

      // Fail-closed: when the engine is reachable off this machine, every route
      // except the health probe needs the bearer token. resolveEngineBind()
      // guarantees a token exists for a non-loopback bind, so this can never be
      // anonymous. Keep this gate above every other /api route.
      if (bind.remoteAccess) {
        const provided = bearerTokenFromHeader(req.headers.authorization)
        if (!engineTokenMatches(provided, bind.authToken)) {
          sendJson(res, 401, { error: "A valid engine token is required." })
          return
        }
      }

      if (url.pathname === "/api/v1/engine/info") {
        sendJson(res, 200, {
          engine: "return-app-automation-engine",
          version: process.env.RETURN_APP_VERSION || "dev",
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          pid: process.pid,
          engineMode: bind.mode,
          bindHost: bind.host,
          bindPort: bind.port,
          uptimeSeconds: Math.round(process.uptime()),
          dataDir: agentDataDir(),
          status: engineStatus(),
          panels: getPanelStatuses(config.userDataDir).map((p) => ({
            key: p.key,
            name: p.name,
            state: p.state,
            automated: p.automated,
            sessionSaved: Boolean(p.sessionSavedAt),
          })),
        })
        return
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(getDashboardHtml())
        return
      }

      if (url.pathname === "/api/status") {
        const status = engineStatus()
        sendJson(res, 200, {
          isRunning: status.workerRunning,
          isCurrentlyProcessing: status.isCurrentlyProcessing,
          activeJobInfo: status.activeJobInfo,
          activeSummary: status.activeSummary,
          nextPollCountdown: status.nextPollCountdown,
          lastHeartbeatTime: status.lastHeartbeatTime,
          lastPollTime: status.lastPollTime,
          lastFollowUpCheckTime: status.lastFollowUpCheckTime,
          followUpChecksRun: status.followUpChecksRun,
          lastFollowUpResult: status.lastFollowUpResult,
          backendUrl: status.backendUrl,
          agentUuid: status.agentUuid,
          agentName: status.agentName,
          signedIn: status.signedIn,
        })
        return
      }

      if (url.pathname === "/api/operator/session" && req.method === "GET") {
        const user = await currentOperator()
        operatorSignedIn = Boolean(user && canRunClaimBot(user.role))
        sendJson(res, 200, { signedIn: operatorSignedIn, user })
        return
      }

      if (url.pathname === "/api/operator/login" && req.method === "POST") {
        try {
          const body = await readJson(req)
          const result = await loginOperator(String(body.email || ""), String(body.password || ""))
          if (!result.ok) {
            sendJson(res, result.status, { error: result.message })
            return
          }
          if (!canRunClaimBot(result.user.role)) {
            await logoutOperator()
            sendJson(res, 403, { error: "Only an Admin or Supervisor can run the Server PC claim bot." })
            return
          }
          logger.info(`Operator ${result.user.name} signed in. Claim bot is running.`)
          await beginClaimWork()
          sendJson(res, 200, { ok: true, user: result.user })
        } catch (error) {
          logger.error("Operator sign-in failed.", error)
          sendJson(res, 400, { error: "Sign-in failed." })
        }
        return
      }

      if (url.pathname === "/api/operator/logout" && req.method === "POST") {
        operatorSignedIn = false
        isWorkerRunning = false
        await logoutOperator()
        logger.info("Operator signed out. Claim bot is paused until the next sign-in.")
        sendJson(res, 200, { ok: true })
        return
      }

      if (url.pathname === "/api/jobs") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before viewing claims." })
          return
        }
        const jobs = await client.getRecentJobs()
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(jobs))
        return
      }

      if (url.pathname === "/api/follow-ups" && req.method === "GET") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before viewing ticket follow-ups." })
          return
        }
        // Pass the real outcome through. A failed read must not look like an empty list, or the dashboard would
        // report "no tickets are tracked" while nothing could actually be read.
        const data = await client.getFollowUps({ pageSize: 100 })
        if (!data.ok) {
          sendJson(res, data.status, { error: data.error })
          return
        }
        sendJson(res, 200, { rows: data.rows, total: data.total, summary: data.summary })
        return
      }

      if (url.pathname === "/api/panels" && req.method === "GET") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before viewing panels." })
          return
        }
        sendJson(res, 200, { panels: getPanelStatuses(config.userDataDir) })
        return
      }

      if (url.pathname.startsWith("/api/panels/") && url.pathname.endsWith("/clear") && req.method === "POST") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before clearing a panel hold." })
          return
        }
        const key = decodeURIComponent(url.pathname.split("/")[3] || "")
        clearPanelHold(key)
        logger.info(`Panel hold cleared by operator: ${key}`)
        sendJson(res, 200, { ok: true, panels: getPanelStatuses(config.userDataDir) })
        return
      }

      if (url.pathname === "/api/scheduler/toggle" && req.method === "POST") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before starting the claim bot." })
          return
        }
        // An optional `action` query parameter lets a remote caller send the desired state instead of a
        // blind toggle, so a stale menu label does not start the worker when the operator meant to pause
        // it (or vice versa) after another client changed the state. Without it, the endpoint toggles.
        const action = url.searchParams.get("action")
        if (action === "start") {
          engineStart()
        } else if (action === "pause") {
          enginePause()
        } else if (isWorkerRunning) {
          enginePause()
        } else {
          engineStart()
        }
        logger.info(action ? `Claim bot ${action === "start" ? "resumed" : "paused"}.` : "Claim bot toggled.")
        sendJson(res, 200, { ok: true, isRunning: isWorkerRunning })
        return
      }

      if (url.pathname === "/api/scheduler/poll-now" && req.method === "POST") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before checking for claims." })
          return
        }
        logger.info("Manual claim check triggered from the desktop bot.")
        // A one-shot check must not resume a paused worker (see engineRunOnceNow).
        void engineRunOnceNow()
        sendJson(res, 200, { ok: true })
        return
      }

      if (url.pathname === "/api/test-connection") {
        // Read-only ping on purpose: a signed-out operator whose backend URL is
        // wrong must be able to see that before signing in.
        const result = await client.testConnection()
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(result))
        return
      }

      if (url.pathname.startsWith("/api/v1/ai-center")) {
        const handled = await handleAiCenterRoute(req, res, url, { operatorSignedIn, dir: agentDataDir(), sendJson, readJson })
        if (handled) return
      }

      if (url.pathname === "/api/v1/ai-memory" && req.method === "GET") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before viewing AI memory." })
          return
        }
        sendJson(res, 200, buildAiMemoryPayload(
          pruneLocalEvents(loadLocalMemory(agentDataDir()), Date.now()),
          aiUsageSnapshot(),
          loadAiAssistConfig().enabled,
        ))
        return
      }

      if (url.pathname === "/api/v1/ai-memory/disable" && req.method === "POST") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before changing AI memory." })
          return
        }
        try {
          const body = await readJson(req)
          const id = String(body.id || "").trim()
          if (!id) {
            sendJson(res, 400, { error: "A procedure id is required." })
            return
          }
          const dir = agentDataDir()
          const current = pruneLocalEvents(loadLocalMemory(dir), Date.now())
          const next = disableLocalProcedure(current, id)
          if (!next.found) {
            sendJson(res, 404, { error: "No cached procedure has that id." })
            return
          }
          saveLocalMemory(dir, next.memory)
          logger.info("AI memory procedure disabled locally by operator: " + id)
          sendJson(res, 200, { ok: true, id, changed: next.changed })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "Could not update AI memory." })
        }
        return
      }

      if (url.pathname === "/api/security") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before viewing security status." })
          return
        }
        sendJson(res, 200, {
          osCredentialStore: localEncryptionAvailable(),
          detail: localEncryptionAvailable()
            ? "Operator token and PC API key are encrypted with the OS credential store on this machine."
            : "OS credential store is not available here; secrets use the local file format. They are encrypted automatically when the packaged app runs.",
        })
        return
      }

      if (url.pathname === "/api/updates/check") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before checking for updates." })
          return
        }
        sendJson(res, 200, await checkForUpdates())
        return
      }

      if (url.pathname === "/api/portal-logins" && req.method === "GET") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before setting up a supplier login." })
          return
        }
        try {
          sendJson(res, 200, await listPortalLogins())
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "Could not load supplier logins." })
        }
        return
      }

      if (url.pathname === "/api/portal-logins" && req.method === "POST") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before saving a supplier login." })
          return
        }
        try {
          const body = await readJson(req)
          const result = await savePortalLogin(String(body.marketplace || ""), String(body.username || ""), String(body.password || ""))
          if (!result.ok) {
            sendJson(res, result.status, { error: result.message })
            return
          }
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "Could not save the supplier login." })
        }
        return
      }

      if (url.pathname === "/api/portal-logins/test" && req.method === "POST") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before testing a supplier login." })
          return
        }
        if (engineBusy()) {
          sendJson(res, 409, { error: "A claim or another login test is running. Wait for it to finish, then test the login." })
          return
        }
        // Two login tests at once would drive the same supplier profile and the
        // same debug port, so the second one gets a 409 above rather than racing.
        portalTestInFlight = true
        // The test needs the supplier profile to itself, so the poller is paused
        // for its duration. Remember whether it was running: a failed test must
        // put the engine back exactly as it was, otherwise a mistyped password
        // would leave a 24/7 bot paused with no obvious cause.
        const wasRunning = isWorkerRunning
        isWorkerRunning = false
        try {
          const body = await readJson(req)
          const result = await testPortalLogin(String(body.marketplace || "Meesho"), String(body.username || ""), String(body.password || ""))
          sendJson(res, result.ok ? 200 : 400, result)
        } catch (error) {
          logger.error("Supplier login test failed.", error)
          sendJson(res, 500, { error: error instanceof Error ? error.message : "Could not open the supplier login." })
        } finally {
          portalTestInFlight = false
          if (wasRunning && operatorSignedIn) {
            engineStart()
          }
        }
        return
      }

      if (url.pathname === "/api/portal-browser" && req.method === "GET") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before viewing the supplier browser." })
          return
        }
        sendJson(res, 200, { views: supplierViewStatus() })
        return
      }

      if (url.pathname === "/api/portal-browser/hide" && req.method === "POST") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before hiding the supplier browser." })
          return
        }
        const hidden = hideSupplierViews()
        sendJson(res, 200, { ok: true, hidden })
        return
      }

      if (url.pathname === "/api/portal-browser/show" && req.method === "POST") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before showing the supplier browser." })
          return
        }
        try {
          const body = await readJson(req)
          const panelKey = panelKeyForMarketplace(String(body.marketplace || ""))
          if (showSupplierView(panelKey)) {
            sendJson(res, 200, { ok: true, panelKey })
          } else {
            sendJson(res, 404, { error: "No open supplier browser for that marketplace. Test the login first." })
          }
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "Could not show the supplier browser." })
        }
        return
      }

      if (url.pathname === "/api/jobs/run-one" && req.method === "POST") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before running a claim." })
          return
        }
        if (supplierProfileInUse()) {
          sendJson(res, 409, { error: "A claim or a supplier login is using the browser profile. Wait for it to finish, then run the claim." })
          return
        }
        try {
          const body = await readJson(req)
          const result = await queueOneClaim(Number(body.jobId))
          if (!result.ok) {
            sendJson(res, result.status, { error: result.message })
            return
          }
          void engineRunOnceNow()
          sendJson(res, 200, { ok: true, message: "That claim is next. The bot will open the supplier panel for it." })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "Could not run that claim." })
        }
        return
      }

      if (url.pathname === "/api/config" && req.method === "POST") {
        let body = ""
        req.on("data", (chunk) => { body += chunk })
        req.on("end", async () => {
          try {
            const data = JSON.parse(body) as { backendUrl?: string }
            const updates = typeof data.backendUrl === "string" ? { backendUrl: data.backendUrl } : {}
            if (updates.backendUrl) {
              // A backend change always signs the operator out first: the saved
              // session token belongs to the old server, and pointing the engine
              // at a different server must never leak it. The operator signs in
              // again, deliberately, to the new server.
              engineSetBackendUrl(updates.backendUrl)
              operatorSignedIn = false
              isWorkerRunning = false
              await logoutOperator()
              logger.info(`Agent backend URL changed. Signed out; new backend: ${config.backendUrl}`)
              const { apiKey: _apiKey, ...publicConfig } = config
              res.writeHead(200, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ ok: true, signedOut: true, config: publicConfig }))
              return
            }
            if (!operatorSignedIn) {
              sendJson(res, 401, { error: "Sign in before changing the engine settings." })
              return
            }
            config = saveAgentConfig(updates)
            client = new AgentBackendClient(config)
            logger.info(`Agent configuration updated. Backend URL: ${config.backendUrl}`)
            if (operatorSignedIn) await client.register()
            const { apiKey: _apiKey, ...publicConfig } = config
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ ok: true, config: publicConfig }))
          } catch (err: any) {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: err?.message || String(err) }))
          }
        })
        return
      }

      if (url.pathname === "/api/logs/stream") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before viewing bot logs." })
          return
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        })
        res.write(": keepalive\n\n")

        for (const log of logger.getRecentLogs()) {
          res.write(`data: ${JSON.stringify(log)}\n\n`)
        }

        sseClients.add(res)
        req.on("close", () => {
          sseClients.delete(res)
        })
        return
      }

      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("Not Found")
    })

    server.once("error", reject)
    server.listen(bind.port, bind.host, () => {
      if (bind.remoteAccess) {
        logger.info(
          `Automation engine listening on ${bind.host}:${bind.port} (remote mode; bearer token required on every route except /api/health).`,
        )
      } else {
        logger.info(`Claim bot window is ready at ${localEngineUrl(bind)}`)
      }
      resolve(server)
    })
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Native App Window Spawner (Chromium --app mode)
// ---------------------------------------------------------------------------------------------------------------

export function launchAppWindow(url: string): void {
  const browserPath = findSystemBrowser()
  if (!browserPath) {
    logger.warn(`No Chromium browser found to open desktop app window. You can open ${url} in your browser.`)
    return
  }

  const args = [
    `--app=${url}`,
    "--window-size=1260,840",
    "--no-first-run",
    "--no-default-browser-check",
  ]

  logger.info(`Launching Desktop App Window via ${path.basename(browserPath)}...`)
  child_process.spawn(browserPath, args, {
    detached: true,
    stdio: "ignore",
  }).unref()
}

// ---------------------------------------------------------------------------------------------------------------
// Main Entrypoint
// ---------------------------------------------------------------------------------------------------------------

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║    TaskFlow Pro · 24/7 Desktop Claim Processing Bot Application       ║
║    Automated Marketplace Return Claims & Evidence Processing Engine   ║
║    GUI Dashboard + Continuous Background Automation Service           ║
╚═══════════════════════════════════════════════════════════════════════╝
`)

  logger.info(`Starting 24/7 Claim Desktop Bot (Backend: ${config.backendUrl})...`)

  const bind = resolveEngineBind()
  await startDesktopAppServer(bind)
  await resumeClaimBotIfSignedIn()

  // A server deployment never opens a window; a desktop run does unless asked not to.
  const isHeadlessArg = process.argv.includes("--no-window") || process.env.HEADLESS === "true"
  if (bind.mode === "local" && !isHeadlessArg) {
    // Use the bound host, not a hardcoded 127.0.0.1: ENGINE_HOST=::1 listens on
    // IPv6 loopback only, where 127.0.0.1 would be refused.
    launchAppWindow(localEngineUrl(bind))
  }
}

if (process.argv[1] && process.argv[1].includes("desktop-app-server")) {
  main().catch((err) => {
    logger.error("Fatal error starting desktop app server:", err)
    process.exit(1)
  })
}
