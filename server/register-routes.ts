// HTTP routes for the return scan register: scanning, the register and its export, tickets, the accounts the user may use,
// and the administrator configuration of issue categories and logistics partners.
//
// Every route passes the signed-in user's account scope (server/access.ts) to the service layer, so the restriction is
// applied in SQL. Configuration changes need an administrator (requireAdmin in server/http.ts). A ServiceError becomes
// its HTTP status with its message and details.

import type { Express, RequestHandler } from "express"
import * as XLSX from "xlsx"
import { getPool } from "./db.js"
import { addAlias, addDomain, addPartner, listPartners, setAliasActive, setPartnerActive } from "./admin-config.js"
import {
  ServiceError,
  accessibleAccounts,
  exportRegisterRows,
  listCategories,
  listRegister,
  lookupShipment,
  correctScanIssue,
  recordScan,
  registerOptions,
  scanSession,
  ticketHistory,
  updateCategory,
  createCategory,
  updateTicketStatus,
  writeAudit,
  type Actor,
  type RegisterFilters,
} from "./register-service.js"
import {
  TICKET_STATUSES,
  headersFor,
  registerCsv,
  registerRecords,
  type RegisterColumnMode,
  type ScanSubmission,
} from "./register-rules.js"
import { actorOf, requireAdmin, scopeOf, sendError } from "./http.js"
import { publishChange } from "./live.js"

const COLUMN_MODES: readonly string[] = ["approved", "extended", "operational"]

function optionalInt(value: string, label: string): number | null {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new ServiceError(400, `${label} must be a whole number.`)
  return parsed
}

function optionalDay(value: string, label: string): string {
  if (!value) return ""
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ServiceError(400, `${label} must be a date in the form YYYY-MM-DD.`)
  return value
}

// Reads the register filters from the query string. Every value is checked before it reaches the database.
export function filtersFrom(query: Record<string, unknown>): RegisterFilters {
  const text = (key: string) => String(query[key] ?? "").trim()
  const ticketStatus = text("ticketStatus")
  if (ticketStatus && !(TICKET_STATUSES as readonly string[]).includes(ticketStatus)) {
    throw new ServiceError(400, "Choose a valid ticket status.")
  }
  return {
    marketplaceId: optionalInt(text("marketplaceId"), "Marketplace"),
    tracking: text("tracking").slice(0, 80),
    order: text("order").slice(0, 80),
    sku: text("sku").slice(0, 80),
    issue: text("issue").slice(0, 40),
    ticketStatus,
    scannerId: optionalInt(text("scannerId"), "Scanner"),
    partner: text("partner").slice(0, 60),
    dateFrom: optionalDay(text("dateFrom"), "From date"),
    dateTo: optionalDay(text("dateTo"), "To date"),
  }
}

// Turns the JSON body of a save into the submission type. Anything missing becomes a value the rules reject.
// scannedTracking is the AWB the scanner read. It is recorded with the scan, so the match can be checked later.
// flyerId/flyerState carry the Meesho flyer capture (Meesho issue returns only; see flyerErrorFor).
export function submissionFrom(body: Record<string, unknown>): ScanSubmission {
  const items: unknown[] = Array.isArray(body.items) ? body.items : []
  return {
    shipmentId: Number(body.shipmentId),
    clientScanKey: String(body.clientScanKey ?? ""),
    notes: String(body.notes ?? "").trim(),
    scannedTracking: String(body.scannedTracking ?? "").trim().slice(0, 80),
    flyerId: String(body.flyerId ?? "").trim().toUpperCase().slice(0, 120),
    flyerState: String(body.flyerState ?? "not_required").trim().toLowerCase().slice(0, 20) || "not_required",
    items: items.map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>
      const issues: unknown[] = Array.isArray(item.issues) ? item.issues : []
      return {
        itemId: Number(item.itemId),
        receivedQty: Number(item.receivedQty),
        verified: item.verified === true,
        issues: issues.map((rawIssue) => {
          const issue = (rawIssue ?? {}) as Record<string, unknown>
          const subIssue = issue.subIssueId
          return {
            categoryCode: String(issue.categoryCode ?? ""),
            subIssueId: subIssue === null || subIssue === undefined || subIssue === "" ? null : Number(subIssue),
            qty: Number(issue.qty),
            ticketCode: String(issue.ticketCode ?? "").trim(),
            notes: String(issue.notes ?? "").trim(),
          }
        }),
      }
    }),
  }
}

// Sorting is read from the query string and checked against a fixed list in the service.
function sortFrom(query: Record<string, unknown>): { sort: string; direction: string } {
  return { sort: String(query.sort ?? ""), direction: String(query.direction ?? "") }
}

