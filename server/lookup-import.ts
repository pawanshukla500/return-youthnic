// Lookup data from a marketplace return file: product SKU resolution, logistics partner detection, and the staged
// commit that replaces the active lookup rows for one account in a single transaction.
//
// A failed upload rolls back completely, so the previous active lookup data stays in place. Superseded rows are
// kept, because scans refer to them.
//
// Rows are never merged by AWB. Each non-duplicate return row becomes its own expected line, with its own quantity.
// The only rows that are not counted are exact duplicates of an earlier row in the same file (see sheets.ts).

import type pg from "pg"
import { applyPartners, type Queryable } from "./logistics.js"
import { compactSkuKey, listingSkuCandidates, marketplaceRank } from "./marketplace-rules.js"
import { normalizeSkuKey } from "./oms/client.js"
import type { PartnerMatch } from "./marketplace-rules.js"
import { isScannableRow, rowStatus, type DisplayIdentifierKind, type MarketplaceSkuIdentifierKind, type ParsedRow } from "./sheets.js"

export type ProductSource = "product_master" | "omsguru_master" | "unresolved"

export type ProductMapping = {
  checked: number
  mappedRows: number
  titledRows: number
  // Marketplace SKUs that did not resolve to a product SKU.
  unmapped: string[]
  // Catalog image per listing SKU, used when the import saves the SKU.
  images: Map<string, string>
  sources: Map<string, ProductSource>
  // Partner decision per row, used by the preview and by the commit.
  partners: Map<ParsedRow, PartnerMatch>
}

// The marketplace SKU identification (FNSKU, ASIN, FSN, JioCode or Myntra SKU code) comes from the layout's own
// column, set by the row mapper in server/sheets.ts. Nothing is read by header name here.
export function identifierFor(row: ParsedRow): string {
  return (row.marketplaceSkuIdentifier ?? "").trim()
}

// One product-master row for a listing SKU. An exact compact match beats the parent listing
// (the form without a trailing article suffix). A row for this account beats an "all" row.
export async function masterSkusForListings(
  db: Queryable,
  pairs: { listing: string; marketplace: string }[],
): Promise<Map<string, { masterSku: string; imageUrl: string }>> {
  const result = new Map<string, { masterSku: string; imageUrl: string }>()
  const wanted = pairs.filter((pair) => pair.listing.trim())
  if (!wanted.length) return result
  const compacts = new Set<string>()
  for (const pair of wanted) {
    for (const candidate of listingSkuCandidates(pair.listing)) compacts.add(compactSkuKey(candidate))
  }
  const found = await db.query(
    `SELECT listing_sku, marketplace, master_sku, image_url
     FROM product_master
     WHERE replace(lower(listing_sku), ' ', '') = ANY($1::text[])`,
    [[...compacts]],
  )
  const best = new Map<string, { masterSku: string; imageUrl: string; score: number }>()
  for (const pair of wanted) {
    const key = `${pair.marketplace.toLowerCase()}|${pair.listing}`
    const candidates = listingSkuCandidates(pair.listing).map(compactSkuKey)
    for (const row of found.rows) {
      const rank = marketplaceRank(String(row.marketplace), pair.marketplace.toLowerCase())
      if (rank === 0) continue
      const stored = compactSkuKey(String(row.listing_sku))
      const place = candidates.indexOf(stored)
      if (place < 0) continue
      const score = (candidates.length - place) * 10 + rank
      const current = best.get(key)
      if (!current || score > current.score) {
        best.set(key, { masterSku: String(row.master_sku), imageUrl: String(row.image_url || ""), score })
      }
    }
  }
  for (const [key, hit] of best) result.set(key, { masterSku: hit.masterSku, imageUrl: hit.imageUrl })
  return result
}

