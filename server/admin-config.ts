// Admin configuration for the logistics partner reference data: partners, their aliases, and their tracking domains.
// Every change is written to register_audit_log with the signed-in user. Nothing here deletes a row: a partner, alias or
// domain is switched off, so the history of earlier scans and lookups stays readable.
//
// Still to do (not in this file): header aliases, return type mappings, and validation exceptions. They need their own
// reference tables and screens. See docs/notes/phase1-register-status.md.

import type pg from "pg"
import { aliasKey, hostOf } from "./marketplace-rules.js"
import { ServiceError, writeAudit, type Actor } from "./register-service.js"

const MAX_NAME = 60
const MAX_ALIAS = 60

export type PartnerRow = {
  id: number
  name: string
  active: boolean
  aliases: { id: number; alias: string; aliasKey: string; marketplace: string; active: boolean }[]
  domains: { id: number; host: string; active: boolean }[]
}

export async function listPartners(db: pg.Pool): Promise<PartnerRow[]> {
  const partners = await db.query("SELECT id, name, active FROM logistics_partners ORDER BY name")
  const aliases = await db.query(
    `SELECT a.id, a.partner_id, a.alias_key, a.active, COALESCE(m.name, 'All marketplaces') AS marketplace
     FROM logistics_partner_aliases a
     LEFT JOIN marketplaces m ON m.id = a.marketplace_id
     ORDER BY a.alias_key, a.id`,
  )
  const domains = await db.query("SELECT id, partner_id, host, active FROM logistics_partner_domains ORDER BY host")
  return partners.rows.map((partner) => ({
    id: Number(partner.id),
    name: String(partner.name),
    active: Boolean(partner.active),
    aliases: aliases.rows
      .filter((alias) => Number(alias.partner_id) === Number(partner.id))
      .map((alias) => ({
        id: Number(alias.id),
        alias: String(alias.alias_key),
        aliasKey: String(alias.alias_key),
        marketplace: String(alias.marketplace),
        active: Boolean(alias.active),
      })),
    domains: domains.rows
      .filter((domain) => Number(domain.partner_id) === Number(partner.id))
      .map((domain) => ({ id: Number(domain.id), host: String(domain.host), active: Boolean(domain.active) })),
  }))
}

function cleanName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim()
  if (!name) throw new ServiceError(400, "Enter a partner name.")
  if (name.length > MAX_NAME) throw new ServiceError(400, `The partner name must be ${MAX_NAME} characters or fewer.`)
  return name
}

