import test from "node:test"
import assert from "node:assert/strict"
import {
  buildFillChunks,
  buildMappingInsertChunks,
  cleanVmsCategory,
  cleanVmsImageUrl,
  cleanVmsSku,
  dedupeVmsMappings,
  dedupeVmsRows,
  normalizeVmsMarketplace,
  probeVmsCatalogue,
} from "../vms/catalog.js"
import { getVmsConnectionSettings, queryVmsReadOnly } from "../vms/db.js"

test("[synthetic] VMS image links keep http(s), anything else is blank and never repaired", () => {
  assert.equal(cleanVmsImageUrl("https://img.example.invalid/SYN-1.jpg"), "https://img.example.invalid/SYN-1.jpg")
  assert.equal(cleanVmsImageUrl("http://img.example.invalid/SYN-1.jpg"), "http://img.example.invalid/SYN-1.jpg")
  assert.equal(cleanVmsImageUrl(""), "")
  assert.equal(cleanVmsImageUrl(null), "")
  assert.equal(cleanVmsImageUrl("ftp://img.example.invalid/SYN-1.jpg"), "")
  assert.equal(cleanVmsImageUrl("not a link"), "")
  assert.equal(cleanVmsImageUrl("https://169.254.169.254/SYN-1.jpg"), "")
})

test("[synthetic] VMS SKUs are trimmed and capped, never guessed", () => {
  assert.equal(cleanVmsSku("  SYN-SKU-1  "), "SYN-SKU-1")
  assert.equal(cleanVmsSku(""), "")
  assert.equal(cleanVmsSku(null), "")
  assert.equal("x".repeat(200).length, 200)
  assert.equal(cleanVmsSku("x".repeat(200)).length, 120)
})

test("[synthetic] VMS access accepts only single-statement SELECT/WITH, before any connection is opened", async () => {
  for (const sql of [
    "INSERT INTO sku_photos (sku) VALUES ('SYN-1')",
    "UPDATE sku_photos SET title = 'SYN-1'",
    "DELETE FROM sku_photos",
    "DROP TABLE sku_photos",
    "TRUNCATE sku_photos",
    "ALTER TABLE sku_photos ADD COLUMN SYN_X text",
    "CREATE TABLE SYN_X (id int)",
    "MERGE INTO sku_photos USING SYN_X ON true WHEN MATCHED THEN DELETE",
    "SELECT * FROM sku_photos; DELETE FROM sku_photos",
    "SELECT * FROM sku_photos INTO SYN_COPY",
    "LISTEN SYN_CHANNEL",
    "NOTIFY SYN_CHANNEL",
    "CALL SYN_PROC()",
    "  -- comment only",
  ]) {
    await assert.rejects(queryVmsReadOnly(sql), /strictly READ-ONLY/)
  }
})

test("[synthetic] VMS connection refuses sslmode=no-verify and never leaks the URL", () => {
  const previous = process.env.VMS_DATABASE_URL
  try {
    process.env.VMS_DATABASE_URL = "postgresql://SYN-USER:SYN-PASS@localhost:5432/SYN-VMS?sslmode=no-verify"
    assert.throws(() => getVmsConnectionSettings(), /sslmode=no-verify is not allowed/)
  } finally {
    if (previous === undefined) delete process.env.VMS_DATABASE_URL
    else process.env.VMS_DATABASE_URL = previous
  }
})

test("[synthetic] VMS dedup keeps the first image per SKU key (case-insensitive), skipping imageless rows", () => {
  const deduped = dedupeVmsRows([
    { sku: "SYN-SKU-1", imageUrl: "https://img.example.invalid/SYN-a.jpg", marketplace: "SYN-MP" },
    { sku: "syn-sku-1", imageUrl: "https://img.example.invalid/SYN-b.jpg", marketplace: "SYN-MP" },
    { sku: "SYN-SKU-2", imageUrl: "", marketplace: "SYN-MP" },
    { sku: "SYN-SKU-3", imageUrl: "https://img.example.invalid/SYN-c.jpg", marketplace: "SYN-MP" },
  ])
  assert.equal(deduped.size, 2)
  assert.equal(deduped.get("syn-sku-1"), "https://img.example.invalid/SYN-a.jpg")
  assert.equal(deduped.get("syn-sku-3"), "https://img.example.invalid/SYN-c.jpg")
})

test("[synthetic] VMS fill chunks number every placeholder exactly once per chunk", () => {
  const imageByKey = new Map([
    ["syn-sku-1", "https://img.example.invalid/SYN-1.jpg"],
    ["syn-sku-2", "https://img.example.invalid/SYN-2.jpg"],
    ["syn-sku-3", "https://img.example.invalid/SYN-3.jpg"],
  ])
  const chunks = buildFillChunks(imageByKey, 2)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].values.length, 4)
  assert.equal(chunks[1].values.length, 2)
  for (const chunk of chunks) {
    const placeholders = (chunk.sql.match(/\$\d+/g) || []).map((token) => Number(token.slice(1)))
    assert.deepEqual(placeholders, placeholders.map((_, index) => index + 1))
    assert.match(chunk.sql, /COALESCE\(pm\.image_url, ''\) = ''/)
  }
})

