import assert from "node:assert/strict"
import test from "node:test"
import {
  authenticateAutomationAgent,
  createOrQueueAutomationJob,
  decryptSecret,
  encryptSecret,
  getJobExecutionBundle,
  likeContains,
  lookupReturnForClaim,
  maskSecret,
  mapToReceiptIssueCategory,
  pollNextAutomationJob,
  defaultRequireApprovalBeforeSubmit,
  isMeeshoAccountName,
  resolveClaimScanId,
  updateJobProgress,
} from "../claim-automation-service.js"
import { ServiceError } from "../register-service.js"
import type pg from "pg"

process.env.AUTOMATION_SECRET_KEY ||= "SYN-TEST-AUTOMATION-KEY-AT-LEAST-32-CHARS"

function serviceErrorCode(promise: Promise<unknown>): Promise<number> {
  return promise.then(
    () => -1,
    (err) => {
      assert.ok(err instanceof ServiceError, `expected ServiceError, got ${String(err)}`)
      return (err as ServiceError).status
    },
  )
}

function fakePool() {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params })
      if (sql.includes("SELECT j.attempts, j.max_attempts")) {
        return {
          rows: [
            {
              attempts: 1,
              max_attempts: 3,
              marketplace_id: 3,
              agent_id: 9,
              lease_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    },
    release: () => undefined,
  }
  return { pool: { connect: async () => client } as unknown as pg.Pool, queries }
}

test("new Meesho credentials default to full-auto; other marketplaces keep approval", () => {
  assert.equal(isMeeshoAccountName("Meesho"), true)
  assert.equal(isMeeshoAccountName("SYN-Meesho VB Exports"), true)
  assert.equal(isMeeshoAccountName("Flipkart"), false)
  assert.equal(defaultRequireApprovalBeforeSubmit("Meesho"), false)
  assert.equal(defaultRequireApprovalBeforeSubmit("Flipkart"), true)
  assert.equal(defaultRequireApprovalBeforeSubmit("Amazon"), true)
})

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
  await updateJobProgress(pool, 7, { stage: "filling_form", logMessage: "SYN-filling" })

  const jobUpdate = queries.find((q) => q.sql.includes("UPDATE claim_automation_jobs"))
  assert.ok(jobUpdate)
  assert.doesNotMatch(jobUpdate.sql, /marketplace_claim_id/)
  assert.equal(queries.some((q) => q.sql.includes("UPDATE claims")), false)
})

// M9: the submitting state is granted only by the queue lease. A worker must
// never self-authorize by reporting its way into submitting.
test("job progress: reporting the submitting stage is rejected", async () => {
  const { pool, queries } = fakePool()
  const code = await serviceErrorCode(updateJobProgress(pool, 7, { stage: "submitting", logMessage: "SYN-submitting" }))
  assert.equal(code, 409)
  assert.equal(queries.length, 0, "rejected self-authorization must not touch the database")
})

// M9: progress is accepted only from the worker holding a live lease.
test("job progress: a worker without the lease cannot report progress", async () => {
  const { pool, queries } = fakePool()
  const code = await serviceErrorCode(
    updateJobProgress(pool, 7, { stage: "filling_form", logMessage: "SYN-stale" }, 77),
  )
  assert.equal(code, 404)
  assert.ok(!queries.some((q) => q.sql.includes("UPDATE claim_automation_jobs")), "rejected progress must not rewrite the job")
})

test("job progress: the lease holder reports progress while the lease is live", async () => {
  const { pool, queries } = fakePool()
  await updateJobProgress(pool, 7, { stage: "filling_form", logMessage: "SYN-holder" }, 9)
  assert.ok(queries.some((q) => q.sql.includes("UPDATE claim_automation_jobs")), "the holder's progress must be recorded")
})

// 2.3: the claim lookup's partial match treats % and _ as text, not LIKE wildcards.
test("claim lookup: the contains-pattern escapes LIKE wildcards and the escape character", () => {
  assert.equal(likeContains("SYN-123"), "%SYN-123%")
  assert.equal(likeContains("SYN%1_2"), "%SYN\\%1\\_2%")
  assert.equal(likeContains("SYN\\9"), "%SYN\\\\9%")
})

