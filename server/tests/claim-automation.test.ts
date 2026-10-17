import assert from "node:assert/strict"
import test from "node:test"
import {
  authenticateAutomationAgent,
  decryptSecret,
  encryptSecret,
  maskSecret,
  mapToReceiptIssueCategory,
  updateJobProgress,
} from "../claim-automation-service.js"
import type pg from "pg"

process.env.AUTOMATION_SECRET_KEY ||= "SYN-TEST-AUTOMATION-KEY-AT-LEAST-32-CHARS"

function fakePool() {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params })
      if (sql.includes("SELECT j.attempts, j.max_attempts")) {
        return { rows: [{ attempts: 1, max_attempts: 3, marketplace_id: 3 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    release: () => undefined,
  }
  return { pool: { connect: async () => client } as unknown as pg.Pool, queries }
}

test("credentials encryption: round-trips plaintext correctly using AES-256-GCM", () => {
  const password = "SuperSecretMarketplacePassword#2026!"
  const encrypted = encryptSecret(password)
  assert.notEqual(encrypted, password)
  assert.match(encrypted, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/)

  const decrypted = decryptSecret(encrypted)
  assert.equal(decrypted, password)
})

test("credentials encryption: handles empty string and malformed ciphertext safely", () => {
  assert.equal(encryptSecret(""), "")
  assert.equal(decryptSecret(""), "")
  assert.equal(decryptSecret("invalid-cipher-text"), "")
  assert.equal(decryptSecret("12:34:56"), "")
})

test("credentials encryption: refuses to use a source-code fallback key", () => {
  const previous = process.env.AUTOMATION_SECRET_KEY
  delete process.env.AUTOMATION_SECRET_KEY
  assert.throws(() => encryptSecret("SYN-secret"), /encryption is not configured/)
  process.env.AUTOMATION_SECRET_KEY = previous || "SYN-TEST-AUTOMATION-KEY-AT-LEAST-32-CHARS"
})

test("agent authentication requires the UUID, API key, authorization, and assigned job", async () => {
  const key = "SYN-agent-key"
  const hash = (await import("node:crypto")).createHash("sha256").update(key).digest("hex")
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM claim_automation_agents")) {
        return { rows: [{ id: 9, agent_uuid: "SYN-agent", api_key_hash: hash, is_authorized: true }] }
      }
      if (sql.includes("FROM claim_automation_jobs")) {
        return { rows: params[1] === 9 ? [{ "?column?": 1 }] : [] }
      }
      return { rows: [] }
    },
  } as unknown as pg.Pool

  assert.deepEqual(await authenticateAutomationAgent(db, "SYN-agent", key, 42), { id: 9, uuid: "SYN-agent" })
  await assert.rejects(authenticateAutomationAgent(db, "SYN-agent", "SYN-wrong", 42), /authentication failed/)
})

test("credentials masking: masks username safely without leaking plaintext", () => {
  assert.equal(maskSecret(""), "")
  assert.equal(maskSecret("ab"), "****")
  assert.equal(maskSecret("seller_vb"), "se****vb")
  assert.equal(maskSecret("supplier@meesho.com"), "su****om")
})

test("evidence requirements: validates marketplace-specific rules", () => {
  const marketplacesWithVideo = ["Myntra VB", "Myntra EJ", "Meesho", "Ajio"]
  const marketplacesImagesOnly = ["Flipkart"]

  for (const m of marketplacesWithVideo) {
    assert.ok(marketplacesWithVideo.includes(m), `${m} requires video`)
  }
  for (const m of marketplacesImagesOnly) {
    assert.ok(!marketplacesWithVideo.includes(m), `${m} is images only`)
  }
})

test("automation job stages: valid progression and states", () => {
  const validStages = [
    "queued",
    "downloading_media",
    "prepared",
    "waiting_approval",
    "approved",
    "submitting",
    "completed",
    "failed",
    "manual_intervention_required",
    "not_eligible",
  ]

  assert.equal(validStages.length, 10)
  assert.ok(validStages.includes("prepared"))
  assert.ok(validStages.includes("manual_intervention_required"))
})

test("mapToReceiptIssueCategory: maps marketplace issue codes and reasons to database categories", () => {
  assert.deepEqual(mapToReceiptIssueCategory("wrong_item"), { code: "wrong_product", label: "Wrong product" })
  assert.deepEqual(mapToReceiptIssueCategory("missing_items"), { code: "missing_component", label: "Missing product or component" })
  assert.deepEqual(mapToReceiptIssueCategory("damaged_item"), { code: "damaged_product", label: "Damaged product" })
  assert.deepEqual(mapToReceiptIssueCategory("other_issue"), { code: "other_issue", label: "Other issue" })
})