test("[synthetic] VMS probe without a configured URL fails closed with no connection attempt", async () => {
  const previous = process.env.VMS_DATABASE_URL
  try {
    delete process.env.VMS_DATABASE_URL
    const probe = await probeVmsCatalogue()
    assert.equal(probe.ok, false)
    assert.match(probe.error || "", /not configured/)
    assert.equal(probe.tables.length, 0)
  } finally {
    if (previous === undefined) delete process.env.VMS_DATABASE_URL
    else process.env.VMS_DATABASE_URL = previous
  }
})

test("[synthetic] cleanVmsCategory trims whitespace and limits length without crashing on null", () => {
  assert.equal(cleanVmsCategory("  Sarees  \n\t "), "Sarees")
  assert.equal(cleanVmsCategory(null), "")
  assert.equal(cleanVmsCategory(""), "")
  assert.equal(cleanVmsCategory("a".repeat(150)).length, 100)
})

test("[synthetic] normalizeVmsMarketplace normalizes known channels and handles edge cases", () => {
  assert.equal(normalizeVmsMarketplace("myntra_vb"), "Myntra VB")
  assert.equal(normalizeVmsMarketplace("Myntra EJ"), "Myntra EJ")
  assert.equal(normalizeVmsMarketplace("Myntra"), "all")
  assert.equal(normalizeVmsMarketplace("Amazon IN"), "Amazon")
  assert.equal(normalizeVmsMarketplace("Flipkart Wholesale"), "Flipkart")
  assert.equal(normalizeVmsMarketplace("Meesho Dropship"), "Meesho")
  assert.equal(normalizeVmsMarketplace("Ajio B2C"), "Ajio")
  assert.equal(normalizeVmsMarketplace("Shopify Store"), "Shopify")
  assert.equal(normalizeVmsMarketplace("all"), "all")
  assert.equal(normalizeVmsMarketplace(""), "all")
  assert.equal(normalizeVmsMarketplace(null), "all")
})

test("[synthetic] dedupeVmsMappings keeps first occurrence, enriches missing image and category", () => {
  const rows = [
    {
      listingSku: "SYN-LIST-1",
      masterSku: "SYN-MASTER-1",
      category: "",
      imageUrl: "",
      marketplace: "Amazon",
    },
    {
      listingSku: "syn-list-1",
      masterSku: "SYN-MASTER-1",
      category: "Kurta",
      imageUrl: "https://img.example.invalid/SYN-1.jpg",
      marketplace: "Amazon",
    },
    {
      listingSku: "",
      masterSku: "SYN-MASTER-2",
      category: "Saree",
      imageUrl: "",
      marketplace: "Amazon",
    },
    {
      listingSku: "SYN-LIST-2",
      masterSku: "",
      category: "Saree",
      imageUrl: "",
      marketplace: "Amazon",
    },
  ]
  const deduped = dedupeVmsMappings(rows)
  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].listingSku, "SYN-LIST-1")
  assert.equal(deduped[0].masterSku, "SYN-MASTER-1")
  assert.equal(deduped[0].category, "Kurta")
  assert.equal(deduped[0].imageUrl, "https://img.example.invalid/SYN-1.jpg")
  assert.equal(deduped[0].marketplace, "Amazon")
})

test("[synthetic] buildMappingInsertChunks properly partitions and generates parameterized upsert SQL", () => {
  const rows = [
    {
      listingSku: "SYN-LIST-1",
      masterSku: "SYN-MASTER-1",
      category: "Kurta",
      imageUrl: "https://img.example.invalid/SYN-1.jpg",
      marketplace: "Amazon",
    },
    {
      listingSku: "SYN-LIST-2",
      masterSku: "SYN-MASTER-2",
      category: "Saree",
      imageUrl: "https://img.example.invalid/SYN-2.jpg",
      marketplace: "Flipkart",
    },
    {
      listingSku: "SYN-LIST-3",
      masterSku: "SYN-MASTER-3",
      category: "Lehenga",
      imageUrl: "",
      marketplace: "Meesho",
    },
  ]
  const chunks = buildMappingInsertChunks(rows, 2)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].values.length, 10) // 2 rows * 5 params
  assert.equal(chunks[1].values.length, 5) // 1 row * 5 params
  assert.match(chunks[0].sql, /INSERT INTO product_master/)
  assert.match(chunks[0].sql, /ON CONFLICT \(marketplace, listing_sku\) DO UPDATE/)

  // Verify placeholder numbering
  for (const chunk of chunks) {
    const placeholders = (chunk.sql.match(/\$\d+/g) || []).map((t) => Number(t.slice(1)))
    assert.deepEqual(placeholders, placeholders.map((_, i) => i + 1))
  }
})
