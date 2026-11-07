import dotenv from "dotenv"
import path from "node:path"
import fs from "node:fs"
import { agentDataDir } from "./paths.js"

// Capture keys that were present in the process environment prior to loading any .env file
const initialEnvKeys = new Set(Object.keys(process.env))

export function isBackendUrlExternallyControlled(): boolean {
  return initialEnvKeys.has("BACKEND_URL") || initialEnvKeys.has("APP_URL")
}

const MEESHO_USER_ALIASES = ["MEESHOID", "MEESHO_ID", "MEESHO_USERNAME"] as const
const MEESHO_PASS_ALIASES = ["MEESHO_PWD", "MEESHO_PASSWORD", "MEESHO_PASS"] as const

// Check if any alias in each group was already supplied by the process environment
const hasInitialMeeshoUser = MEESHO_USER_ALIASES.some((key) => initialEnvKeys.has(key))
const hasInitialMeeshoPass = MEESHO_PASS_ALIASES.some((key) => initialEnvKeys.has(key))

try {
  // Load standard process.cwd() .env if present
  dotenv.config()

  // Also check AGENT_DATA_DIR/.env for persistent warehouse PC deployments
  try {
    const dataDirEnv = path.join(agentDataDir(), ".env")
    if (fs.existsSync(dataDirEnv)) {
      dotenv.config({ path: dataDirEnv })
    }
  } catch {
    // Ignore if agentDataDir is unavailable
  }

  // Preserve process environment precedence for Meesho credential alias groups:
  // If the process environment defined any alias in the group, drop any file-loaded aliases
  // that were not originally present in the process environment.
  if (hasInitialMeeshoUser) {
    for (const key of MEESHO_USER_ALIASES) {
      if (!initialEnvKeys.has(key)) {
        delete process.env[key]
      }
    }
  }
  if (hasInitialMeeshoPass) {
    for (const key of MEESHO_PASS_ALIASES) {
      if (!initialEnvKeys.has(key)) {
        delete process.env[key]
      }
    }
  }
} catch {
  // Ignore in bundled or restricted environments
}