export async function addPartner(db: pg.Pool, actor: Actor, rawName: string) {
  const name = cleanName(rawName)
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const existing = await client.query("SELECT id FROM logistics_partners WHERE lower(name) = lower($1)", [name])
    if (existing.rows[0]) throw new ServiceError(409, `${name} is already in the partner list.`)
    const inserted = await client.query("INSERT INTO logistics_partners (name) VALUES ($1) RETURNING id", [name])
    const id = Number(inserted.rows[0].id)
    await writeAudit(client, actor.id, "logistics_partner.add", "logistics_partner", String(id), { name })
    await client.query("COMMIT")
    return { id, name, active: true }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function setPartnerActive(db: pg.Pool, actor: Actor, partnerId: number, active: boolean) {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const updated = await client.query(
      "UPDATE logistics_partners SET active = $2 WHERE id = $1 RETURNING id, name, active",
      [partnerId, active],
    )
    if (!updated.rows[0]) throw new ServiceError(404, "That partner does not exist.")
    await writeAudit(client, actor.id, "logistics_partner.active", "logistics_partner", String(partnerId), { active })
    await client.query("COMMIT")
    return { id: partnerId, name: String(updated.rows[0].name), active: Boolean(updated.rows[0].active) }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

// An alias is matched on letters and digits only, so "Xpress Bees", "xpress-bees" and "XPRESSBEES" are one alias.
// marketplace null applies the alias to every marketplace.
export async function addAlias(
  db: pg.Pool,
  actor: Actor,
  partnerId: number,
  rawAlias: string,
  marketplaceName: string | null,
) {
  const alias = rawAlias.trim()
  if (alias.length > MAX_ALIAS) throw new ServiceError(400, `The alias must be ${MAX_ALIAS} characters or fewer.`)
  const key = aliasKey(alias)
  if (!key) throw new ServiceError(400, "Enter an alias with letters or digits.")
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const partner = await client.query("SELECT id, name, active FROM logistics_partners WHERE id = $1", [partnerId])
    if (!partner.rows[0]) throw new ServiceError(404, "That partner does not exist.")
    let marketplaceId: number | null = null
    if (marketplaceName) {
      const marketplace = await client.query("SELECT id FROM marketplaces WHERE name = $1", [marketplaceName])
      if (!marketplace.rows[0]) throw new ServiceError(400, "Choose a connected marketplace, or all marketplaces.")
      marketplaceId = Number(marketplace.rows[0].id)
    }
    const duplicate = await client.query(
      "SELECT id FROM logistics_partner_aliases WHERE alias_key = $1 AND COALESCE(marketplace_id, 0) = $2",
      [key, marketplaceId ?? 0],
    )
    if (duplicate.rows[0]) throw new ServiceError(409, `The alias "${alias}" is already used for this scope.`)
    const inserted = await client.query(
      `INSERT INTO logistics_partner_aliases (partner_id, alias_key, marketplace_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [partnerId, key, marketplaceId],
    )
    const id = Number(inserted.rows[0].id)
    await writeAudit(client, actor.id, "logistics_partner.alias_add", "logistics_partner_alias", String(id), {
      partner: String(partner.rows[0].name),
      alias: key,
      marketplace: marketplaceName ?? "All marketplaces",
    })
    await client.query("COMMIT")
    return { id, partnerId, alias: key, marketplace: marketplaceName ?? "All marketplaces", active: true }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function setAliasActive(db: pg.Pool, actor: Actor, aliasId: number, active: boolean) {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const updated = await client.query(
      "UPDATE logistics_partner_aliases SET active = $2 WHERE id = $1 RETURNING id, alias_key",
      [aliasId, active],
    )
    if (!updated.rows[0]) throw new ServiceError(404, "That alias does not exist.")
    await writeAudit(client, actor.id, "logistics_partner.alias_active", "logistics_partner_alias", String(aliasId), {
      alias: String(updated.rows[0].alias_key),
      active,
    })
    await client.query("COMMIT")
    return { id: aliasId, active }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

// A tracking host is only the host name (for example track.example.in). Its AWB format is read by code, in
// LINK_RULES (server/marketplace-rules.ts). A host added here identifies the partner from a link, but its
// AWB is not read until the format is added to the code and verified against a real file.
export async function addDomain(db: pg.Pool, actor: Actor, partnerId: number, rawHost: string) {
  const host = rawHost.trim().toLowerCase()
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || hostOf(`https://${host}`) !== host) {
    throw new ServiceError(400, "Enter a host name only, for example track.example.in.")
  }
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const partner = await client.query("SELECT id, name FROM logistics_partners WHERE id = $1", [partnerId])
    if (!partner.rows[0]) throw new ServiceError(404, "That partner does not exist.")
    const duplicate = await client.query("SELECT id FROM logistics_partner_domains WHERE host = $1", [host])
    if (duplicate.rows[0]) throw new ServiceError(409, `${host} is already linked to a partner.`)
    const inserted = await client.query(
      "INSERT INTO logistics_partner_domains (partner_id, host) VALUES ($1, $2) RETURNING id",
      [partnerId, host],
    )
    const id = Number(inserted.rows[0].id)
    await writeAudit(client, actor.id, "logistics_partner.domain_add", "logistics_partner_domain", String(id), {
      partner: String(partner.rows[0].name),
      host,
    })
    await client.query("COMMIT")
    return { id, partnerId, host, active: true }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
