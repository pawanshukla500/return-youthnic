import type pg from "pg"
import { queryShopifyReadOnly, shopifyDatabaseUrl } from "./db.js"
import { masterSkusForListings } from "../lookup-import.js"
import { formatScanTime } from "../format.js"

export type SyncShopifyResult = {
  ok: boolean
  returnsSynced: number
  rtosSynced: number
  totalActive: number
  error?: string
  lastSyncedAt: string
}

export type RawShopifyReturn = {
  return_id: number
  order_id: number
  shopify_return_id: string | null
  return_reason: string | null
  return_status: string
  return_waybill: string | null
  forward_waybill: string | null
  carrier: string | null
  return_created_at: Date
  return_updated_at: Date
  order_name: string
  customer_name: string
  customer_phone: string | null
  customer_city: string | null
  total_amount: number | null
}

export type RawShopifyReturnItem = {
  return_id: number
  order_item_id: number
  quantity: number
  sku: string | null
  title: string
  price: number
  image_url: string | null
}

export type RawShopifyRto = {
  shipment_id: number
  order_id: number
  waybill_number: string | null
  courier: string | null
  shipment_status: string
  tracking_status: string | null
  rto_updated_at: Date
  shipment_created_at: Date
  order_name: string
  customer_name: string
  customer_phone: string | null
  customer_city: string | null
  rto_risk_reason: string | null
  order_status: string
  total_amount: number | null
}

export type RawShopifyOrderItem = {
  order_id: number
  order_item_id: number
  sku: string | null
  title: string
  quantity: number
  price: number
  image_url: string | null
}

/**
 * Fetches returns and RTOs from the external Shopify database (strictly READ-ONLY)
 * and synchronizes them into expected_returns in the local warehouse scan register.
 */
