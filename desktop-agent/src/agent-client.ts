import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { loadAgentConfig, saveAgentConfig, type AgentConfig } from "./config.js"
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

export type FollowUpOutcome = "status_read" | "not_supported" | "login_required" | "not_found" | "error"

export type FollowUpPollResult = {
  hasFollowUp: boolean
  followUp?: {
    followUpId: number
    claimId: number
    marketplace: string
    accountName: string
    marketplaceClaimId: string
    portalUrl: string
  }
}

export type FollowUpReport = {
  outcome: FollowUpOutcome
  statusText?: string
  normalizedStatus?: string
  note?: string
  screenshotPath?: string
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
    contentHash: string
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
        headers: {
          "Content-Type": "application/json",
          ...(operatorAuthorization() ? { Authorization: operatorAuthorization()! } : {}),
        },
        body: JSON.stringify({
          agentUuid: this.config.agentUuid,
          agentName: this.config.agentName,
          hostname: os.hostname(),
          platform: process.platform,
          version: process.env.RETURN_APP_VERSION || process.env.npm_package_version || "1.1.0",
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
      saveAgentConfig({ apiKey: data.apiKey })
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
          "X-Agent-Key": this.apiKey,
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
          "X-Agent-Key": this.apiKey,
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

  /**
   * Ask the server for the next follow-up ticket check that is due for this agent.
   *
   * The server only hands out a row when one is actually due (every 2 days by default), so an empty answer is
   * the normal case for most cycles.
   */
  async pollFollowUp(): Promise<FollowUpPollResult> {
    if (!this.isRegistered) {
      const ok = await this.register()
      if (!ok) return { hasFollowUp: false }
    }
    try {
      const url = `${this.config.backendUrl}/api/automation/follow-ups/due?agentUuid=${encodeURIComponent(this.config.agentUuid)}`
      const res = await fetch(url, {
        headers: {
          "X-Agent-UUID": this.config.agentUuid,
          "X-Agent-Key": this.apiKey,
        },
      })
      if (!res.ok) {
        if (res.status === 401 || res.status === 404) this.isRegistered = false
        return { hasFollowUp: false }
      }
      return (await res.json()) as FollowUpPollResult
    } catch (err) {
      logger.debug("Follow-up check failed:", err)
      return { hasFollowUp: false }
    }
  }

  /** Report the outcome of one follow-up check so the server can reschedule or stop the ticket. */
  async reportFollowUp(followUpId: number, data: FollowUpReport): Promise<void> {
    try {
      const url = `${this.config.backendUrl}/api/automation/follow-ups/${followUpId}/result`
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-UUID": this.config.agentUuid,
          "X-Agent-Key": this.apiKey,
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error(`Follow-up report failed with HTTP ${res.status}.`)
      logger.info(`Follow-up #${followUpId} reported (${data.outcome}${data.statusText ? `: ${data.statusText}` : ""}).`)
    } catch (err) {
      logger.error("Failed to report follow-up result:", err)
      throw err
    }
  }

  async getExecutionBundle(jobId: number): Promise<JobExecutionBundle | null> {
    try {
      const url = `${this.config.backendUrl}/api/automation/jobs/${jobId}/bundle`
      const res = await fetch(url, {
        headers: { "X-Agent-UUID": this.config.agentUuid, "X-Agent-Key": this.apiKey },
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

  async downloadEvidenceFiles(claimId: number, files: JobExecutionBundle["evidenceFiles"]): Promise<Map<string, string[]>> {
    const downloadedMap = new Map<string, string[]>()
    const claimDir = path.join(this.config.workDir, `claim-${claimId}`)
    if (!fs.existsSync(claimDir)) {
      fs.mkdirSync(claimDir, { recursive: true })
    }

    for (const f of files) {
      const safeName = `${f.id}_${f.fieldKey}_${path.basename(f.originalFilename)}`
      const localPath = path.join(claimDir, safeName)
      const partialPath = `${localPath}.part`

      if (await this.isCompleteEvidenceFile(localPath, f.sizeBytes, f.contentHash)) {
        downloadedMap.set(f.fieldKey, [...(downloadedMap.get(f.fieldKey) || []), localPath])
        continue
      }
      await fs.promises.rm(localPath, { force: true }).catch(() => undefined)
      await fs.promises.rm(partialPath, { force: true }).catch(() => undefined)

      try {
        const mediaUrl = `${this.config.backendUrl}/api/claims/${claimId}/media/${f.id}`
        logger.info(`Downloading evidence file: ${f.fieldKey} (${f.originalFilename})...`)
        const headers: Record<string, string> = { "X-Agent-UUID": this.config.agentUuid }
        const authorization = operatorAuthorization()
        if (authorization) headers.Authorization = authorization
        const res = await fetch(mediaUrl, { headers })

        if (res.ok && res.body) {
          await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(partialPath))
          const totalBytes = (await fs.promises.stat(partialPath)).size
          if (f.sizeBytes > 0 && totalBytes !== f.sizeBytes) {
            throw new Error(`Evidence size mismatch for ${f.originalFilename}.`)
          }
          if (!(await this.isCompleteEvidenceFile(partialPath, f.sizeBytes, f.contentHash))) {
            throw new Error(`Evidence integrity check failed for ${f.originalFilename}.`)
          }
          await fs.promises.rename(partialPath, localPath)
          downloadedMap.set(f.fieldKey, [...(downloadedMap.get(f.fieldKey) || []), localPath])
          logger.info(`Saved ${f.fieldKey} to ${localPath} (${totalBytes} bytes).`)
        } else {
          logger.warn(`Could not download ${f.fieldKey} (${res.status}).`)
        }
      } catch (err) {
        await fs.promises.rm(partialPath, { force: true }).catch(() => undefined)
        logger.error(`Failed downloading ${f.fieldKey}:`, err)
      }
    }

    const downloadedCount = Array.from(downloadedMap.values()).reduce((total, entries) => total + entries.length, 0)
    if (downloadedCount !== files.length) {
      throw new Error(`Downloaded ${downloadedCount} of ${files.length} evidence files. The claim will be retried.`)
    }
    return downloadedMap
  }

  private async isCompleteEvidenceFile(filePath: string, sizeBytes: number, contentHash: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(filePath)
      if (!stat.isFile() || stat.size <= 0 || (sizeBytes > 0 && stat.size !== sizeBytes)) return false
      if (!contentHash) return true
      const hash = crypto.createHash("sha256")
      const stream = fs.createReadStream(filePath)
      for await (const chunk of stream) hash.update(chunk)
      return hash.digest("hex") === contentHash
    } catch {
      return false
    }
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
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-UUID": this.config.agentUuid, "X-Agent-Key": this.apiKey },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error(`Progress update failed with HTTP ${res.status}.`)
    } catch (err) {
      logger.error("Failed to report progress to backend:", err)
      throw err
    }
  }

  async completeJob(jobId: number, data: { marketplaceClaimId: string; screenshotPath?: string; notes?: string }): Promise<void> {
    try {
      const url = `${this.config.backendUrl}/api/automation/jobs/${jobId}/complete`
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-UUID": this.config.agentUuid, "X-Agent-Key": this.apiKey },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error(`Completion update failed with HTTP ${res.status}.`)
      logger.info(`Job #${jobId} reported as COMPLETED (Marketplace Ref: ${data.marketplaceClaimId}).`)
    } catch (err) {
      logger.error("Failed to report job completion:", err)
      throw err
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

  /**
   * Read the ticket follow-ups for the dashboard.
   *
   * This is a signed-in operator read, not an agent poll, so it carries the operator's bearer token, exactly
   * like the evidence download. An empty list is returned when nobody is signed in or the server is
   * unreachable, so the dashboard renders "sign in" instead of failing.
   */
  async getFollowUps(filter: { pageSize?: number } = {}): Promise<{ rows: any[]; total: number; summary: any }> {
    const empty = { rows: [] as any[], total: 0, summary: {} }
    try {
      const authorization = operatorAuthorization()
      if (!authorization) return empty
      const q = new URLSearchParams()
      if (filter.pageSize) q.set("pageSize", String(filter.pageSize))
      const url = `${this.config.backendUrl}/api/automation/follow-ups?${q.toString()}`
      const res = await fetch(url, { headers: { Authorization: authorization } })
      if (!res.ok) return empty
      return (await res.json()) as { rows: any[]; total: number; summary: any }
    } catch (err) {
      logger.debug("Failed to fetch ticket follow-ups from backend:", err)
      return empty
    }
  }

  async getRecentJobs(filter: { stage?: string; search?: string; page?: number; pageSize?: number } = {}): Promise<{ rows: any[]; total: number }> {
    try {
      this.apiKey = loadAgentConfig().apiKey
      const q = new URLSearchParams()
      q.set("agentUuid", this.config.agentUuid)
      if (filter.stage) q.set("stage", filter.stage)
      if (filter.search) q.set("search", filter.search)
      if (filter.page) q.set("page", String(filter.page))
      if (filter.pageSize) q.set("pageSize", String(filter.pageSize))
      const url = `${this.config.backendUrl}/api/automation/agent/jobs?${q.toString()}`
      const res = await fetch(url, {
        headers: { "X-Agent-UUID": this.config.agentUuid, "X-Agent-Key": this.apiKey },
      })
      if (!res.ok) return { rows: [], total: 0 }
      return (await res.json()) as { rows: any[]; total: number }
    } catch (err) {
      logger.error("Failed to fetch jobs list from backend:", err)
      return { rows: [], total: 0 }
    }
  }
}