// Product SKU for each listing SKU. Precedence:
//  1. VB EXPORT product master (product_master), for this account or for 'all'.
//  2. OMSGuru master: the listing's OMSGuru SKU record (oms_listings to oms_skus). Used only when exactly one master
//     code matches. Several codes are left unresolved, never guessed.
// Titles come from sku_catalog. The image comes from the product master's own link when it has one, otherwise from
// sku_catalog. Unresolved lines keep the marketplace SKU as their item code.
// Logistics partner detection runs in the same pass, so the preview shows its warnings.
export async function resolveProductSkus(db: pg.Pool, rows: ParsedRow[], marketplace: string): Promise<ProductMapping> {
  const partners = await applyPartners(db, rows, marketplace)
  const listings = [...new Set(rows.map((row) => row.channelListingId).filter(Boolean))]
  const empty: ProductMapping = {
    checked: 0,
    mappedRows: 0,
    titledRows: 0,
    unmapped: [],
    images: new Map(),
    sources: new Map(),
    partners,
  }
  if (!listings.length) return empty

  const found = await masterSkusForListings(
    db,
    listings.map((listing) => ({ listing, marketplace })),
  )
  const best = new Map<string, { masterSku: string; imageUrl: string }>()
  for (const listing of listings) {
    const hit = found.get(`${marketplace.toLowerCase()}|${listing}`)
    if (hit) best.set(listing, hit)
  }

  const notInMaster = listings.filter((listing) => !best.has(listing))
  const omsCodes = await omsMasterCodes(db, notInMaster)

  const normalized = [...new Set(listings.map((listing) => normalizeSkuKey(listing)))]
  const catalog = await db.query("SELECT sku, title, image_url FROM sku_catalog WHERE sku = ANY($1::text[])", [normalized])
  const catalogBySku = new Map<string, { title: string; imageUrl: string }>()
  for (const row of catalog.rows) {
    catalogBySku.set(String(row.sku), { title: String(row.title || ""), imageUrl: String(row.image_url || "") })
  }

  const masterFor = new Map<string, string>()
  const sources = new Map<string, ProductSource>()
  // The product master's own image link per listing SKU. It wins over the OMSGuru catalog image (see below).
  const masterImage = new Map<string, string>()
  for (const listing of listings) {
    const hit = best.get(listing)
    if (hit) {
      masterFor.set(listing, hit.masterSku)
      sources.set(listing, "product_master")
      if (hit.imageUrl) masterImage.set(listing, hit.imageUrl)
      continue
    }
    const codes = omsCodes.get(listing) || []
    if (codes.length === 1) {
      masterFor.set(listing, codes[0])
      sources.set(listing, "omsguru_master")
      continue
    }
    sources.set(listing, "unresolved")
  }

  const images = new Map<string, string>()
  let mappedRows = 0
  let checked = 0
  let titledRows = 0
  for (const row of rows) {
    if (!row.channelListingId) continue
    checked++
    const master = masterFor.get(row.channelListingId)
    if (master) {
      row.sku = master
      mappedRows++
    }
    const info = catalogBySku.get(normalizeSkuKey(row.channelListingId))
    if (info) {
      if (info.title) {
        row.productName = info.title
        titledRows++
      }
      if (info.imageUrl) images.set(row.channelListingId, info.imageUrl)
    }
  }
  // The product master's image link wins over the OMSGuru catalog image for the same listing SKU.
  for (const [listing, url] of masterImage) images.set(listing, url)
  const unmapped = listings.filter((listing) => sources.get(listing) === "unresolved")
  return { checked, mappedRows, titledRows, unmapped, images, sources, partners }
}

// Listing SKU to the OMSGuru master codes it maps to. The SQL matches on upper-cased, trimmed text, and the final
// comparison uses normalizeSkuKey, the same key every other join uses.
async function omsMasterCodes(db: pg.Pool, listings: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (!listings.length) return result
  const keys = [...new Set(listings.map((listing) => listing.trim().toUpperCase()))]
  const found = await db.query(
    `SELECT l.channel_sku, s.sku_code
     FROM oms_listings l
     JOIN oms_skus s ON s.oms_sku_id = l.oms_sku_id
     WHERE UPPER(TRIM(l.channel_sku)) = ANY($1::text[]) AND s.sku_code <> ''`,
    [keys],
  )
  for (const listing of listings) {
    const target = normalizeSkuKey(listing)
    const codes = new Set<string>()
    for (const row of found.rows) {
      if (normalizeSkuKey(String(row.channel_sku)) === target) codes.add(String(row.sku_code))
    }
    result.set(listing, [...codes])
  }
  return result
}

