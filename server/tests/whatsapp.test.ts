// Unit tests for WhatsApp Enterprise Gateway & OMSGuru Group Dispatcher.
// Follows strict Return App testing standards:
// - All test data starts with SYN-
// - No network calls in unit tests (mocked fetch)
// - Verifies caption formatting, tagging, mentions, error resilience and fail-closed config

import test from "node:test"
import assert from "node:assert/strict"
import type pg from "pg"
import {
  renderOmsguruWhatsAppCaption,
  sendWhatsAppTextMessage,
  sendWhatsAppDocument,
  sendOmsguruDailyToWhatsApp,
  checkWhatsAppConnection,
  getWhatsAppConfig,
  updateWhatsAppConfig,
  redactWhatsAppConfig,
  whatsAppConfigFromEnv,
  type WhatsAppConfig,
} from "../whatsapp.js"
import { type OmsguruDailyUpdateRecord, type SkuUpdateItem, buildOmsguruCsv } from "../omsguru-daily.js"

// A fully configured synthetic gateway: every value is SYN- test data, never a real login or ID.
const SYN_CONFIG: WhatsAppConfig = {
  enabled: true,
  apiUrl: "https://SYN-gateway.example.invalid",
  basicAuth: "SYN-USER:SYN-PASS",
  groupJid: "SYN-GROUP@g.us",
  tagUserJid: "SYN-TAG-USER@s.whatsapp.net",
  tagUserLid: "SYN-TAG-USER@lid",
  tagUserName: "SYN-Tagged User",
}

const syntheticRecord: OmsguruDailyUpdateRecord = {
  id: 101,
  requestId: "SYN-REQ-20261102-1234",
  updateDate: "2026-11-02",
  dropshipWarehouseId: "6688",
  totalSkus: 12,
  totalQty: 145,
  csvContent: "Dropship Warehouse,Product SkuCode,Quantity,Cost Price\n6688,SYN-SKU-01,10,0",
  fileName: "UpdateInStockQtyAnd_orLastPurchasePrice.csv",
  storagePath: "inventory-update-file/2026-11-02.csv",
  storageUrl: "https://example.com/2026-11-02.csv",
  emailSent: true,
  emailSentAt: "2026-11-02T17:30:00Z",
  emailRecipients: ["test@example.com"],
  emailCc: [],
  skuBreakdown: [
    {
      sku: "SYN-SKU-01",
      qty: 100,
      marketplaces: { "Myntra VB": 60, Meesho: 40 },
    },
    {
      sku: "SYN-SKU-02",
      qty: 45,
      marketplaces: { Flipkart: 45 },
    },
  ],
  generatedBy: 1,
  createdAt: "2026-11-02T17:30:00Z",
}

// Replaces global fetch with a counter so a test can assert that no network call was made.
async function withFetchSpy(run: () => Promise<void>): Promise<number> {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return { ok: true, status: 200, json: async () => ({ code: "SUCCESS", results: {} }) } as any
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
  }
  return calls
}

const WHATSAPP_ENV_KEYS = [
  "WHATSAPP_API_URL",
  "WHATSAPP_BASIC_AUTH",
  "WHATSAPP_GROUP_JID",
  "WHATSAPP_TAG_USER_JID",
  "WHATSAPP_TAG_USER_LID",
  "WHATSAPP_TAG_USER_NAME",
]

// Runs with exactly these WHATSAPP_* values in process.env, then restores what the shell had.
async function withWhatsAppEnv(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(WHATSAPP_ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of WHATSAPP_ENV_KEYS) delete process.env[key]
  Object.assign(process.env, values)
  try {
    await run()
  } finally {
    for (const key of WHATSAPP_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

// A pg.Pool stand-in that records every query and answers the settings read with `stored`.
function fakeDb(stored?: Partial<WhatsAppConfig>) {
  const queries: { sql: string; params?: unknown[] }[] = []
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params })
      if (sql.includes("FROM app_system_settings")) {
        return { rows: stored ? [{ setting_value: stored }] : [] }
      }
      return { rows: [] }
    },
  } as unknown as pg.Pool
  return { db, queries }
}

test("WhatsApp Gateway — default config from an empty environment is disabled with no login, group or tagged user", () => {
  const config = whatsAppConfigFromEnv({})
  assert.equal(config.enabled, false)
  assert.equal(config.basicAuth, "")
  assert.equal(config.groupJid, "")
  assert.equal(config.tagUserJid, "")
  assert.equal(config.tagUserLid, "")
  assert.equal(config.tagUserName, "")
  // The plain gateway URL is not a secret and keeps its default.
  assert.equal(config.apiUrl, "https://wa.youthnic.shop")
})