export async function syncShopifyReturns(db: pg.Pool): Promise<SyncShopifyResult> {
  if (!shopifyDatabaseUrl()) {
    return {
      ok: false,
      returnsSynced: 0,
      rtosSynced: 0,
      totalActive: 0,
      error: "SHOPIFY_DATABASE_URL is not configured in .env",
      lastSyncedAt: "",
    }
  }

  const syncRun = await db.query<{ id: number }>(
    `INSERT INTO shopify_sync_runs (status) VALUES ('running') RETURNING id`,
  )
  const runId = syncRun.rows[0].id

  try {
    // 1. Ensure Shopify marketplace channel exists
    const marketRes = await db.query<{ id: number }>(
      `SELECT id FROM marketplaces WHERE name = 'Shopify' LIMIT 1`,
    )
    if (!marketRes.rows.length) {
      throw new Error("Shopify marketplace channel is not initialized in reference data.")
    }
    const marketplaceId = marketRes.rows[0].id

    // 2. Look up Delhivery logistics partner
    const partnerRes = await db.query<{ id: number; name: string }>(
      `SELECT id, name FROM logistics_partners WHERE name ILIKE '%Delhivery%' LIMIT 1`,
    )
    const partnerId = partnerRes.rows[0]?.id ?? null
    const partnerName = partnerRes.rows[0]?.name ?? "Delhivery"

    // 3. Ensure courier record for Delhivery
    const courierRes = await db.query<{ id: number }>(
      `INSERT INTO couriers (name) VALUES ('Delhivery')
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
    )
    const courierId = courierRes.rows[0].id

    // 4. Fetch Returns from Shopify database (READ ONLY)
    const returnsRes = await queryShopifyReadOnly<RawShopifyReturn>(`
      SELECT 
        r.id as return_id,
        r."orderId" as order_id,
        r."shopifyReturnId" as shopify_return_id,
        r."returnReason" as return_reason,
        r."returnStatus" as return_status,
        r."returnWaybillNumber" as return_waybill,
        r."forwardWaybill" as forward_waybill,
        r.carrier,
        r."createdAt" as return_created_at,
        r."updatedAt" as return_updated_at,
        o."shopifyOrderName" as order_name,
        o."customerName" as customer_name,
        o."customerPhone" as customer_phone,
        o."customerCity" as customer_city,
        o."totalAmount" as total_amount
      FROM "Return" r
      JOIN "Order" o ON r."orderId" = o.id
      ORDER BY r."createdAt" DESC;
    `)

    // Fetch items for returns
    const returnItemsRes = await queryShopifyReadOnly<RawShopifyReturnItem>(`
      SELECT 
        ri."returnId" as return_id,
        ri.quantity,
        oi.id as order_item_id,
        oi.sku,
        oi.title,
        oi.price,
        oi."imageUrl" as image_url
      FROM "ReturnItem" ri
      JOIN "OrderItem" oi ON ri."orderItemId" = oi.id;
    `)

    const returnItemsByReturnId = new Map<number, RawShopifyReturnItem[]>()
    for (const item of returnItemsRes.rows) {
      const list = returnItemsByReturnId.get(item.return_id) || []
      list.push(item)
      returnItemsByReturnId.set(item.return_id, list)
    }

    // 5. Fetch RTOs from Shopify database (READ ONLY)
    const rtoRes = await queryShopifyReadOnly<RawShopifyRto>(`
      SELECT 
        s.id as shipment_id,
        s."orderId" as order_id,
        s."waybillNumber" as waybill_number,
        s.courier,
        s.status as shipment_status,
        s."trackingStatus" as tracking_status,
        s."updatedAt" as rto_updated_at,
        s."createdAt" as shipment_created_at,
        o."shopifyOrderName" as order_name,
        o."customerName" as customer_name,
        o."customerPhone" as customer_phone,
        o."customerCity" as customer_city,
        o."rtoRiskReason" as rto_risk_reason,
        o.status as order_status,
        o."totalAmount" as total_amount
      FROM "Shipment" s
      JOIN "Order" o ON s."orderId" = o.id
      WHERE s.status IN ('RTO', 'RTO_DELIVERED') OR o.status IN ('RTO_INITIATED', 'RTO_DELIVERED')
      ORDER BY s."updatedAt" DESC;
    `)

    const rtoOrderIds = [...new Set(rtoRes.rows.map((r) => r.order_id))]
    let rtoOrderItems: RawShopifyOrderItem[] = []
    if (rtoOrderIds.length > 0) {
      const itemsRes = await queryShopifyReadOnly<RawShopifyOrderItem>(
        `
        SELECT 
          oi."orderId" as order_id,
          oi.id as order_item_id,
          oi.sku,
          oi.title,
          oi.quantity,
          oi.price,
          oi."imageUrl" as image_url
        FROM "OrderItem" oi
        WHERE oi."orderId" = ANY($1::int[]);
      `,
        [rtoOrderIds],
      )
      rtoOrderItems = itemsRes.rows
    }

    const orderItemsByOrderId = new Map<number, RawShopifyOrderItem[]>()
    for (const item of rtoOrderItems) {
      const list = orderItemsByOrderId.get(item.order_id) || []
      list.push(item)
      orderItemsByOrderId.set(item.order_id, list)
    }

    // Collect all SKUs to resolve against product_master
    const allListingSkus = new Set<string>()
    for (const item of returnItemsRes.rows) {
      if (item.sku?.trim()) allListingSkus.add(item.sku.trim())
    }
    for (const item of rtoOrderItems) {
      if (item.sku?.trim()) allListingSkus.add(item.sku.trim())
    }

    const skuPairs = [...allListingSkus].map((listing) => ({ listing, marketplace: "shopify" }))
    const resolvedProductSkus = await masterSkusForListings(db, skuPairs)

    let returnsSyncedCount = 0
    let rtosSyncedCount = 0

    // Begin local transaction for upserting into return-scan_youthnic
    const client = await db.connect()
    try {
      await client.query("BEGIN")

      // 6. Ingest Customer Returns
      for (const ret of returnsRes.rows) {
        const trackingId = (ret.return_waybill?.trim() || ret.forward_waybill?.trim() || "").trim()
        if (!trackingId) continue

        const items = returnItemsByReturnId.get(ret.return_id) || []
        const primaryTitle = items[0]?.title || `Shopify Return ${ret.order_name}`
        const reason = ret.return_reason || "Customer Return"
        const isCancelled = ret.return_status === "CANCELLED"
        const lookupStatus = isCancelled ? "superseded" : "active"

        // Check if existing active return exists for this tracking ID and account
        const existing = await client.query<{ id: number; lookup_status: string }>(
          `SELECT id, lookup_status FROM expected_returns 
           WHERE marketplace_id = $1 AND tracking_id = $2 
           ORDER BY id DESC LIMIT 1`,
          [marketplaceId, trackingId],
        )

        let expectedReturnId: number

        if (existing.rows.length > 0) {
          expectedReturnId = existing.rows[0].id
          await client.query(
            `UPDATE expected_returns SET
               order_number = $1,
               alt_tracking_id = COALESCE($2, alt_tracking_id),
               return_reason = $3,
               product_title = $4,
               customer_city = $5,
               customer_phone = $6,
               shopify_order_name = $7,
               shopify_return_id = $8,
               shopify_synced_at = now(),
               lookup_status = CASE WHEN $9 = 'superseded' THEN 'superseded' ELSE lookup_status END
             WHERE id = $10`,
            [
              ret.order_name,
              ret.forward_waybill?.trim() || null,
              reason,
              primaryTitle,
              ret.customer_city || null,
              ret.customer_phone || null,
              ret.order_name,
              String(ret.return_id),
              lookupStatus,
              expectedReturnId,
            ],
          )
        } else {
          const insertRes = await client.query<{ id: number }>(
            `INSERT INTO expected_returns
              (tracking_id, marketplace_id, order_number, courier_id, return_type, matched_from,
               product_title, alt_tracking_id, return_reason, lookup_status, return_type_raw,
               tracking_source, csv_tracking_id, tracking_url, url_tracking_id, tracking_validation,
               identifier_source, forward_tracking_id, return_event_id, carrier_from_link,
               logistics_partner_id, logistic_partner_name, partner_detection_method, partner_confidence, partner_source_value,
               shopify_order_id, shopify_return_id, shopify_order_name, customer_city, customer_phone, shopify_synced_at)
             VALUES
              ($1, $2, $3, $4, 'Customer Return', 'Shopify real-time automated sync',
               $5, $6, $7, $8, $9,
               'return_tracking', $10, '', '', 'match',
               'csv_awb', $11, $12, '',
               $13, $14, 'explicit_carrier', 'verified', 'Delhivery',
               $15, $16, $17, $18, $19, now())
             RETURNING id`,
            [
              trackingId,
              marketplaceId,
              ret.order_name,
              courierId,
              primaryTitle,
              ret.forward_waybill?.trim() || null,
              reason,
              lookupStatus,
              ret.return_status,
              trackingId,
              ret.forward_waybill?.trim() || "",
              String(ret.return_id),
              partnerId,
              partnerName,
              String(ret.order_id),
              String(ret.return_id),
              ret.order_name,
              ret.customer_city || null,
              ret.customer_phone || null,
            ],
          )
          expectedReturnId = insertRes.rows[0].id

          // Insert items
          for (const [idx, item] of items.entries()) {
            const listingSku = item.sku?.trim() || `SHOP-${item.order_item_id}`
            const resolved = resolvedProductSkus.get(`shopify|${listingSku}`)
            const imageUrl = resolved?.imageUrl || item.image_url || ""

            const skuRow = await client.query<{ id: number }>(
              `INSERT INTO skus (code, name, color_name, color_hex, key_detail, brand_label, set_contents, image_url, brand_badge)
               VALUES ($1, $2, '', '', '', 'Youthnic', '', $3, '')
               ON CONFLICT (code) DO UPDATE SET
                 name = EXCLUDED.name,
                 image_url = CASE WHEN EXCLUDED.image_url <> '' THEN EXCLUDED.image_url ELSE skus.image_url END
               RETURNING id`,
              [listingSku, item.title, imageUrl],
            )

            await client.query(
              `INSERT INTO expected_return_items
                (expected_return_id, sku_id, qty, sort_order, label, order_line_id, channel_listing_id,
                 product_sku_source, marketplace_sku_identifier, marketplace_sku_identifier_kind,
                 display_order_item_id, display_identifier_kind, source_line_no, row_fingerprint, shipment_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
               ON CONFLICT DO NOTHING`,
              [
                expectedReturnId,
                skuRow.rows[0].id,
                item.quantity || 1,
                idx,
                item.title,
                String(item.order_item_id),
                listingSku,
                resolved ? "product_master" : "unresolved",
                listingSku,
                "",
                String(item.order_item_id),
                "order_line",
                idx + 1,
                `shopify-ret-${ret.return_id}-${item.order_item_id}`,
                "",
              ],
            )
          }
        }
        returnsSyncedCount++
      }

      // 7. Ingest RTO Shipments
      for (const rto of rtoRes.rows) {
        const trackingId = (rto.waybill_number || "").trim()
        if (!trackingId) continue

        const items = orderItemsByOrderId.get(rto.order_id) || []
        const primaryTitle = items[0]?.title || `Shopify RTO ${rto.order_name}`
        const reason = rto.rto_risk_reason || rto.tracking_status || "Courier Return (RTO)"

        const existing = await client.query<{ id: number }>(
          `SELECT id FROM expected_returns 
           WHERE marketplace_id = $1 AND tracking_id = $2 
           ORDER BY id DESC LIMIT 1`,
          [marketplaceId, trackingId],
        )

        let expectedReturnId: number

        if (existing.rows.length > 0) {
          expectedReturnId = existing.rows[0].id
          await client.query(
            `UPDATE expected_returns SET
               order_number = $1,
               return_reason = $2,
               product_title = $3,
               customer_city = $4,
               customer_phone = $5,
               shopify_order_name = $6,
               shopify_synced_at = now()
             WHERE id = $7`,
            [
              rto.order_name,
              reason,
              primaryTitle,
              rto.customer_city || null,
              rto.customer_phone || null,
              rto.order_name,
              expectedReturnId,
            ],
          )
        } else {
          const insertRes = await client.query<{ id: number }>(
            `INSERT INTO expected_returns
              (tracking_id, marketplace_id, order_number, courier_id, return_type, matched_from,
               product_title, alt_tracking_id, return_reason, lookup_status, return_type_raw,
               tracking_source, csv_tracking_id, tracking_url, url_tracking_id, tracking_validation,
               identifier_source, forward_tracking_id, return_event_id, carrier_from_link,
               logistics_partner_id, logistic_partner_name, partner_detection_method, partner_confidence, partner_source_value,
               shopify_order_id, shopify_return_id, shopify_order_name, customer_city, customer_phone, shopify_synced_at)
             VALUES
              ($1, $2, $3, $4, 'RTO', 'Shopify real-time automated sync',
               $5, null, $6, 'active', $7,
               'tracking_id', $8, '', '', 'match',
               'csv_awb', '', '', '',
               $9, $10, 'explicit_carrier', 'verified', 'Delhivery',
               $11, null, $12, $13, $14, now())
             RETURNING id`,
            [
              trackingId,
              marketplaceId,
              rto.order_name,
              courierId,
              primaryTitle,
              reason,
              rto.shipment_status,
              trackingId,
              partnerId,
              partnerName,
              String(rto.order_id),
              rto.order_name,
              rto.customer_city || null,
              rto.customer_phone || null,
            ],
          )
          expectedReturnId = insertRes.rows[0].id

          // Insert items
          for (const [idx, item] of items.entries()) {
            const listingSku = item.sku?.trim() || `SHOP-${item.order_item_id}`
            const resolved = resolvedProductSkus.get(`shopify|${listingSku}`)
            const imageUrl = resolved?.imageUrl || item.image_url || ""

            const skuRow = await client.query<{ id: number }>(
              `INSERT INTO skus (code, name, color_name, color_hex, key_detail, brand_label, set_contents, image_url, brand_badge)
               VALUES ($1, $2, '', '', '', 'Youthnic', '', $3, '')
               ON CONFLICT (code) DO UPDATE SET
                 name = EXCLUDED.name,
                 image_url = CASE WHEN EXCLUDED.image_url <> '' THEN EXCLUDED.image_url ELSE skus.image_url END
               RETURNING id`,
              [listingSku, item.title, imageUrl],
            )

            await client.query(
              `INSERT INTO expected_return_items
                (expected_return_id, sku_id, qty, sort_order, label, order_line_id, channel_listing_id,
                 product_sku_source, marketplace_sku_identifier, marketplace_sku_identifier_kind,
                 display_order_item_id, display_identifier_kind, source_line_no, row_fingerprint, shipment_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
               ON CONFLICT DO NOTHING`,
              [
                expectedReturnId,
                skuRow.rows[0].id,
                item.quantity || 1,
                idx,
                item.title,
                String(item.order_item_id),
                listingSku,
                resolved ? "product_master" : "unresolved",
                listingSku,
                "",
                String(item.order_item_id),
                "order_line",
                idx + 1,
                `shopify-rto-${rto.order_id}-${item.order_item_id}`,
                "",
              ],
            )
          }
        }
        rtosSyncedCount++
      }

      // Count total active scannable returns for Shopify
      const activeRes = await client.query<{ count: string }>(
        `SELECT count(*)::text as count FROM expected_returns 
         WHERE marketplace_id = $1 AND lookup_status = 'active'`,
        [marketplaceId],
      )
      const totalActive = Number(activeRes.rows[0]?.count ?? 0)

      const syncLabel = `Synced ${formatScanTime(new Date())}`
      await client.query(
        `UPDATE marketplaces 
         SET last_synced_label = $1, status = 'Real-time sync' 
         WHERE id = $2`,
        [syncLabel, marketplaceId],
      )

      await client.query(
        `UPDATE shopify_sync_runs SET
           completed_at = now(),
           status = 'success',
           returns_synced = $1,
           rtos_synced = $2,
           total_active = $3
         WHERE id = $4`,
        [returnsSyncedCount, rtosSyncedCount, totalActive, runId],
      )

      await client.query("COMMIT")

      return {
        ok: true,
        returnsSynced: returnsSyncedCount,
        rtosSynced: rtosSyncedCount,
        totalActive,
        lastSyncedAt: syncLabel,
      }
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    const errorMsg = (err as Error).message
    await db.query(
      `UPDATE shopify_sync_runs SET
         completed_at = now(),
         status = 'failed',
         error_message = $1
       WHERE id = $2`,
      [errorMsg, runId],
    )
    return {
      ok: false,
      returnsSynced: 0,
      rtosSynced: 0,
      totalActive: 0,
      error: errorMsg,
      lastSyncedAt: "",
    }
  }
}
