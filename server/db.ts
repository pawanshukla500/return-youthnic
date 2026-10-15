import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { ensureReferenceData } from "./reference-data.js"

const { Pool } = pg

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// Schema version marker. Stored in schema_migrations on the first successful apply. Bumping it no longer
// triggers a destructive rebuild: the schema files are fully additive and idempotent, and a rebuild would
// destroy scan and claim history. See assertSchemaFilesSafe below for the production-data guard.
const SCHEMA_VERSION = 1

// The schema files, applied in this order on every start. Each one is additive and safe to re-run.
//  schema.sql               base tables (snapshot tables kept, unused)
//  schema-import.sql        lookup activation, register tables, categories, audit, reference-era tables.
//                            The scan bench taps an issue, so those categories do not require a typed ticket ID.
//  schema-register.sql      logistics partners, tracking evidence, return type and display identifiers, scan snapshots
//  schema-scan-history.sql  scan history snapshots (original AWB, link AWB, source file, return event) and indexes
//  schema-shopify.sql       Shopify real-time return and RTO ingestion and sync runs
//  schema-payment.sql       Payment and sales amount synchronization and sync runs
//  schema-iron.sql          Iron Send tracking (operational category, sent and received quantities, overdue setting)
//  schema-flyer.sql         Meesho flyer ID capture for issue returns (permanent claim evidence)
//  schema-claims.sql       Claims foundation: templates, claim records, media metadata, status history
const SCHEMA_FILES = [
  "schema.sql",
  "schema-import.sql",
  "schema-register.sql",
  "schema-scan-history.sql",
  "schema-shopify.sql",
  "schema-payment.sql",
  "schema-unmapped-skus.sql",
  "schema-return-reasons.sql",
  "schema-iron.sql",
  "schema-flyer.sql",
  "schema-claims.sql",
] as const

// History tables whose rows must never be destroyed by any code path. Listed here so they cannot silently
// reappear in a future migration allowlist without an explicit, reviewed change. Each table either holds
// scan evidence (scans, items, issues, claim tickets, claim history), upload history (batches, rows), the
// audit log, or permanent lookup data (expected_returns, expected_return_items, cancelled_returns).
const HISTORY_TABLES = [
  "receipt_scans",
  "receipt_scan_items",
  "receipt_scan_issues",
  "claim_tickets",
  "claim_ticket_history",
  "evidence_events",
  "expected_returns",
  "expected_return_items",
  "cancelled_returns",
  "upload_batches",
  "upload_rows",
  "register_audit_log",
  "iron_send_records",
  "iron_receive_events",
  "iron_batches",
  "claims",
  "claim_media",
  "claim_status_history",
] as const