test("WhatsApp Gateway — default config is enabled only when both the login and the group ID are set", () => {
  const both = whatsAppConfigFromEnv({
    WHATSAPP_API_URL: " https://SYN-gateway.example.invalid ",
    WHATSAPP_BASIC_AUTH: " SYN-USER:SYN-PASS ",
    WHATSAPP_GROUP_JID: "SYN-GROUP@g.us",
    WHATSAPP_TAG_USER_JID: "SYN-TAG-USER@s.whatsapp.net",
    WHATSAPP_TAG_USER_LID: "SYN-TAG-USER@lid",
    WHATSAPP_TAG_USER_NAME: "SYN-Tagged User",
  })
  assert.deepEqual(both, SYN_CONFIG)

  assert.equal(whatsAppConfigFromEnv({ WHATSAPP_BASIC_AUTH: "SYN-USER:SYN-PASS" }).enabled, false)
  assert.equal(whatsAppConfigFromEnv({ WHATSAPP_GROUP_JID: "SYN-GROUP@g.us" }).enabled, false)
  assert.equal(whatsAppConfigFromEnv({ WHATSAPP_BASIC_AUTH: "  ", WHATSAPP_GROUP_JID: "SYN-GROUP@g.us" }).enabled, false)
})

test("WhatsApp Gateway — sends and status checks with a missing login or group ID make no network call", async () => {
  const noLogin: WhatsAppConfig = { ...SYN_CONFIG, basicAuth: "" }
  const noGroup: WhatsAppConfig = { ...SYN_CONFIG, groupJid: "" }

  const calls = await withFetchSpy(async () => {
    for (const cfg of [noLogin, noGroup, whatsAppConfigFromEnv({})]) {
      const textRes = await sendWhatsAppTextMessage({ phone: "SYN-GROUP@g.us", message: "SYN-TEST" }, cfg, 1)
      assert.equal(textRes.success, false)
      assert.match(textRes.error || "", /not configured/)

      const fileRes = await sendWhatsAppDocument(
        { phone: "SYN-GROUP@g.us", caption: "SYN-CAPTION", filename: "test.csv", fileBuffer: "csv,data" },
        cfg,
        1,
      )
      assert.equal(fileRes.success, false)
      assert.match(fileRes.error || "", /not configured/)

      const status = await checkWhatsAppConnection(cfg)
      assert.equal(status.connected, false)
      assert.match(status.error || "", /not configured/)
    }
  })
  assert.equal(calls, 0)

  const reason = (await sendWhatsAppTextMessage({ phone: "", message: "SYN-TEST" }, whatsAppConfigFromEnv({}), 1)).error
  assert.match(reason || "", /WHATSAPP_BASIC_AUTH/)
  assert.match(reason || "", /WHATSAPP_GROUP_JID/)
})

test("WhatsApp Gateway — a forced OMSGuru dispatch with a stored config missing the login sends nothing", async () => {
  // Stored settings say enabled, but carry no login, and the environment has none: the dispatch must still fail closed.
  const { db, queries } = fakeDb({ enabled: true, groupJid: "SYN-GROUP@g.us" })

  let result: Awaited<ReturnType<typeof sendOmsguruDailyToWhatsApp>> | undefined
  let calls = -1
  await withWhatsAppEnv({}, async () => {
    calls = await withFetchSpy(async () => {
      result = await sendOmsguruDailyToWhatsApp(db, syntheticRecord, { force: true })
    })
  })
  assert.equal(calls, 0)
  assert.equal(result?.sent, false)
  assert.match(result?.error || "", /not configured: missing gateway login/)
  // The settings read, then one update that records the reason on the history row: no audit row, no "sent" update.
  assert.equal(queries.length, 2)
  assert.match(queries[1].sql, /UPDATE omsguru_daily_inventory_updates\s+SET whatsapp_sent = false, whatsapp_error = \$1/)
  assert.match(String(queries[1].params?.[0]), /not configured: missing gateway login/)
  assert.equal(queries[1].params?.[1], syntheticRecord.id)
})

