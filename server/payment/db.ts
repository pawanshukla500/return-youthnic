import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

const { Pool } = pg

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

let paymentPool: pg.Pool | null = null

export function paymentDatabaseUrl(): string {
  return process.env.PAYMENT_DATABASE_URL?.trim() || ""
}

export type PaymentDbConnectionSettings = {
  connectionString: string
  ssl: false | { rejectUnauthorized: boolean; ca?: string; checkServerIdentity?: () => undefined }
}

/**
 * Returns connection parameters for the external Payment/Sales database.
 * Strictly verifies TLS certificate. Never leaks URL or secrets in errors.
 * Complies with AGENTS.md Invariants 7 and 8.
 */
export function getPaymentConnectionSettings(): PaymentDbConnectionSettings {
  const raw = paymentDatabaseUrl()
  if (!raw) {
    throw new Error("PAYMENT_DATABASE_URL is not set in environment.")
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error("PAYMENT_DATABASE_URL must be a valid postgresql:// URL.")
  }

  const sslmode = (parsed.searchParams.get("sslmode") || "").trim().toLowerCase()
  if (sslmode === "no-verify") {
    throw new Error("sslmode=no-verify is not allowed. The payment database certificate must be verified.")
  }

  parsed.searchParams.delete("sslmode")
  parsed.searchParams.delete("sslrootcert")
  const connectionString = parsed.toString()

  // Look for dedicated CA certificate in environment or certs folder
  const caFromEnv = (process.env.PAYMENT_SSL_CA || process.env.PAYMENT_DATABASE_SSL_CA || "").trim()
  let ca: string | undefined = caFromEnv || undefined
  if (!ca) {
    const caPath = (process.env.PAYMENT_SSL_CA_FILE || "").trim() || path.join(root, "certs", "payment-ca.pem")
    if (fs.existsSync(caPath)) {
      try {
        ca = fs.readFileSync(caPath, "utf8")
      } catch {
        // ignore read errors, fallback to system CAs
      }
    }
  }

  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname)
  if (local) {
    return { connectionString, ssl: false }
  }

  if (ca) {
    return {
      connectionString,
      ssl: {
        rejectUnauthorized: true,
        ca,
        checkServerIdentity: () => undefined,
      },
    }
  }

  return {
    connectionString,
    ssl: { rejectUnauthorized: true },
  }
}

export function getPaymentPool(): pg.Pool {
  if (!paymentPool) {
    const settings = getPaymentConnectionSettings()
    paymentPool = new Pool({
      connectionString: settings.connectionString,
      ssl: settings.ssl,
      connectionTimeoutMillis: 10000,
      max: 5,
      idleTimeoutMillis: 30000,
    })
  }
  return paymentPool
}

export async function closePaymentPool(): Promise<void> {
  if (paymentPool) {
    await paymentPool.end()
    paymentPool = null
  }
}

const DESTRUCTIVE_SQL_PATTERN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i

/**
 * Executes a strictly read-only query on the external Payment/Sales database.
 * Guaranteed to never modify, insert, delete, or alter any data in the payment database.
 */
export async function queryPaymentReadOnly<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  if (DESTRUCTIVE_SQL_PATTERN.test(sql)) {
    throw new Error("Refusing query: External Payment database access is strictly READ-ONLY.")
  }

  const pool = getPaymentPool()
  return await pool.query<T>(sql, params)
}

/**
 * Quick connectivity and table inspection test for the external payment database.
 */
export async function testPaymentConnection(): Promise<{
  ok: boolean
  message: string
  tables?: string[]
}> {
  if (!paymentDatabaseUrl()) {
    return { ok: false, message: "PAYMENT_DATABASE_URL is not configured." }
  }

  try {
    const res = await queryPaymentReadOnly<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = 'public' 
       AND table_name IN ('orders', 'unified_settlements', 'settlements', 'myntra_order_details', 'meesho_settlement_items', 'fk_settlement_orders', 'amazon_settlement_lines')`,
    )
    const tables = res.rows.map((r) => r.table_name)
    return {
      ok: true,
      message: `Connected to Payment Database. Found ${tables.length} relevant sales/settlement tables.`,
      tables,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Connection failed"
    return { ok: false, message: msg }
  }
}
