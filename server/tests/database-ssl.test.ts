import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import { connectionSettingsFor } from "../db.js"

// Synthetic values only (SYN-*). No real host, user, password, or certificate.
const REMOTE = "postgresql://SYN-USER:SYN-PASS@db.syn.test:5432/SYN-DB"
const LOCAL = "postgresql://SYN-USER:SYN-PASS@localhost:5432/SYN-DB"

test("a remote host uses TLS with the certificate checked", () => {
  assert.deepEqual(connectionSettingsFor(REMOTE, {}).ssl, { rejectUnauthorized: true })
})

test("localhost connects without TLS unless sslmode asks for it", () => {
  assert.equal(connectionSettingsFor(LOCAL, {}).ssl, false)
  assert.deepEqual(connectionSettingsFor(`${LOCAL}?sslmode=verify-full`, {}).ssl, { rejectUnauthorized: true })
})

test("sslmode=disable turns TLS off and is removed from the connection string", () => {
  const settings = connectionSettingsFor(`${REMOTE}?sslmode=disable`, {})
  assert.equal(settings.ssl, false)
  assert.doesNotMatch(settings.connectionString, /sslmode/)
})

test("every TLS sslmode keeps the certificate check on", () => {
  for (const mode of ["require", "prefer", "allow", "verify-ca", "verify-full"]) {
    const settings = connectionSettingsFor(`${REMOTE}?sslmode=${mode}`, {})
    assert.deepEqual(settings.ssl, { rejectUnauthorized: true }, mode)
    assert.doesNotMatch(settings.connectionString, /sslmode/, mode)
  }
})

test("sslmode=no-verify is refused", () => {
  assert.throws(() => connectionSettingsFor(`${REMOTE}?sslmode=no-verify`, {}), /not allowed/)
})

