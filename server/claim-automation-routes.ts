import type { Express, RequestHandler } from "express"
import { getPool } from "./db.js"
import { actorOf, requireAdmin, requireSupervisorOrAdmin, scopeOf, sendError } from "./http.js"
import { ServiceError } from "./register-service.js"
import {
  approveJobForSubmission,
  completeJobSubmission,
  createOrQueueAutomationJob,
  getJobExecutionBundle,
  listAutomationAgents,
  listAutomationJobs,
  listMarketplaceCredentials,
  lookupReturnForClaim,
  pollNextAutomationJob,
  recordAgentHeartbeat,
  registerOrUpdateAgent,
  retryAutomationJob,
  saveMarketplaceCredential,
  updateJobProgress,
} from "./claim-automation-service.js"
import { createClaim } from "./claims-service.js"

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function positiveId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function mountClaimAutomationRoutes(app: Express, requireUser: RequestHandler): void {
  // -------------------------------------------------------------------------------------------------------------
  // Return Details Lookup for Claims (Mobile + Web, Scanned or Independent)
  // -------------------------------------------------------------------------------------------------------------
  app.get("/api/claims/return-lookup", requireUser, async (req, res, next) => {
    try {
      const q = req.query as Record<string, unknown>
      const query = text(q.query || q.search || q.awb || q.orderId)
      if (query.length < 3) {
        throw new ServiceError(400, "Enter at least 3 characters from the AWB, Packet ID, or Order ID.")
      }

      const lookup = await lookupReturnForClaim(
        getPool(),
        scopeOf(req),
        query,
        positiveId(q.marketplaceId),
      )

      if (!lookup) {
        res.status(404).json({ found: false, message: "No matching return found for that tracking number or order." })
        return
      }

      res.json(lookup)
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // Unified claim creation (handles both existing scan or automatically linking expected return)
  app.post("/api/claims/unified-create", requireUser, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const db = getPool()
      const actor = actorOf(req)
      const scope = scopeOf(req)

      let receiptScanId = positiveId(body.receiptScanId)

      // If receiptScanId is not yet created, create a pending scan record from expectedReturnId
      if (!receiptScanId) {
        const expectedReturnId = positiveId(body.expectedReturnId)
        if (!expectedReturnId) {
          throw new ServiceError(400, "Provide either receiptScanId or expectedReturnId.")
        }

        const client = await db.connect()
        try {
          await client.query("BEGIN")
          const erRes = await client.query(
            `SELECT er.id, er.marketplace_id, er.tracking_id, er.order_number
             FROM expected_returns er
             WHERE er.id = $1`,
            [expectedReturnId],
          )
          if (!erRes.rows[0]) throw new ServiceError(404, "Expected return record not found.")

          // Create receipt scan with claim issue marker
          const scanInsert = await client.query(
            `INSERT INTO receipt_scans (
               expected_return_id, scanned_by, scanned_at, status, scanned_tracking,
               tracking_match_leg, tracking_validation, flyer_id
             )
             VALUES ($1, $2, now(), 'issue', $3, 'return', 'match', $4)
             RETURNING id`,
            [
              expectedReturnId,
              actor.id,
              text(body.awb || erRes.rows[0].tracking_id),
              text(body.packetId),
            ],
          )
          receiptScanId = Number(scanInsert.rows[0].id)
          await client.query("COMMIT")
        } catch (err) {
          await client.query("ROLLBACK")
          throw err
        } finally {
          client.release()
        }
      }

      // Create claim
      const claim = await createClaim(db, actor, scope, {
        receiptScanId,
        claimReason: text(body.claimReason) || "Wrong Product",
        claimTitle: text(body.claimTitle) || `Claim for ${text(body.orderId || body.awb)}`,
        claimDescription: text(body.claimDescription || body.claimContent),
        remarks: text(body.remarks),
        claimTemplateId: positiveId(body.claimTemplateId),
        marketplaceIssueCode: text(body.marketplaceIssueCode),
      })

      // Update snapshots on claims row
      await db.query(
        `UPDATE claims
         SET customer_name_snapshot = $2,
             total_price_snapshot = $3,
             shipped_date = $4,
             sku_snapshot = $5,
             packet_id_snapshot = COALESCE(NULLIF($6, ''), packet_id_snapshot),
             claim_content = $7
         WHERE id = $1`,
        [
          claim.id,
          text(body.customerName),
          Number(body.totalPrice) || 0,
          text(body.shippedDate) || null,
          text(body.sku),
          text(body.packetId),
          text(body.claimContent),
        ],
      )

      // Queue automation job
      const jobId = await createOrQueueAutomationJob(db, claim.id)

      res.status(201).json({ claim, jobId })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // -------------------------------------------------------------------------------------------------------------
  // Windows Desktop EXE Automation Agent Endpoints
  // -------------------------------------------------------------------------------------------------------------

  app.post("/api/automation/agent/register", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const result = await registerOrUpdateAgent(getPool(), {
        agentUuid: text(body.agentUuid),
        agentName: text(body.agentName),
        hostname: text(body.hostname),
        platform: text(body.platform),
        version: text(body.version),
        apiKey: text(body.apiKey),
      })
      res.json(result)
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/automation/agent/heartbeat", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const uuid = text(body.agentUuid)
      if (!uuid) throw new ServiceError(400, "Agent UUID required.")
      await recordAgentHeartbeat(
        getPool(),
        uuid,
        (text(body.status) as any) || "online",
        (body.currentTaskInfo || {}) as Record<string, unknown>,
      )
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/automation/agent/poll", async (req, res, next) => {
    try {
      const agentUuid = text(req.query.agentUuid || req.headers["x-agent-uuid"])
      if (!agentUuid) throw new ServiceError(400, "Agent UUID required.")
      const job = await pollNextAutomationJob(getPool(), agentUuid)
      res.json({ hasJob: Boolean(job), job })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/automation/jobs/:id/bundle", async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Job not found.")
      const bundle = await getJobExecutionBundle(getPool(), id)
      res.json(bundle)
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/automation/jobs/:id/progress", async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Job not found.")
      const body = (req.body ?? {}) as Record<string, unknown>
      await updateJobProgress(getPool(), id, {
        stage: text(body.stage) || "processing",
        logMessage: text(body.logMessage),
        screenshotPath: text(body.screenshotPath),
        manualActionReason: text(body.manualActionReason),
      })
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/automation/jobs/:id/complete", async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Job not found.")
      const body = (req.body ?? {}) as Record<string, unknown>
      await completeJobSubmission(getPool(), id, {
        marketplaceClaimId: text(body.marketplaceClaimId),
        screenshotPath: text(body.screenshotPath),
        notes: text(body.notes),
      })
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // -------------------------------------------------------------------------------------------------------------
  // Admin & Supervisor Operations (Dashboard, Jobs, Credentials, Approvals)
  // -------------------------------------------------------------------------------------------------------------

  app.get("/api/automation/agents", requireUser, async (_req, res, next) => {
    try {
      const agents = await listAutomationAgents(getPool())
      res.json({ agents })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/automation/jobs", requireUser, async (req, res, next) => {
    try {
      const q = req.query as Record<string, unknown>
      const result = await listAutomationJobs(getPool(), scopeOf(req), {
        stage: text(q.stage) || undefined,
        marketplaceId: positiveId(q.marketplaceId) || undefined,
        search: text(q.search) || undefined,
        page: positiveId(q.page) || 1,
        pageSize: positiveId(q.pageSize) || 25,
      })
      res.json(result)
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/automation/jobs/:id/approve", requireUser, requireSupervisorOrAdmin, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Job not found.")
      await approveJobForSubmission(getPool(), actorOf(req), scopeOf(req), id)
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/automation/jobs/:id/retry", requireUser, requireSupervisorOrAdmin, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Job not found.")
      await retryAutomationJob(getPool(), actorOf(req), id)
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/automation/jobs/:id/manual-resolve", requireUser, requireSupervisorOrAdmin, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Job not found.")
      const body = (req.body ?? {}) as Record<string, unknown>
      const refId = text(body.marketplaceClaimId)
      if (!refId) throw new ServiceError(400, "Marketplace Claim Reference ID is required.")
      await completeJobSubmission(getPool(), id, {
        marketplaceClaimId: refId,
        screenshotPath: text(body.screenshotPath),
        notes: text(body.notes),
      })
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/automation/credentials", requireUser, async (req, res, next) => {
    try {
      const credentials = await listMarketplaceCredentials(getPool(), scopeOf(req))
      res.json({ credentials })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/admin/automation/credentials", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const credId = await saveMarketplaceCredential(getPool(), actorOf(req), {
        id: positiveId(body.id) || undefined,
        marketplaceId: positiveId(body.marketplaceId),
        accountName: text(body.accountName),
        portalUrl: text(body.portalUrl),
        username: text(body.username) || undefined,
        password: text(body.password) || undefined,
        automationMode: text(body.automationMode) || undefined,
        requireApprovalBeforeSubmit: body.requireApprovalBeforeSubmit !== false,
        autoPrepare: body.autoPrepare !== false,
      })
      res.json({ id: credId })
    } catch (error) {
      sendError(res, error, next)
    }
  })
}