test("WhatsApp Gateway — WHATSAPP_* values set after import are read at call time", async () => {
  // server/index.ts loads .env after its imports have run, so the config must not be fixed at import.
  await withWhatsAppEnv({ WHATSAPP_BASIC_AUTH: "SYN-USER:SYN-PASS", WHATSAPP_GROUP_JID: "SYN-GROUP@g.us" }, async () => {
    const config = await getWhatsAppConfig(fakeDb().db)
    assert.equal(config.enabled, true)
    assert.equal(config.basicAuth, "SYN-USER:SYN-PASS")
    assert.equal(config.groupJid, "SYN-GROUP@g.us")

    // A stored row still overrides the environment, and fills its blanks from it.
    const stored = await getWhatsAppConfig(fakeDb({ enabled: false, groupJid: "SYN-OTHER-GROUP@g.us" }).db)
    assert.equal(stored.enabled, false)
    assert.equal(stored.groupJid, "SYN-OTHER-GROUP@g.us")
    assert.equal(stored.basicAuth, "SYN-USER:SYN-PASS")
  })
})

test("WhatsApp Gateway — redactWhatsAppConfig never returns the gateway login", () => {
  const redacted = redactWhatsAppConfig(SYN_CONFIG)
  assert.equal("basicAuth" in redacted, false)
  assert.equal(redacted.basicAuthSet, true)
  assert.equal(redacted.groupJid, "SYN-GROUP@g.us")
  assert.equal(redactWhatsAppConfig({ ...SYN_CONFIG, basicAuth: " " }).basicAuthSet, false)
})

test("WhatsApp Gateway — saving settings without a login keeps the stored login and keeps it out of the audit log", async () => {
  const { db, queries } = fakeDb({ ...SYN_CONFIG })
  // What the settings page posts back: the redacted config it was given, with one field changed.
  const posted = { ...redactWhatsAppConfig(SYN_CONFIG), enabled: false } as Partial<WhatsAppConfig>
  const updated = await updateWhatsAppConfig(db, posted, 1)
  assert.equal(updated.basicAuth, "SYN-USER:SYN-PASS")
  assert.equal(updated.enabled, false)

  const settingsWrite = queries.find((q) => q.sql.includes("INSERT INTO app_system_settings"))
  assert.equal(JSON.parse(String(settingsWrite?.params?.[0])).basicAuth, "SYN-USER:SYN-PASS")
  const auditWrite = queries.find((q) => q.sql.includes("INSERT INTO register_audit_log"))
  const auditDetails = String(auditWrite?.params?.[1])
  assert.equal(auditDetails.includes("SYN-PASS"), false)
  assert.equal(JSON.parse(auditDetails).basicAuthSet, true)

  // An empty login in the body is treated as "not sent", not as "clear it".
  assert.equal((await updateWhatsAppConfig(db, { basicAuth: "" }, 1)).basicAuth, "SYN-USER:SYN-PASS")
})

test("WhatsApp Gateway — renderOmsguruWhatsAppCaption generates rich briefing with mentions and tags", () => {
  const result = renderOmsguruWhatsAppCaption(syntheticRecord, SYN_CONFIG)

  // Verify simple and normal caption format: @user tag without brackets + clean prompt
  assert.equal(
    result.caption,
    "@SYN-TAG-USER\nPlease update this inventory on Omsguru SYN-REQ-20261102-1234"
  )

  // Verify mentions array contains both Phone JID and LID
  assert.deepEqual(result.mentions, [
    "SYN-TAG-USER@s.whatsapp.net",
    "SYN-TAG-USER@lid",
  ])
})

test("WhatsApp Gateway — renderOmsguruWhatsAppCaption with no tagged user has no tag line and no mentions", () => {
  const result = renderOmsguruWhatsAppCaption(syntheticRecord, { ...SYN_CONFIG, tagUserJid: "", tagUserLid: "" })
  assert.equal(result.caption, "Please update this inventory on Omsguru SYN-REQ-20261102-1234")
  assert.deepEqual(result.mentions, [])
})

test("WhatsApp Gateway — disabled config skips sending gracefully without throwing", async () => {
  const disabledConfig: WhatsAppConfig = {
    ...SYN_CONFIG,
    enabled: false,
  }

  const calls = await withFetchSpy(async () => {
    const textRes = await sendWhatsAppTextMessage(
      { phone: "SYN-1234", message: "Test" },
      disabledConfig,
    )
    assert.equal(textRes.success, false)
    assert.match(textRes.error || "", /disabled/)

    const fileRes = await sendWhatsAppDocument(
      {
        phone: "SYN-1234",
        caption: "Test",
        filename: "test.csv",
        fileBuffer: "csv,data",
      },
      disabledConfig,
    )
    assert.equal(fileRes.success, false)
    assert.match(fileRes.error || "", /disabled/)
  })
  assert.equal(calls, 0)
})