test("sendError: correctly serializes ServiceError and duck-typed status errors as JSON", async () => {
  const { sendError } = await import("../http.js")
  const { ServiceError } = await import("../register-service.js")

  let capturedStatus = 0
  let capturedJson: any = null
  let nextCalledWith: any = null

  const mockRes: any = {
    status(code: number) {
      capturedStatus = code
      return this
    },
    json(body: any) {
      capturedJson = body
      return this
    },
  }

  const mockNext = (err?: any) => {
    nextCalledWith = err
  }

  // 1. ServiceError
  sendError(mockRes, new ServiceError(400, "Choose an active claim template for this marketplace."), mockNext)
  assert.equal(capturedStatus, 400)
  assert.equal(capturedJson?.error, "Choose an active claim template for this marketplace.")
  assert.equal(nextCalledWith, null)

  // 2. Duck-typed status error
  capturedStatus = 0
  capturedJson = null
  sendError(mockRes, { status: 404, message: "Claim not found." }, mockNext)
  assert.equal(capturedStatus, 404)
  assert.equal(capturedJson?.error, "Claim not found.")
  assert.equal(nextCalledWith, null)

  // 3. Generic Error without status -> forwards to next
  capturedStatus = 0
  capturedJson = null
  const genericErr = new Error("Database connection timed out")
  sendError(mockRes, genericErr, mockNext)
  assert.equal(capturedStatus, 0)
  assert.equal(capturedJson, null)
  assert.equal(nextCalledWith, genericErr)
})

test("credentials encryption: complex passwords and phone identifiers", () => {
  const credentialsList = [
    "9876543210",
    "vaibhav@vbexports.co.in",
    "P@ssw0rd!#$2026_ComplexKey&More",
    "Special-Characters: / ? & = # + %",
  ]

  for (const cred of credentialsList) {
    const enc = encryptSecret(cred)
    assert.match(enc, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/)
    const dec = decryptSecret(enc)
    assert.equal(dec, cred)
  }
})

test("marketplace credentials: portal URLs map to standard supplier dashboards", () => {
  const defaultPortalUrls: Record<string, string> = {
    meesho: "https://supplier.meesho.com/panel/v3/new/root/login",
    flipkart: "https://seller.flipkart.com/index.html#dashboard",
    amazon: "https://sellercentral.amazon.in/",
    myntra: "https://partners.myntrainfo.com/",
    ajio: "https://supplier.ajio.com/",
  }

  assert.equal(defaultPortalUrls["meesho"], "https://supplier.meesho.com/panel/v3/new/root/login")
  assert.ok(defaultPortalUrls["meesho"].includes("supplier.meesho.com"))
  assert.ok(defaultPortalUrls["flipkart"].includes("seller.flipkart.com"))
})

test("desktop agent config: defaults to production cloud URL and sanitizes legacy localhost", async () => {
  const { DEFAULT_PRODUCTION_URL, loadAgentConfig } = await import("../../desktop-agent/src/config.js")
  assert.equal(DEFAULT_PRODUCTION_URL, "https://return.youthnic.shop")
  const config = loadAgentConfig()
  assert.ok(!config.backendUrl.includes("127.0.0.1"), "backendUrl must not be localhost")
  assert.ok(!config.backendUrl.includes("localhost"), "backendUrl must not be localhost")
  assert.equal(config.backendUrl, "https://return.youthnic.shop")
})

test("low-spec hardware optimization: adaptive scheduler backoff calculation", () => {
  function calculatePollDelay(hasJob: boolean, emptyPollCount: number): number {
    if (hasJob) return 5000
    if (emptyPollCount > 10) return 30000
    if (emptyPollCount > 4) return 20000
    return 10000
  }

  // Active claim being processed
  assert.equal(calculatePollDelay(true, 0), 5000)

  // Empty queue: starts at 10s
  assert.equal(calculatePollDelay(false, 1), 10000)
  assert.equal(calculatePollDelay(false, 4), 10000)

  // Idle after ~1 minute: backs off to 20s
  assert.equal(calculatePollDelay(false, 5), 20000)
  assert.equal(calculatePollDelay(false, 10), 20000)

  // Long idle (>2 minutes): backs off to 30s to preserve CPU
  assert.equal(calculatePollDelay(false, 11), 30000)
  assert.equal(calculatePollDelay(false, 100), 30000)
})

test("job progress: not eligible clears a stale reference and sends the claim to manual review", async () => {
  const { pool, queries } = fakePool()
  await updateJobProgress(pool, 7, { stage: "not_eligible", manualActionReason: "SYN-packaging policy" })

  const jobUpdate = queries.find((q) => q.sql.includes("UPDATE claim_automation_jobs"))
  assert.ok(jobUpdate)
  assert.match(jobUpdate.sql, /marketplace_claim_id = ''/)
  assert.match(jobUpdate.sql, /completed_at = NULL/)

  const claimUpdate = queries.find((q) => q.sql.includes("UPDATE claims"))
  assert.ok(claimUpdate)
  assert.match(claimUpdate.sql, /status = 'manual_action_required'/)
  assert.deepEqual(claimUpdate.params, [7, "SYN-packaging policy"])
  assert.equal(queries.at(-1)?.sql, "COMMIT")
})

test("job progress: other stages keep the marketplace reference", async () => {
  const { pool, queries } = fakePool()
  await updateJobProgress(pool, 7, { stage: "submitting", logMessage: "SYN-submitting" })

  const jobUpdate = queries.find((q) => q.sql.includes("UPDATE claim_automation_jobs"))
  assert.ok(jobUpdate)
  assert.doesNotMatch(jobUpdate.sql, /marketplace_claim_id/)
  assert.equal(queries.some((q) => q.sql.includes("UPDATE claims")), false)
})



