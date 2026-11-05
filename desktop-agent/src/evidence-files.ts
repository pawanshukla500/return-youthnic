/**
 * Local evidence-file endpoints for the desktop renderer.
 *
 * The engine downloads claim evidence into `config.workDir/claim-<id>/` (see
 * AgentBackendClient.downloadEvidenceFiles). These helpers back
 * GET /api/evidence/:claimId and GET /api/evidence/:claimId/:fileName in
 * desktop-app-server.ts. They touch only the local filesystem, so they keep
 * working while the backend is down.
 *
 * The path-safety helper is the security boundary: the file name comes from a
 * URL, so it must never be able to escape the claim directory. Anything that
 * is not a plain file name inside the claim dir (traversal, absolute paths,
 * separators, empty or oversized names) is rejected with null and the route
 * answers 400 without touching the file.
 */

import fs from "node:fs"
import path from "node:path"

/** claimId shape used by the evidence routes: strict, no path characters. */
export const EVIDENCE_CLAIM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/

/** File names longer than this are rejected before touching the disk. */
export const EVIDENCE_MAX_FILE_NAME_LENGTH = 255

export type EvidenceFileInfo = {
  name: string
  sizeBytes: number
  mtimeIso: string
}

export function isValidEvidenceClaimId(claimId: string): boolean {
  return EVIDENCE_CLAIM_ID_PATTERN.test(claimId)
}

/**
 * Resolves fileName to an absolute path inside workDir/claim-<claimId>, or
 * null when claimId or fileName is not safe. No filesystem access happens
 * here; a null means the route must answer 400, a resolved path still has to
 * be stat'ed (and may 404).
 */
export function resolveEvidenceFile(workDir: string, claimId: string, fileName: string): string | null {
  if (!isValidEvidenceClaimId(claimId)) return null
  if (!fileName || fileName.length > EVIDENCE_MAX_FILE_NAME_LENGTH) return null
  // Reject separators and drive letters outright; the prefix check below is
  // the backstop, not the first line.
  if (/[/\\]/.test(fileName)) return null
  if (fileName.includes("\0")) return null
  const claimDir = path.resolve(path.join(workDir, `claim-${claimId}`))
  const fullPath = path.resolve(claimDir, fileName)
  if (fullPath !== claimDir && !fullPath.startsWith(claimDir + path.sep)) return null
  return fullPath
}

/** Top-level regular files of the claim dir, sorted by name, .part excluded. */
export function listEvidenceFiles(workDir: string, claimId: string): EvidenceFileInfo[] {
  if (!isValidEvidenceClaimId(claimId)) return []
  const claimDir = path.join(workDir, `claim-${claimId}`)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(claimDir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: EvidenceFileInfo[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name.endsWith(".part")) continue
    if (!resolveEvidenceFile(workDir, claimId, entry.name)) continue
    let stat: fs.Stats
    try {
      stat = fs.statSync(path.join(claimDir, entry.name))
    } catch {
      continue
    }
    files.push({ name: entry.name, sizeBytes: stat.size, mtimeIso: stat.mtime.toISOString() })
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return files
}

const EVIDENCE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
}

/** Extensions the browser can render inline; everything else downloads. */
const EVIDENCE_INLINE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "mp4", "webm"])

function evidenceExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".")
  if (dot < 0 || dot === fileName.length - 1) return ""
  return fileName.slice(dot + 1).toLowerCase()
}

export function evidenceContentType(fileName: string): string {
  return EVIDENCE_CONTENT_TYPES[evidenceExtension(fileName)] || "application/octet-stream"
}

export function evidenceDisposition(fileName: string): "inline" | "attachment" {
  return EVIDENCE_INLINE_EXTENSIONS.has(evidenceExtension(fileName)) ? "inline" : "attachment"
}

/**
 * Headers for a successful evidence stream: Content-Type from the extension
 * map, Content-Length from the stat, and a disposition that previews images
 * and video inline while downloading anything else. The file name is already
 * validated (no separators/quotes) by resolveEvidenceFile before this runs.
 */
export function evidenceStreamHeaders(fileName: string, sizeBytes: number): Record<string, string> {
  const safeName = fileName.replace(/["\\\r\n]/g, "_")
  return {
    "Content-Type": evidenceContentType(fileName),
    "Content-Length": String(sizeBytes),
    "Content-Disposition": `${evidenceDisposition(fileName)}; filename="${safeName}"`,
  }
}
