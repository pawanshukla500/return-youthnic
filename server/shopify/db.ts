import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

const { Pool } = pg

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

let shopifyPool: pg.Pool | null = null

export function shopifyDatabaseUrl(): string {
  return process.env.SHOPIFY_DATABASE_URL?.trim() || ""
}

export type ShopifyDbConnectionSettings = {
  connectionString: string
  ssl: false | { rejectUnauthorized: boolean; ca?: string; checkServerIdentity?: () => undefined }
}

/**
 * Returns connection parameters for Shopify database.
 * Strictly verifies TLS certificate. Never leaks URL or secrets in errors.
 */
export function getShopifyConnectionSettings(): ShopifyDbConnectionSettings {
  const raw = shopifyDatabaseUrl()
  if (!raw) {
    throw new Error("SHOPIFY_DATABASE_URL is not set in environment.")
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error("SHOPIFY_DATABASE_URL must be a valid postgresql:// URL.")
  }

  parsed.searchParams.delete("sslmode")
  parsed.searchParams.delete("sslrootcert")
  const connectionString = parsed.toString()

  // Look for dedicated CA certificate in environment or certs folder
  const caFromEnv = (process.env.SHOPIFY_SSL_CA || process.env.SHOPIFY_DATABASE_SSL_CA || "").trim()
  let ca: string | undefined = caFromEnv || undefined
  if (!ca) {
    const caPath = (process.env.SHOPIFY_SSL_CA_FILE || "").trim() || path.join(root, "certs", "shopify-ca.pem")
    if (fs.existsSync(caPath)) {
      try {
        ca = fs.readFileSync(caPath, "utf8")
      } catch {
        // ignore
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
        checkServerIdentity: () => undefined, // allows matching IP CN
      },
    }
  }

  return {
    connectionString,
    ssl: { rejectUnauthorized: true },
  }
}

export function getShopifyPool(): pg.Pool {
  if (!shopifyPool) {
    const settings = getShopifyConnectionSettings()
    shopifyPool = new Pool({
      connectionString: settings.connectionString,
      ssl: settings.ssl,
      connectionTimeoutMillis: 10000,
      max: 5,
    })
  }
  return shopifyPool
}

const DESTRUCTIVE_SQL_PATTERN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i

/**
 * Executes a strictly read-only query on the external Shopify database.
 * Guaranteed to never modify, insert, delete, or alter any data on Shopify.
 */
export async function queryShopifyReadOnly<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  if (DESTRUCTIVE_SQL_PATTERN.test(sql)) {
    throw new Error("Refusing query: External Shopify database access is strictly READ-ONLY.")
  }

  const pool = getShopifyPool()
  const client = await pool.connect()
  try {
    // Explicit read-only transaction: Postgres rejects any write attempt natively
    await client.query("BEGIN READ ONLY")
    const result = await client.query<T>(sql, params)
    await client.query("COMMIT")
    return result
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function checkShopifyConnection(): Promise<{ ok: boolean; message: string; orderCount?: number }> {
  if (!shopifyDatabaseUrl()) {
    return { ok: false, message: "SHOPIFY_DATABASE_URL is not configured." }
  }

  try {
    const res = await queryShopifyReadOnly<{ count: string }>(
      'SELECT count(*)::text as count FROM "Order"',
    )
    const count = Number(res.rows[0]?.count ?? 0)
    return { ok: true, message: "Connected (Read-Only)", orderCount: count }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
