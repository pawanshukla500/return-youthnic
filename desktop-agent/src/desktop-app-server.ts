import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import child_process from "node:child_process"
import { loadAgentConfig, saveAgentConfig, type AgentConfig } from "./config.js"
import { bearerTokenFromHeader, engineTokenMatches, resolveEngineBind, type EngineBind } from "./engine-config.js"
import { agentDataDir } from "./paths.js"
import { logger } from "./logger.js"
import { AgentBackendClient } from "./agent-client.js"
import { BrowserRunner, findSystemBrowser } from "./browser-runner.js"
import { getAutomationEngine } from "./marketplaces/registry.js"
import { currentOperator, loginOperator, logoutOperator } from "./operator-session.js"
import { closePortalLoginBrowser, holdPortalBrowser, listPortalLogins, PORTAL_CHANNELS, profileDirFor, queueOneClaim, readSessionSavedAt, savePortalLogin, testPortalLogin } from "./portal-login.js"
import { clearPanelHold, getPanelStatuses, markPanelBusy, markPanelResult, panelKeyForMarketplace } from "./panel-queue.js"
import { localEncryptionAvailable } from "./local-secrets.js"
import { checkForUpdates } from "./update-check.js"

/**
 * The engine owns exactly one worker loop. The Electron shell embeds this
 * module in-process and drives it through engineStart/enginePause/enginePollNow;
 * a remote client drives the same state over the HTTP routes below. There is no
 * second copy of the loop anywhere.
 */
let engineBind: EngineBind | null = null

let config: AgentConfig = loadAgentConfig()
let client = new AgentBackendClient(config)

let isWorkerRunning = false
let isCurrentlyProcessing = false
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

async function pollAndProcessJob(): Promise<boolean> {
  if (!isWorkerRunning || isCurrentlyProcessing || holdPortalBrowser()) return false
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

    await client.updateProgress(jobHeader.jobId, {
      stage: "downloading_media",
      logMessage: "Agent downloading evidence photos and unboxing videos from cloud storage...",
    })

    const evidenceFilesMap = await client.downloadEvidenceFiles(bundle.claimId, bundle.evidenceFiles)
    logger.info(`Downloaded ${evidenceFilesMap.size} evidence files for Claim #${bundle.claimId}.`)

    // Launch browser
    const browserRunner = new BrowserRunner()
    const isHeadless = config.browserMode === "headless" || bundle.automationMode === "headless"
    const profilePath = profileDirFor(config.userDataDir, bundle.marketplace)

    const browserSession = await browserRunner.launch({
      profileDir: profilePath,
      headless: isHeadless,
    })

    let keepBrowserOpen = false
    try {
      await browserRunner.connectToPage(browserSession.port)

      const engine = getAutomationEngine(
        bundle.marketplace,
        browserRunner,
        bundle,
        evidenceFilesMap,
        path.join(config.workDir, `claim-${bundle.claimId}`),
      )

      const sessionSaved = Boolean(readSessionSavedAt(profileDirFor(config.userDataDir, bundle.marketplace)))
      const action = jobHeader.stage === "submitting" || sessionSaved ? "submit" : "prepare"
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
        // Clean up local downloaded evidence files so they don't occupy disk space
        await client.cleanClaimEvidenceFiles(bundle.claimId)
      } else if (result.stage === "manual_intervention_required") {
        keepBrowserOpen = true
        holdPortalBrowser(browserRunner)
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
        await client.cleanClaimEvidenceFiles(bundle.claimId)
      }
    } finally {
      if (!keepBrowserOpen) await browserRunner.close()
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
    await client.sendHeartbeat("online", { status: "idle" })
  }
  return true
}

