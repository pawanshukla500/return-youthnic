import type { Express, RequestHandler } from "express"
import multer from "multer"
import { accountCondition, allowsAccount, NO_ACCESS_MESSAGE, type AccountScope } from "./access.js"
import { getPool } from "./db.js"
import { parseScannerList, type ScannerListEntry } from "./scanner-list.js"
import { scopeOf } from "./http.js"

const uploadFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

type Candidate = {
  expectedReturnId: number
  accountId: number
  accountName: string
  matchedTrackingField: "tracking_id" | "alt_tracking_id"
  matchedLeg: "return" | "forward"
  alreadyScanned: boolean
}

type ValidatedEntry = ScannerListEntry & {
  matchStatus: "malformed" | "unassigned" | "unmatched" | "ambiguous" | "matched" | "previously_scanned"
  candidates: Candidate[]
  mappedAccount: string
}

function parseSheetAccounts(raw: unknown): Record<string, string> {
  if (!raw) return {}
  if (typeof raw === "object") return raw as Record<string, string>
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

async function scopedAccounts(scope: AccountScope) {
  const params: unknown[] = []
  const condition = accountCondition(scope, "m.id", params)
  const result = await getPool().query(`SELECT m.id, m.name FROM marketplaces m WHERE ${condition}`, params)
  return result.rows.map((row) => ({ id: Number(row.id), name: String(row.name) }))
}

function matchFor(
  entry: ScannerListEntry,
  candidates: Map<string, Candidate[]>,
  sheetAccount: string,
): ValidatedEntry {
  if (entry.status !== "valid") {
    return { ...entry, matchStatus: "malformed", candidates: [], mappedAccount: sheetAccount }
  }
  if (!sheetAccount) {
    return { ...entry, matchStatus: "unassigned", candidates: [], mappedAccount: "" }
  }
  const found = candidates.get(entry.normalizedValue) ?? []
  if (found.length === 0) return { ...entry, matchStatus: "unmatched", candidates: [], mappedAccount: sheetAccount }
  if (found.length > 1) {
    return {
      ...entry,
      matchStatus: found.every((candidate) => candidate.alreadyScanned) ? "previously_scanned" : "ambiguous",
      candidates: found,
      mappedAccount: sheetAccount,
    }
  }
  if (found[0].alreadyScanned) {
    return { ...entry, matchStatus: "previously_scanned", candidates: found, mappedAccount: sheetAccount }
  }
  return { ...entry, matchStatus: "matched", candidates: found, mappedAccount: sheetAccount }
}

export function mountScannerListRoutes(app: Express, requireUser: RequestHandler): void {
  app.post("/api/uploads/scanner-list/preview", requireUser, uploadFile.single("file"), async (req, res, next) => {
    try {
      const file = req.file
      if (!file) return res.status(400).json({ error: "Choose an XLSX scanner-list file" })
      const scope = scopeOf(req)
      const accounts = await scopedAccounts(scope)
      const byName = new Map(accounts.map((account) => [account.name, account]))
      const sheetAccounts = parseSheetAccounts(req.body?.sheetAccounts)
      const parsed = parseScannerList(file.buffer)
      const chosen = new Map<string, string>()
      for (const sheet of parsed.sheets) {
        const name = String(sheetAccounts[sheet.name] || "").trim()
        if (name && !byName.has(name)) return res.status(403).json({ error: NO_ACCESS_MESSAGE })
        chosen.set(sheet.name, name)
      }

      const normalizedValues = [...new Set(parsed.entries.filter((entry) => entry.status === "valid").map((entry) => entry.normalizedValue))]
      const accountNames = [...new Set([...chosen.values()].filter(Boolean))]
      const accountIds = accountNames.map((name) => byName.get(name)?.id).filter((id): id is number => id !== undefined)
      const candidates = new Map<string, Candidate[]>()
      if (normalizedValues.length && accountIds.length) {
        const result = await getPool().query(
          `SELECT er.id, er.tracking_id, er.alt_tracking_id, m.id AS account_id, m.name AS account_name,
                  EXISTS (
                    SELECT 1 FROM receipt_scans rs WHERE rs.expected_return_id = er.id
                  ) AS already_scanned
           FROM expected_returns er
           JOIN marketplaces m ON m.id = er.marketplace_id
           WHERE er.lookup_status = 'active'
             AND (er.tracking_id = ANY($1::text[]) OR er.alt_tracking_id = ANY($1::text[]))
             AND m.id = ANY($2::integer[])`,
          [normalizedValues, accountIds],
        )
        for (const row of result.rows) {
          const expectedReturnId = Number(row.id)
          const candidate: Candidate = {
            expectedReturnId,
            accountId: Number(row.account_id),
            accountName: String(row.account_name),
            matchedTrackingField: String(row.tracking_id) === String(row.alt_tracking_id) ? "tracking_id" : "tracking_id",
            matchedLeg: "return",
            alreadyScanned: Boolean(row.already_scanned),
          }
          const primary = String(row.tracking_id)
          const alternate = String(row.alt_tracking_id || "")
          const add = (key: string, field: "tracking_id" | "alt_tracking_id", leg: "return" | "forward") => {
            if (!key || !normalizedValues.includes(key)) return
            const item = { ...candidate, matchedTrackingField: field, matchedLeg: leg }
            const existing = candidates.get(key) ?? []
            if (!existing.some((current) => current.expectedReturnId === item.expectedReturnId && current.accountId === item.accountId)) {
              candidates.set(key, [...existing, item])
            }
          }
          add(primary, "tracking_id", "return")
          add(alternate, "alt_tracking_id", "forward")
        }
      }

      const entries = parsed.entries.map((entry) => matchFor(entry, candidates, chosen.get(entry.sheet) ?? ""))
      const counts = {
        sheets: parsed.counts.sheets,
        entries: entries.length,
        matched: entries.filter((entry) => entry.matchStatus === "matched").length,
        unmatched: entries.filter((entry) => entry.matchStatus === "unmatched").length,
        ambiguous: entries.filter((entry) => entry.matchStatus === "ambiguous").length,
        previouslyScanned: entries.filter((entry) => entry.matchStatus === "previously_scanned").length,
        unassigned: entries.filter((entry) => entry.matchStatus === "unassigned").length,
        malformed: entries.filter((entry) => entry.matchStatus === "malformed").length,
        duplicateEntries: entries.filter((entry) => entry.duplicate).length,
      }
      res.json({
        kind: parsed.kind,
        filename: file.originalname,
        sheets: parsed.sheets.map((sheet) => ({
          name: sheet.name,
          sourceRows: sheet.sourceRows,
          nonEmptyCells: sheet.nonEmptyCells,
          columns: sheet.columns,
          mappedAccount: chosen.get(sheet.name) ?? "",
        })),
        accounts,
        counts,
        entries,
        message: "Validation only. This scanner list is not a return-master upload and cannot activate or create scans.",
      })
    } catch (error) {
      next(error)
    }
  })
}
