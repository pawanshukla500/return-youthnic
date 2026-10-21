import fs from "node:fs"
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

/**
 * Create the data root and return it.
 *
 * The root holds supplier browser cookies, the operator session token and the
 * PC API key, so it is created owner-only (0700). On POSIX this is what stops
 * another local user on a shared server from reading those files. On Windows
 * the mode argument is ignored (ACLs govern access) and the call is harmless.
 */
export function ensureAgentDataDir(): string {
  const dir = agentDataDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * Write a file that holds a secret (session token, PC API key).
 *
 * `mode` on writeFileSync only applies when the file is created, so an existing
 * file left behind by an older build would keep its looser permissions. The
 * chmod below tightens it on every write. Both steps are best-effort: a
 * filesystem that cannot express the mode must not stop the engine.
 */
export function writeSecretFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Windows and some network filesystems do not support this; not fatal.
  }
}