let schedulerStarted = false
let idlePolls = 0

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
 * start a second chain.
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
    :root {
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
  </style>
</head>
<body>
  <header inert>
    <div class="brand">
      <div class="brand-icon">🤖</div>
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
    </form>
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
    <section class="panel" id="onboarding" style="padding: 16px 18px;">
      <div class="panel-title" style="margin-bottom: 4px;">First-time setup — connect each supplier panel <span id="onboarding-count" style="font-size: 11px; font-weight: normal; color: var(--muted);"></span></div>
      <p style="color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 12px;">Do one panel at a time. For each marketplace, save the supplier ID and password, then sign in: the supplier page opens in a visible browser window. Complete any OTP or CAPTCHA there yourself — the cookies are saved on this PC so sign-in sticks across restarts. A panel whose session expires drops back to Connect here.</p>
      <div id="onboarding-steps" style="display: grid; gap: 8px;"></div>
      <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 12px; font-size: 12px; color: var(--muted);">
        <span id="security-line">Checking credential storage…</span>
        <button class="btn btn-secondary" type="button" onclick="checkUpdates()">Check for updates</button>
        <span id="update-result"></span>
      </div>
    </section>

    <section class="panel" id="portal-setup" style="padding: 16px 18px;">
      <div class="panel-title" style="margin-bottom: 6px;">Supplier login, then one claim</div>
      <p style="color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 12px;">Do one marketplace at a time. Leave the ID and password blank to use the bot login already saved on the web. Test login opens the system browser, signs in, and stores the cookies on this PC. If a code appears, type it in that window before closing it.</p>
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
    </section>

    <section class="panel" id="panel-queue" style="padding: 16px 18px;">
      <div class="panel-title" style="margin-bottom: 4px;">Panel-wise continuous filing</div>
      <p style="color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 12px;">Each supplier panel keeps its own login cookies and queue. The bot rotates through the ready panels, so one panel waiting on OTP or cooling down never stops the others.</p>
      <div id="panel-strip" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px;"></div>
    </section>

    <!-- KPI Overview -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Total Claims Tracked</div>
        <div class="kpi-val" id="kpi-total">0</div>
        <div class="kpi-sub">Across all marketplace channels</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label" style="color: #6ee7b7;">✓ Done (Completed)</div>
        <div class="kpi-val" style="color: #10b981;" id="kpi-completed">0</div>
        <div class="kpi-sub">Filed with official ticket ID</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label" style="color: #fbbf24;">⏳ Queued (Waiting)</div>
        <div class="kpi-val" style="color: #f59e0b;" id="kpi-queued">0</div>
        <div class="kpi-sub">Ready for 24/7 bot pickup</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label" style="color: #93c5fd;">⚡ In Progress</div>
        <div class="kpi-val" style="color: #3b82f6;" id="kpi-inprogress">0</div>
        <div class="kpi-sub" id="active-task-label">Idle / Polling</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label" style="color: #fca5a5;">⚠️ Action Required</div>
        <div class="kpi-val" style="color: #ef4444;" id="kpi-failed">0</div>
        <div class="kpi-sub">OTP, CAPTCHA, or Portal Review</div>
      </div>
    </div>

    <!-- Main Content: Claims Table & Live Logs -->
    <div class="content-split">
      <!-- Claims Table Panel -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">
            <span>📋 Claims Queue Pipeline</span>
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
            <span>💻 24/7 Bot Activity & Automation Log</span>
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
  </main>

  <script>
    let currentTab = 'all';
    let allJobs = [];
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
        error.textContent = 'Sign-in failed. Check that the claim bot is still running.';
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
        const strip = document.getElementById('panel-strip');
        const dot = { idle: '#10b981', preparing: '#3b82f6', submitting: '#3b82f6', manual_action: '#f59e0b', cooldown: '#ef4444', disabled: '#64748b' };
        const label = { idle: 'Ready', preparing: 'Preparing', submitting: 'Filing', manual_action: 'Needs you', cooldown: 'Cooling down', disabled: 'Off' };
        strip.innerHTML = (data.panels || []).map(p =>
          '<div style="background:#080f0d;border:1px solid var(--line);border-radius:8px;padding:10px 12px;">' +
          '<div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:' + (dot[p.state] || '#64748b') + ';display:inline-block;"></span>' +
          '<span>' + p.name + '</span>' +
          (p.automated ? '<span style="font-size:10px;color:#6ee7b7;border:1px solid var(--line);border-radius:4px;padding:0 4px;">auto</span>' : '<span style="font-size:10px;color:#fbbf24;border:1px solid var(--line);border-radius:4px;padding:0 4px;">assisted</span>') +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:4px;">' + (label[p.state] || p.state) +
          (p.activeJobId ? ' · job #' + p.activeJobId : '') +
          (p.sessionSavedAt ? ' · cookies ✓' : ' · no cookies') + '</div>' +
          (p.lastResult ? '<div style="font-size:11px;color:#a7f3d0;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + p.lastResult.replace(/"/g, '&quot;') + '">' + p.lastResult + '</div>' : '') +
          ((p.state === 'manual_action' || p.state === 'cooldown') ? '<button class="btn btn-secondary" style="margin-top:6px;" data-key="' + p.key + '" onclick="clearPanelHold(this.dataset.key)">Rejoin rotation</button>' : '') +
          '</div>'
        ).join('');
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

    async function toggleWorker() {
      await fetch('/api/scheduler/toggle', { method: 'POST' });
      await loadStatus();
    }

    async function pollNow() {
      await fetch('/api/scheduler/poll-now', { method: 'POST' });
      await loadStatus();
      await loadJobs();
    }

    async function updateBackendUrl() {
      const url = document.getElementById('backend-url-input').value.trim();
      if (!url) return;
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backendUrl: url })
      });
      testBackendConnection();
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

    async function checkUpdates() {
      const out = document.getElementById('update-result');
      out.textContent = 'Checking…';
      try {
        const res = await fetch('/api/updates/check');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          out.textContent = data.error || 'Update check needs sign-in.';
          return;
        }
        if (!data.updateAvailable) {
          out.textContent = 'Up to date (this app: ' + (data.currentVersion || '?') + ').';
          return;
        }
        const list = data.downloads || [];
        const platform = (navigator.platform || '').toLowerCase();
        const wantExt = platform.includes('win') ? '.exe' : (platform.includes('mac') ? '.dmg' : '.deb');
        const best = list.find((d) => (d.name || '').toLowerCase().endsWith(wantExt)) || list[0];
        out.innerHTML = 'Update available: ' + data.latestTag +
          (best ? ' — <a href="' + best.url + '" target="_blank" rel="noopener" style="color:#6ee7b7;font-weight:700;">Download ' + best.name + '</a>' : '') +
          ' (install it over this version; supplier cookies are kept).';
      } catch {
        out.textContent = 'Update check failed (offline?).';
      }
    }

    async function savePortal() {
      const message = document.getElementById('portal-message');
      message.textContent = '';
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
    }

    async function testPortal() {
      const message = document.getElementById('portal-message');
      message.style.color = '#a7f3d0';
      message.textContent = 'Opening the supplier login...';
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
    loadOperator();
    loadPortalLogins();
    loadSecurityLine();
    loadStatus();
    loadJobs();
    loadPanels();
    connectSse();
    setInterval(loadStatus, 2000);
    setInterval(loadJobs, 10000);
    setInterval(loadPanels, 5000);
    setInterval(loadPortalLogins, 30000);
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
  activeJobInfo: unknown
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
    activeJobInfo,
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

/** Check for a claim immediately instead of waiting for the next poll. */
export function enginePollNow(): void {
  if (!operatorSignedIn) return
  isWorkerRunning = true
  idlePolls = 0
  scheduleNextPoll(1000)
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
  // Prune the local evidence cache once at startup so an installed engine and a
  // server engine both honour the 24-hour cache rule (AGENTS.md rule 13).
  void client.pruneOldEvidenceFiles().catch(() => undefined)
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)

      // The health probe is the only route that never needs the engine token, so
      // Docker, systemd and load balancers can check liveness without a secret.
      if (url.pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          status: isCurrentlyProcessing ? "busy" : isWorkerRunning ? "running" : "idle",
          signedIn: operatorSignedIn,
          uptimeSeconds: Math.round(process.uptime()),
          version: process.env.RETURN_APP_VERSION || "dev",
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          engineMode: bind.mode,
          backendUrl: config.backendUrl,
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
        if (isWorkerRunning) {
          enginePause()
          logger.info("Claim bot paused. It stays on this machine and resumes when Start Bot is used.")
        } else {
          engineStart()
          logger.info("Claim bot resumed.")
        }
        sendJson(res, 200, { ok: true, isRunning: isWorkerRunning })
        return
      }

      if (url.pathname === "/api/scheduler/poll-now" && req.method === "POST") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before checking for claims." })
          return
        }
        logger.info("Manual claim check triggered from the desktop bot.")
        enginePollNow()
        sendJson(res, 200, { ok: true })
        return
      }

      if (url.pathname === "/api/test-connection") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before testing the server connection." })
          return
        }
        const result = await client.testConnection()
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(result))
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
        if (isCurrentlyProcessing) {
          sendJson(res, 409, { error: "A claim is running. Wait until it finishes, then test the login." })
          return
        }
        isWorkerRunning = false
        try {
          const body = await readJson(req)
          const result = await testPortalLogin(String(body.marketplace || "Meesho"), String(body.username || ""), String(body.password || ""))
          if (result.ok && operatorSignedIn) {
            engineStart()
          }
          sendJson(res, result.ok ? 200 : 400, result)
        } catch (error) {
          logger.error("Supplier login test failed.", error)
          sendJson(res, 500, { error: error instanceof Error ? error.message : "Could not open the supplier login." })
        }
        return
      }

      if (url.pathname === "/api/jobs/run-one" && req.method === "POST") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before running a claim." })
          return
        }
        if (isCurrentlyProcessing) {
          sendJson(res, 409, { error: "A claim is already running. Let it finish before starting the next one." })
          return
        }
        try {
          const body = await readJson(req)
          const result = await queueOneClaim(Number(body.jobId))
          if (!result.ok) {
            sendJson(res, result.status, { error: result.message })
            return
          }
          enginePollNow()
          sendJson(res, 200, { ok: true, message: "That claim is next. The bot will open the supplier panel for it." })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "Could not run that claim." })
        }
        return
      }

      if (url.pathname === "/api/config" && req.method === "POST") {
        if (!operatorSignedIn) {
          sendJson(res, 401, { error: "Sign in before changing the server connection." })
          return
        }
        let body = ""
        req.on("data", (chunk) => { body += chunk })
        req.on("end", async () => {
          try {
            const data = JSON.parse(body) as { backendUrl?: string }
            const updates = typeof data.backendUrl === "string" ? { backendUrl: data.backendUrl } : {}
            if (updates.backendUrl) {
              engineSetBackendUrl(updates.backendUrl)
            } else {
              config = saveAgentConfig(updates)
              client = new AgentBackendClient(config)
            }
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
        logger.info(`Claim bot window is ready at http://127.0.0.1:${bind.port}`)
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
    launchAppWindow(`http://127.0.0.1:${bind.port}`)
  }
}

if (process.argv[1] && process.argv[1].includes("desktop-app-server")) {
  main().catch((err) => {
    logger.error("Fatal error starting desktop app server:", err)
    process.exit(1)
  })
}
