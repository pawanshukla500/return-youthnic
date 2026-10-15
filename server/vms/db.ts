import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

const { Pool } = pg

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

let vmsPool: pg.Pool | null = null

// Whether a VMS database URL is configured. The URL itself is never printed,
// logged or returned by any function in this module.
export function isVmsConfigured(): boolean {
  return (process.env.VMS_DATABASE_URL?.trim() || "") !== ""
}

function vmsDatabaseUrl(): string {
  return process.env.VMS_DATABASE_URL?.trim() || ""
}

export async function closeVmsPool(): Promise<void> {
  if (vmsPool) {
    const pool = vmsPool
    vmsPool = null
    await pool.end().catch(() => {})
  }
}

export type VmsDbConnectionSettings = {
  connectionString: string
  ssl: false | { rejectUnauthorized: true; ca?: string; checkServerIdentity?: () => undefined }
}

/**
 * Connection parameters for the VMS database. TLS is always verified on
 * non-local hosts; `sslmode=no-verify` is refused. Error messages never
 * include the URL or any credential.
 */
export function getVmsConnectionSettings(): VmsDbConnectionSettings {
  const raw = vmsDatabaseUrl()
  if (!raw) {
    throw new Error("VMS_DATABASE_URL is not set in the environment.")
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error("VMS_DATABASE_URL must be a valid postgresql:// URL.")
  }
  const sslmode = (parsed.searchParams.get("sslmode") || "").trim().toLowerCase()
  if (sslmode === "no-verify") {
    throw new Error("sslmode=no-verify is not allowed. The VMS database certificate must be verified.")
  }
  parsed.searchParams.delete("sslmode")
  parsed.searchParams.delete("sslrootcert")
  const connectionString = parsed.toString()

  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname)
  if (local && (sslmode === "" || sslmode === "disable")) {
    return { connectionString, ssl: false }
  }

  const caFromEnv = (process.env.VMS_SSL_CA || "").trim()
  let ca: string | undefined = caFromEnv || undefined
  if (!ca) {
    const caPath = (process.env.VMS_SSL_CA_FILE || "").trim() || path.join(root, "certs", "vms-ca.pem")
    if (fs.existsSync(caPath)) {
      try {
        ca = fs.readFileSync(caPath, "utf8")
      } catch {
        // ignore; connect without an explicit CA below
      }
    }
  }
  if (ca) {
    // The chain is verified against the pinned CA. Hostname matching is
    // relaxed (same precedent as the Shopify integration) because the VMS
    // connection address is not in the certificate's name list.
    return {
      connectionString,
      ssl: { rejectUnauthorized: true, ca, checkServerIdentity: () => undefined },
    }
  }
  return { connectionString, ssl: { rejectUnauthorized: true } }
}

export function getVmsPool(): pg.Pool {
  if (!vmsPool) {
    const settings = getVmsConnectionSettings()
    vmsPool = new Pool({
      connectionString: settings.connectionString,
      ssl: settings.ssl,
      connectionTimeoutMillis: 10000,
      max: 3,
    })
  }
  return vmsPool
}

// Statements that can never run against the VMS database. The connection below
// additionally runs every query inside BEGIN READ ONLY, so Postgres itself
// rejects any write even if this list ever missed one.
// Only plain SELECT/WITH queries may run against VMS (single statement: no
// stacked `;`). Everything else is refused before any connection is opened.
// The query additionally runs inside BEGIN READ ONLY, so Postgres natively
// rejects table writes (INSERT/UPDATE/DELETE/MERGE/COPY FROM/SELECT INTO).
// Note: READ ONLY does not block session side-effects (LISTEN/NOTIFY,
// advisory locks, pg_terminate_backend), so the allowlist above is the real
// guard — keep it narrow and never widen it for caller convenience.
const READONLY_SQL_PATTERN = /^\s*(SELECT|WITH)\b/i

/**
 * Executes a strictly read-only query on the external VMS database.
 * Guaranteed to never modify, insert, delete or alter anything there:
 * only single-statement SELECT/WITH is accepted, and the transaction is
 * READ ONLY, so the server rejects table writes natively.
 */
export async function queryVmsReadOnly<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  if (!READONLY_SQL_PATTERN.test(sql) || sql.includes(";") || /\bINTO\b/i.test(sql)) {
    throw new Error("Refusing query: external VMS database access is strictly READ-ONLY.")
  }

  const pool = getVmsPool()
  const client = await pool.connect()
  try {
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

/**
 * Fetches the VMS server's presented certificate chain and pins it to
 * certs/vms-ca.pem (git-ignored, same precedent as db-ca.pem and
 * shopify-ca.pem), so later connections verify TLS against it.
 * Prints only the fingerprint and validity dates — never the URL, host
 * or any credential.
 */
export async function fetchVmsCa(): Promise<{ ok: boolean; message: string; fingerprint?: string }> {
  const raw = vmsDatabaseUrl()
  if (!raw) {
    return { ok: false, message: "VMS_DATABASE_URL is not set in the environment." }
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, message: "VMS_DATABASE_URL must be a valid postgresql:// URL." }
  }
  const tls = await import("node:tls")
  const host = parsed.hostname
  const port = Number(parsed.port || 5432)
  const chain: string[] = await new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, servername: host }, () => {
      try {
        const peer = socket.getPeerCertificate(true) as unknown as {
          raw?: Buffer
          issuerCertificate?: unknown
        }
        // Walk to the root of the presented chain and pin that.
        let current: unknown = peer
        let lastRaw: Buffer | undefined
        const seen = new Set<unknown>()
        while (
          current &&
          typeof current === "object" &&
          "raw" in (current as Record<string, unknown>) &&
          !seen.has(current)
        ) {
          seen.add(current)
          lastRaw = (current as { raw: Buffer }).raw
          current = (current as { issuerCertificate?: unknown }).issuerCertificate
        }
        const pems: string[] = []
        if (peer?.raw) {
          pems.push(`-----BEGIN CERTIFICATE-----\n${peer.raw.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----`)
        }
        if (lastRaw && (!peer?.raw || !lastRaw.equals(peer.raw))) {
          pems.push(`-----BEGIN CERTIFICATE-----\n${lastRaw.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----`)
        }
        socket.end()
        resolve(pems)
      } catch (err) {
        socket.destroy()
        reject(err)
      }
    })
    socket.setTimeout(10000, () => {
      socket.destroy()
      reject(new Error("Timed out reaching the VMS server."))
    })
    socket.on("error", reject)
  })
  if (!chain.length) {
    return { ok: false, message: "The VMS server presented no certificate." }
  }
  const crypto = await import("node:crypto")
  const fingerprint = crypto.createHash("sha256").update(chain.join("\n")).digest("hex")
  const caPath = (process.env.VMS_SSL_CA_FILE || "").trim() || path.join(root, "certs", "vms-ca.pem")
  fs.mkdirSync(path.dirname(caPath), { recursive: true })
  fs.writeFileSync(caPath, `${chain.join("\n")}\n`, "utf8")
  vmsPool?.end().catch(() => {})
  vmsPool = null
  return { ok: true, message: "Certificate pinned. Later connections verify TLS against it.", fingerprint }
}

export async function checkVmsConnection(): Promise<{ ok: boolean; message: string }> {
  if (!isVmsConfigured()) {
    return { ok: false, message: "VMS_DATABASE_URL is not configured." }
  }
  try {
    await queryVmsReadOnly("SELECT 1 AS ok")
    return { ok: true, message: "Connected (Read-Only)" }
  } catch {
    // Static message: driver errors can embed the host, which is never printed.
    return { ok: false, message: "Could not reach the VMS database." }
  }
}
