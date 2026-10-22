import { after, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { agentDataDir, agentSubdir, ensureAgentDataDir, writeSecretFile } from "./src/paths.js"

/**
 * The data root holds the supplier browser cookies, the operator session token
 * and the PC API key. On a shared Linux server the directory and file modes are
 * what stop another local user from reading them, so they are asserted here.
 * Windows ignores the mode argument (ACLs govern access), so the mode checks
 * run only on POSIX; the path and content checks run everywhere.
 */

const isPosix = process.platform !== "win32"
const tempDirs: string[] = []
let dataDir = ""

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-paths-"))
  tempDirs.push(dataDir)
  process.env.AGENT_DATA_DIR = dataDir
})

after(() => {
  delete process.env.AGENT_DATA_DIR
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

describe("engine data paths", () => {
  it("honours AGENT_DATA_DIR so a server or container can mount its own volume", () => {
    assert.equal(agentDataDir(), dataDir)
  })

  it("falls back to the signed-in user's home folder when AGENT_DATA_DIR is unset", () => {
    delete process.env.AGENT_DATA_DIR
    assert.equal(agentDataDir(), path.join(os.homedir(), ".taskflow-claim-agent"))
  })

  it("joins subfolders under the data root", () => {
    assert.equal(agentSubdir("logs"), path.join(dataDir, "logs"))
    assert.equal(agentSubdir("browser-profiles", "meesho"), path.join(dataDir, "browser-profiles", "meesho"))
  })

  it("creates the data root on demand and returns it", () => {
    const root = path.join(dataDir, "nested", "root")
    process.env.AGENT_DATA_DIR = root
    assert.equal(ensureAgentDataDir(), root)
    assert.ok(fs.statSync(root).isDirectory())
  })
})

describe("secret files under the data root", () => {
  it("writes the contents and creates the parent folder", () => {
    const secret = agentSubdir("operator-session.json")
    writeSecretFile(secret, JSON.stringify({ token: "SYN-encrypted" }))
    assert.equal(fs.readFileSync(secret, "utf8"), JSON.stringify({ token: "SYN-encrypted" }))
  })

  it("overwrites an existing secret in place", () => {
    const secret = agentSubdir("config.json")
    writeSecretFile(secret, "first")
    writeSecretFile(secret, "second")
    assert.equal(fs.readFileSync(secret, "utf8"), "second")
  })

  it("creates the root and the secret owner-only on POSIX", { skip: !isPosix }, () => {
    const secret = agentSubdir("config.json")
    writeSecretFile(secret, "SYN-secret")
    assert.equal(modeOf(dataDir), 0o700, "the data root must not be world or group readable")
    assert.equal(modeOf(secret), 0o600, "a secret file must be readable only by its owner")
  })

  it("tightens a root left loose by an older build on POSIX", { skip: !isPosix }, () => {
    // A folder that already exists keeps its mode unless it is chmodded, so the
    // guard has to run on every call, not only when it creates the folder.
    fs.chmodSync(dataDir, 0o755)
    assert.equal(modeOf(dataDir), 0o755)
    ensureAgentDataDir()
    assert.equal(modeOf(dataDir), 0o700)
  })

  it("tightens a secret file left loose by an older build on POSIX", { skip: !isPosix }, () => {
    // `mode` on writeFileSync only applies when the file is created.
    const secret = agentSubdir("config.json")
    fs.writeFileSync(secret, "SYN-old", "utf8")
    fs.chmodSync(secret, 0o644)
    assert.equal(modeOf(secret), 0o644)
    writeSecretFile(secret, "SYN-new")
    assert.equal(modeOf(secret), 0o600)
  })
})
