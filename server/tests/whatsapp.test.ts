// Unit tests for WhatsApp Enterprise Gateway & OMSGuru Group Dispatcher.
// Follows strict Return App testing standards:
// - All test data starts with SYN-
// - No network calls in unit tests (mocked fetch)
// - Verifies caption formatting, tagging, mentions, and error resilience

import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_WHATSAPP_CONFIG,
  renderOmsguruWhatsAppCaption,
  sendWhatsAppTextMessage,
  sendWhatsAppDocument,
  checkWhatsAppConnection,
  type WhatsAppConfig,
} from "../whatsapp.js"
import { type OmsguruDailyUpdateRecord, type SkuUpdateItem, buildOmsguruCsv } from "../omsguru-daily.js"

test("WhatsApp Gateway — DEFAULT_WHATSAPP_CONFIG defaults match production parameters", () => {
  assert.equal(DEFAULT_WHATSAPP_CONFIG.apiUrl, "https://wa.youthnic.shop")
  assert.equal(DEFAULT_WHATSAPP_CONFIG.groupJid, "919825149497-1631941133@g.us")
  assert.equal(DEFAULT_WHATSAPP_CONFIG.tagUserJid, "916306361624@s.whatsapp.net")
  assert.equal(DEFAULT_WHATSAPP_CONFIG.tagUserLid, "214250249314376@lid")
  assert.equal(DEFAULT_WHATSAPP_CONFIG.tagUserName, "Pandit Vishal Tiwari")
  assert.equal(DEFAULT_WHATSAPP_CONFIG.enabled, true)
})

test("WhatsApp Gateway — renderOmsguruWhatsAppCaption generates rich briefing with mentions and tags", () => {
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

  const result = renderOmsguruWhatsAppCaption(syntheticRecord, DEFAULT_WHATSAPP_CONFIG)

  // Verify simple and normal caption format: @user tag without brackets + clean prompt
  assert.equal(
    result.caption,
    "@916306361624\nPlease update this inventory on Omsguru SYN-REQ-20261102-1234"
  )

  // Verify mentions array contains both Phone JID and LID
  assert.deepEqual(result.mentions, [
    "916306361624@s.whatsapp.net",
    "214250249314376@lid",
  ])
})

test("WhatsApp Gateway — disabled config skips sending gracefully without throwing", async () => {
  const disabledConfig: WhatsAppConfig = {
    ...DEFAULT_WHATSAPP_CONFIG,
    enabled: false,
  }

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
      DEFAULT_WHATSAPP_CONFIG,
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
      DEFAULT_WHATSAPP_CONFIG,
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
      DEFAULT_WHATSAPP_CONFIG,
      2,
    )

    assert.equal(callCount, 2)
    assert.equal(res.success, true)
    assert.equal(res.messageId, "SYN-DOC-MSG-777")
  } finally {
    globalThis.fetch = originalFetch
  }
})

