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
  syncClaimTicketToRegister,
  updateJobProgress,
} from "./claim-automation-service.js"
import { createClaim, getClaim } from "./claims-service.js"

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

      // If receiptScanId is not yet created, resolve or create scan record from expectedReturnId
      if (!receiptScanId) {
        let expectedReturnId = positiveId(body.expectedReturnId)
        if (!expectedReturnId) {
          const lookupVal = text(body.subOrderId || body.awb || body.orderId)
          if (lookupVal) {
            const autoLookup = await lookupReturnForClaim(db, scope, lookupVal)
            if (autoLookup) {
              expectedReturnId = autoLookup.expectedReturnId
              if (autoLookup.scanId) {
                receiptScanId = autoLookup.scanId
              }
            }
          }
        }
        if (!receiptScanId && !expectedReturnId) {
          throw new ServiceError(400, "Provide either receiptScanId, expectedReturnId, or valid AWB/Sub Order ID.")
        }

        if (!receiptScanId && expectedReturnId) {
          const client = await db.connect()
          try {
            await client.query("BEGIN")
            const erRes = await client.query(
              `SELECT er.id, er.marketplace_id, er.tracking_id, er.order_number, m.name AS marketplace
               FROM expected_returns er
               JOIN marketplaces m ON m.id = er.marketplace_id
               WHERE er.id = $1`,
              [expectedReturnId],
            )
            if (!erRes.rows[0]) throw new ServiceError(404, "Expected return record not found.")

            // Check if receipt_scan already exists for this expected_return_id
            const existingScan = await client.query(
              `SELECT id FROM receipt_scans WHERE expected_return_id = $1`,
              [expectedReturnId],
            )
            if (existingScan.rows[0]) {
              receiptScanId = Number(existingScan.rows[0].id)
            } else {
              const scanTimeLabel = new Intl.DateTimeFormat("en-IN", {
                timeZone: "Asia/Kolkata",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: true,
              }).format(new Date())

              const flyerVal = text(body.packetId)
              const scanInsert = await client.query(
                `INSERT INTO receipt_scans (
                   expected_return_id, scanned_by, scanned_at, scanned_time_label,
                   outcome, issue_label, status, scanned_tracking,
                   matched_leg, tracking_validation_snapshot, flyer_id, flyer_state,
                   tracking_id_snapshot, order_number_snapshot, marketplace_snapshot
                 )
                 VALUES ($1, $2, now(), $3, 'issue', $4, 'Draft', $5, 'return', 'match', $6, $7, $8, $9, $10)
                 RETURNING id`,
                [
                  expectedReturnId,
                  actor.id,
                  scanTimeLabel,
                  text(body.claimReason) || "Wrong Product",
                  text(body.awb || erRes.rows[0].tracking_id),
                  flyerVal,
                  flyerVal ? "scanned" : "not_required",
                  String(erRes.rows[0].tracking_id),
                  String(erRes.rows[0].order_number),
                  String(erRes.rows[0].marketplace),
                ],
              )
              receiptScanId = Number(scanInsert.rows[0].id)

              // Populate receipt_scan_items from expected_return_items
              const eriList = await client.query(
                `SELECT eri.id, eri.display_order_item_id, eri.order_line_id, eri.channel_listing_id,
                        eri.marketplace_sku_identifier, eri.qty, COALESCE(eri.label, s.name, 'Returned Product') AS label,
                        s.code AS sku_code
                 FROM expected_return_items eri
                 LEFT JOIN skus s ON s.id = eri.sku_id
                 WHERE eri.expected_return_id = $1
                 ORDER BY eri.id ASC`,
                [expectedReturnId],
              )
              if (eriList.rows.length > 0) {
                for (let i = 0; i < eriList.rows.length; i++) {
                  const erRow = eriList.rows[i]
                  await client.query(
                    `INSERT INTO receipt_scan_items (
                       receipt_scan_id, expected_return_item_id, line_no, order_item_id,
                       marketplace_sku, product_sku, product_sku_source, product_name,
                       expected_qty, received_qty, verified
                     )
                     VALUES ($1, $2, $3, $4, $5, $6, 'unrecorded', $7, $8, 1, true)`,
                    [
                      receiptScanId,
                      Number(erRow.id),
                      i + 1,
                      String(erRow.display_order_item_id || erRow.order_line_id || ""),
                      String(erRow.channel_listing_id || erRow.marketplace_sku_identifier || ""),
                      String(erRow.sku_code || ""),
                      String(erRow.label || "Returned Product"),
                      Number(erRow.qty || 1),
                    ],
                  )
                }
              }
            }
            await client.query("COMMIT")
          } catch (err) {
            await client.query("ROLLBACK")
            throw err
          } finally {
            client.release()
          }
        }
      }

      if (!receiptScanId) {
        throw new ServiceError(400, "Failed to resolve or create receipt scan.")
      }

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
             shipped_date = COALESCE($4::date, shipped_date),
             sku_snapshot = COALESCE(NULLIF($5, ''), sku_snapshot),
             packet_id_snapshot = COALESCE(NULLIF($6, ''), packet_id_snapshot),
             sub_order_id_snapshot = COALESCE(NULLIF($7, ''), sub_order_id_snapshot),
             awb_snapshot = COALESCE(NULLIF($8, ''), awb_snapshot),
             packet_state_snapshot = COALESCE(NULLIF($9, ''), packet_state_snapshot, 'Tampered'),
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
          text(body.packetState || "Tampered"),
          text(body.claimContent || body.claimDescription).slice(0, 2000),
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

      res.status(201).json({ claim, jobId, ticketCode: initialTicketCode })
    } catch (error) {
      console.error("[unified-create error]", error)
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

  app.get("/api/automation/agent/jobs", async (req, res, next) => {
    try {
      const agentUuid = text(req.query.agentUuid || req.headers["x-agent-uuid"])
      if (!agentUuid) throw new ServiceError(400, "Agent UUID required.")

      const db = getPool()
      const agentRes = await db.query(
        `SELECT id, is_authorized FROM claim_automation_agents WHERE agent_uuid = $1`,
        [agentUuid],
      )
      if (agentRes.rows.length === 0 || !agentRes.rows[0].is_authorized) {
        throw new ServiceError(401, "Agent not authorized.")
      }

      const q = req.query as Record<string, unknown>
      const result = await listAutomationJobs(db, { all: true }, {
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