// The column set of an export. The default is the approved 19 columns, exactly as the mapping lists them.
function columnModeFrom(query: Record<string, unknown>): RegisterColumnMode {
  const value = String(query.columns ?? "approved")
  if (!COLUMN_MODES.includes(value)) throw new ServiceError(400, "Choose approved, extended or operational columns.")
  return value as RegisterColumnMode
}

// Spreadsheet formulas are neutralized in the Excel export too, the same way as the CSV.
function safeCell(value: string | number): string | number {
  if (typeof value !== "string") return value
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

// Switches one tracking host on or off. A host is never deleted, and each change is written to the audit log.
async function setDomainActive(
  actor: Actor,
  id: number,
  active: boolean,
): Promise<{ id: number; host: string; active: boolean }> {
  const client = await getPool().connect()
  try {
    await client.query("BEGIN")
    const updated = await client.query(
      "UPDATE logistics_partner_domains SET active = $2 WHERE id = $1 RETURNING id, host, active",
      [id, active],
    )
    const row = updated.rows[0]
    if (!row) throw new ServiceError(404, "That tracking host does not exist.")
    await writeAudit(client, actor.id, "partner.host", "logistics_partner_domain", String(id), {
      host: String(row.host),
      active,
    })
    await client.query("COMMIT")
    return { id, host: String(row.host), active: Boolean(row.active) }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export function mountRegisterRoutes(app: Express, requireUser: RequestHandler): void {
  // The accounts the signed-in user may use. Account selectors on the scan and upload screens are filled from this list.
  app.get("/api/accounts", requireUser, async (req, res, next) => {
    try {
      res.json({ accounts: await accessibleAccounts(getPool(), scopeOf(req)) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/scan/lookup", requireUser, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const shipment =
        body.shipmentId === undefined || body.shipmentId === null || body.shipmentId === "" ? null : Number(body.shipmentId)
      if (shipment !== null && (!Number.isInteger(shipment) || shipment < 1)) {
        throw new ServiceError(400, "Choose a valid return.")
      }
      const result = await lookupShipment(
        getPool(),
        {
          tracking: String(body.tracking ?? ""),
          marketplace: String(body.marketplace ?? "Auto detect"),
          shipmentId: shipment,
        },
        scopeOf(req),
        actorOf(req),
      )
      res.json(result)
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/scan/complete", requireUser, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const receipt = await recordScan(
        getPool(),
        actorOf(req),
        {
          submission: submissionFrom(body),
          photoCount: Number(body.photoCount ?? 0),
          hasVideo: body.hasVideo === true,
        },
        scopeOf(req),
      )
      res.json(receipt)
      if (!receipt.replayed) {
        publishChange({
          kind: "scan.saved",
          marketplaceId: receipt.scan.marketplaceId,
          shipmentId: receipt.scan.shipmentId,
          scanId: receipt.scan.id,
          actorId: actorOf(req).id,
        })
      }
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/scan/correct", requireUser, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const receipt = await correctScanIssue(getPool(), actorOf(req), submissionFrom(body), scopeOf(req))
      res.json(receipt)
      publishChange({
        kind: "scan.corrected",
        marketplaceId: receipt.scan.marketplaceId,
        shipmentId: receipt.scan.shipmentId,
        scanId: receipt.scan.id,
        actorId: actorOf(req).id,
      })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/scan/session", requireUser, async (req, res, next) => {
    try {
      res.json(await scanSession(getPool(), scopeOf(req)))
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/register", requireUser, async (req, res, next) => {
    try {
      const page = Number(req.query.page ?? 1)
      const pageSize = Number(req.query.pageSize ?? 50)
      const query = req.query as Record<string, unknown>
      res.json(await listRegister(getPool(), filtersFrom(query), page, pageSize, sortFrom(query), scopeOf(req)))
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // format=csv (default) or format=xlsx, and columns=approved (default), extended or operational. Both come from the same
  // rows as the screen, with the same column order. The export is limited to the accounts the user may see.
  app.get("/api/register/export", requireUser, async (req, res, next) => {
    try {
      const query = req.query as Record<string, unknown>
      const format = String(query.format ?? "csv")
      if (format !== "csv" && format !== "xlsx") throw new ServiceError(400, "The export format is csv or xlsx.")
      const mode = columnModeFrom(query)
      const rows = await exportRegisterRows(getPool(), filtersFrom(query), scopeOf(req))
      if (format === "xlsx") {
        const table: (string | number)[][] = [headersFor(mode), ...registerRecords(rows, mode)].map((line) =>
          line.map(safeCell),
        )
        const sheet = XLSX.utils.aoa_to_sheet(table)
        const book = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(book, sheet, "Return register")
        const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        res.setHeader("Content-Disposition", `attachment; filename=return-register-${mode}.xlsx`)
        res.send(buffer)
        return
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8")
      res.setHeader("Content-Disposition", `attachment; filename=return-register-${mode}.csv`)
      res.send(registerCsv(rows, mode))
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/register/options", requireUser, async (req, res, next) => {
    try {
      res.json(await registerOptions(getPool(), scopeOf(req)))
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/tickets/:id/status", requireUser, async (req, res, next) => {
    try {
      const ticketId = Number(req.params.id)
      if (!Number.isInteger(ticketId) || ticketId < 1) throw new ServiceError(400, "That ticket does not exist.")
      const body = (req.body ?? {}) as Record<string, unknown>
      const ticket = await updateTicketStatus(
        getPool(),
        actorOf(req),
        ticketId,
        String(body.status ?? ""),
        String(body.reason ?? ""),
        scopeOf(req),
      )
      res.json({ ticket })
      publishChange({ kind: "ticket.updated", marketplaceId: null, actorId: actorOf(req).id })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/tickets/:id/history", requireUser, async (req, res, next) => {
    try {
      const ticketId = Number(req.params.id)
      if (!Number.isInteger(ticketId) || ticketId < 1) throw new ServiceError(400, "That ticket does not exist.")
      res.json({ history: await ticketHistory(getPool(), ticketId, scopeOf(req)) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // ---- Administrator configuration. Reads and writes need the Admin role. Every change is audited. ----

  app.get("/api/admin/issue-categories", requireUser, requireAdmin, async (_req, res, next) => {
    try {
      res.json({ categories: await listCategories(getPool()) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/admin/issue-categories/:code", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const changes: { active?: boolean; requiresTicket?: boolean } = {}
      if (typeof body.active === "boolean") changes.active = body.active
      if (typeof body.requiresTicket === "boolean") changes.requiresTicket = body.requiresTicket
      if (Object.keys(changes).length === 0) throw new ServiceError(400, "Nothing to change.")
      const category = await updateCategory(getPool(), actorOf(req), String(req.params.code), changes)
      res.json({ category })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/admin/issue-categories", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const label = String(body.label || "").trim()
      const code = body.code ? String(body.code).trim() : undefined
      const requiresTicket = Boolean(body.requiresTicket)
      const allowsSubIssue = Boolean(body.allowsSubIssue)
      const category = await createCategory(getPool(), actorOf(req), {
        label,
        code,
        requiresTicket,
        allowsSubIssue,
      })
      res.status(201).json({ category })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  // ---- Logistics partners. Nothing is deleted: a partner, alias or host is switched off. ----

  app.get("/api/admin/logistics-partners", requireUser, requireAdmin, async (_req, res, next) => {
    try {
      res.json({ partners: await listPartners(getPool()) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/admin/logistics-partners", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      res.json({ partner: await addPartner(getPool(), actorOf(req), String(body.name ?? "")) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/admin/logistics-partners/:id", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id)
      const body = (req.body ?? {}) as Record<string, unknown>
      if (!Number.isInteger(id) || id < 1) throw new ServiceError(400, "That partner does not exist.")
      if (typeof body.active !== "boolean") throw new ServiceError(400, "Nothing to change.")
      res.json({ partner: await setPartnerActive(getPool(), actorOf(req), id, body.active) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/admin/logistics-partners/:id/aliases", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id)
      const body = (req.body ?? {}) as Record<string, unknown>
      if (!Number.isInteger(id) || id < 1) throw new ServiceError(400, "That partner does not exist.")
      const marketplace = String(body.marketplace ?? "").trim()
      res.json({
        alias: await addAlias(getPool(), actorOf(req), id, String(body.alias ?? ""), marketplace || null),
      })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/admin/logistics-partner-aliases/:id", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id)
      const body = (req.body ?? {}) as Record<string, unknown>
      if (!Number.isInteger(id) || id < 1) throw new ServiceError(400, "That alias does not exist.")
      if (typeof body.active !== "boolean") throw new ServiceError(400, "Nothing to change.")
      res.json({ alias: await setAliasActive(getPool(), actorOf(req), id, body.active) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/admin/logistics-partners/:id/domains", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id)
      const body = (req.body ?? {}) as Record<string, unknown>
      if (!Number.isInteger(id) || id < 1) throw new ServiceError(400, "That partner does not exist.")
      res.json({ domain: await addDomain(getPool(), actorOf(req), id, String(body.host ?? "")) })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/admin/logistics-partner-domains/:id", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id)
      const body = (req.body ?? {}) as Record<string, unknown>
      if (!Number.isInteger(id) || id < 1) throw new ServiceError(400, "That tracking host does not exist.")
      if (typeof body.active !== "boolean") throw new ServiceError(400, "Nothing to change.")
      res.json({ domain: await setDomainActive(actorOf(req), id, body.active) })
    } catch (error) {
      sendError(res, error, next)
    }
  })
}