export type ImportProgressEvent = {
  phase: "init" | "staging" | "batch_pause" | "finalizing" | "complete"
  batchIndex: number
  totalBatches: number
  processedRows: number
  totalRows: number
  percent: number
  message: string
}

export type LookupCommitInput = {
  marketplaceName: string
  filename: string
  uploadedBy: number
  uploadedLabel: string
  // Every parsed row of the file, valid or not. All of them are kept in upload_rows.
  rows: ParsedRow[]
  images: Map<string, string>
  sources: Map<string, ProductSource>
  batchSize?: number
  pauseMs?: number
  onProgress?: (event: ImportProgressEvent) => Promise<void> | void
}

export type LookupCommitResult = {
  batchId: number
  activatedRows: number
  scannableRows: number
  pendingRows: number
  rejectedRows: number
  supersededRows: number
  cancelledRows: number
}

type ImportItem = {
  sku: string
  label: string
  qty: number
  colorName: string
  keyDetail: string
  brandLabel: string
  setContents: string
  channelListingId: string
  // The real channel order line. Empty for Ajio and Amazon, which have none.
  orderLineId: string
  // What the register shows as Order Item ID, and what kind of identifier it is.
  displayOrderItemId: string
  displayIdentifierKind: DisplayIdentifierKind
  imageUrl: string
  source: ProductSource
  identifier: string
  identifierKind: MarketplaceSkuIdentifierKind
  sourceLineNo: number
  rowFingerprint: string
  returnEventId: string
  shipmentId: string
}

type ImportGroup = { header: ParsedRow; partner: PartnerMatch | undefined; items: ImportItem[] }

const ROW_CHUNK = 400
const CANCEL_CHUNK = 500

// One group per tracking ID. One item per counted row. Rows are never summed, so each row keeps its own quantity,
// order line, return event and source line.
function groupReturns(
  rows: ParsedRow[],
  images: Map<string, string>,
  sources: Map<string, ProductSource>,
  partners: Map<ParsedRow, PartnerMatch>,
): Map<string, ImportGroup> {
  const groups = new Map<string, ImportGroup>()
  for (const row of rows) {
    if (!isScannableRow(row)) continue
    let group = groups.get(row.trackingId)
    if (!group) {
      group = { header: row, partner: partners.get(row), items: [] }
      groups.set(row.trackingId, group)
    }
    group.items.push({
      sku: row.sku,
      label: row.productName,
      qty: row.qty,
      colorName: row.colorName,
      keyDetail: row.keyDetail,
      brandLabel: row.brandLabel,
      setContents: row.setContents,
      channelListingId: row.channelListingId,
      orderLineId: row.orderLineId || "",
      displayOrderItemId: row.displayOrderItemId || row.orderLineId || "",
      displayIdentifierKind: row.displayIdentifierKind || "",
      imageUrl: images.get(row.channelListingId) || "",
      source: sources.get(row.channelListingId) || "unresolved",
      identifier: identifierFor(row),
      identifierKind: row.marketplaceSkuIdentifierKind || "",
      sourceLineNo: row.sourceLineNo ?? 0,
      rowFingerprint: row.rowFingerprint ?? "",
      returnEventId: row.returnEventId ?? "",
      shipmentId: row.shipmentId || "",
    })
  }
  return groups
}

async function insertUploadRows(
  client: pg.PoolClient,
  batchId: number,
  marketplaceId: number,
  rows: ParsedRow[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += ROW_CHUNK) {
    const chunk = rows.slice(start, start + ROW_CHUNK)
    const values: unknown[] = [batchId, marketplaceId]
    const placeholders = chunk.map((row, index) => {
      const base = values.length
      values.push(
        start + index + 1,
        row.trackingId,
        row.csvTrackingId ?? "",
        row.orderId,
        row.valid,
        rowStatus(row),
        row.error,
        JSON.stringify(row.raw ?? {}),
        row.warnings.join("; "),
        row.duplicateKind ?? "",
        row.rowFingerprint ?? "",
        row.sourceLineNo ?? null,
      )
      const at = (offset: number) => `$${base + offset}`
      return `($1, $2, ${at(1)}, ${at(2)}, ${at(3)}, ${at(4)}, ${at(5)}, ${at(6)}, ${at(7)}, ${at(8)}, ${at(9)}, ${at(10)}, ${at(11)}, ${at(12)})`
    })
    await client.query(
      `INSERT INTO upload_rows
        (upload_batch_id, marketplace_id, line_no, tracking_id, source_tracking_id, order_id, valid, row_status, error, row_data,
         warnings, duplicate_kind, row_fingerprint, source_line_no)
       VALUES ${placeholders.join(", ")}`,
      values,
    )
  }
}

