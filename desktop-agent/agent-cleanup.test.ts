import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AgentBackendClient } from "./src/agent-client.js"

/** R4: evidence cleanup keeps referenced screenshots (24h prune still reclaims them). */
describe("evidence cleanup keeps referenced screenshots", () => {
  function clientWithWorkDir(workDir: string): AgentBackendClient {
    return new AgentBackendClient({
      agentUuid: "SYN-agent",
      agentName: "SYN-agent",
      backendUrl: "http://127.0.0.1:1",
      apiKey: "SYN-key",
      pollIntervalMs: 1000,
      heartbeatIntervalMs: 1000,
      followUpCheckIntervalMs: 1000,
      browserMode: "headless",
      browserPath: "",
      userDataDir: workDir,
      workDir,
      logLevel: "error",
    })
  }

  it("deletes evidence but keeps the submission screenshot", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-clean-"))
    const claimDir = path.join(workDir, "claim-7")
    fs.mkdirSync(claimDir, { recursive: true })
    fs.writeFileSync(path.join(claimDir, "9_photo_evidence.jpg"), "SYN-image")
    fs.writeFileSync(path.join(claimDir, "submitted-meesho-job-7.png"), "SYN-shot")
    await clientWithWorkDir(workDir).cleanClaimEvidenceFiles(7, ["submitted-meesho-job-7.png"])
    assert.deepEqual(fs.readdirSync(claimDir).sort(), ["submitted-meesho-job-7.png"])
  })

  it("removes everything when nothing is referenced", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-clean-"))
    const claimDir = path.join(workDir, "claim-8")
    fs.mkdirSync(claimDir, { recursive: true })
    fs.writeFileSync(path.join(claimDir, "9_photo_evidence.jpg"), "SYN-image")
    await clientWithWorkDir(workDir).cleanClaimEvidenceFiles(8)
    assert.deepEqual(fs.readdirSync(claimDir), [])
  })
})