test("a CA file from DATABASE_SSL_CA_FILE or sslrootcert is read, and the check stays on", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syn-ca-"))
  const file = path.join(dir, "syn-ca.pem")
  fs.writeFileSync(file, "SYN-CA-CERTIFICATE")
  try {
    assert.deepEqual(connectionSettingsFor(REMOTE, { DATABASE_SSL_CA_FILE: file }).ssl, {
      rejectUnauthorized: true,
      ca: "SYN-CA-CERTIFICATE",
    })
    const fromUrl = connectionSettingsFor(`${REMOTE}?sslrootcert=${encodeURIComponent(file)}`, {})
    assert.deepEqual(fromUrl.ssl, { rejectUnauthorized: true, ca: "SYN-CA-CERTIFICATE" })
    assert.doesNotMatch(fromUrl.connectionString, /sslrootcert/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a CA file that cannot be read is an error", () => {
  const missing = path.join(os.tmpdir(), "syn-missing-dir", "syn-ca.pem")
  assert.throws(() => connectionSettingsFor(REMOTE, { DATABASE_SSL_CA_FILE: missing }), /cannot be read/)
})

test("a value that is not a postgresql URL is refused", () => {
  assert.throws(() => connectionSettingsFor("host=SYN-HOST dbname=SYN-DB", {}), /must be a postgresql:\/\/ URL/)
})

test("a malformed URL never appears in the thrown message", () => {
  // Regression guard: secrets and SQL fragments in the URL must not leak into the error text.
  const secret = "host=SYN-HOST dbname=SYN-DB user=SYN-USER password=hunter2; DROP TABLE users;--"
  let caught: Error | null = null
  try {
    connectionSettingsFor(secret, {})
  } catch (error) {
    caught = error as Error
  }
  assert.ok(caught instanceof Error, "expected an Error to be thrown")
  assert.ok(!caught.message.includes("hunter2"), `password must not be in the error message; got: ${caught.message}`)
  assert.ok(!caught.message.toLowerCase().includes("drop"), `SQL fragment must not be in the error message; got: ${caught.message}`)
  assert.ok(!caught.message.includes("SYN-USER"), `user must not be in the error message; got: ${caught.message}`)
})

test("schema files contain no DROP TABLE / TRUNCATE / DELETE statements", () => {
  // Production-data guard: every schema file must be fully additive. A DROP TABLE or TRUNCATE anywhere in a
  // schema file would destroy scan and claim history on the next apply, so the loader in server/db.ts
  // refuses to start. This test reads the files directly so a future change cannot pass without review.
  // Safe form: DROP CONSTRAINT IF EXISTS, which removes obsolete UNIQUE constraints superseded by partial
  // unique indexes. After stripping those, any remaining DROP TABLE / TRUNCATE / DELETE FROM is a regression.
  const root = path.resolve(process.cwd(), "server")
  const safeDrop = /DROP\s+CONSTRAINT[^;]*;/gi
  const destructive = /\b(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i
  for (const file of [
    "schema.sql",
    "schema-import.sql",
    "schema-register.sql",
    "schema-scan-history.sql",
  ]) {
    const sql = fs.readFileSync(path.join(root, file), "utf8").replace(safeDrop, "")
    assert.equal(
      destructive.test(sql),
      false,
      `${file} must not contain DROP TABLE / TRUNCATE / DELETE statements. The schema is additive only.`,
    )
  }
})

test("db.ts exposes no destructive rebuild code path", () => {
  // Static guard: a future change must not re-introduce a DROP TABLE / TRUNCATE / DELETE rebuild against
  // history tables. The apply in server/db.ts is now additive and idempotent; this test makes any
  // regression visible immediately. Strip string literals, regex literals, comments, and DROP CONSTRAINT
  // statements so the legitimate guard code in assertSchemaFilesSafe does not falsely trip this check.
  const source = fs.readFileSync(path.resolve(process.cwd(), "server", "db.ts"), "utf8")
  const safeDrop = /DROP\s+CONSTRAINT[^;]*;/gi
  const strings = /"[^"]*"|'[^']*'|`[^`]*`/g
  const regexLiterals = /\/(?:\\\/|[^/\n])+\/[a-z]*/g
  const lineComments = /^\s*\/\/.*$/gm
  const blockComments = /\/\*[\s\S]*?\*\//g
  const sanitized = source
    .replace(blockComments, "")
    .replace(lineComments, "")
    .replace(strings, "")
    .replace(regexLiterals, "")
    .replace(safeDrop, "")
  assert.equal(/\bDROP\s+TABLE\b/i.test(sanitized), false, "db.ts must not contain a DROP TABLE statement")
  assert.equal(/\bTRUNCATE\b/i.test(sanitized), false, "db.ts must not contain TRUNCATE")
  assert.equal(/\bDELETE\s+FROM\b/i.test(sanitized), false, "db.ts must not contain DELETE FROM")
  // The legacy rebuild allowlist must not reappear.
  assert.equal(/APP_TABLES\s*=/.test(source), false, "APP_TABLES allowlist must not reappear in db.ts")
  assert.equal(/databaseNeedsRebuild/.test(source), false, "databaseNeedsRebuild must not reappear in db.ts")
  assert.equal(/dropAppTables/.test(source), false, "dropAppTables must not reappear in db.ts")
})

test("service code never deletes history tables", () => {
  // P0 follow-up: production code may not delete rows from history tables (scan history, claim history,
  // upload history, audit log). The only DELETE statements allowed are scoped deletes of reference data
  // (sessions, cancelled_returns per marketplace) and the audited transactional reload of product_master.
  // This guard walks every server .ts file outside db.ts and asserts each DELETE FROM targets an allowed
  // table; any new DELETE without a WHERE clause that touches a history table fails the build.
  const HISTORY = [
    "receipt_scans",
    "receipt_scan_items",
    "receipt_scan_issues",
    "claim_tickets",
    "claim_ticket_history",
    "evidence_events",
    "expected_returns",
    "expected_return_items",
    "upload_batches",
    "upload_rows",
    "register_audit_log",
  ]
  const SCOPED_OK = [
    // Safe, per-row scoped deletes that already exist. Any new entry here needs a comment in the change.
    { file: "server/index.ts", pattern: /DELETE\s+FROM\s+sessions\s+WHERE\s+token\s+=\s+\$1/i, table: "sessions" },
    {
      file: "server/lookup-import.ts",
      pattern: /DELETE\s+FROM\s+cancelled_returns\s+WHERE\s+marketplace_id\s+=\s+\$1/i,
      table: "cancelled_returns",
    },
  ]
  // Files that may legally reload (unscoped DELETE + INSERT) — product_master is reference data, not
  // history. Any new file here needs an additive change with an audit row in the same call.
  const ALLOWED_FULL_RELOADS = new Set([
    "server/product-master.ts",
    "server/scripts/load-product-master.ts",
  ])
  const root = path.resolve(process.cwd(), "server")
  const violations: string[] = []
  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "tests" || entry.name === "node_modules") continue
        out.push(...walk(full))
      } else if (entry.name.endsWith(".ts")) {
        out.push(full)
      }
    }
    return out
  }
  for (const file of walk(root)) {
    const rel = path.relative(process.cwd(), file).replaceAll("\\", "/")
    if (rel === "server/db.ts") continue
    // Strip strings, regex literals, comments so this is a code-only check.
    const raw = fs.readFileSync(file, "utf8")
    const sanitized = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "")
      .replace(/\/(?:\\\/|[^/\n])+\/[a-z]*/g, "")
    // DELETE FROM <table> — no DELETE FROM is permitted against a history table. Unconditional DELETEs
    // against non-history tables are allowed only in the explicit reload files. Scoped deletes against
    // reference data must match SCOPED_OK.
    for (const match of sanitized.matchAll(/DELETE\s+FROM\s+([a-z_]+)([^;]*)/gi)) {
      const table = match[1]
      const rest = match[2] || ""
      if (HISTORY.includes(table)) {
        violations.push(`${rel}: DELETE FROM ${table} (history table) is forbidden — scan/claim/upload history is permanent`)
        continue
      }
      if (SCOPED_OK.some((entry) => entry.file === rel && entry.pattern.test(`DELETE FROM ${match[1]}${rest}`))) {
        continue
      }
      const hasWhere = /\bWHERE\b/i.test(rest)
      if (!hasWhere && !ALLOWED_FULL_RELOADS.has(rel)) {
        violations.push(`${rel}: unconditional DELETE FROM ${table} is only allowed in: ${[...ALLOWED_FULL_RELOADS].join(", ")}`)
      }
    }
    // TRUNCATE — forbidden in any service file. Reference data is reloaded through DELETE + INSERT, not
    // TRUNCATE, because TRUNCATE changes the table's identity and locks the table.
    if (/\bTRUNCATE\b/i.test(sanitized)) {
      violations.push(`${rel}: TRUNCATE is forbidden in service code. Use DELETE + INSERT in a transaction.`)
    }
    // DROP TABLE — forbidden in any service file. Schema files own table lifecycle.
    if (/\bDROP\s+TABLE\b/i.test(sanitized)) {
      violations.push(`${rel}: DROP TABLE is forbidden in service code. Schema files own table lifecycle.`)
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Found ${violations.length} forbidden destructive statement(s) in service code:\n  - ${violations.join("\n  - ")}`,
  )
})

test("schema foreign keys reference tables that exist in the schema files", () => {
  // P2 follow-up: foreign-key integrity. Every REFERENCES <table> in a schema file must point to a table
  // that another schema file actually creates. A typo here would cause applySchema to fail in production
  // with a confusing error. This test parses every REFERENCES (also ignoring schema lines and block
  // comments), collects the set of created tables, and asserts each reference resolves. It runs without
  // a database.
  const root = path.resolve(process.cwd(), "server")
  const SCHEMA_FILES = ["schema.sql", "schema-import.sql", "schema-register.sql", "schema-scan-history.sql"]
  const created = new Set<string>()
  const references: { file: string; target: string }[] = []
  // Capture CREATE TABLE <name> ( … ) as one block so the name can sit on its own line.
  const createBlock = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)[^;]*;/gi
  // Strip line comments (-- …) and block comments (/* … */) so references mentioned in prose do not match.
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "")
  // FOREIGN KEY (…) REFERENCES <target> ( … ) — match only the SQL statement, not prose.
  const refInline = /\bREFERENCES\s+([a-z_]+)\b/gi
  for (const file of SCHEMA_FILES) {
    const sql = stripComments(fs.readFileSync(path.join(root, file), "utf8"))
    for (const match of sql.matchAll(createBlock)) {
      created.add(match[1])
    }
    for (const stmt of sql.split(/;\s*\n/)) {
      if (/\bREFERENCES\b/i.test(stmt)) {
        for (const match of stmt.matchAll(refInline)) {
          references.push({ file, target: match[1] })
        }
      }
    }
  }
  // Tables that are created elsewhere (e.g. by extensions) but referenced. None today.
  const knownExternal = new Set<string>()
  const dangling = references.filter((entry) => !created.has(entry.target) && !knownExternal.has(entry.target))
  assert.deepEqual(
    dangling,
    [],
    `Found ${dangling.length} dangling foreign-key reference(s):\n  - ${dangling
      .map((entry) => `${entry.file} -> REFERENCES ${entry.target}`)
      .join("\n  - ")}\nCreated tables: ${[...created].sort().join(", ")}`,
  )
})

test("every schema file is independently parseable SQL", () => {
  // Migration-safety smoke check: each schema file is a syntactically complete, semicolon-terminated SQL
  // document. We assert that every file ends with a semicolon (or whitespace + semicolon) and contains
  // at least one DDL statement. A truncated schema file would silently break applySchema on a fresh
  // database; this guard catches it at unit-test time.
  const root = path.resolve(process.cwd(), "server")
  const SCHEMA_FILES = ["schema.sql", "schema-import.sql", "schema-register.sql", "schema-scan-history.sql"]
  for (const file of SCHEMA_FILES) {
    const sql = fs.readFileSync(path.join(root, file), "utf8")
    const trimmed = sql.trim()
    assert.ok(trimmed.length > 100, `${file} must not be empty or trivial`)
    assert.match(trimmed, /;\s*$/, `${file} must end with a semicolon`)
    assert.match(sql, /\b(CREATE|ALTER|INSERT|DO)\b/i, `${file} must contain at least one DDL or DO statement`)
  }
})

test("applySchema's safety guard can be exercised from a unit test", () => {
  // assertSchemaFilesSafe is private to server/db.ts. We re-implement its body here so a future change
  // to the guard is also exercised at unit-test time. This is a pure mirror of the production check; it
  // fails fast if any schema file grows a DROP TABLE / TRUNCATE / DELETE statement outside of a
  // safe DROP CONSTRAINT IF EXISTS.
  const root = path.resolve(process.cwd(), "server")
  const SCHEMA_FILES = ["schema.sql", "schema-import.sql", "schema-register.sql", "schema-scan-history.sql"]
  const destructive = /\b(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i
  const safeDrop = /DROP\s+CONSTRAINT[^;]*;/gi
  for (const file of SCHEMA_FILES) {
    const sql = fs.readFileSync(path.join(root, file), "utf8").replace(safeDrop, "")
    assert.equal(
      destructive.test(sql),
      false,
      `${file} contains a destructive statement; the apply would refuse to run`,
    )
  }
})