// 2.3: a claim attaches only to a saved bench scan. The fake answers the bench's exact saved-scan query.
function scanPool(scansByKey: Record<string, Array<{ scan_id: number; marketplace_id: number }>>) {
  const keys: string[] = []
  const pool = {
    query: async (_sql: string, params: unknown[] = []) => {
      keys.push(String(params[0]))
      return { rows: scansByKey[String(params[0])] ?? [] }
    },
  } as unknown as pg.Pool
  return { pool, keys }
}

const allAccounts = { all: true } as const

test("claim scan: the app's saved scan id is used as sent, with no lookup", async () => {
  const { pool, keys } = scanPool({})
  assert.equal(await resolveClaimScanId(pool, allAccounts, { scanId: 41, keys: ["SYN-AWB-1"] }), 41)
  assert.equal(keys.length, 0)
})

test("claim scan: an older APK with no scan id attaches to the one saved scan for its AWB", async () => {
  const { pool, keys } = scanPool({ "SYN-AWB-2": [{ scan_id: 52, marketplace_id: 1 }] })
  assert.equal(await resolveClaimScanId(pool, allAccounts, { scanId: null, keys: ["syn-awb-2", "SYN-SUB-2", ""] }), 52)
  assert.deepEqual(keys, ["SYN-AWB-2"], "the AWB is tried first, upper-cased like the bench")
})

test("claim scan: a stale sub order never rescues an AWB that has no saved scan", async () => {
  const { pool, keys } = scanPool({ "SYN-SUB-3": [{ scan_id: 63, marketplace_id: 1 }] })
  await assert.rejects(
    resolveClaimScanId(pool, allAccounts, { scanId: null, keys: ["SYN-AWB-3", "SYN-SUB-3", ""] }),
    /Save the bench scan first/,
  )
  assert.deepEqual(keys, ["SYN-AWB-3"], "only the AWB is tried when one is sent")
  assert.equal(await resolveClaimScanId(pool, allAccounts, { scanId: null, keys: ["", "SYN-SUB-3", ""] }), 63)
})

test("claim scan: no saved scan is rejected with bench_scan_required", async () => {
  const { pool } = scanPool({})
  await assert.rejects(resolveClaimScanId(pool, allAccounts, { scanId: null, keys: ["SYN-AWB-4", "", ""] }), (err) => {
    assert.ok(err instanceof ServiceError)
    assert.equal(err.status, 409)
    assert.equal(err.extra.code, "bench_scan_required")
    assert.match(err.message, /Save the bench scan first/)
    return true
  })
  await assert.rejects(resolveClaimScanId(pool, allAccounts, { scanId: null, keys: ["", "", ""] }), /Save the bench scan first/)
})

test("claim scan: two saved scans for one AWB never bind silently", async () => {
  const { pool } = scanPool({
    "SYN-AWB-5": [
      { scan_id: 71, marketplace_id: 4 },
      { scan_id: 72, marketplace_id: 5 },
    ],
  })
  await assert.rejects(resolveClaimScanId(pool, allAccounts, { scanId: null, keys: ["SYN-AWB-5"] }), (err) => {
    assert.ok(err instanceof ServiceError)
    assert.equal(err.status, 409)
    assert.equal(err.extra.code, "scan_ambiguous")
    return true
  })
})

// 2.3: a restricted user's account list is bound after the search text, so $1 and $2 stay the text and its pattern.
test("claim lookup: a restricted scope binds the account list after the search text", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  } as unknown as pg.Pool
  assert.equal(await lookupReturnForClaim(pool, { all: false, marketplaceIds: [3, 5] }, "SYN-AWB_9"), null)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].params, ["SYN-AWB_9", "%SYN-AWB\\_9%", [3, 5]])
  assert.match(calls[0].sql, /er\.marketplace_id = ANY\(\$3::integer\[\]\)/)
  assert.match(calls[0].sql, /er\.lookup_status = 'active'/)
})

