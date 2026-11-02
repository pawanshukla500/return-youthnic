/**
 * AI operational memory: pure rules for approved recovery procedures.
 *
 * Memory-first execution means the worker reuses a verified fix without a new
 * model call. Only procedures with status `approved` are matchable. AI
 * suggestions enter as `pending` and stay inert until an operator approves
 * them; `disabled` procedures are never matched. Nothing here deletes rows.
 */

export const PROCEDURE_STATUSES = ["pending", "approved", "disabled"] as const
export type ProcedureStatus = (typeof PROCEDURE_STATUSES)[number]

export const PROCEDURE_SOURCES = ["operator", "ai-suggestion", "worker"] as const
export type ProcedureSource = (typeof PROCEDURE_SOURCES)[number]

export type MemoryProcedure = {
  id: number | string
  marketplace: string
  errorSignature: string
  title: string
  steps: string[]
  status: ProcedureStatus
  source: ProcedureSource
}

/**
 * Normalize a raw worker error into a matchable signature: lowercase, collapse
 * volatile tokens (numbers, UUIDs, timestamps, temp paths, ports), collapse
 * whitespace, cap length. Two failures from the same root cause must map to
 * the same signature even when ports, PIDs, or timings differ.
 */
export function normalizeErrorSignature(raw: string): string {
  let value = String(raw || "").toLowerCase()
  value = value
    .replace(/[a-z]:[\\/][^\s]*/g, " <path> ")
    .replace(/\/[^\s]*\.(png|jpg|jpeg|pdf|xlsx|csv|log|tmp)\b/g, " <file> ")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, " <id> ")
    .replace(/\b\d{9,15}\b/g, " <ticket> ")
    .replace(/:\d{2,5}\b/g, ":<port>")
    .replace(/\bport\s+\d+\b/g, "port <port>")
    .replace(/\b\d+\b/g, " <n> ")
    .replace(/\s+/g, " ")
    .trim()
  if (!value) return "unknown-error"
  return value.slice(0, 300)
}

/**
 * Memory-first lookup: the first `approved` procedure whose marketplace and
 * normalized signature both match. Marketplace compares case-insensitively; a
 * blank procedure marketplace never matches (procedures are per-marketplace).
 */
export function matchApprovedProcedure(
  procedures: MemoryProcedure[],
  marketplace: string,
  errorSignature: string,
): MemoryProcedure | null {
  const market = String(marketplace || "").trim().toLowerCase()
  const signature = String(errorSignature || "").trim().toLowerCase()
  if (!market || !signature) return null
  for (const procedure of procedures) {
    if (procedure.status !== "approved") continue
    if (String(procedure.marketplace || "").trim().toLowerCase() !== market) continue
    if (String(procedure.errorSignature || "").trim().toLowerCase() !== signature) continue
    if (!Array.isArray(procedure.steps) || procedure.steps.length === 0) continue
    return procedure
  }
  return null
}

export type ProcedureTransition = "approve" | "disable" | "requeue"

/**
 * Status transitions for the inspect/approve/disable/correct interface.
 * AI suggestions can only become usable through `approve`, applied by an
 * operator — never by the worker, never by the model.
 */
export function procedureTransition(from: ProcedureStatus, action: ProcedureTransition): ProcedureStatus | null {
  if (action === "approve" && from === "pending") return "approved"
  if (action === "disable" && (from === "pending" || from === "approved")) return "disabled"
  if (action === "requeue" && from === "disabled") return "pending"
  return null
}

export function isUsableProcedure(procedure: MemoryProcedure): boolean {
  return (
    procedure.status === "approved" &&
    Array.isArray(procedure.steps) &&
    procedure.steps.length > 0 &&
    procedure.steps.every((step) => typeof step === "string" && step.trim().length > 0)
  )
}
