import type { Express, RequestHandler } from "express"
import { getPool } from "./db.js"
import { actorOf, requireAdmin, requireSupervisorOrAdmin, scopeOf, sendError } from "./http.js"
import { ServiceError } from "./register-service.js"
import { publishChange } from "./live.js"
import {
  approveJobForSubmission,
  authenticateAutomationAgent,
  completeJobSubmission,
  createOrQueueAutomationJob,
  getJobExecutionBundle,
  listAutomationAgents,
  listAutomationJobs,
  getPortalLoginForSetup,
  listMarketplaceCredentials,
  lookupReturnForClaim,
  pollNextAutomationJob,
  recordAgentHeartbeat,
  registerOrUpdateAgent,
  resolveClaimScanId,
  retryAutomationJob,
  saveMarketplaceCredential,
  scopeForAutomationAgent,
  syncClaimTicketToRegister,
  updateJobProgress,
} from "./claim-automation-service.js"
import { createClaim, getClaim } from "./claims-service.js"
import { normalizeMeeshoPacketState } from "./meesho-claims.js"
import { mountAiMemoryRoutes } from "./ai-memory-routes.js"
import {
  leaseNextDueFollowUp,
  listFollowUps,
  recordFollowUpResult,
  type FollowUpOutcome,
} from "./claim-follow-up-service.js"

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function positiveId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function agentCredentials(req: Parameters<RequestHandler>[0]): { uuid: string; apiKey: string } {
  return {
    uuid: text(req.headers["x-agent-uuid"]),
    apiKey: text(req.headers["x-agent-key"]),
  }
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

  // Unified claim creation (phone and console). The claim attaches to a saved bench scan in the caller's accounts:
  // send its id as scanId (receiptScanId is the older name). This route never creates a receipt scan.
  app.post("/api/claims/unified-create", requireUser, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const db = getPool()
      const actor = actorOf(req)
      const scope = scopeOf(req)

      const receiptScanId = await resolveClaimScanId(db, scope, {
        scanId: positiveId(body.scanId) ?? positiveId(body.receiptScanId),
        keys: [text(body.awb), text(body.subOrderId), text(body.orderId)],
      })

      // Check if claim already exists for this receiptScanId
      const existingClaim = await db.query(
        `SELECT id FROM claims WHERE receipt_scan_id = $1`,
        [receiptScanId],
      )

      let claim: any
      if (existingClaim.rows[0]) {
        const claimId = Number(existingClaim.rows[0].id)
        claim = await getClaim(db, scope, claimId)
      } else {
        // Create claim
        claim = await createClaim(db, actor, scope, {
          receiptScanId,
          claimReason: (text(body.claimReason) || "Wrong Product").slice(0, 200),
          claimTitle: (text(body.claimTitle) || `Claim for ${text(body.orderId || body.awb)}`).slice(0, 200),
          claimDescription: text(body.claimDescription || body.claimContent).slice(0, 2000),
          remarks: text(body.remarks).slice(0, 2000),
          claimTemplateId: positiveId(body.claimTemplateId),
          marketplaceIssueCode: text(body.marketplaceIssueCode),
          packetState: text(body.packetState),
          packetId: text(body.packetId),
          missingAmount: Number(body.missingAmount) || 0,
          subOrderId: text(body.subOrderId),
        })
      }

      // Parse shipped date safely
      let parsedShippedDate: string | null = null
      const rawShipped = text(body.shippedDate)
      if (rawShipped) {
        const d = new Date(rawShipped)
        if (!isNaN(d.getTime())) {
          parsedShippedDate = d.toISOString().split("T")[0]
        }
      }

      // Update snapshots on claims row
      await db.query(
        `UPDATE claims
         SET customer_name_snapshot = COALESCE(NULLIF($2, ''), customer_name_snapshot),
             total_price_snapshot = COALESCE(NULLIF($3, 0), total_price_snapshot),
             claim_amount = COALESCE(NULLIF($11, 0), NULLIF($3, 0), claim_amount),
             shipped_date = COALESCE($4::date, shipped_date),
             sku_snapshot = COALESCE(NULLIF($5, ''), sku_snapshot),
             packet_id_snapshot = COALESCE(NULLIF($6, ''), packet_id_snapshot),
             sub_order_id_snapshot = COALESCE(NULLIF($7, ''), sub_order_id_snapshot),
             awb_snapshot = COALESCE(NULLIF($8, ''), awb_snapshot),
             packet_state_snapshot = COALESCE(NULLIF($9, ''), packet_state_snapshot, 'Unknown'),
             claim_content = COALESCE(NULLIF($10, ''), claim_content)
         WHERE id = $1`,
        [
          claim.id,
          text(body.customerName),
          Number(body.totalPrice) || 0,
          parsedShippedDate,
          text(body.sku),
          text(body.packetId),
          text(body.subOrderId),
          text(body.awb),
          normalizeMeeshoPacketState(body.packetState),
          text(body.claimContent || body.claimDescription).slice(0, 2000),
          Number(body.missingAmount) || 0,
        ],
      )

      // Queue automation job
      let jobId: number | null = null
      try {
        jobId = await createOrQueueAutomationJob(db, claim.id)
      } catch (err) {
        console.warn("[unified-create] createOrQueueAutomationJob warning:", err)
      }

      // Sync ticket ID and Draft status to return register
      const initialTicketCode = text(body.ticketCode) || `CLM-${claim.id}`
      try {
        await syncClaimTicketToRegister(db, {
          receiptScanId,
          ticketCode: initialTicketCode,
          status: "Draft",
          actorId: actor.id,
          issueCategoryCode: text(body.marketplaceIssueCode) || "wrong_item",
          issueCategoryLabel: text(body.claimReason) || "Wrong Product",
          notes: `Claim created: ${initialTicketCode}`,
        })
      } catch (err) {
        console.warn("[unified-create] syncClaimTicketToRegister warning:", err)
      }

      publishChange({ kind: "claim.updated", marketplaceId: claim.marketplaceId, actorId: actor.id })
      res.status(201).json({ claim, jobId, ticketCode: initialTicketCode })
    } catch (error) {
      console.error("[unified-create error]", error)
      sendError(res, error, next)
    }
  })

  // -------------------------------------------------------------------------------------------------------------
  // Windows Desktop EXE Automation Agent Endpoints
  // -------------------------------------------------------------------------------------------------------------

  app.post("/api/automation/agent/register", requireUser, requireSupervisorOrAdmin, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const result = await registerOrUpdateAgent(getPool(), {
        agentUuid: text(body.agentUuid),
        agentName: text(body.agentName),
        hostname: text(body.hostname),
        platform: text(body.platform),
        version: text(body.version),
        apiKey: text(body.apiKey),
        registeredByUserId: actorOf(req).id,
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
      const credentials = agentCredentials(req)
      await authenticateAutomationAgent(getPool(), uuid, credentials.apiKey)
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
      const db = getPool()
      await authenticateAutomationAgent(db, agentUuid, agentCredentials(req).apiKey)
      // Optional, comma separated: marketplaces whose desktop panel is held, so their queued jobs are not leased.
      const skipMarketplaces = text(req.query.skipMarketplaces).split(",")
      const job = await pollNextAutomationJob(db, agentUuid, await scopeForAutomationAgent(db, agentUuid), skipMarketplaces)
      res.json({ hasJob: Boolean(job), job })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/automation/agent/jobs", async (req, res, next) => {
    try {
      const agentUuid = text(req.query.agentUuid || req.headers["x-agent-uuid"])
      if (!agentUuid) throw new ServiceError(400, "Agent UUID required.")
      const db = getPool()
      await authenticateAutomationAgent(db, agentUuid, agentCredentials(req).apiKey)

      const q = req.query as Record<string, unknown>
      const result = await listAutomationJobs(db, await scopeForAutomationAgent(db, agentUuid), {
        stage: text(q.stage) || undefined,
        marketplaceId: positiveId(q.marketplaceId) || undefined,
        search: text(q.search) || undefined,
        page: positiveId(q.page) || 1,
        pageSize: positiveId(q.pageSize) || 50,
      })
      res.json(result)
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/automation/jobs/:id/bundle", async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Job not found.")
      const credentials = agentCredentials(req)
      await authenticateAutomationAgent(getPool(), credentials.uuid, credentials.apiKey, id)
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
      const credentials = agentCredentials(req)
      const agent = await authenticateAutomationAgent(getPool(), credentials.uuid, credentials.apiKey, id)
      const body = (req.body ?? {}) as Record<string, unknown>
      // M9: the lease-holder check inside updateJobProgress rejects progress
      // from a worker that no longer holds a live lease on this job.
      const marketplaceId = await updateJobProgress(getPool(), id, {
        stage: text(body.stage) || "processing",
        checkpoint: text(body.checkpoint) || undefined,
        logMessage: text(body.logMessage),
        screenshotPath: text(body.screenshotPath),
        manualActionReason: text(body.manualActionReason),
        nextRetrySeconds: Number.isFinite(Number(body.nextRetrySeconds)) ? Number(body.nextRetrySeconds) : undefined,
      }, agent.id)
      publishChange({ kind: "claim.updated", marketplaceId })
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/automation/jobs/:id/complete", async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Job not found.")
      const credentials = agentCredentials(req)
      const agent = await authenticateAutomationAgent(getPool(), credentials.uuid, credentials.apiKey, id)
      const body = (req.body ?? {}) as Record<string, unknown>
      // M9: the endpoint verifies lease ownership, lease liveness and the
      // account's submission authorization atomically before recording a ticket.
      const marketplaceId = await completeJobSubmission(getPool(), id, {
        marketplaceClaimId: text(body.marketplaceClaimId),
        screenshotPath: text(body.screenshotPath),
        notes: text(body.notes),
      }, undefined, { agentId: agent.id })
      publishChange({ kind: "claim.updated", marketplaceId })
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // -------------------------------------------------------------------------------------------------------------
  // Follow-up ticket checks (the desktop re-opens a supplier portal on a cadence and reads the ticket status)
  // -------------------------------------------------------------------------------------------------------------

  app.get("/api/automation/follow-ups/due", async (req, res, next) => {
    try {
      const agentUuid = text(req.query.agentUuid || req.headers["x-agent-uuid"])
      if (!agentUuid) throw new ServiceError(400, "Agent UUID required.")
      const db = getPool()
      await authenticateAutomationAgent(db, agentUuid, agentCredentials(req).apiKey)
      const followUp = await leaseNextDueFollowUp(db, agentUuid, await scopeForAutomationAgent(db, agentUuid))
      res.json({ hasFollowUp: Boolean(followUp), followUp })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/automation/follow-ups/:id/result", async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Follow-up not found.")
      const credentials = agentCredentials(req)
      await authenticateAutomationAgent(getPool(), credentials.uuid, credentials.apiKey)
      const body = (req.body ?? {}) as Record<string, unknown>
      const result = await recordFollowUpResult(getPool(), credentials.uuid, id, {
        outcome: (text(body.outcome) as FollowUpOutcome) || "error",
        statusText: text(body.statusText),
        normalizedStatus: text(body.normalizedStatus),
        note: text(body.note),
        screenshotPath: text(body.screenshotPath),
      })
      if (result.marketplaceId !== null) publishChange({ kind: "claim.updated", marketplaceId: result.marketplaceId })
      res.json({ ok: true, ...result })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // -------------------------------------------------------------------------------------------------------------
  // Admin & Supervisor Operations (Dashboard, Jobs, Credentials, Approvals)
  // -------------------------------------------------------------------------------------------------------------

  app.get("/api/automation/agents", requireUser, requireSupervisorOrAdmin, async (_req, res, next) => {
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

  app.get("/api/automation/follow-ups", requireUser, async (req, res, next) => {
    try {
      const q = req.query as Record<string, unknown>
      const result = await listFollowUps(getPool(), scopeOf(req), {
        activeOnly: String(q.activeOnly || "") === "true",
        search: text(q.search) || undefined,
        page: positiveId(q.page) || 1,
        pageSize: positiveId(q.pageSize) || 50,
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
      const marketplaceId = await approveJobForSubmission(getPool(), actorOf(req), scopeOf(req), id)
      publishChange({ kind: "claim.updated", marketplaceId, actorId: actorOf(req).id })
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/automation/jobs/:id/retry", requireUser, requireSupervisorOrAdmin, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id)
      if (!id) throw new ServiceError(404, "Job not found.")
      const marketplaceId = await retryAutomationJob(getPool(), actorOf(req), scopeOf(req), id)
      publishChange({ kind: "claim.updated", marketplaceId, actorId: actorOf(req).id })
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
      // M9: operator-approved manual resolution stays separate from automated
      // submission: the route is Supervisor/Admin-gated and carries the
      // operator override instead of a worker lease.
      const marketplaceId = await completeJobSubmission(getPool(), id, {
        marketplaceClaimId: refId,
        screenshotPath: text(body.screenshotPath),
        notes: text(body.notes),
      }, scopeOf(req), { operatorOverride: true })
      publishChange({ kind: "claim.updated", marketplaceId, actorId: actorOf(req).id })
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/automation/portal-login-secret", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const account = text(req.query.account)
      if (!account) throw new ServiceError(400, "Account name is required.")
      const secret = await getPortalLoginForSetup(getPool(), account)
      if (!secret) throw new ServiceError(404, "No bot password is saved for this marketplace.")
      res.json(secret)
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
        requireApprovalBeforeSubmit:
          typeof body.requireApprovalBeforeSubmit === "boolean" ? body.requireApprovalBeforeSubmit : undefined,
        autoPrepare: body.autoPrepare !== false,
      })
      res.json({ id: credId })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  mountAiMemoryRoutes(app, requireUser)
}