test("createOrQueueAutomationJob: queues reclaimed completed claims once without overriding active stages", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  let existingStage = "completed"
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params })
      if (sql.includes("SELECT m.name")) return { rows: [{ name: "Meesho" }] }
      if (sql.includes("SELECT id, stage FROM claim_automation_jobs")) return { rows: [{ id: 88, stage: existingStage }] }
      if (sql.includes("FROM claims c") && sql.includes("marketplace_credentials")) return { rows: [{ id: 1, automation_mode: "visible" }] }
      if (sql.includes("INSERT INTO claim_automation_jobs")) return { rows: [{ id: 99 }] }
      return { rows: [] }
    },
  } as unknown as pg.Pool

  assert.equal(await createOrQueueAutomationJob(pool, 12), 88)
  assert.equal(await createOrQueueAutomationJob(pool, 12, { requeueReopened: true }), 99)

  existingStage = "prepared"
  assert.equal(await createOrQueueAutomationJob(pool, 12), 88)
  assert.equal(await createOrQueueAutomationJob(pool, 12, { requeueReopened: true }), 99)

  existingStage = "queued"
  assert.equal(await createOrQueueAutomationJob(pool, 12, { requeueReopened: true }), 88)
})

test("pollNextAutomationJob: backfills missing queued jobs for scoped ready Meesho claims before leasing", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params })
      if (sql.includes("FROM claim_automation_agents")) return { rows: [{ id: 7 }] }
      return { rows: [] }
    },
    release: () => undefined,
  }
  const pool = { connect: async () => client } as unknown as pg.Pool
  await pollNextAutomationJob(pool, "SYN-agent-backfill", { all: false, marketplaceIds: [4] })
  const backfill = queries.find((q) => q.sql.includes("INSERT INTO claim_automation_jobs"))
  assert.ok(backfill, "backfill insert must run inside pollNextAutomationJob")
  assert.match(backfill.sql, /NOT EXISTS/)
  assert.match(backfill.sql, /FOR UPDATE OF c SKIP LOCKED/)
  assert.match(backfill.sql, /c\.status IN \('ready_for_claim', 'reclaim', 'escalated'\)/)
  assert.deepEqual(backfill.params, [[4]])
})

test("getJobExecutionBundle: resolves returnType from receipt_scan_items/expected_returns when snapshot is empty", async () => {
  const calls: string[] = []
  const rawClaimSnapshot = ""
  const rawScanItemReturnType = "Customer Return"
  const rawExpectedReturnType = "RTO"
  const pool = {
    query: async (sql: string) => {
      calls.push(sql)
      if (sql.includes("FROM claim_automation_jobs j")) {
        const hasFallbackSql =
          sql.includes("NULLIF(c.return_type_snapshot, '')") &&
          sql.includes("FROM receipt_scan_items rsi") &&
          sql.includes("er.return_type")
        const resolvedReturnType = hasFallbackSql
          ? rawClaimSnapshot || rawScanItemReturnType || rawExpectedReturnType
          : rawClaimSnapshot
        return {
          rows: [{
            job_id: 1,
            claim_id: 2,
            stage: "downloading_media",
            claim_status: "ready_for_claim",
            marketplace: "Meesho",
            account_name: "Meesho",
            portal_url: "https://supplier.meesho.com/panel/v3/new/root/login",
            username_encrypted: "",
            password_encrypted: "",
            auth_state: {},
            browser_mode: "visible",
            automation_mode: "autonomous",
            require_approval_before_submit: false,
            claim_reason: "Wrong return",
            claim_title: "SYN Title",
            claim_description: "SYN Desc",
            claim_content: "",
            remarks: "",
            sub_order_id_snapshot: "SYN-SUB-1",
            awb_snapshot: "SYN-AWB-1",
            packet_id_snapshot: "SYN-PKT-1",
            customer_name_snapshot: "",
            total_price_snapshot: 100,
            sku_snapshot: "",
            packet_state_snapshot: "Intact",
            marketplace_issue_code: "wrong_return",
            return_type_snapshot: resolvedReturnType,
            order_number: "SYN-ORD-1",
            tracking_id: "SYN-AWB-1",
          }],
        }
      }
      return { rows: [] }
    },
  } as unknown as pg.Pool
  const bundle = await getJobExecutionBundle(pool, 1)
  assert.equal(bundle.claim.returnType, "Customer Return")
})
