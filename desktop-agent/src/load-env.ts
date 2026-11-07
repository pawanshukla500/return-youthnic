import dotenv from "dotenv"
import path from "node:path"
import fs from "node:fs"
import { agentDataDir } from "./paths.js"

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
} catch {
  // Ignore in bundled or restricted environments
}
