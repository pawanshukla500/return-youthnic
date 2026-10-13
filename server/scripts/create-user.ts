// Creates one sign-in user. The app starts with no users, so run this once for the first admin and once for
// each person after that. Start the app once first so the schema exists.
//
// Usage (from the project folder). The password comes from the NEW_USER_PASSWORD environment variable.
// It is never taken from the command line and never printed:
//   $env:NEW_USER_PASSWORD = '<a password of at least 10 characters>'
//   npm run user:create -- --name "Full Name" --email person@company.com --role Admin --all-marketplaces
//   npm run user:create -- --name "Full Name" --email person@company.com --role Scanner --marketplaces "Myntra VB,Flipkart"
//
// The connection uses the same verified TLS settings as the app (see server/db.ts).
// Marketplace names must match the names in Admin > Marketplace accounts. Roles are free text: only the
// literal string "Admin" (case-insensitive) grants administrator rights (see isAdminRole in server/access.ts).
// Every other signed-in user can only use the accounts assigned to them.

import path from "node:path"
import { fileURLToPath } from "node:url"
import bcrypt from "bcryptjs"
import dotenv from "dotenv"
import { databaseUrl, getPool } from "../db.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
dotenv.config({ path: path.join(root, ".env") })

const KNOWN_FLAGS = new Set(["name", "email", "role", "alias", "marketplaces"])

type Options = {
  name: string
  email: string
  role: string
  alias: string | null
  allMarketplaces: boolean
  marketplaces: string[]
}

function readOptions(argv: string[]): Options {
  const values = new Map<string, string>()
  let allMarketplaces = false
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === undefined) break
    if (flag === "--all-marketplaces") {
      allMarketplaces = true
      continue
    }
    const key = flag.startsWith("--") ? flag.slice(2) : ""
    const value = argv[index + 1]
    if (!KNOWN_FLAGS.has(key) || value === undefined) {
      throw new Error(`Unexpected argument "${flag}". Use --name, --email, --role, --alias, --marketplaces or --all-marketplaces.`)
    }
    values.set(key, value.trim())
    index++
  }

  const name = values.get("name") || ""
  const email = (values.get("email") || "").toLowerCase()
  const role = values.get("role") || ""
  if (!name || !email || !role) throw new Error("Give --name, --email and --role.")
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("--email does not look like an email address.")

  const marketplaces = (values.get("marketplaces") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  if (!allMarketplaces && !marketplaces.length) {
    throw new Error('Give --marketplaces "Name, Name" or --all-marketplaces.')
  }

  const alias = (values.get("alias") || "").toLowerCase()
  return { name, email, role, alias: alias || null, allMarketplaces, marketplaces }
}

async function createUser(options: Options) {
  const password = process.env.NEW_USER_PASSWORD || ""
  if (password.length < 10) {
    throw new Error("Set NEW_USER_PASSWORD to a password of at least 10 characters first.")
  }

  const client = await getPool().connect()
  try {
    await client.query("BEGIN")
    const ready = await client.query("SELECT to_regclass('public.users') IS NOT NULL AS ready")
    if (!ready.rows[0].ready) {
      throw new Error("The app schema does not exist yet. Start the app once (npm run dev), then run this again.")
    }

    const initials = options.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("")
    const passwordHash = await bcrypt.hash(password, 10)
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO users (initials, name, email, login_alias, password_hash, role, sidebar_label, has_all_marketplaces)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
       RETURNING id`,
      [initials, options.name, options.email, options.alias, passwordHash, options.role, options.allMarketplaces],
    )
    const userId = inserted.rows[0].id

    if (!options.allMarketplaces) {
      const found = await client.query<{ id: number; name: string }>(
        "SELECT id, name FROM marketplaces WHERE name = ANY($1::text[])",
        [options.marketplaces],
      )
      const unknown = options.marketplaces.filter((name) => !found.rows.some((row) => row.name === name))
      if (unknown.length) {
        throw new Error(`Unknown marketplace(s): ${unknown.join(", ")}. Use the names shown in Admin > Marketplace accounts.`)
      }
      for (const row of found.rows) {
        await client.query("INSERT INTO user_marketplaces (user_id, marketplace_id) VALUES ($1, $2)", [userId, row.id])
      }
    }

    await client.query("COMMIT")
    console.log(
      `Created ${options.role} user ${options.email}. The password was read from NEW_USER_PASSWORD and was not printed.`,
    )
  } catch (error) {
    await client.query("ROLLBACK")
    if (error instanceof Error && "code" in error && error.code === "23505") {
      throw new Error("A user with this email or login alias already exists.")
    }
    throw error
  } finally {
    client.release()
  }
}

async function run() {
  try {
    if (!databaseUrl()) throw new Error("DATABASE_URL is not set. Add it to the .env file first.")
    await createUser(readOptions(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    // Close the pool if there is one. If the connection settings were rejected, the error was already printed above.
    try {
      if (databaseUrl()) await getPool().end()
    } catch {
      // Nothing to close.
    }
  }
}

void run()
