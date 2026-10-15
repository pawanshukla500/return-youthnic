import path from "node:path"
import { loadAgentConfig } from "./config.js"
import { logger } from "./logger.js"
import { AgentBackendClient } from "./agent-client.js"
import { BrowserRunner, findSystemBrowser } from "./browser-runner.js"
import { getAutomationEngine } from "./marketplaces/registry.js"

async function main() {
  const args = process.argv.slice(2)
  const isTestBrowser = args.includes("--test-browser")
  const isStatusOnly = args.includes("--status")

  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║    TaskFlow Pro · Windows Desktop Claim Processing Agent v1.0.0      ║
║    Automated Marketplace Return Claims & Evidence Processing Engine   ║
╚═══════════════════════════════════════════════════════════════════════╝
`)

  const config = loadAgentConfig()
  logger.info(`Starting Claim Processing Agent (UUID: ${config.agentUuid}, Backend: ${config.backendUrl})...`)

  if (isTestBrowser) {
    const browserPath = findSystemBrowser()
    logger.info(`Detected System Browser: ${browserPath || "NOT FOUND"}`)
    if (!browserPath) {
      logger.error("No compatible browser (Edge/Chrome) found on this machine.")
      process.exit(1)
    }
    const runner = new BrowserRunner()
    const session = await runner.launch({
      executablePath: browserPath,
      profileDir: path.join(config.userDataDir, "test-profile"),
      headless: false,
    })
    await runner.connectToPage(session.port)
    await runner.navigate("https://www.google.com")
    logger.info("Browser launched and connected successfully! Exiting test.")
    session.browserProcess.kill()
    process.exit(0)
  }

  const client = new AgentBackendClient(config)
  const registered = await client.register()
  if (!registered) {
    logger.error("Could not register with Return App backend. Check backend URL and network connectivity.")
    if (isStatusOnly) process.exit(1)
  }

  if (isStatusOnly) {
    logger.info("Agent status verified. Exiting.")
    process.exit(0)
  }

  // Periodic Heartbeat
  setInterval(async () => {
    await client.sendHeartbeat("online", { status: "idle", uptime: process.uptime() })
  }, config.heartbeatIntervalMs)

  logger.info(`Worker loop started. Polling backend every ${config.pollIntervalMs / 1000}s for marketplace claims...`)

  let isProcessing = false

  const pollAndProcess = async () => {
    if (isProcessing) return
    try {
      const poll = await client.pollJob()
      if (!poll.hasJob || !poll.job) return

      isProcessing = true
      const jobHeader = poll.job
      logger.info(`=== Received Claim Job #${jobHeader.jobId} (${jobHeader.marketplace} · Order: ${jobHeader.orderNumber} · Stage: ${jobHeader.stage}) ===`)

      await client.sendHeartbeat("busy", { activeJobId: jobHeader.jobId, marketplace: jobHeader.marketplace })

      const bundle = await client.getExecutionBundle(jobHeader.jobId)
      if (!bundle) {
        logger.error(`Could not retrieve bundle for job #${jobHeader.jobId}. Skipping.`)
        isProcessing = false
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
      const isHeadless = bundle.automationMode === "headless"
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
        // Do not force kill browser immediately if manual intervention is required, to allow user to see/interact
      }
    } catch (err: any) {
      logger.error("Error processing automation job:", err)
    } finally {
      isProcessing = false
      await client.sendHeartbeat("online", { status: "idle" })
    }
  }

  // Initial poll and recurring poll
  await pollAndProcess()
  setInterval(pollAndProcess, config.pollIntervalMs)

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down Claim Processing Agent...")
    await client.sendHeartbeat("offline", { status: "stopped" })
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  logger.error("Fatal error in agent:", err)
  process.exit(1)
})
