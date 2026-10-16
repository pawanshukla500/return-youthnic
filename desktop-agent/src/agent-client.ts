import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import type { AgentConfig } from "./config.js"
import { logger } from "./logger.js"

export type JobPollResult = {
  hasJob: boolean
  job?: {
    jobId: number
    claimId: number
    stage: string
    marketplace: string
    orderNumber: string
    trackingId: string
  }
}

export type JobExecutionBundle = {
  jobId: number
  claimId: number
  stage: string
  marketplace: string
  accountName: string
  portalUrl: string
  credentials: { username: string; password: string; authState: Record<string, unknown> }
  automationMode: string
  requireApprovalBeforeSubmit: boolean
  claim: {
    orderNumber: string
    subOrderId: string
    trackingId: string
    packetId: string
    sku: string
    customerName: string
    totalPrice: number
    claimReason: string
    claimTitle: string
    claimDescription: string
    claimContent: string
    remarks: string
  }
  evidenceFiles: Array<{
    id: number
    fieldKey: string
    fieldType: string
    originalFilename: string
    mimeType: string
    sizeBytes: number
    storageObjectPath: string
  }>
}

export class AgentBackendClient {
  private apiKey: string
  private agentId = 0
  private authorized = true

  constructor(private config: AgentConfig) {
    this.apiKey = config.apiKey
  }

  async register(): Promise<boolean> {
    try {
      const url = `${this.config.backendUrl}/api/automation/agent/register`
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentUuid: this.config.agentUuid,
          agentName: this.config.agentName,
          hostname: os.hostname(),
          platform: process.platform,
          version: "1.0.0",
          apiKey: this.apiKey,
        }),
      })

      if (!res.ok) {
        logger.error(`Agent registration failed with status ${res.status}: ${await res.text()}`)
        return false
      }

      const data = (await res.json()) as { agentId: number; apiKey: string; authorized: boolean }
      this.agentId = data.agentId
      this.apiKey = data.apiKey
      this.authorized = data.authorized
      logger.info(`Agent registered successfully (ID: ${this.agentId}, Authorized: ${this.authorized}).`)
      return true
    } catch (err) {
      logger.error("Failed to connect to backend during registration:", err)
      return false
    }
  }

  async sendHeartbeat(status: "online" | "busy" | "offline" | "error", taskInfo: Record<string, unknown> = {}): Promise<void> {
    try {
      const url = `${this.config.backendUrl}/api/automation/agent/heartbeat`
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-UUID": this.config.agentUuid,
        },
        body: JSON.stringify({
          agentUuid: this.config.agentUuid,
          status,
          currentTaskInfo: taskInfo,
        }),
      })
    } catch {
      // Heartbeat silently fails on network jitter
    }
  }

  async pollJob(): Promise<JobPollResult> {
    try {
      const url = `${this.config.backendUrl}/api/automation/agent/poll?agentUuid=${encodeURIComponent(this.config.agentUuid)}`
      const res = await fetch(url, {
        headers: {
          "X-Agent-UUID": this.config.agentUuid,
        },
      })
      if (!res.ok) return { hasJob: false }
      return (await res.json()) as JobPollResult
    } catch (err) {
      logger.debug("Poll job check failed:", err)
      return { hasJob: false }
    }
  }

  async getExecutionBundle(jobId: number): Promise<JobExecutionBundle | null> {
    try {
      const url = `${this.config.backendUrl}/api/automation/jobs/${jobId}/bundle`
      const res = await fetch(url, {
        headers: { "X-Agent-UUID": this.config.agentUuid },
      })
      if (!res.ok) {
        logger.error(`Failed to fetch job bundle (${res.status}): ${await res.text()}`)
        return null
      }
      return (await res.json()) as JobExecutionBundle
    } catch (err) {
      logger.error("Error retrieving job bundle:", err)
      return null
    }
  }

  async downloadEvidenceFiles(claimId: number, files: JobExecutionBundle["evidenceFiles"]): Promise<Map<string, string>> {
    const downloadedMap = new Map<string, string>()
    const claimDir = path.join(this.config.workDir, `claim-${claimId}`)
    if (!fs.existsSync(claimDir)) {
      fs.mkdirSync(claimDir, { recursive: true })
    }

    for (const f of files) {
      const safeName = `${f.fieldKey}_${path.basename(f.originalFilename)}`
      const localPath = path.join(claimDir, safeName)

      if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
        downloadedMap.set(f.fieldKey, localPath)
        continue
      }

      try {
        const mediaUrl = `${this.config.backendUrl}/api/claims/${claimId}/media/${f.id}`
        logger.info(`Downloading evidence file: ${f.fieldKey} (${f.originalFilename})...`)
        const res = await fetch(mediaUrl, {
          headers: { "X-Agent-UUID": this.config.agentUuid },
        })

        if (res.ok) {
          const buffer = Buffer.from(await res.arrayBuffer())
          fs.writeFileSync(localPath, buffer)
          downloadedMap.set(f.fieldKey, localPath)
          logger.info(`Saved ${f.fieldKey} to ${localPath} (${buffer.length} bytes).`)
        } else {
          logger.warn(`Could not download ${f.fieldKey} (${res.status}).`)
        }
      } catch (err) {
        logger.error(`Failed downloading ${f.fieldKey}:`, err)
      }
    }

    return downloadedMap
  }

  async cleanClaimEvidenceFiles(claimId: number): Promise<void> {
    const claimDir = path.join(this.config.workDir, `claim-${claimId}`)
    if (fs.existsSync(claimDir)) {
      try {
        await fs.promises.rm(claimDir, { recursive: true, force: true })
        logger.info(`[Cleanup] Deleted local temporary evidence directory for claim #${claimId}`)
      } catch (err) {
        logger.warn(`[Cleanup] Failed to delete temporary claim directory ${claimDir}:`, err)
      }
    }
  }

  async updateProgress(jobId: number, data: { stage: string; logMessage?: string; screenshotPath?: string; manualActionReason?: string }): Promise<void> {
    try {
      const url = `${this.config.backendUrl}/api/automation/jobs/${jobId}/progress`
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-UUID": this.config.agentUuid },
        body: JSON.stringify(data),
      })
    } catch (err) {
      logger.error("Failed to report progress to backend:", err)
    }
  }

  async completeJob(jobId: number, data: { marketplaceClaimId: string; screenshotPath?: string; notes?: string }): Promise<void> {
    try {
      const url = `${this.config.backendUrl}/api/automation/jobs/${jobId}/complete`
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-UUID": this.config.agentUuid },
        body: JSON.stringify(data),
      })
      logger.info(`Job #${jobId} reported as COMPLETED (Marketplace Ref: ${data.marketplaceClaimId}).`)
    } catch (err) {
      logger.error("Failed to report job completion:", err)
    }
  }
}
