// Logistics partner detection against the database reference tables (logistics_partners, logistics_partner_aliases,
// logistics_partner_domains). The decision rules are pure and live in server/marketplace-rules.ts. This file only loads
// the reference rows and applies the rules to the parsed rows.
//
// Partner names are never guessed from the shape of an AWB. A carrier that is not on the list stays
// "Unknown / Pending Verification" until it is added in Admin.

import { detectPartner, type PartnerIndex, type PartnerMatch } from "./marketplace-rules.js"
import type { ParsedRow } from "./sheets.js"

// The part of pg's Pool and PoolClient that this module uses. Both satisfy it.
export type Queryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export async function loadPartnerIndex(db: Queryable, marketplace: string): Promise<PartnerIndex> {
  const index: PartnerIndex = { aliases: new Map(), hosts: new Map() }
  const aliases = await db.query(
    `SELECT p.id AS partner_id, p.name, a.alias_key, COALESCE(m.name, '*') AS scope
     FROM logistics_partner_aliases a
     JOIN logistics_partners p ON p.id = a.partner_id
     LEFT JOIN marketplaces m ON m.id = a.marketplace_id
     WHERE a.active AND p.active AND (a.marketplace_id IS NULL OR m.name = $1)`,
    [marketplace],
  )
  for (const row of aliases.rows) {
    index.aliases.set(`${String(row.scope)}|${String(row.alias_key)}`, {
      partnerId: Number(row.partner_id),
      name: String(row.name),
    })
  }
  const hosts = await db.query(
    `SELECT d.host, p.id AS partner_id, p.name
     FROM logistics_partner_domains d
     JOIN logistics_partners p ON p.id = d.partner_id
     WHERE d.active AND p.active`,
  )
  for (const row of hosts.rows) {
    index.hosts.set(String(row.host), { partnerId: Number(row.partner_id), name: String(row.name) })
  }
  return index
}

// Applies partner detection to every row and returns the decision for each row object. Idempotent: running it twice
// gives the same decisions, and a warning is never added twice.
export async function applyPartners(
  db: Queryable,
  rows: ParsedRow[],
  marketplace: string,
): Promise<Map<ParsedRow, PartnerMatch>> {
  const decisions = new Map<ParsedRow, PartnerMatch>()
  if (!rows.length) return decisions
  const index = await loadPartnerIndex(db, marketplace)
  for (const row of rows) {
    const match = detectPartner(index, marketplace, row.carrierValue ?? "", row.trackingUrl ?? "")
    decisions.set(row, match)
    if (match.warning && !row.warnings.includes(match.warning)) row.warnings = [...row.warnings, match.warning]
  }
  return decisions
}