// Writes the new lookup rows with status 'staging'. They become visible only when the activation step runs.
async function stageGroups(
  client: pg.PoolClient,
  batchId: number,
  marketplaceId: number,
  marketplaceName: string,
  groups: Map<string, ImportGroup>,
  batchSize: number = 500,
  pauseMs: number = 0,
  onProgress?: (event: ImportProgressEvent) => Promise<void> | void,
): Promise<void> {
  const totalItems = [...groups.values()].reduce((sum, g) => sum + g.items.length, 0)
  const effectiveBatchSize = batchSize > 0 ? batchSize : 500
  const totalBatches = Math.max(1, Math.ceil(totalItems / effectiveBatchSize))
  let processedItems = 0
  let currentBatch = 1

  if (onProgress) {
    await onProgress({
      phase: "staging",
      batchIndex: 1,
      totalBatches,
      processedRows: 0,
      totalRows: totalItems,
      percent: 5,
      message: `Starting batch 1 of ${totalBatches} (${Math.min(effectiveBatchSize, totalItems)} rows)...`,
    })
  }

  for (const [trackingId, group] of groups) {
    const first = group.header
    const partner = group.partner
    const courier = await client.query(
      `INSERT INTO couriers (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [first.courier || "—"],
    )
    const expected = await client.query(
      `INSERT INTO expected_returns
        (tracking_id, marketplace_id, order_number, courier_id, return_type, matched_from, product_title,
         upload_batch_id, alt_tracking_id, return_reason, lookup_status,
         return_type_raw, tracking_source, csv_tracking_id, tracking_url, url_tracking_id, tracking_validation,
         identifier_source, forward_tracking_id, return_event_id, carrier_from_link,
         logistics_partner_id, logistic_partner_name, partner_detection_method, partner_confidence, partner_source_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'staging',
               $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
       RETURNING id`,
      [
        trackingId,
        marketplaceId,
        first.orderId || "—",
        courier.rows[0].id,
        first.returnType,
        `Matched from ${marketplaceName} data uploaded for batch ${batchId}`,
        first.productName,
        batchId,
        first.altTrackingId || null,
        first.returnReason || null,
        first.returnTypeRaw ?? "",
        first.trackingSource ?? "tracking_id",
        first.csvTrackingId ?? trackingId,
        first.trackingUrl || "",
        first.urlTrackingId || "",
        first.trackingValidation ?? "not_applicable",
        first.identifierSource ?? "csv_awb",
        first.forwardTrackingId || "",
        first.returnEventId || "",
        first.carrierFromLink || "",
        partner?.partnerId ?? null,
        partner?.name ?? "Unknown / Pending Verification",
        partner?.method ?? "none",
        partner?.confidence ?? "none",
        partner?.sourceValue ?? first.carrierValue ?? "",
      ],
    )
    const expectedId = Number(expected.rows[0].id)
    for (const [index, item] of group.items.entries()) {
      const sku = await client.query(
        `INSERT INTO skus (code, name, color_name, color_hex, key_detail, brand_label, set_contents, image_url, brand_badge)
         VALUES ($1, $2, $3, '', $4, $5, $6, $7, '')
         ON CONFLICT (code) DO UPDATE SET
          name = EXCLUDED.name,
          color_name = EXCLUDED.color_name,
          key_detail = EXCLUDED.key_detail,
          brand_label = EXCLUDED.brand_label,
          set_contents = EXCLUDED.set_contents,
          image_url = CASE WHEN EXCLUDED.image_url <> '' THEN EXCLUDED.image_url ELSE skus.image_url END
         RETURNING id`,
        [item.sku, item.label, item.colorName, item.keyDetail, item.brandLabel, item.setContents, item.imageUrl],
      )
      await client.query(
        `INSERT INTO expected_return_items
          (expected_return_id, sku_id, qty, sort_order, label, order_line_id, channel_listing_id,
           product_sku_source, marketplace_sku_identifier, marketplace_sku_identifier_kind,
           display_order_item_id, display_identifier_kind, source_line_no, row_fingerprint, shipment_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          expectedId,
          Number(sku.rows[0].id),
          item.qty,
          index,
          item.label,
          item.orderLineId || null,
          item.channelListingId || null,
          item.source,
          item.identifier || null,
          item.identifierKind,
          item.displayOrderItemId || null,
          item.displayIdentifierKind,
          item.sourceLineNo || null,
          item.rowFingerprint || null,
          item.shipmentId || "",
        ],
      )
    }

    processedItems += group.items.length
    if (processedItems >= currentBatch * effectiveBatchSize && currentBatch < totalBatches) {
      if (onProgress) {
        const percent = Math.min(88, Math.round((processedItems / totalItems) * 85))
        await onProgress({
          phase: "batch_pause",
          batchIndex: currentBatch,
          totalBatches,
          processedRows: processedItems,
          totalRows: totalItems,
          percent,
          message: `Batch ${currentBatch} of ${totalBatches} complete (${processedItems.toLocaleString()} / ${totalItems.toLocaleString()} rows). Pausing 1s for database integrity...`,
        })
      }
      if (pauseMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs))
      }
      currentBatch++
      if (onProgress) {
        await onProgress({
          phase: "staging",
          batchIndex: currentBatch,
          totalBatches,
          processedRows: processedItems,
          totalRows: totalItems,
          percent: Math.min(88, Math.round((processedItems / totalItems) * 85)),
          message: `Staging batch ${currentBatch} of ${totalBatches}...`,
        })
      }
    }
  }

  if (onProgress) {
    await onProgress({
      phase: "finalizing",
      batchIndex: totalBatches,
      totalBatches,
      processedRows: totalItems,
      totalRows: totalItems,
      percent: 92,
      message: `All ${totalItems.toLocaleString()} rows staged across ${totalBatches} batches. Committing active lookup...`,
    })
  }
}

