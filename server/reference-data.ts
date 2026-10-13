import type pg from "pg"

// Marketplace channels the app works with. These are reference rows, not sample data: uploads and scans
// find a channel by name. Each start adds any that are missing and never changes a row that exists.
const CHANNELS = [
  ["AMZ", "Amazon", "Upload only"],
  ["FLIP", "Flipkart", "Upload only"],
  ["MEES", "Meesho", "Upload only"],
  ["MYVB", "Myntra VB", "Upload only"],
  ["MYEJ", "Myntra EJ", "Upload only"],
  ["AJIO", "Ajio", "Upload only"],
  ["SHOP", "Shopify", "Real-time sync"],
] as const

export async function ensureReferenceData(db: pg.Pool) {
  for (const [index, [code, name, status]] of CHANNELS.entries()) {
    await db.query(
      `INSERT INTO marketplaces (code, name, status, last_synced_label, sort_order)
       VALUES ($1, $2, $3, '', $4)
       ON CONFLICT (name) DO UPDATE SET
         status = CASE WHEN marketplaces.name = 'Shopify' THEN 'Real-time sync' ELSE marketplaces.status END`,
      [code, name, status, index + 1],
    )
  }
}
