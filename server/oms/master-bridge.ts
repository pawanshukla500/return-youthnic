// Nightly OMSGuru listing→product-master bridge (a step of server/scripts/sync-oms-catalog.ts).
//
// Reads only already-synced tables (oms_listings joined to oms_skus on oms_sku_id) plus the channel
// list the sync script already fetched: zero new OMSGuru API calls, no credentials touched. In one
// transaction it (a) inserts new product_master mappings, (b) fills blank product_master images
// from listing images, and (c) flips matching unmapped_listing_skus rows to mapped. On error the
// transaction rolls back and product_master is untouched.
//
// A channel whose labels do not map to exactly one account is skipped and counted, never guessed:
// anything containing "myntra" is ambiguous (VB vs EJ) and maps to nothing.
//
// Synthetic-tested only (server/tests/oms-master-bridge.test.ts). No live API, no database tests.

import type pg from "pg"

export type BridgeChannel = { id: number; name: string; channel_name: string }

export type BridgeResult = {
  inserted: number
  imageFilled: number
  skippedChannels: { id: number; label: string }[]
}

// OMSGuru channel labels to the exact account names in server/reference-data.ts: Amazon, Flipkart,
// Meesho, Myntra VB, Myntra EJ, Ajio, Shopify. Case-insensitive whole-word match on channel_name
// first, then name. Anything containing "myntra" is ambiguous (VB vs EJ) and returns null, as does
// anything unknown. Null means skipped and counted.
export function marketplaceForChannel(channelName: string, name: string): string | null {
  const primary = (channelName ?? "").trim()
  const secondary = (name ?? "").trim()
  if (/myntra/i.test(primary) || /myntra/i.test(secondary)) return null
  for (const label of [primary, secondary]) {
    if (!label) continue
    if (/\bamazon\b/i.test(label)) return "Amazon"
    if (/\bflipkart\b/i.test(label)) return "Flipkart"
    if (/\bmeesho\b/i.test(label)) return "Meesho"
    if (/\bajio\b/i.test(label)) return "Ajio"
    if (/\bshopify\b/i.test(label)) return "Shopify"
  }
  return null
}

function channelLabel(channel: BridgeChannel): string {
  const channelName = (channel.channel_name ?? "").trim()
  const name = (channel.name ?? "").trim()
  if (channelName && name && channelName.toLowerCase() !== name.toLowerCase()) {
    return `${channelName} / ${name}`
  }
  return channelName || name || `Channel ${channel.id}`
}

// New mappings only: a mapped listing (non-null oms_sku_id) with a non-blank channel SKU and master
// SKU. Blank listing images are kept as '' so a valuable new mapping is never dropped for want of
// an image. Existing (marketplace, listing_sku) rows are left alone.
const INSERT_BRIDGED_SQL = `
  INSERT INTO product_master (marketplace, listing_sku, master_sku, category, cogs, weight_slab, image_url, updated_at)
  SELECT $1, l.channel_sku, s.sku_code, NULL, NULL, NULL, COALESCE(l.image_url, ''), now()
  FROM oms_listings l
  JOIN oms_skus s ON s.oms_sku_id = l.oms_sku_id
  WHERE l.channel_company_id = $2
    AND l.oms_sku_id IS NOT NULL
    AND btrim(COALESCE(l.channel_sku, '')) <> ''
    AND btrim(COALESCE(s.sku_code, '')) <> ''
  ON CONFLICT (marketplace, listing_sku) DO NOTHING`

// Image append: a blank product_master image takes the listing image, a stored image is never
// overwritten by a blank (the same CASE-style guard as server/oms/catalog.ts).
const FILL_IMAGES_SQL = `
  UPDATE product_master pm
  SET image_url = l.image_url,
      updated_at = now()
  FROM oms_listings l
  JOIN oms_skus s ON s.oms_sku_id = l.oms_sku_id
  WHERE l.channel_company_id = $2
    AND l.oms_sku_id IS NOT NULL
    AND btrim(COALESCE(l.channel_sku, '')) <> ''
    AND btrim(COALESCE(s.sku_code, '')) <> ''
    AND pm.marketplace = $1
    AND LOWER(pm.listing_sku) = LOWER(l.channel_sku)
    AND COALESCE(pm.image_url, '') = ''
    AND COALESCE(l.image_url, '') <> ''`

// Same flip as server/product-master.ts: resolve the unmapped queue against the master.
const FLIP_UNMAPPED_SQL = `
  UPDATE unmapped_listing_skus u
  SET status = 'mapped'
  FROM product_master pm
  WHERE u.status = 'unmapped'
    AND LOWER(pm.listing_sku) = LOWER(u.listing_sku)`

// Inserts new mappings, fills blank images, then flips the unmapped queue, all in one transaction.
export async function bridgeMasterMappings(
  db: pg.Pool,
  channels: BridgeChannel[],
): Promise<BridgeResult> {
  const skippedChannels: BridgeResult["skippedChannels"] = []
  const mapped: { marketplace: string; id: number }[] = []
  for (const channel of channels) {
    const marketplace = marketplaceForChannel(channel.channel_name ?? "", channel.name ?? "")
    if (!marketplace) skippedChannels.push({ id: channel.id, label: channelLabel(channel) })
    else mapped.push({ marketplace, id: channel.id })
  }
  let inserted = 0
  let imageFilled = 0
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    for (const { marketplace, id } of mapped) {
      const added = await client.query(INSERT_BRIDGED_SQL, [marketplace, id])
      inserted += added.rowCount ?? 0
    }
    for (const { marketplace, id } of mapped) {
      const filled = await client.query(FILL_IMAGES_SQL, [marketplace, id])
      imageFilled += filled.rowCount ?? 0
    }
    await client.query(FLIP_UNMAPPED_SQL)
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
  return { inserted, imageFilled, skippedChannels }
}
