import type { Express, Request, RequestHandler } from "express"
import { getPool } from "./db.js"
import { actorOf, requireAdmin, requireSupervisorOrAdmin, scopeOf, sendError } from "./http.js"
import { ServiceError } from "./register-service.js"
import {
  authenticateAutomationAgent,
  scopeForAutomationAgent,
} from "./claim-automation-service.js"
import {
  correctProcedure,
  createProcedure,
  listSyncedProceduresForAgent,
  listProcedures,
  transitionProcedure,
} from "./ai-memory-store.js"
import { createTask, listTasks, resolveTask } from "./operator-tasks.js"

/**
 * AI memory + operator task routes (Milestone 3).
 *
 * - Admin-only procedure management: inspect, propose (always `pending`),
 *   approve/disable/requeue through the validated transition, and correct
 *   content (correction re-queues an approved procedure to `pending`).
 * - Supervisor/Admin task center: list + resolve operator tasks in scope.
 * - Agent endpoints (automation key): read approved procedures in the
 *   agent's scope for the local cache sync, and file operator tasks for
 *   items the worker cannot finish alone.
 *
 * Mounted from `mountClaimAutomationRoutes`, which already owns the
 * automation + admin surface and the `requireUser` gate.
 */

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function positiveId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function strArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map((s) => String(s || "")).filter((s) => s.trim() !== "")
}

async function agentScope(req: Request) {
  const uuid = text(req.headers["x-agent-uuid"])
  const apiKey = text(req.headers["x-agent-key"])
  if (!uuid) throw new ServiceError(400, "Agent UUID required.")
  const db = getPool()
  await authenticateAutomationAgent(db, uuid, apiKey)
  return { scope: await scopeForAutomationAgent(db, uuid) }
}

function actorLabel(req: Request): string {
  const actor = actorOf(req)
  return `${String(actor.name || "operator")} (#${Number(actor.id) || 0})`
}

export function mountAiMemoryRoutes(app: Express, requireUser: RequestHandler): void {
  app.get("/api/admin/ai-memory/procedures", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const procedures = await listProcedures(getPool(), {
        status: text(req.query.status) || undefined,
        marketplace: text(req.query.marketplace) || undefined,
      })
      res.json({ procedures })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/admin/ai-memory/procedures", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const procedure = await createProcedure(getPool(), {
        marketplace: text(body.marketplace),
        errorSignature: text(body.errorSignature),
        title: text(body.title),
        steps: strArray(body.steps),
        source: text(body.source),
        actor: actorLabel(req),
      })
      res.status(201).json({ procedure })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/admin/ai-memory/procedures/:id", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const action = text(body.action)
      if (action !== "approve" && action !== "disable" && action !== "requeue") {
        throw new ServiceError(400, "Action must be approve, disable, or requeue.")
      }
      const procedure = await transitionProcedure(getPool(), Number(req.params.id), action, actorLabel(req))
      res.json({ procedure })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/admin/ai-memory/procedures/:id/correct", requireUser, requireAdmin, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const procedure = await correctProcedure(getPool(), Number(req.params.id), {
        title: typeof body.title === "string" ? body.title : undefined,
        steps: Array.isArray(body.steps) ? (body.steps as unknown[]).map(String) : undefined,
        errorSignature: typeof body.errorSignature === "string" ? body.errorSignature : undefined,
        marketplace: typeof body.marketplace === "string" ? body.marketplace : undefined,
      })
      res.json({ procedure })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/automation/ai-memory/procedures", async (req, res, next) => {
    try {
      const { scope } = await agentScope(req)
      const procedures = await listSyncedProceduresForAgent(getPool(), scope)
      res.json({ procedures })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/tasks", requireUser, requireSupervisorOrAdmin, async (req, res, next) => {
    try {
      const tasks = await listTasks(getPool(), scopeOf(req), { status: text(req.query.status) || undefined })
      res.json({ tasks })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.patch("/api/tasks/:id/resolve", requireUser, requireSupervisorOrAdmin, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const task = await resolveTask(getPool(), scopeOf(req), Number(req.params.id), actorLabel(req), text(body.resolution))
      res.json({ task })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.get("/api/automation/tasks", async (req, res, next) => {
    try {
      const { scope } = await agentScope(req)
      const tasks = await listTasks(getPool(), scope, { status: text(req.query.status) || undefined })
      res.json({ tasks })
    } catch (error) {
      sendError(res, error, next)
    }
  })

  app.post("/api/automation/tasks", async (req, res, next) => {
    try {
      const { scope } = await agentScope(req)
      const body = (req.body ?? {}) as Record<string, unknown>
      const task = await createTask(getPool(), scope, {
        claimId: positiveId(body.claimId) || 0,
        marketplace: text(body.marketplace),
        kind: text(body.kind),
        title: text(body.title),
        note: text(body.note),
        owner: "",
        source: "worker",
      })
      res.status(201).json({ task })
    } catch (error) {
      sendError(res, error, next)
    }
  })
}