test("WhatsApp & OMSGuru Daily CSV — buildOmsguruCsv strictly filters zero/negative quantities and blank SKUs", () => {
  const testItems: SkuUpdateItem[] = [
    { sku: "SYN-VALID-SKU-1", qty: 10, marketplaces: { "Myntra VB": 10 } },
    { sku: "SYN-VALID-SKU-2", qty: 5, marketplaces: { "Flipkart": 5 } },
    { sku: "SYN-ZERO-QTY", qty: 0, marketplaces: { "Meesho": 0 } },
    { sku: "SYN-NEGATIVE-QTY", qty: -3, marketplaces: { "Amazon": -3 } },
    { sku: "   ", qty: 8, marketplaces: { "Ajio": 8 } },
    { sku: "", qty: 2, marketplaces: { "Shopify": 2 } },
  ]

  const csv = buildOmsguruCsv({
    warehouseId: "6688",
    requestId: "SYN-REQ-001",
    skus: testItems,
  })
  const lines = csv.trim().split(/\r?\n/)

  // Header + exactly 2 valid items (others filtered out)
  assert.equal(lines.length, 3)
  assert.match(lines[0], /DropshipWarehouseId,Item SkuCode,InventoryAction,QtyIncludesBlocked,Qty,RackSpace,Last Purchase Price,Notes/)
  assert.match(lines[1], /6688,SYN-VALID-SKU-1,ADD,,10,,,SYN-REQ-001/)
  assert.match(lines[2], /6688,SYN-VALID-SKU-2,ADD,,5,,,SYN-REQ-001/)
  assert.equal(csv.includes("SYN-ZERO-QTY"), false)
  assert.equal(csv.includes("SYN-NEGATIVE-QTY"), false)
})

test("WhatsApp Gateway — sendWhatsAppTextMessage retries on 500 error and recovers on next attempt", async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0

  globalThis.fetch = (async (url: any, init: any) => {
    callCount++
    if (callCount === 1) {
      return {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({ code: "INTERNAL_ERROR", message: "Transient gateway failure" }),
      } as any
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: "SUCCESS", results: { message_id: "SYN-MSG-SUCCESS-001" } }),
    } as any
  }) as typeof fetch

  try {
    const res = await sendWhatsAppTextMessage(
      { phone: "SYN-9999", message: "SYN-TEST-RETRY" },
      SYN_CONFIG,
      2,
    )

    assert.equal(callCount, 2)
    assert.equal(res.success, true)
    assert.equal(res.messageId, "SYN-MSG-SUCCESS-001")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("WhatsApp Gateway — sendWhatsAppTextMessage exhausts retries and returns clean error message on persistent failure", async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0

  globalThis.fetch = (async () => {
    callCount++
    return {
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => ({ code: "BAD_GATEWAY", message: "Upstream container unreachable" }),
    } as any
  }) as typeof fetch

  try {
    const res = await sendWhatsAppTextMessage(
      { phone: "SYN-9999", message: "SYN-TEST-FAIL" },
      SYN_CONFIG,
      2,
    )

    assert.equal(callCount, 2)
    assert.equal(res.success, false)
    assert.match(res.error || "", /Upstream container unreachable/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("WhatsApp Gateway — sendWhatsAppDocument retries on transient network error and succeeds", async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0

  globalThis.fetch = (async (url: any, init: any) => {
    callCount++
    if (callCount === 1) {
      throw new Error("ETIMEDOUT: Connection timed out")
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: "SUCCESS", results: { message_id: "SYN-DOC-MSG-777" } }),
    } as any
  }) as typeof fetch

  try {
    const res = await sendWhatsAppDocument(
      {
        phone: "SYN-9999",
        caption: "SYN-CAPTION",
        filename: "test.csv",
        fileBuffer: "Dropship,Sku,Qty\n6688,SYN-SKU,1",
      },
      SYN_CONFIG,
      2,
    )

    assert.equal(callCount, 2)
    assert.equal(res.success, true)
    assert.equal(res.messageId, "SYN-DOC-MSG-777")
  } finally {
    globalThis.fetch = originalFetch
  }
})
