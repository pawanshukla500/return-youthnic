import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import child_process from "node:child_process"
import { loadAgentConfig, saveAgentConfig, type AgentConfig } from "./config.js"
import { logger } from "./logger.js"
import { AgentBackendClient } from "./agent-client.js"
import { BrowserRunner, findSystemBrowser } from "./browser-runner.js"
import { getAutomationEngine } from "./marketplaces/registry.js"

let config: AgentConfig = loadAgentConfig()
let client = new AgentBackendClient(config)

let isWorkerRunning = true
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

async function pollAndProcessJob(): Promise<void> {
  if (!isWorkerRunning || isCurrentlyProcessing) return
  lastPollTime = new Date().toLocaleTimeString("en-IN")
  nextPollCountdown = Math.round(config.pollIntervalMs / 1000)

  try {
    const poll = await client.pollJob()
    if (!poll.hasJob || !poll.job) return

    isCurrentlyProcessing = true
    const jobHeader = poll.job
    activeJobInfo = jobHeader

    logger.info(`=== Received Claim Job #${jobHeader.jobId} (${jobHeader.marketplace} · AWB/Order: ${jobHeader.trackingId || jobHeader.orderNumber} · Stage: ${jobHeader.stage}) ===`)
    await client.sendHeartbeat("busy", { activeJobId: jobHeader.jobId, marketplace: jobHeader.marketplace })

    const bundle = await client.getExecutionBundle(jobHeader.jobId)
    if (!bundle) {
      logger.error(`Could not retrieve bundle for job #${jobHeader.jobId}. Skipping.`)
      isCurrentlyProcessing = false
      activeJobInfo = null
      return
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
    const profilePath = path.join(config.userDataDir, `profile-${bundle.marketplace.toLowerCase().replace(/[^a-z0-9]/g, "_")}`)

    const browserSession = await browserRunner.launch({
      profileDir: profilePath,
      headless: isHeadless,
    })

    try {
      await browserRunner.connectToPage(browserSession.port)

      const engine = getAutomationEngine(
        bundle.marketplace,
        browserRunner,
        bundle,
        evidenceFilesMap,
        path.join(config.workDir, `claim-${bundle.claimId}`),
      )

      const action = jobHeader.stage === "submitting" ? "submit" : "prepare"
      const result = await engine.execute(action)

      if (result.stage === "prepared") {
        await client.updateProgress(jobHeader.jobId, {
          stage: "prepared",
          logMessage: "Claim prepared on seller portal. Waiting for user approval before submission.",
          screenshotPath: result.screenshotPath,
        })
      } else if (result.stage === "completed") {
        await client.completeJob(jobHeader.jobId, {
          marketplaceClaimId: result.marketplaceClaimId || "CONFIRMED",
          screenshotPath: result.screenshotPath,
        })
        // Clean up local downloaded evidence files so they don't occupy disk space
        await client.cleanClaimEvidenceFiles(bundle.claimId)
      } else if (result.stage === "manual_intervention_required") {
        await client.updateProgress(jobHeader.jobId, {
          stage: "manual_intervention_required",
          logMessage: result.manualActionReason || "Manual action required on portal.",
          screenshotPath: result.screenshotPath,
          manualActionReason: result.manualActionReason,
        })
      }
    } finally {
      await browserRunner.close()
    }
  } catch (err: any) {
    logger.error("Error processing automation job:", err)
  } finally {
    isCurrentlyProcessing = false
    activeJobInfo = null
    await client.sendHeartbeat("online", { status: "idle" })
  }
}

function startScheduler(): void {
  if (pollTimer) clearInterval(pollTimer)
  if (countdownTimer) clearInterval(countdownTimer)

  pollTimer = setInterval(pollAndProcessJob, config.pollIntervalMs)
  countdownTimer = setInterval(() => {
    if (nextPollCountdown > 0) {
      nextPollCountdown--
    } else {
      nextPollCountdown = Math.round(config.pollIntervalMs / 1000)
    }
  }, 1000)

  // Send periodic heartbeat
  setInterval(async () => {
    lastHeartbeatTime = new Date().toLocaleTimeString("en-IN")
    await client.sendHeartbeat("online", { status: isCurrentlyProcessing ? "busy" : "idle", uptime: process.uptime() })
  }, config.heartbeatIntervalMs)

  void pollAndProcessJob()
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
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-icon">🤖</div>
      <div>
        <div class="brand-title">TaskFlow Pro · 24/7 Desktop Claim Processing Bot</div>
        <div class="brand-subtitle">Automated Marketplace Return Claims & Evidence Engine · Server PC Active</div>
      </div>
    </div>
    <div style="display: flex; align-items: center; gap: 12px;">
      <div class="status-pill" id="agent-status-pill">
        <span class="pulse-dot"></span>
        <span id="agent-status-text">24/7 Bot Online</span>
      </div>
    </div>
  </header>

  <div class="top-toolbar">
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
      <button class="btn btn-secondary" onclick="testBrowser()">🖥️ Launch Test Browser</button>
    </div>
  </div>

  <main>
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
              </tr>
            </thead>
            <tbody id="jobs-table-body">
              <tr>
                <td colspan="6" style="text-align: center; padding: 30px; color: var(--muted);">Loading marketplace claims queue...</td>
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

    async function loadStatus() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) return;
        const data = await res.json();
        isRunning = data.isRunning;
        document.getElementById('toggle-worker-btn').innerText = isRunning ? '⏸ Pause Bot' : '▶ Start Bot';
        document.getElementById('agent-status-text').innerText = isRunning ? (data.isCurrentlyProcessing ? '⚡ Filing Claim...' : '24/7 Bot Online') : '⏸ Bot Paused';
        document.getElementById('agent-status-pill').style.background = isRunning ? 'var(--primary-light)' : 'rgba(239, 68, 68, 0.12)';
        document.getElementById('agent-status-pill').style.color = isRunning ? 'var(--primary)' : 'var(--danger)';
        document.getElementById('countdown').innerText = data.nextPollCountdown + 's';
        if (data.activeJobInfo) {
          document.getElementById('active-task-label').innerText = data.activeJobInfo.marketplace + ' #' + data.activeJobInfo.jobId;
        } else {
          document.getElementById('active-task-label').innerText = isRunning ? 'Idle / Polling every 10s' : 'Paused';
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
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--muted);">No claims match current filter.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(j => {
        const mpClass = 'badge-' + (j.marketplace || '').toLowerCase();
        let stageClass = 'stage-queued';
        if (j.stage === 'completed') stageClass = 'stage-completed';
        else if (['downloading_media', 'opening_portal', 'filling_form', 'submitting'].includes(j.stage)) stageClass = 'stage-' + j.stage;
        else if (j.stage === 'prepared') stageClass = 'stage-prepared';
        else if (['manual_intervention_required', 'failed'].includes(j.stage)) stageClass = 'stage-manual';

        return '<tr>' +
          '<td><span class="badge ' + mpClass + '">' + (j.marketplace || 'Channel') + '</span></td>' +
          '<td><strong>' + (j.trackingId || j.orderNumber || '—') + '</strong><br><small style="color: var(--muted); font-family: monospace;">' + (j.orderNumber || '') + '</small></td>' +
          '<td>' + (j.claimReason || 'Damaged / Wrong') + '</td>' +
          '<td><span class="badge ' + stageClass + '">' + j.stage + '</span>' + (j.manualActionReason ? '<br><small style="color: #fca5a5;">' + j.manualActionReason + '</small>' : '') + '</td>' +
          '<td>' + (j.marketplaceClaimId ? '<strong style="color: #34d399; font-family: monospace;">' + j.marketplaceClaimId + '</strong>' : '<span style="color: var(--muted);">Pending Submit</span>') + '</td>' +
          '<td><small style="color: var(--muted);">' + (j.updatedAt ? new Date(j.updatedAt).toLocaleTimeString('en-IN') : '—') + '</small></td>' +
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

    async function testBrowser() {
      alert("Launching system Chromium browser in test mode...");
      await fetch('/api/test-browser', { method: 'POST' });
    }

    function clearLogs() {
      document.getElementById('terminal').innerHTML = '';
    }

    function appendLog(entry) {
      const term = document.getElementById('terminal');
      const div = document.createElement('div');
      div.className = 'log-line';
      const timeStr = entry.timestamp ? entry.timestamp.split('T')[1].split('.')[0] : '';
      div.innerHTML = '<span class="log-time">[' + timeStr + ']</span> <span class="log-' + entry.level + '">' + entry.message + '</span>';
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
    loadStatus();
    loadJobs();
    connectSse();
    setInterval(loadStatus, 2000);
    setInterval(loadJobs, 10000);
  </script>
</body>
</html>`
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP API & Static Server
// ---------------------------------------------------------------------------------------------------------------

export function startDesktopAppServer(port = 3005): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)

      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(getDashboardHtml())
        return
      }

      if (url.pathname === "/api/status") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          isRunning: isWorkerRunning,
          isCurrentlyProcessing,
          activeJobInfo,
          nextPollCountdown,
          lastHeartbeatTime,
          lastPollTime,
          backendUrl: config.backendUrl,
          agentUuid: config.agentUuid,
          agentName: config.agentName,
        }))
        return
      }

      if (url.pathname === "/api/jobs") {
        const jobs = await client.getRecentJobs()
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(jobs))
        return
      }

      if (url.pathname === "/api/scheduler/toggle" && req.method === "POST") {
        isWorkerRunning = !isWorkerRunning
        logger.info(`24/7 Automation Scheduler ${isWorkerRunning ? "RESUMED" : "PAUSED"} by user.`)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, isRunning: isWorkerRunning }))
        return
      }

      if (url.pathname === "/api/scheduler/poll-now" && req.method === "POST") {
        logger.info("Manual poll triggered via Desktop App.")
        void pollAndProcessJob()
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (url.pathname === "/api/test-connection") {
        const result = await client.testConnection()
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(result))
        return
      }

      if (url.pathname === "/api/test-browser" && req.method === "POST") {
        const browserPath = findSystemBrowser()
        if (!browserPath) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: false, message: "No compatible Chromium browser found." }))
          return
        }
        const runner = new BrowserRunner()
        void runner.launch({
          executablePath: browserPath,
          profileDir: path.join(config.userDataDir, "test-profile"),
          headless: false,
        }).then(async (session) => {
          await runner.connectToPage(session.port)
          await runner.navigate("https://www.google.com")
          logger.info("Browser launched and connected successfully!")
        })
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (url.pathname === "/api/config" && req.method === "POST") {
        let body = ""
        req.on("data", (chunk) => { body += chunk })
        req.on("end", async () => {
          try {
            const data = JSON.parse(body)
            config = saveAgentConfig(data)
            client = new AgentBackendClient(config)
            logger.info(`Agent configuration updated. Backend URL: ${config.backendUrl}`)
            await client.register()
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ ok: true, config }))
          } catch (err: any) {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: err?.message || String(err) }))
          }
        })
        return
      }

      if (url.pathname === "/api/logs/stream") {
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

    server.listen(port, "127.0.0.1", () => {
      logger.info(`Desktop App Dashboard server running at http://127.0.0.1:${port}`)
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

  // Register with backend
  await client.register()

  // Start HTTP dashboard server
  const port = 3005
  await startDesktopAppServer(port)

  // Start background worker loop
  startScheduler()

  // Open native desktop app window unless running with --headless or in CI
  const isHeadlessArg = process.argv.includes("--no-window") || process.env.HEADLESS === "true"
  if (!isHeadlessArg) {
    launchAppWindow(`http://127.0.0.1:${port}`)
  }
}

if (process.argv[1] && process.argv[1].includes("desktop-app-server")) {
  main().catch((err) => {
    logger.error("Fatal error starting desktop app server:", err)
    process.exit(1)
  })
}