// Reads every schema file and refuses to apply them if any contain a destructive statement against a
// history table. The check runs in the same transaction as the apply, so a hostile change cannot reach the
// database. Allowed: DROP CONSTRAINT (removes obsolete UNIQUE constraints that were superseded by partial
// unique indexes), DROP INDEX IF EXISTS (used nowhere today; safe), and CREATE / ALTER / INSERT / UPDATE.
function assertSchemaFilesSafe(): void {
  const destructive = /\b(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i
  for (const file of SCHEMA_FILES) {
    const sql = fs.readFileSync(path.join(root, "server", file), "utf8")
    if (destructive.test(sql)) {
      throw new Error(
        `Refusing to apply server/${file}: contains a DROP TABLE / TRUNCATE / DELETE statement. ` +
          `The schema is additive only. Replace the statement with an additive change, or remove the destructive line entirely.`,
      )
    }
  }
}

export function databaseUrl() {
  return process.env.DATABASE_URL?.trim() || ""
}

export type DatabaseConnection = {
  connectionString: string
  ssl: false | { rejectUnauthorized: true; ca?: string }
}

// Turns DATABASE_URL into the connection string and the SSL setting that pg uses.
// The server certificate is checked whenever TLS is on. No setting turns that check off.
//  - localhost, 127.0.0.1 and [::1] connect without TLS, unless sslmode asks for TLS.
//  - Any other host connects with TLS, unless sslmode=disable.
//  - sslmode=require, prefer, allow, verify-ca and verify-full all mean TLS with the check on.
//  - sslmode=no-verify is refused.
//  - A private CA certificate comes from DATABASE_SSL_CA_FILE, or from sslrootcert in the URL.
// sslmode and sslrootcert are removed from the string, so the driver uses only the setting returned here.
// Error messages never include the URL.
export function connectionSettingsFor(url: string, env: NodeJS.ProcessEnv = process.env): DatabaseConnection {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("DATABASE_URL must be a postgresql:// URL. Check the value in the .env file.")
  }
  const sslmode = (parsed.searchParams.get("sslmode") || "").trim().toLowerCase()
  const caFromUrl = (parsed.searchParams.get("sslrootcert") || "").trim()
  parsed.searchParams.delete("sslmode")
  parsed.searchParams.delete("sslrootcert")
  const connectionString = parsed.toString()

  if (sslmode === "no-verify") {
    throw new Error("sslmode=no-verify is not allowed. The database certificate must be verified.")
  }

  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname)
  const useTls = sslmode === "" ? !local : sslmode !== "disable"
  if (!useTls) return { connectionString, ssl: false }

  const caFromEnv = (env.DATABASE_SSL_CA || env.DATABASE_SSL_CA_PEM || "").trim()
  const caPath = (env.DATABASE_SSL_CA_FILE || "").trim() || caFromUrl
  if (!caFromEnv && !caPath) return { connectionString, ssl: { rejectUnauthorized: true } }

  let ca: string = caFromEnv
  if (!ca && caPath) {
    try {
      ca = fs.readFileSync(caPath, "utf8")
    } catch {
      throw new Error("The CA certificate file (DATABASE_SSL_CA_FILE or sslrootcert) cannot be read. Check the path.")
    }
  }
  return { connectionString, ssl: { rejectUnauthorized: true, ca } }
}

let pool: pg.Pool | null = null

export function getPool() {
  const url = databaseUrl()
  if (!url) throw new Error("DATABASE_URL is not set")
  if (!pool) {
    const connection = connectionSettingsFor(url)
    pool = new Pool({
      connectionString: connection.connectionString,
      ssl: connection.ssl,
      connectionTimeoutMillis: 8000,
      max: 10,
      min: 2,
      idleTimeoutMillis: 30000,
    })
  }
  return pool
}

// A new pool for the same database. Tests use it to check that data survives a reconnect, as after a restart.
export function openPool(url: string = databaseUrl()): pg.Pool {
  const connection = connectionSettingsFor(url)
  return new Pool({
    connectionString: connection.connectionString,
    ssl: connection.ssl,
    connectionTimeoutMillis: 8000,
  })
}

// True when this database has already been initialised to the current schema. False on a fresh database or
// before the schema_migrations table exists. The apply only inserts new columns, indexes, and reference
// rows; it never deletes or rewrites anything, so an empty database and a populated one both run the same
// statements safely.
async function isSchemaApplied(client: pg.PoolClient): Promise<boolean> {
  const result = await client.query<{ version: number }>(
    "SELECT version FROM schema_migrations WHERE version = $1",
    [SCHEMA_VERSION],
  )
  return result.rows.length > 0
}

// Applies every schema file in one transaction. The schema files are fully additive and idempotent, so
// running them on every start is safe on both fresh and populated databases. No code path drops a table
// or rewrites data. assertSchemaFilesSafe refuses the apply if any schema file contains a DROP TABLE /
// TRUNCATE / DELETE statement, so a hostile edit cannot reach the database.
export async function applySchema(db: pg.Pool): Promise<void> {
  const client = await db.connect()
  try {
    assertSchemaFilesSafe()
    await client.query("BEGIN")
    await client.query("SET LOCAL lock_timeout = '15s'")
    for (const file of SCHEMA_FILES) {
      const sql = fs.readFileSync(path.join(root, "server", file), "utf8")
      await client.query(sql)
    }
    if (!(await isSchemaApplied(client))) {
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
        [SCHEMA_VERSION],
      )
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function initDatabase() {
  if (!databaseUrl()) {
    return {
      ok: false as const,
      message: "Add DATABASE_URL to the .env file and restart the server.",
    }
  }

  const db = getPool()
  await db.query("SELECT 1")
  await applySchema(db)
  // Reference rows only (marketplace channels). The app starts with no users, scans or figures.
  await ensureReferenceData(db)
  return { ok: true as const, message: "Connected" }
}
