// Shared HTTP helpers for the route modules: the signed-in user and the account scope that requireUser attaches, the
// administrator check, and the mapping of a ServiceError to its HTTP status.
//
// requireUser (server/index.ts) must run before any helper here. It sets req.user with the scope from scopeFor()
// (server/access.ts). Each route passes that scope to its service function, so the restriction is applied in SQL.

import type { NextFunction, Request, Response } from "express"
import { isAdminRole, isSupervisorOrAdminRole, type AccountScope } from "./access.js"
import { ServiceError, type Actor } from "./register-service.js"

export type SessionUser = {
  id: number
  name: string
  role: string
  scope: AccountScope
}

export type AuthedRequest = Request & { user: SessionUser }

export function userOf(req: Request): SessionUser {
  const user = (req as AuthedRequest).user
  if (!user) throw new Error("requireUser must run before this route reads the signed-in user")
  return user
}

export function scopeOf(req: Request): AccountScope {
  return userOf(req).scope
}

export function actorOf(req: Request): Actor {
  const user = userOf(req)
  return { id: user.id, name: user.name }
}

// Only an administrator may read configuration that lists other users, and only an administrator may change anything.
// Roles are free text set by the user:create script ("Admin"), compared without regard to letter case.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminRole(userOf(req).role)) {
    res.status(403).json({ error: "Only an administrator can use this." })
    return
  }
  next()
}

// Routes requiring supervisor or administrator permissions
export function requireSupervisorOrAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isSupervisorOrAdminRole(userOf(req).role)) {
    res.status(403).json({ error: "Only a supervisor or administrator can use this." })
    return
  }
  next()
}

// A ServiceError becomes its HTTP status with its message and details. Anything else goes to the error handler.
export function sendError(res: Response, error: unknown, next: NextFunction): void {
  if (error instanceof ServiceError) {
    res.status(error.status).json({ error: error.message, details: error.details, ...error.extra })
    return
  }
  next(error)
}
