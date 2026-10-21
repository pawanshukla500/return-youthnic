import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

/**
 * The crash guards decide whether a 24/7 engine survives a bad request or exits
 * for a clean supervisor restart. That behaviour only exists in a real process,
 * so these checks spawn child processes rather than calling the handlers.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..")
const crashGuardUrl = pathToFileURL(path.join(here, "src", "crash-guard.ts")).href

function runProbe(body: string): { status: number | null; stdout: string; stderr: string; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-crash-"))
  const probeFile = path.join(dataDir, "probe.mjs")
  fs.writeFileSync(
    probeFile,
    `import { installCrashGuards } from ${JSON.stringify(crashGuardUrl)}\ninstallCrashGuards()\n${body}\n`,
    "utf8",
  )
  const result = spawnSync(process.execPath, ["--import", "tsx", probeFile], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
    // Keep the probe's logs out of the real engine data folder.
    env: { ...process.env, AGENT_DATA_DIR: dataDir },
  })
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", dataDir }
}

describe("crash guards for a long-running engine", () => {
  it("keeps running after an unhandled promise rejection", () => {
    const { status, stdout } = runProbe(
      [
        `Promise.reject(new Error("SYN-simulated failed request"))`,
        `setTimeout(() => { console.log("SYN-STILL-ALIVE"); process.exit(0) }, 800)`,
      ].join("\n"),
    )
    assert.equal(status, 0, "a rejected promise must not terminate the engine")
    assert.match(stdout, /SYN-STILL-ALIVE/)
  })

  it("logs a fatal error synchronously and exits non-zero so a supervisor can restart", () => {
    const { status, stdout, dataDir } = runProbe(
      [
        `setTimeout(() => { throw new Error("SYN-simulated fatal error") }, 50)`,
        `setTimeout(() => { console.log("SYN-SHOULD-NOT-REACH") }, 1200)`,
      ].join("\n"),
    )
    assert.equal(status, 1, "an uncaught exception must exit non-zero")
    assert.doesNotMatch(stdout, /SYN-SHOULD-NOT-REACH/)

    // The line must already be on disk when the process exits (fatalSync).
    const day = new Date().toISOString().slice(0, 10)
    const logFile = path.join(dataDir, "logs", `bot-${day}.log`)
    assert.ok(fs.existsSync(logFile), `expected a daily log at ${logFile}`)
    assert.match(fs.readFileSync(logFile, "utf8"), /SYN-simulated fatal error/)
  })

  it("installs the guards only once per process", () => {
    const { status, stdout } = runProbe(
      [
        `import { installCrashGuards as again } from ${JSON.stringify(crashGuardUrl)}`,
        `again()`,
        `again()`,
        `console.log("SYN-LISTENERS:" + process.listenerCount("uncaughtException") + ":" + process.listenerCount("unhandledRejection"))`,
        `process.exit(0)`,
      ].join("\n"),
    )
    assert.equal(status, 0)
    assert.match(stdout, /SYN-LISTENERS:1:1/)
  })
})
