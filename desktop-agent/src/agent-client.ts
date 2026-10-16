import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import type { AgentConfig } from "./config.js"
import { operatorAuthorization } from "./operator-session.js"
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
  private isRegistered = false

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
        this.isRegistered = false
        return false
      }

      const data = (await res.json()) as { agentId: number; apiKey: string; authorized: boolean }
      this.agentId = data.agentId
      this.apiKey = data.apiKey
      this.authorized = data.authorized
      this.isRegistered = true
      logger.info(`Agent registered successfully (ID: ${this.agentId}, Authorized: ${this.authorized}).`)
      return true
    } catch (err) {
      this.isRegistered = false
      logger.error("Failed to connect to backend during registration:", err)
      return false
    }
  }

  async sendHeartbeat(status: "online" | "busy" | "offline" | "error", taskInfo: Record<string, unknown> = {}): Promise<void> {
    if (!this.isRegistered) {
      await this.register()
      if (!this.isRegistered) return
    }
    try {
      const url = `${this.config.backendUrl}/api/automation/agent/heartbeat`
      const res = await fetch(url, {
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
      if (res.status === 401 || res.status === 404) {
        this.isRegistered = false
      }
    } catch {
      // Heartbeat silently fails on network jitter
    }
  }

  async pollJob(): Promise<JobPollResult> {
    if (!this.isRegistered) {
      const ok = await this.register()
      if (!ok) return { hasJob: false }
    }
    try {
      const url = `${this.config.backendUrl}/api/automation/agent/poll?agentUuid=${encodeURIComponent(this.config.agentUuid)}`
      const res = await fetch(url, {
        headers: {
          "X-Agent-UUID": this.config.agentUuid,
        },
      })
      if (!res.ok) {
        if (res.status === 401 || res.status === 404) {
          this.isRegistered = false
        }
        return { hasJob: false }
      }
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
        const headers: Record<string, string> = { "X-Agent-UUID": this.config.agentUuid }
        const authorization = operatorAuthorization()
        if (authorization) headers.Authorization = authorization
        const res = await fetch(mediaUrl, { headers })

        if (res.ok && res.body) {
          const fileStream = fs.createWriteStream(localPath)
          const reader = res.body.getReader()
          let totalBytes = 0
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            fileStream.write(value)
            totalBytes += value.length
          }
          await new Promise<void>((resolve, reject) => {
            fileStream.end(() => resolve())
            fileStream.on("error", reject)
          })
          downloadedMap.set(f.fieldKey, localPath)
          logger.info(`Saved ${f.fieldKey} to ${localPath} (${totalBytes} bytes).`)
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

  async pruneOldEvidenceFiles(maxAgeHours = 24): Promise<void> {
    if (!fs.existsSync(this.config.workDir)) return
    try {
      const now = Date.now()
      const maxAgeMs = maxAgeHours * 60 * 60 * 1000
      const entries = await fs.promises.readdir(this.config.workDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith("claim-")) {
          const fullPath = path.join(this.config.workDir, entry.name)
          const stats = await fs.promises.stat(fullPath)
          if (now - stats.mtimeMs > maxAgeMs) {
            await fs.promises.rm(fullPath, { recursive: true, force: true }).catch(() => undefined)
            logger.info(`[Prune] Pruned old temporary claim directory: ${entry.name}`)
          }
        }
      }
    } catch (err) {
      logger.warn("[Prune] Failed to prune old evidence files:", err)
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

  async testConnection(): Promise<{ ok: boolean; status: number; message: string; latencyMs: number }> {
    const start = Date.now()
    try {
      const url = `${this.config.backendUrl}/api/health`
      const res = await fetch(url)
      const latencyMs = Date.now() - start
      if (res.ok) {
        return { ok: true, status: res.status, message: "Backend connected successfully.", latencyMs }
      }
      return { ok: false, status: res.status, message: `Backend responded with HTTP ${res.status}`, latencyMs }
    } catch (err: any) {
      return { ok: false, status: 0, message: err?.message || String(err), latencyMs: Date.now() - start }
    }
  }

  async getRecentJobs(filter: { stage?: string; search?: string; page?: number; pageSize?: number } = {}): Promise<{ rows: any[]; total: number }> {
    try {
      const q = new URLSearchParams()
      q.set("agentUuid", this.config.agentUuid)
      if (filter.stage) q.set("stage", filter.stage)
      if (filter.search) q.set("search", filter.search)
      if (filter.page) q.set("page", String(filter.page))
      if (filter.pageSize) q.set("pageSize", String(filter.pageSize))
      const url = `${this.config.backendUrl}/api/automation/agent/jobs?${q.toString()}`
      const res = await fetch(url, {
        headers: { "X-Agent-UUID": this.config.agentUuid },
      })
      if (!res.ok) return { rows: [], total: 0 }
      return (await res.json()) as { rows: any[]; total: number }
    } catch (err) {
      logger.error("Failed to fetch jobs list from backend:", err)
      return { rows: [], total: 0 }
    }
  }
}