async function replaceCancelled(
  client: pg.PoolClient,
  marketplaceId: number,
  batchId: number,
  rows: ParsedRow[],
): Promise<void> {
  // Cancelled rows are not scans, so this marketplace's set is replaced in full, within the same transaction.
  await client.query("DELETE FROM cancelled_returns WHERE marketplace_id = $1", [marketplaceId])
  for (let start = 0; start < rows.length; start += CANCEL_CHUNK) {
    const chunk = rows.slice(start, start + CANCEL_CHUNK)
    const values: unknown[] = [marketplaceId, batchId]
    const placeholders = chunk.map((row) => {
      const base = values.length
      values.push(row.orderId || "—", row.orderLineId, row.channelListingId || null, row.qty, row.returnType, row.returnReason)
      return `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $2)`
    })
    await client.query(
      `INSERT INTO cancelled_returns
        (marketplace_id, order_number, order_line_id, channel_listing_id, qty, return_type, reason, upload_batch_id)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (marketplace_id, order_line_id) DO NOTHING`,
      values,
    )
  }
}

// Commits one validated upload for one account. Steps, all in one transaction:
//  1. Insert the batch, its raw rows, and the new lookup rows with status 'staging'.
//  2. Replace the cancelled rows for the account.
//  3. Mark the account's previously active lookup rows 'superseded' (they stay, because scans refer to them).
//  4. Mark the new rows 'active'.
// Any failure rolls everything back, so the previous active lookup data is never left missing.
export async function commitLookupUpload(db: pg.Pool, input: LookupCommitInput): Promise<LookupCommitResult> {
  const scannable = input.rows.filter(isScannableRow)
  if (!scannable.length) throw new Error("No scannable rows to import")
  const cancelledRows = input.rows.filter((row) => row.valid && row.cancelled)
  const pendingCount = input.rows.filter((row) => row.valid && !isScannableRow(row) && !row.cancelled && !row.duplicate).length
  const rejectedCount = input.rows.filter((row) => !row.valid).length
  const status = pendingCount || rejectedCount ? `${scannable.length} active; ${pendingCount} pending; ${rejectedCount} rejected` : "Imported"
  const detectedFormat = input.rows[0]?.profileId ?? ""
  const duplicateRows = input.rows.filter((row) => row.duplicate).length

  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const lockSeconds = Math.max(30, Math.ceil((input.rows.length / 500) * ((input.pauseMs ?? 0) / 1000) + 30))
    await client.query(`SET LOCAL lock_timeout = '${lockSeconds}s'`)
    const marketplace = await client.query("SELECT id FROM marketplaces WHERE name = $1", [input.marketplaceName])
    const marketplaceId = marketplace.rows[0] ? Number(marketplace.rows[0].id) : 0
    if (!marketplaceId) throw new Error("Select a connected marketplace before importing")

    // Two uploads for one account cannot interleave their activation steps.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`lookup:${marketplaceId}`])

    const partners = await applyPartners(client as unknown as Queryable, input.rows, input.marketplaceName)

    const batch = await client.query(
      `INSERT INTO upload_batches
        (filename, marketplace_id, row_count, uploaded_label, status, detected_format,
         scannable_row_count, pending_row_count, rejected_row_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input.filename,
        marketplaceId,
        input.rows.length,
        input.uploadedLabel,
        pendingCount || rejectedCount ? "Imported with exceptions" : "Imported",
        detectedFormat,
        scannable.length,
        pendingCount,
        rejectedCount,
      ],
    )
    const batchId = Number(batch.rows[0].id)

    const groups = groupReturns(scannable, input.images, input.sources, partners)
    await insertUploadRows(client, batchId, marketplaceId, input.rows)
    await stageGroups(
      client,
      batchId,
      marketplaceId,
      input.marketplaceName,
      groups,
      input.batchSize ?? 500,
      input.pauseMs ?? 0,
      input.onProgress,
    )
    await replaceCancelled(client, marketplaceId, batchId, cancelledRows)

    const superseded = await client.query(
      `UPDATE expected_returns SET lookup_status = 'superseded'
       WHERE marketplace_id = $1 AND lookup_status = 'active'
       RETURNING id`,
      [marketplaceId],
    )
    const activated = await client.query(
      `UPDATE expected_returns SET lookup_status = 'active'
       WHERE marketplace_id = $1 AND upload_batch_id = $2 AND lookup_status = 'staging'
       RETURNING id`,
      [marketplaceId, batchId],
    )
    await client.query(
      `UPDATE upload_batches SET status = 'Replaced'
       WHERE marketplace_id = $1 AND id <> $2 AND status <> 'Replaced'`,
      [marketplaceId, batchId],
    )

    const result: LookupCommitResult = {
      batchId,
      activatedRows: activated.rowCount ?? 0,
      scannableRows: scannable.length,
      pendingRows: pendingCount,
      rejectedRows: rejectedCount,
      supersededRows: superseded.rowCount ?? 0,
      cancelledRows: cancelledRows.length,
    }
    await client.query(
      `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'lookup.activate', 'upload_batch', $2, $3::jsonb)`,
      [
        input.uploadedBy,
        String(batchId),
        JSON.stringify({
          marketplace: input.marketplaceName,
          format: detectedFormat,
          activatedRows: result.activatedRows,
          scannableRows: result.scannableRows,
          pendingRows: result.pendingRows,
          rejectedRows: result.rejectedRows,
          supersededRows: result.supersededRows,
          cancelledRows: result.cancelledRows,
          exactDuplicateRows: duplicateRows,
        }),
      ],
    )
    await client.query("COMMIT")
    if (input.onProgress) {
      const effectiveBatchSize = (input.batchSize ?? 500) > 0 ? (input.batchSize ?? 500) : 500
      const totalBatches = Math.max(1, Math.ceil(scannable.length / effectiveBatchSize))
      await input.onProgress({
        phase: "complete",
        batchIndex: totalBatches,
        totalBatches,
        processedRows: scannable.length,
        totalRows: scannable.length,
        percent: 100,
        message: `Successfully activated ${scannable.length.toLocaleString()} lookup rows.`,
      })
    }
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
