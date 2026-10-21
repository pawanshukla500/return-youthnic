import os from "node:os"
import path from "node:path"

/**
 * Engine state paths.
 *
 * The automation engine keeps its config, browser profiles, evidence cache,
 * logs and operator session under one root folder. On a warehouse PC that root
 * is the signed-in user's home folder. On a Linux server or in a container it
 * is pointed at a mounted volume with AGENT_DATA_DIR, so the same code runs in
 * all three deployment modes without a rewrite.
 *
 * This module deliberately imports nothing but Node builtins so every other
 * engine module (logger, config, operator session) can use it without an
 * import cycle.
 */

export function agentDataDir(): string {
  const override = process.env.AGENT_DATA_DIR?.trim()
  return override ? override : path.join(os.homedir(), ".taskflow-claim-agent")
}

export function agentSubdir(...segments: string[]): string {
  return path.join(agentDataDir(), ...segments)
}
