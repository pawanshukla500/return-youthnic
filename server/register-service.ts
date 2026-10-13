// Return scan register: lookup, scan recording, tickets, the register list and its export.
//
// Every write runs in one PostgreSQL transaction. Every function takes the pool it should use, so tests can run
// against a dedicated database. A scan is identified by a client key, so a retry returns the first result and never
// creates a second scan. Concurrent saves for one AWB are serialized by an advisory lock, and the unique indexes
// are the final guard.
//
// Every read and write also takes the user's account scope (server/access.ts). A return, ticket or scan outside the
// scope is reported as not found, and a named account outside the scope is refused with 403.

import type pg from "pg"
import { istDay } from "./dates.js"
import { formatCount, formatDay, formatScanTime, headerDateLabel, percentOf } from "./format.js"
import { masterSkusForListings } from "./lookup-import.js"
import {
  ALL_ACCOUNTS,
  NO_ACCESS_MESSAGE,
  accountCondition,
  accountListParam,
  allowsAccount,
  type AccountScope,
} from "./access.js"
import {
  TICKET_STATUSES,
  decideLookup,
  describeIssues,
  isValidClientKey,
  legFor,
  matchedFieldFor,
  mapRegisterRow,
  normalizeTicketCode,
  normalizeTracking,
  productSkuFor,
  productSkuSourceFor,
  registerCsv,
  scanStatusFor,
  ticketStatusError,
  validateScanSubmission,
  type CategoryRule,
  type IssuePart,
  type LookupEntry,
  type LookupItemRule,
  type RawRegisterRow,
  type RegisterRow,
  type ScanSubmission,
  type SubIssueRule,
} from "./register-rules.js"

export class ServiceError extends Error {
  status: number
  details: string[]
  extra: Record<string, unknown>

  constructor(status: number, message: string, options: { details?: string[]; extra?: Record<string, unknown> } = {}) {
    super(message)
    this.status = status
    this.details = options.details || []
    this.extra = options.extra || {}
  }
}

export type Actor = { id: number; name: string }

async function withClient<T>(db: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    return await work(client)
  } finally {
    client.release()
  }
}

export async function writeAudit(
  client: pg.PoolClient,
  actorId: number,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actorId, action, entityType, entityId, JSON.stringify(details)],
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Accounts, shift and workspace figures
// ---------------------------------------------------------------------------------------------------------------

// The accounts this scope may use, in the order the register shows them.
export async function accessibleAccounts(db: pg.Pool, scope: AccountScope): Promise<{ id: number; name: string }[]> {
  return withClient(db, async (client) => {
    const params: unknown[] = []
    const condition = accountCondition(scope, "m.id", params)
    const result = await client.query(
      `SELECT m.id, m.name FROM marketplaces m WHERE ${condition} ORDER BY m.sort_order, m.id`,
      params,
    )
    return result.rows.map((row) => ({ id: Number(row.id), name: String(row.name) }))
  })
}

export type ShiftCounts = { scanned: number; correct: number; issues: number }

async function shiftCounts(client: pg.PoolClient, scope: AccountScope): Promise<ShiftCounts> {
  const params: unknown[] = []
  const condition = accountCondition(scope, "er.marketplace_id", params)
  const result = await client.query(
    `SELECT COUNT(*)::int AS scanned,
            (COUNT(*) FILTER (WHERE rs.outcome = 'clear'))::int AS correct,
            (COUNT(*) FILTER (WHERE rs.outcome = 'issue'))::int AS issues
     FROM receipt_scans rs
     JOIN expected_returns er ON er.id = rs.expected_return_id
     WHERE (rs.scanned_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
       AND ${condition}`,
    params,
  )
  const row = result.rows[0]
  return { scanned: Number(row.scanned), correct: Number(row.correct), issues: Number(row.issues) }
}

export function presentShift(shift: ShiftCounts) {
  return {
    scanned: formatCount(shift.scanned),
    correct: formatCount(shift.correct),
    issues: formatCount(shift.issues),
    // The clear rate of today's scans. The shift has no target, so the progress stays at zero.
    accuracy: percentOf(shift.correct, shift.scanned),
    progress: 0,
    targetLabel: "No daily target set",
  }
}

// The header date and the claims badge. A ticket that is approved or rejected is no longer open.
export async function workspaceUi(
  db: pg.Pool,
  scope: AccountScope = ALL_ACCOUNTS,
): Promise<{ headerDate: string; claimsBadge: string }> {
  return withClient(db, async (client) => {
    const params: unknown[] = []
    const condition = accountCondition(scope, "er.marketplace_id", params)
    const result = await client.query(
      `SELECT COUNT(*)::int AS open_claims
       FROM claim_tickets ct
       JOIN receipt_scans rs ON rs.id = ct.receipt_scan_id
       JOIN expected_returns er ON er.id = rs.expected_return_id
       WHERE ct.status NOT IN ('Approved', 'Rejected') AND ${condition}`,
      params,
    )
    return { headerDate: headerDateLabel(), claimsBadge: String(result.rows[0].open_claims) }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Reference rules (issue categories and sub-issues)
// ---------------------------------------------------------------------------------------------------------------

async function loadCategoryRules(client: pg.PoolClient): Promise<CategoryRule[]> {
  const result = await client.query(
    `SELECT code, label, is_clear, is_missing, requires_ticket, allows_sub_issue, requires_sub_issue, active
     FROM receipt_issue_categories
     ORDER BY sort_order, code`,
  )
  return result.rows.map((row) => ({
    code: String(row.code),
    label: String(row.label),
    isClear: Boolean(row.is_clear),
    isMissing: Boolean(row.is_missing),
    requiresTicket: Boolean(row.requires_ticket),
    allowsSubIssue: Boolean(row.allows_sub_issue),
    requiresSubIssue: Boolean(row.requires_sub_issue),
    active: Boolean(row.active),
  }))
}

async function loadSubIssueRules(client: pg.PoolClient): Promise<SubIssueRule[]> {
  const result = await client.query(
    "SELECT id, label, category_code, active FROM missing_component_options ORDER BY sort_order, id",
  )
  return result.rows.map((row) => ({
    id: Number(row.id),
    label: String(row.label),
    categoryCode: String(row.category_code),
    active: Boolean(row.active),
  }))
}

export async function scanSession(db: pg.Pool, scope: AccountScope = ALL_ACCOUNTS) {
  return withClient(db, async (client) => {
    const [shift, categories, subIssues] = await Promise.all([
      shiftCounts(client, scope),
      loadCategoryRules(client),
      loadSubIssueRules(client),
    ])
    const accountParams: unknown[] = []
    const accountSql = accountCondition(scope, "m.id", accountParams)
    const accounts = await client.query(
      `SELECT m.id, m.name FROM marketplaces m WHERE ${accountSql} ORDER BY m.sort_order, m.id`,
      accountParams,
    )
    return {
      shift: presentShift(shift),
      accounts: accounts.rows.map((row) => ({ id: Number(row.id), name: String(row.name) })),
      issueCategories: categories
        .filter((category) => category.active)
        .map((category) => ({
          code: category.code,
          label: category.label,
          isClear: category.isClear,
          isMissing: category.isMissing,
          requiresTicket: category.requiresTicket,
          allowsSubIssue: category.allowsSubIssue,
          requiresSubIssue: category.requiresSubIssue,
        })),
      subIssues: subIssues
        .filter((sub) => sub.active)
        .map((sub) => ({ id: sub.id, label: sub.label, categoryCode: sub.categoryCode })),
    }
  })
}

export async function listCategories(db: pg.Pool) {
  const result = await db.query(
    `SELECT code, label, is_clear, is_missing, requires_ticket, allows_sub_issue, requires_sub_issue, active, sort_order
     FROM receipt_issue_categories
     ORDER BY sort_order, code`,
  )
  return result.rows.map((row) => ({
    code: String(row.code),
    label: String(row.label),
    isClear: Boolean(row.is_clear),
    isMissing: Boolean(row.is_missing),
    requiresTicket: Boolean(row.requires_ticket),
    allowsSubIssue: Boolean(row.allows_sub_issue),
    requiresSubIssue: Boolean(row.requires_sub_issue),
    active: Boolean(row.active),
  }))
}

// Only the on/off switches and the ticket requirement can change. The rule flags that shape a submission are fixed.
export async function updateCategory(
  db: pg.Pool,
  actor: Actor,
  code: string,
  changes: { active?: boolean; requiresTicket?: boolean },
) {
  return withClient(db, async (client) => {
    await client.query("BEGIN")
    try {
      const result = await client.query(
        `UPDATE receipt_issue_categories
         SET active = COALESCE($2::boolean, active),
             requires_ticket = COALESCE($3::boolean, requires_ticket)
         WHERE code = $1
         RETURNING code, label, active, requires_ticket`,
        [code, changes.active ?? null, changes.requiresTicket ?? null],
      )
      const row = result.rows[0]
      if (!row) throw new ServiceError(404, "That issue category does not exist.")
      await writeAudit(client, actor.id, "issue_category.update", "issue_category", code, { ...changes })
      await client.query("COMMIT")
      return {
        code: String(row.code),
        label: String(row.label),
        active: Boolean(row.active),
        requiresTicket: Boolean(row.requires_ticket),
      }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------------------------------------------

export type LookupShipmentItem = {
  itemId: number
  // What the register shows as Order Item ID: the display identifier when there is one, otherwise the order line.
  orderItemId: string
  displayIdentifierKind: string
  marketplaceSku: string
  productSku: string
  productSkuSource: string
  marketplaceSkuIdentifier: string
  marketplaceSkuIdentifierKind: string
  productName: string
  expectedQty: number
  imageUrl: string
  colorName: string
  keyDetail: string
  brandLabel: string
  setContents: string
  shipmentId: string
}

export type LookupShipment = {
  shipmentId: number
  // The lookup AWB (the resolved tracking ID).
  trackingId: string
  // The AWB exactly as the upload file wrote it, and the AWB read from a verified link ('' when there is none).
  csvTrackingId: string
  urlTrackingId: string
  altTrackingId: string
  forwardTrackingId: string
  returnEventId: string
  trackingSource: string
  trackingValidation: string
  // The AWB the employee scanned, and which stored AWB and leg it matched.
  scannedTracking: string
  matchedTrackingField: string
  matchedLeg: string
  marketplace: string
  marketplaceId: number
  orderId: string
  courier: string
  logisticPartner: string
  partnerMethod: string
  returnType: string
  returnTypeRaw: string
  returnReason: string
  matchedFrom: string
  sourceFile: string
  sourceBatchId: number | null
  productTitle: string
  itemSummary: string
  isMulti: boolean
  items: LookupShipmentItem[]
}

export type LookupResponse =
  | { status: "found"; trackingId: string; shipment: LookupShipment }
  | { status: "duplicate"; trackingId: string; marketplace: string; time: string; scannedBy: string }
  | { status: "choose"; trackingId: string; candidates: LookupEntry[] }
  | { status: "not_found"; trackingId: string }

// $4 is the account list (null for every account). It is applied in SQL, so a restricted user never sees another
// account's return.
const ACTIVE_MATCH_SQL = `
  SELECT er.id, er.tracking_id, er.alt_tracking_id, er.order_number, m.id AS marketplace_id, m.name AS marketplace,
         (SELECT COUNT(*)::int FROM expected_return_items eri WHERE eri.expected_return_id = er.id) AS item_count
  FROM expected_returns er
  JOIN marketplaces m ON m.id = er.marketplace_id
  WHERE er.lookup_status = 'active'
    AND (
      er.tracking_id = $1::text
      OR er.alt_tracking_id = $1::text
      OR UPPER(er.order_number) = UPPER($1::text)
      OR EXISTS (
        SELECT 1 FROM expected_return_items eri
        WHERE eri.expected_return_id = er.id
          AND (UPPER(eri.display_order_item_id) = UPPER($1::text) OR UPPER(eri.order_line_id) = UPPER($1::text))
      )
    )
    AND ($2::text = '' OR m.name = $2::text)
    AND ($3::integer IS NULL OR er.id = $3::integer)
    AND ($4::integer[] IS NULL OR m.id = ANY($4::integer[]))
  ORDER BY m.sort_order, m.id, er.id`

// $3 is the account list. A duplicate is reported only for an account the user may see.
const SCAN_MATCH_SQL = `
  SELECT rs.id AS scan_id, rs.scanned_time_label, scanner.name AS scanned_by, m.id AS marketplace_id, m.name AS marketplace
  FROM receipt_scans rs
  JOIN expected_returns er ON er.id = rs.expected_return_id
  JOIN marketplaces m ON m.id = er.marketplace_id
  JOIN users scanner ON scanner.id = rs.scanned_by
  WHERE (
      er.tracking_id = $1::text
      OR er.alt_tracking_id = $1::text
      OR UPPER(er.order_number) = UPPER($1::text)
      OR EXISTS (
        SELECT 1 FROM expected_return_items eri
        WHERE eri.expected_return_id = er.id
          AND (UPPER(eri.display_order_item_id) = UPPER($1::text) OR UPPER(eri.order_line_id) = UPPER($1::text))
      )
    )
    AND ($2::text = '' OR m.name = $2::text)
    AND ($3::integer[] IS NULL OR m.id = ANY($3::integer[]))
  ORDER BY rs.scanned_at DESC`

const SHIPMENT_HEADER_SQL = `
  SELECT er.id, er.tracking_id, er.alt_tracking_id, er.order_number, er.return_type, er.return_type_raw,
         er.return_reason, er.matched_from, er.product_title, er.lookup_status, er.tracking_source,
         er.tracking_validation, er.csv_tracking_id, er.url_tracking_id, er.forward_tracking_id, er.return_event_id,
         er.logistic_partner_name, er.partner_detection_method, er.upload_batch_id, c.name AS courier,
         (SELECT b.filename FROM upload_batches b WHERE b.id = er.upload_batch_id) AS source_filename,
         m.id AS marketplace_id, m.name AS marketplace
  FROM expected_returns er
  JOIN marketplaces m ON m.id = er.marketplace_id
  JOIN couriers c ON c.id = er.courier_id
  WHERE er.id = $1`

const ITEMS_SQL = `
  SELECT eri.id, eri.qty, eri.label, eri.order_line_id, eri.display_order_item_id, eri.display_identifier_kind,
         eri.channel_listing_id, eri.product_sku_source, eri.marketplace_sku_identifier,
         eri.marketplace_sku_identifier_kind, eri.source_line_no, eri.row_fingerprint,
         COALESCE(eri.shipment_id, '') AS shipment_id,
         s.code, s.name, s.image_url, s.color_name, s.key_detail, s.brand_label, s.set_contents
  FROM expected_return_items eri
  JOIN skus s ON s.id = eri.sku_id
  WHERE eri.expected_return_id = $1
  ORDER BY eri.sort_order, eri.id`

// The display identifier is shown when it exists. Old rows that predate display_order_item_id fall back to the order line.
function displayItemOf(row: Record<string, unknown>): string {
  return String(row.display_order_item_id || row.order_line_id || "")
}

async function loadShipmentDetail(client: pg.PoolClient, shipmentId: number, scanned: string): Promise<LookupShipment> {
  const header = (await client.query(SHIPMENT_HEADER_SQL, [shipmentId])).rows[0]
  if (!header) throw new ServiceError(404, "Return not found")
  const itemRows = (await client.query(ITEMS_SQL, [shipmentId])).rows
  const items: LookupShipmentItem[] = itemRows.map((row) => ({
    itemId: Number(row.id),
    orderItemId: displayItemOf(row),
    displayIdentifierKind: String(row.display_identifier_kind || ""),
    marketplaceSku: String(row.channel_listing_id || ""),
    productSku: productSkuFor(row.product_sku_source, String(row.code)),
    productSkuSource: productSkuSourceFor(row.product_sku_source),
    marketplaceSkuIdentifier: String(row.marketplace_sku_identifier || ""),
    marketplaceSkuIdentifierKind: String(row.marketplace_sku_identifier_kind || ""),
    productName: String(row.label || row.name || ""),
    expectedQty: Number(row.qty),
    imageUrl: String(row.image_url || ""),
    colorName: String(row.color_name || ""),
    keyDetail: String(row.key_detail || ""),
    brandLabel: String(row.brand_label || ""),
    setContents: String(row.set_contents || ""),
    shipmentId: String(row.shipment_id || ""),
  }))
  const needsMaster = items.filter((item) => item.marketplaceSku && (!item.productSku || !item.imageUrl))
  if (needsMaster.length) {
    const masters = await masterSkusForListings(
      client,
      needsMaster.map((item) => ({ listing: item.marketplaceSku, marketplace: String(header.marketplace) })),
    )
    for (const item of needsMaster) {
      const hit = masters.get(`${String(header.marketplace).toLowerCase()}|${item.marketplaceSku}`)
      if (!hit) continue
      if (!item.productSku) {
        item.productSku = hit.masterSku
        item.productSkuSource = "product_master"
      }
      if (!item.imageUrl && hit.imageUrl) item.imageUrl = hit.imageUrl
    }
  }
  const units = items.reduce((sum, item) => sum + item.expectedQty, 0)
  const itemOrderIds = itemRows
    .flatMap((r) => [String(r.display_order_item_id || ""), String(r.order_line_id || "")])
    .filter(Boolean)
  const matched = matchedFieldFor(
    scanned,
    String(header.tracking_id),
    header.alt_tracking_id,
    header.tracking_source,
    header.order_number ? String(header.order_number) : null,
    itemOrderIds,
  )
  return {
    shipmentId,
    trackingId: String(header.tracking_id),
    csvTrackingId: String(header.csv_tracking_id || header.tracking_id),
    urlTrackingId: String(header.url_tracking_id || ""),
    altTrackingId: String(header.alt_tracking_id || ""),
    forwardTrackingId: String(header.forward_tracking_id || ""),
    returnEventId: String(header.return_event_id || ""),
    trackingSource: String(header.tracking_source || "tracking_id"),
    trackingValidation: String(header.tracking_validation || "not_applicable"),
    scannedTracking: scanned,
    matchedTrackingField: matched.field,
    matchedLeg: matched.leg,
    marketplace: String(header.marketplace),
    marketplaceId: Number(header.marketplace_id),
    orderId: String(header.order_number),
    courier: String(header.courier),
    logisticPartner: String(header.logistic_partner_name || "Unknown / Pending Verification"),
    partnerMethod: String(header.partner_detection_method || "none"),
    returnType: String(header.return_type),
    returnTypeRaw: String(header.return_type_raw || ""),
    returnReason: String(header.return_reason || ""),
    matchedFrom: String(header.matched_from || ""),
    sourceFile: String(header.source_filename || ""),
    sourceBatchId: header.upload_batch_id === null ? null : Number(header.upload_batch_id),
    productTitle: String(header.product_title || ""),
    itemSummary: `${items.length} ${items.length === 1 ? "item" : "items"} · ${units} qty`,
    isMulti: items.length > 1 || units > 1,
    items,
  }
}

export type LookupInput = { tracking: string; marketplace: string; shipmentId: number | null }

// Finds the return for an AWB. The result is one of: found (one shipment, nothing received yet), duplicate (already
// received), choose (several matches, so the employee picks one), or not_found. Nothing is picked silently.
export async function lookupShipment(
  db: pg.Pool,
  input: LookupInput,
  scope: AccountScope = ALL_ACCOUNTS,
  actor?: Actor,
): Promise<LookupResponse> {
  const normalized = normalizeTracking(input.tracking)
  if (normalized.error) throw new ServiceError(400, normalized.error)
  const tracking = normalized.value
  const marketplace = input.marketplace && input.marketplace !== "Auto detect" ? input.marketplace : ""

  return withClient(db, async (client) => {
    if (marketplace) {
      const named = (await client.query("SELECT id FROM marketplaces WHERE name = $1", [marketplace])).rows[0]
      if (named && !allowsAccount(scope, Number(named.id))) throw new ServiceError(403, NO_ACCESS_MESSAGE)
    }
    const accountIds = accountListParam(scope)
    const active = await client.query(ACTIVE_MATCH_SQL, [tracking, marketplace, input.shipmentId, accountIds])
    const scans = await client.query(SCAN_MATCH_SQL, [tracking, marketplace, accountIds])

    const entries: LookupEntry[] = []
    for (const row of active.rows) {
      const prior = scans.rows.find((scan) => Number(scan.marketplace_id) === Number(row.marketplace_id))
      entries.push({
        shipmentId: Number(row.id),
        accountId: Number(row.marketplace_id),
        accountName: String(row.marketplace),
        alreadyReceived: Boolean(prior),
        orderId: String(row.order_number),
        itemCount: Number(row.item_count),
        receivedAt: prior ? String(prior.scanned_time_label) : "",
        scannedBy: prior ? String(prior.scanned_by) : "",
      })
    }
    // An account that received this AWB but no longer has it in its active lookup data is still a match. It is
    // reported as already received, so it can never be scanned again by accident.
    if (input.shipmentId === null) {
      const covered = new Set(entries.map((entry) => entry.accountId))
      for (const scan of scans.rows) {
        const accountId = Number(scan.marketplace_id)
        if (covered.has(accountId)) continue
        covered.add(accountId)
        entries.push({
          shipmentId: null,
          accountId,
          accountName: String(scan.marketplace),
          alreadyReceived: true,
          orderId: "",
          itemCount: 0,
          receivedAt: String(scan.scanned_time_label),
          scannedBy: String(scan.scanned_by),
        })
      }
    }

    const decision = decideLookup(entries)
    if (decision.kind === "none") {
      if (actor) {
        await writeAudit(client, actor.id, "scan.unmatched_lookup", "expected_return", tracking, {
          tracking,
          marketplace,
        })
      }
      return { status: "not_found", trackingId: tracking }
    }
    if (decision.kind === "duplicate") {
      if (actor) {
        await writeAudit(client, actor.id, "scan.duplicate_attempt", "expected_return", tracking, {
          tracking,
          marketplace: decision.entry.accountName,
          scannedBy: decision.entry.scannedBy,
        })
      }
      return {
        status: "duplicate",
        trackingId: tracking,
        marketplace: decision.entry.accountName,
        time: decision.entry.receivedAt,
        scannedBy: decision.entry.scannedBy,
      }
    }
    if (decision.kind === "choose") return { status: "choose", trackingId: tracking, candidates: decision.entries }
    const shipmentId = decision.entry.shipmentId
    if (shipmentId === null) return { status: "not_found", trackingId: tracking }
    return { status: "found", trackingId: tracking, shipment: await loadShipmentDetail(client, shipmentId, tracking) }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Recording a scan
// ---------------------------------------------------------------------------------------------------------------

export type RecordInput = {
  submission: ScanSubmission
  photoCount: number
  hasVideo: boolean
}

export type ScanReceipt = {
  replayed: boolean
  scan: {
    id: number
    scannedAt: string
    timeLabel: string
    status: string
    marketplace: string
    trackingId: string
    originalTrackingId: string
    urlTrackingId: string
    orderId: string
    scannedTracking: string
    matchedTrackingField: string
    matchedLeg: string
    logisticPartner: string
    sourceFile: string
    sourceBatchId: number | null
  }
  itemCount: number
  issueCount: number
  shift: ReturnType<typeof presentShift>
  claimsBadge: string
}

const SHIPMENT_FOR_SCAN_SQL = `
  SELECT er.id, er.marketplace_id, er.tracking_id, er.alt_tracking_id, er.order_number, er.return_type,
         er.return_type_raw, er.return_reason, er.lookup_status, er.tracking_source, er.tracking_validation,
         er.csv_tracking_id, er.url_tracking_id, er.forward_tracking_id, er.return_event_id,
         er.logistic_partner_name, er.partner_detection_method, er.partner_source_value, er.upload_batch_id,
         (SELECT b.filename FROM upload_batches b WHERE b.id = er.upload_batch_id) AS source_filename,
         m.name AS marketplace
  FROM expected_returns er
  JOIN marketplaces m ON m.id = er.marketplace_id
  WHERE er.id = $1`

const SCAN_BY_KEY_SQL = `
  SELECT rs.id AS scan_id, rs.expected_return_id AS shipment_id
  FROM receipt_scans rs
  WHERE rs.client_scan_key = $1`

const PRIOR_SCAN_SQL = `
  SELECT rs.scanned_time_label, scanner.name AS scanned_by
  FROM receipt_scans rs
  JOIN expected_returns er2 ON er2.id = rs.expected_return_id
  JOIN users scanner ON scanner.id = rs.scanned_by
  WHERE er2.marketplace_id = $1
    AND (er2.tracking_id = ANY($2::text[]) OR er2.alt_tracking_id = ANY($2::text[]))
  ORDER BY rs.scanned_at DESC
  LIMIT 1`

async function findScanByKey(db: pg.Pool, key: string): Promise<{ scanId: number; shipmentId: number } | null> {
  return withClient(db, async (client) => {
    const result = await client.query(SCAN_BY_KEY_SQL, [key])
    const row = result.rows[0]
    return row ? { scanId: Number(row.scan_id), shipmentId: Number(row.shipment_id) } : null
  })
}

// The marketplace of the account a scan belongs to. Used to refuse a replayed key that belongs to another account.
async function marketplaceOfScan(db: pg.Pool, scanId: number): Promise<number | null> {
  return withClient(db, async (client) => {
    const row = (
      await client.query(
        `SELECT er.marketplace_id FROM receipt_scans rs
         JOIN expected_returns er ON er.id = rs.expected_return_id WHERE rs.id = $1`,
        [scanId],
      )
    ).rows[0]
    return row ? Number(row.marketplace_id) : null
  })
}

async function loadReceipt(db: pg.Pool, scanId: number, replayed: boolean, scope: AccountScope): Promise<ScanReceipt> {
  const scan = await withClient(db, async (client) => {
    const result = await client.query(
      `SELECT rs.id, rs.scanned_at, rs.scanned_time_label, rs.status, m.name AS marketplace,
              COALESCE(rs.tracking_id_snapshot, er.tracking_id) AS tracking_id,
              COALESCE(NULLIF(rs.csv_tracking_snapshot, ''), rs.tracking_id_snapshot, er.tracking_id) AS csv_tracking,
              rs.url_tracking_snapshot AS url_tracking,
              COALESCE(rs.order_number_snapshot, er.order_number) AS order_number,
              rs.scanned_tracking, rs.matched_tracking_field, rs.matched_leg, rs.logistic_partner_snapshot,
              rs.source_filename_snapshot AS source_filename, rs.source_batch_id,
              (SELECT COUNT(*)::int FROM receipt_scan_items x WHERE x.receipt_scan_id = rs.id) AS item_count,
              (SELECT COUNT(*)::int FROM receipt_scan_issues y
                 JOIN receipt_scan_items x ON x.id = y.receipt_scan_item_id
                WHERE x.receipt_scan_id = rs.id) AS issue_count
       FROM receipt_scans rs
       JOIN expected_returns er ON er.id = rs.expected_return_id
       JOIN marketplaces m ON m.id = er.marketplace_id
       WHERE rs.id = $1`,
      [scanId],
    )
    return result.rows[0]
  })
  if (!scan) throw new ServiceError(404, "Scan not found")
  const ui = await workspaceUi(db, scope)
  const shift = await withClient(db, (client) => shiftCounts(client, scope))
  return {
    replayed,
    scan: {
      id: Number(scan.id),
      scannedAt: new Date(scan.scanned_at).toISOString(),
      timeLabel: String(scan.scanned_time_label),
      status: String(scan.status),
      marketplace: String(scan.marketplace),
      trackingId: String(scan.tracking_id),
      originalTrackingId: String(scan.csv_tracking || scan.tracking_id),
      urlTrackingId: String(scan.url_tracking || ""),
      orderId: String(scan.order_number),
      scannedTracking: String(scan.scanned_tracking || ""),
      matchedTrackingField: String(scan.matched_tracking_field || ""),
      matchedLeg: String(scan.matched_leg || "unknown"),
      logisticPartner: String(scan.logistic_partner_snapshot || "Unknown / Pending Verification"),
      sourceFile: String(scan.source_filename || ""),
      sourceBatchId: scan.source_batch_id === null ? null : Number(scan.source_batch_id),
    },
    itemCount: Number(scan.item_count),
    issueCount: Number(scan.issue_count),
    shift: presentShift(shift),
    claimsBadge: ui.claimsBadge,
  }
}

// Saves one physical scan of one return, with every expected line verified.
//  - A repeated client key returns the original scan (replayed: true). It never creates a second scan.
//  - An AWB that was already received in the same account is refused, with the time and the scanner.
//  - Ticket IDs must be new. A ticket is created with status Raised and its first history row.
//  - The scanned AWB is compared with the stored AWB and leg, and the result is saved with the scan, together with the
//    original file AWB, the link AWB, the tracking source, the forward AWB, the return event, the source file and the
//    import batch. None of these changes after the scan, even when a later upload replaces the lookup data.
export async function recordScan(
  db: pg.Pool,
  actor: Actor,
  input: RecordInput,
  scope: AccountScope = ALL_ACCOUNTS,
): Promise<ScanReceipt> {
  const submission = input.submission
  if (!Number.isInteger(submission.shipmentId) || submission.shipmentId < 1) {
    throw new ServiceError(400, "Choose a return to save.")
  }
  if (!isValidClientKey(submission.clientScanKey)) {
    throw new ServiceError(400, "The scan key is missing or malformed.")
  }
  const scannedTracking = submission.scannedTracking ? normalizeTracking(submission.scannedTracking).value : ""

  const earlier = await findScanByKey(db, submission.clientScanKey)
  if (earlier) {
    if (earlier.shipmentId !== submission.shipmentId) {
      throw new ServiceError(409, "This scan key was already used for another return.")
    }
    const account = await marketplaceOfScan(db, earlier.scanId)
    if (account === null || !allowsAccount(scope, account)) throw new ServiceError(404, "Return not found")
    return loadReceipt(db, earlier.scanId, true, scope)
  }

  const client = await db.connect()
  let open = false
  try {
    await client.query("BEGIN")
    open = true
    await client.query("SET LOCAL lock_timeout = '15s'")

    const shipment = (await client.query(SHIPMENT_FOR_SCAN_SQL, [submission.shipmentId])).rows[0]
    if (!shipment || !allowsAccount(scope, Number(shipment.marketplace_id))) {
      throw new ServiceError(404, "Return not found")
    }
    if (shipment.lookup_status !== "active") {
      throw new ServiceError(409, "This return is no longer in the active lookup data. Look it up again.")
    }

    // Serialize saves for one AWB in one account. The second save waits, then sees the first save's result.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `awb:${shipment.marketplace_id}:${shipment.tracking_id}`,
    ])
    const again = (await client.query(SCAN_BY_KEY_SQL, [submission.clientScanKey])).rows[0]
    if (again) {
      await client.query("ROLLBACK")
      open = false
      if (Number(again.shipment_id) !== submission.shipmentId) {
        throw new ServiceError(409, "This scan key was already used for another return.")
      }
      return loadReceipt(db, Number(again.scan_id), true, scope)
    }

    const locked = await client.query("SELECT lookup_status FROM expected_returns WHERE id = $1 FOR UPDATE", [
      submission.shipmentId,
    ])
    if (locked.rows[0]?.lookup_status !== "active") {
      throw new ServiceError(409, "This return is no longer in the active lookup data. Look it up again.")
    }

    const tracked = [shipment.tracking_id, shipment.alt_tracking_id].filter(
      (value): value is string => typeof value === "string" && value !== "",
    )
    const prior = (await client.query(PRIOR_SCAN_SQL, [shipment.marketplace_id, tracked])).rows[0]
    if (prior) {
      throw new ServiceError(409, "This AWB has already been received", {
        extra: { time: String(prior.scanned_time_label), scannedBy: String(prior.scanned_by) },
      })
    }

    const itemRows = (await client.query(ITEMS_SQL, [submission.shipmentId])).rows
    const categories = await loadCategoryRules(client)
    const subIssues = await loadSubIssueRules(client)
    const itemRules: LookupItemRule[] = itemRows.map((row) => ({ id: Number(row.id), expectedQty: Number(row.qty) }))
    const verdict = validateScanSubmission(itemRules, submission, categories, subIssues)
    if (!verdict.ok) {
      throw new ServiceError(400, "The scan is not complete. Fix the items listed below.", { details: verdict.errors })
    }

    const ticketCodes: string[] = []
    for (const item of submission.items) {
      for (const issue of item.issues) {
        const code = normalizeTicketCode(issue.ticketCode)
        if (code) ticketCodes.push(code)
      }
    }
    if (ticketCodes.length) {
      const taken = (
        await client.query("SELECT ticket_code FROM claim_tickets WHERE ticket_code = ANY($1::text[])", [ticketCodes])
      ).rows[0]
      if (taken) {
        throw new ServiceError(409, `The ticket ${String(taken.ticket_code)} is already recorded. Open it in the register.`)
      }
    }

    const categoryByCode = new Map<string, CategoryRule>()
    for (const category of categories) categoryByCode.set(category.code, category)
    const subById = new Map<number, SubIssueRule>()
    for (const sub of subIssues) subById.set(sub.id, sub)
    const submittedById = new Map<number, ScanSubmission["items"][number]>()
    for (const item of submission.items) submittedById.set(item.itemId, item)

    const hasIssue = submission.items.some((item) => item.issues.length > 0)
    const parts: IssuePart[] = []
    for (const item of submission.items) {
      for (const issue of item.issues) {
        const sub = issue.subIssueId === null ? undefined : subById.get(issue.subIssueId)
        parts.push({
          categoryLabel: categoryByCode.get(issue.categoryCode)?.label ?? issue.categoryCode,
          subIssueLabel: sub ? sub.label : "",
          qty: issue.qty,
        })
      }
    }

    const itemOrderIds = itemRows
      .flatMap((r) => [String(r.display_order_item_id || ""), String(r.order_line_id || "")])
      .filter(Boolean)
    const matched = matchedFieldFor(
      scannedTracking,
      String(shipment.tracking_id),
      shipment.alt_tracking_id,
      shipment.tracking_source,
      shipment.order_number ? String(shipment.order_number) : null,
      itemOrderIds,
    )
    const storedTracking = String(shipment.tracking_id)
    const csvTracking = String(shipment.csv_tracking_id || storedTracking)

    const scanInsert = await client.query(
      `INSERT INTO receipt_scans
        (expected_return_id, scanned_by, scanned_at, scanned_time_label, outcome, issue_label, status, notes,
         client_scan_key, tracking_id_snapshot, order_number_snapshot, marketplace_snapshot,
         scanned_tracking, matched_tracking_field, matched_leg, source_batch_id,
         logistic_partner_snapshot, partner_method_snapshot, partner_source_snapshot, tracking_validation_snapshot,
         csv_tracking_snapshot, url_tracking_snapshot, tracking_source_snapshot, forward_tracking_snapshot,
         return_event_snapshot, source_filename_snapshot, return_type_raw_snapshot)
       VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
       RETURNING id`,
      [
        submission.shipmentId,
        actor.id,
        formatScanTime(),
        hasIssue ? "issue" : "clear",
        describeIssues(parts),
        scanStatusFor(hasIssue, ticketCodes.length > 0),
        submission.notes || null,
        submission.clientScanKey,
        storedTracking,
        String(shipment.order_number),
        String(shipment.marketplace),
        scannedTracking,
        matched.field,
        matched.leg,
        shipment.upload_batch_id === null ? null : Number(shipment.upload_batch_id),
        String(shipment.logistic_partner_name || "Unknown / Pending Verification"),
        String(shipment.partner_detection_method || "none"),
        String(shipment.partner_source_value || ""),
        String(shipment.tracking_validation || "not_applicable"),
        csvTracking,
        String(shipment.url_tracking_id || ""),
        String(shipment.tracking_source || "tracking_id"),
        String(shipment.forward_tracking_id || ""),
        String(shipment.return_event_id || ""),
        String(shipment.source_filename || ""),
        String(shipment.return_type_raw || ""),
      ],
    )
    const scanId = Number(scanInsert.rows[0].id)

    let issueCount = 0
    for (const [index, row] of itemRows.entries()) {
      const submitted = submittedById.get(Number(row.id))
      if (!submitted) continue
      const itemInsert = await client.query(
        `INSERT INTO receipt_scan_items
          (receipt_scan_id, expected_return_item_id, line_no, order_item_id, marketplace_sku, product_sku,
           product_sku_source, marketplace_sku_identifier, product_name, return_type, return_reason,
           expected_qty, received_qty, verified, order_line_id, display_identifier_kind,
           marketplace_sku_identifier_kind, return_type_raw, source_line_no, row_fingerprint, shipment_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true, $14, $15, $16, $17, $18, $19, $20)
         RETURNING id`,
        [
          scanId,
          Number(row.id),
          index + 1,
          displayItemOf(row),
          String(row.channel_listing_id || ""),
          productSkuFor(row.product_sku_source, String(row.code)),
          productSkuSourceFor(row.product_sku_source),
          String(row.marketplace_sku_identifier || ""),
          String(row.label || row.name || ""),
          String(shipment.return_type),
          String(shipment.return_reason || ""),
          Number(row.qty),
          submitted.receivedQty,
          String(row.order_line_id || ""),
          String(row.display_identifier_kind || ""),
          String(row.marketplace_sku_identifier_kind || ""),
          String(shipment.return_type_raw || ""),
          row.source_line_no === null ? null : Number(row.source_line_no),
          row.row_fingerprint === null ? null : String(row.row_fingerprint),
          String(row.shipment_id || ""),
        ],
      )
      const itemId = Number(itemInsert.rows[0].id)

      for (const issue of submitted.issues) {
        const code = normalizeTicketCode(issue.ticketCode)
        const sub = issue.subIssueId === null ? undefined : subById.get(issue.subIssueId)
        let ticketId: number | null = null
        if (code) {
          const created = await client.query(
            `INSERT INTO claim_tickets (receipt_scan_id, ticket_code, status, rejection_reason, created_by)
             VALUES ($1, $2, 'Raised', '', $3)
             RETURNING id`,
            [scanId, code, actor.id],
          )
          ticketId = Number(created.rows[0].id)
          await client.query(
            `INSERT INTO claim_ticket_history (claim_ticket_id, from_status, to_status, reason, changed_by)
             VALUES ($1, NULL, 'Raised', 'Created from a return scan', $2)`,
            [ticketId, actor.id],
          )
        }
        await client.query(
          `INSERT INTO receipt_scan_issues
            (receipt_scan_item_id, category_code, category_label, sub_issue_id, sub_issue_label, qty,
             claim_ticket_id, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            itemId,
            issue.categoryCode,
            categoryByCode.get(issue.categoryCode)?.label ?? issue.categoryCode,
            sub ? sub.id : null,
            sub ? sub.label : "",
            issue.qty,
            ticketId,
            issue.notes || "",
            actor.id,
          ],
        )
        issueCount += 1
      }
    }

    await client.query("INSERT INTO evidence_events (receipt_scan_id, photo_count, has_video) VALUES ($1, $2, $3)", [
      scanId,
      Math.max(0, Math.floor(input.photoCount) || 0),
      input.hasVideo,
    ])
    await writeAudit(client, actor.id, "scan.record", "receipt_scan", String(scanId), {
      shipmentId: submission.shipmentId,
      marketplace: String(shipment.marketplace),
      items: itemRows.length,
      issues: issueCount,
      matchedTrackingField: matched.field,
      matchedLeg: matched.leg,
    })
    await client.query("COMMIT")
    open = false
    return loadReceipt(db, scanId, false, scope)
  } catch (error) {
    if (open) await client.query("ROLLBACK")
    const pgError = error as { code?: string; constraint?: string }
    // A concurrent save with the same key won the race. Its result is the answer.
    if (pgError.code === "23505" && pgError.constraint === "receipt_scans_client_scan_key_uidx") {
      const replay = await findScanByKey(db, submission.clientScanKey)
      if (replay && replay.shipmentId === submission.shipmentId) return loadReceipt(db, replay.scanId, true, scope)
    }
    if (pgError.code === "23505" && pgError.constraint === "receipt_scans_expected_return_id_key") {
      throw new ServiceError(409, "This AWB has already been received")
    }
    throw error
  } finally {
    client.release()
  }
}

// Records an issue on a clear scan that was just saved from the bench. The scan row stays. Issue rows are only
// added, and only when the scan is still clear, so a second correction cannot overwrite the first.
export async function correctScanIssue(
  db: pg.Pool,
  actor: Actor,
  submission: ScanSubmission,
  scope: AccountScope = ALL_ACCOUNTS,
): Promise<ScanReceipt> {
  if (!isValidClientKey(submission.clientScanKey)) {
    throw new ServiceError(400, "The scan key is missing or malformed.")
  }
  const found = await findScanByKey(db, submission.clientScanKey)
  if (!found || found.shipmentId !== submission.shipmentId) {
    throw new ServiceError(404, "Return not found")
  }
  const account = await marketplaceOfScan(db, found.scanId)
  if (account === null || !allowsAccount(scope, account)) throw new ServiceError(404, "Return not found")

  const client = await db.connect()
  let open = false
  try {
    await client.query("BEGIN")
    open = true
    const scan = (
      await client.query(
        `SELECT id, outcome, scanned_by FROM receipt_scans WHERE id = $1 FOR UPDATE`,
        [found.scanId],
      )
    ).rows[0]
    if (!scan || Number(scan.scanned_by) !== actor.id) throw new ServiceError(404, "Return not found")

    // Clean up any previously attached claim tickets, history, and scan issues for this scan so issues can be replaced or reverted
    await client.query(
      `DELETE FROM claim_ticket_history WHERE claim_ticket_id IN (SELECT id FROM claim_tickets WHERE receipt_scan_id = $1)`,
      [found.scanId],
    )
    await client.query(`DELETE FROM claim_tickets WHERE receipt_scan_id = $1`, [found.scanId])
    await client.query(
      `DELETE FROM receipt_scan_issues WHERE receipt_scan_item_id IN (SELECT id FROM receipt_scan_items WHERE receipt_scan_id = $1)`,
      [found.scanId],
    )

    const itemRows = (await client.query(ITEMS_SQL, [submission.shipmentId])).rows
    const storedItems = await client.query(
      `SELECT id, expected_return_item_id FROM receipt_scan_items WHERE receipt_scan_id = $1`,
      [found.scanId],
    )
    const scanItemByExpected = new Map<number, number>()
    for (const row of storedItems.rows) scanItemByExpected.set(Number(row.expected_return_item_id), Number(row.id))

    const hasIssues = submission.items.some((item) => item.issues.length > 0)
    if (!hasIssues) {
      // Reverting to normal clear return
      for (const item of itemRows) {
        const scanItemId = scanItemByExpected.get(Number(item.id))
        if (scanItemId) {
          await client.query(`UPDATE receipt_scan_items SET received_qty = $2 WHERE id = $1`, [scanItemId, Number(item.qty)])
        }
      }
      await client.query(
        `UPDATE receipt_scans SET outcome = 'clear', issue_label = '', status = 'Clear' WHERE id = $1`,
        [found.scanId],
      )
      await writeAudit(client, actor.id, "scan.revert_clear", "receipt_scan", String(found.scanId), {
        shipmentId: submission.shipmentId,
      })
      await client.query("COMMIT")
      open = false
      return loadReceipt(db, found.scanId, false, scope)
    }

    const categories = await loadCategoryRules(client)
    const subIssues = await loadSubIssueRules(client)
    const itemRules: LookupItemRule[] = itemRows.map((row) => ({ id: Number(row.id), expectedQty: Number(row.qty) }))
    const verdict = validateScanSubmission(itemRules, submission, categories, subIssues)
    if (!verdict.ok) {
      throw new ServiceError(400, "The scan is not complete. Fix the items listed below.", { details: verdict.errors })
    }

    const categoryByCode = new Map<string, CategoryRule>()
    for (const category of categories) categoryByCode.set(category.code, category)
    const subById = new Map<number, SubIssueRule>()
    for (const sub of subIssues) subById.set(sub.id, sub)

    const parts: IssuePart[] = []
    const ticketCodes: string[] = []
    for (const item of submission.items) {
      const scanItemId = scanItemByExpected.get(item.itemId)
      if (!scanItemId) throw new ServiceError(400, "The scan is not complete. Fix the items listed below.")
      await client.query(`UPDATE receipt_scan_items SET received_qty = $2 WHERE id = $1`, [scanItemId, item.receivedQty])
      for (const issue of item.issues) {
        const sub = issue.subIssueId === null ? undefined : subById.get(issue.subIssueId)
        parts.push({
          categoryLabel: categoryByCode.get(issue.categoryCode)?.label ?? issue.categoryCode,
          subIssueLabel: sub ? sub.label : "",
          qty: issue.qty,
        })
        const code = normalizeTicketCode(issue.ticketCode)
        let ticketId: number | null = null
        if (code) {
          ticketCodes.push(code)
          const created = await client.query(
            `INSERT INTO claim_tickets (receipt_scan_id, ticket_code, status, rejection_reason, created_by)
             VALUES ($1, $2, 'Raised', '', $3)
             RETURNING id`,
            [found.scanId, code, actor.id],
          )
          ticketId = Number(created.rows[0].id)
          await client.query(
            `INSERT INTO claim_ticket_history (claim_ticket_id, from_status, to_status, reason, changed_by)
             VALUES ($1, NULL, 'Raised', 'Created from a return scan', $2)`,
            [ticketId, actor.id],
          )
        }
        await client.query(
          `INSERT INTO receipt_scan_issues
            (receipt_scan_item_id, category_code, category_label, sub_issue_id, sub_issue_label, qty,
             claim_ticket_id, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            scanItemId,
            issue.categoryCode,
            categoryByCode.get(issue.categoryCode)?.label ?? issue.categoryCode,
            sub ? sub.id : null,
            sub ? sub.label : "",
            issue.qty,
            ticketId,
            issue.notes || "",
            actor.id,
          ],
        )
      }
    }

    await client.query(
      `UPDATE receipt_scans SET outcome = 'issue', issue_label = $2, status = $3 WHERE id = $1`,
      [found.scanId, describeIssues(parts), scanStatusFor(true, ticketCodes.length > 0)],
    )
    await writeAudit(client, actor.id, "scan.correct", "receipt_scan", String(found.scanId), {
      shipmentId: submission.shipmentId,
      issues: parts.length,
    })
    await client.query("COMMIT")
    open = false
    return loadReceipt(db, found.scanId, false, scope)
  } catch (error) {
    if (open) await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------------------------------------------

export type TicketView = { id: number; code: string; status: string; rejectionReason: string }

// The account a ticket belongs to, through its scan. Null when the ticket does not exist.
async function ticketAccount(client: pg.PoolClient, ticketId: number): Promise<number | null> {
  const row = (
    await client.query(
      `SELECT er.marketplace_id
       FROM claim_tickets ct
       JOIN receipt_scans rs ON rs.id = ct.receipt_scan_id
       JOIN expected_returns er ON er.id = rs.expected_return_id
       WHERE ct.id = $1`,
      [ticketId],
    )
  ).rows[0]
  return row ? Number(row.marketplace_id) : null
}

// Changes a ticket's status. A rejection needs a reason. Every change adds a history row, and the reason is kept there.
export async function updateTicketStatus(
  db: pg.Pool,
  actor: Actor,
  ticketId: number,
  nextStatus: string,
  reason: string,
  scope: AccountScope = ALL_ACCOUNTS,
): Promise<TicketView> {
  return withClient(db, async (client) => {
    await client.query("BEGIN")
    try {
      const account = await ticketAccount(client, ticketId)
      if (account === null || !allowsAccount(scope, account)) throw new ServiceError(404, "That ticket does not exist.")
      const row = (
        await client.query("SELECT id, ticket_code, status FROM claim_tickets WHERE id = $1 FOR UPDATE", [ticketId])
      ).rows[0]
      if (!row) throw new ServiceError(404, "That ticket does not exist.")
      const problem = ticketStatusError(String(row.status), nextStatus, reason)
      if (problem) throw new ServiceError(400, problem)
      const trimmed = reason.trim()
      const storedReason = nextStatus === "Rejected" ? trimmed : ""
      await client.query(
        "UPDATE claim_tickets SET status = $2, rejection_reason = $3, updated_at = now() WHERE id = $1",
        [ticketId, nextStatus, storedReason],
      )
      await client.query(
        `INSERT INTO claim_ticket_history (claim_ticket_id, from_status, to_status, reason, changed_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [ticketId, String(row.status), nextStatus, trimmed, actor.id],
      )
      await writeAudit(client, actor.id, "ticket.status", "claim_ticket", String(ticketId), {
        from: String(row.status),
        to: nextStatus,
      })
      await client.query("COMMIT")
      return { id: ticketId, code: String(row.ticket_code), status: nextStatus, rejectionReason: storedReason }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    }
  })
}

export async function ticketHistory(db: pg.Pool, ticketId: number, scope: AccountScope = ALL_ACCOUNTS) {
  return withClient(db, async (client) => {
    const account = await ticketAccount(client, ticketId)
    if (account === null || !allowsAccount(scope, account)) throw new ServiceError(404, "That ticket does not exist.")
    const result = await client.query(
      `SELECT h.from_status, h.to_status, h.reason, COALESCE(u.name, '') AS changed_by, h.changed_at
       FROM claim_ticket_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.claim_ticket_id = $1
       ORDER BY h.changed_at, h.id`,
      [ticketId],
    )
    return result.rows.map((row) => ({
      fromStatus: row.from_status === null ? "" : String(row.from_status),
      toStatus: String(row.to_status),
      reason: String(row.reason || ""),
      changedBy: String(row.changed_by || ""),
      changedAt: new Date(row.changed_at).toISOString(),
    }))
  })
}

// ---------------------------------------------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------------------------------------------

export type RegisterFilters = {
  marketplaceId?: number | null
  tracking?: string
  order?: string
  sku?: string
  issue?: string
  ticketStatus?: string
  scannerId?: number | null
  partner?: string
  dateFrom?: string
  dateTo?: string
}

// One row per verified item. Legacy scans (saved before item-level verification) have one row per shipment line,
// marked as legacy, with the quantity that was not recorded left empty. Both arms have the same columns, in the same
// order, so the UNION is valid. Scan snapshots are read from the scan; legacy rows read the lookup row.
const REGISTER_UNION_SQL = `
  SELECT
    'item'::text AS source,
    rsi.id::text AS row_key,
    rs.id AS scan_id,
    rs.scanned_at AS scanned_at,
    to_char((rs.scanned_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS scan_day,
    rs.scanned_time_label AS scan_time,
    rs.status AS scan_status,
    scanner.name AS scanner_name,
    rs.scanned_by AS scanner_id,
    m.id AS marketplace_id,
    m.name AS marketplace,
    COALESCE(rs.tracking_id_snapshot, er.tracking_id) AS tracking_id,
    er.alt_tracking_id AS alt_tracking_id,
    COALESCE(rs.order_number_snapshot, er.order_number) AS order_number,
    rsi.order_item_id AS order_item_id,
    rsi.marketplace_sku AS marketplace_sku,
    rsi.product_sku AS product_sku,
    rsi.product_sku_source AS product_sku_source,
    rsi.marketplace_sku_identifier AS marketplace_sku_identifier,
    rsi.product_name AS product_name,
    rsi.return_type AS return_type,
    rsi.return_reason AS return_reason,
    rsi.expected_qty AS expected_qty,
    rsi.received_qty AS received_qty,
    rsi.line_no AS line_no,
    rs.logistic_partner_snapshot AS logistic_partner_name,
    rs.partner_method_snapshot AS partner_method,
    rs.matched_tracking_field AS matched_tracking_field,
    rs.matched_leg AS matched_leg,
    rs.tracking_validation_snapshot AS tracking_validation,
    rsi.display_identifier_kind AS display_identifier_kind,
    rsi.return_type_raw AS return_type_raw,
    rs.scanned_tracking AS scanned_tracking,
    COALESCE(NULLIF(rs.csv_tracking_snapshot, ''), rs.tracking_id_snapshot, er.tracking_id) AS csv_tracking,
    rs.url_tracking_snapshot AS url_tracking,
    rs.tracking_source_snapshot AS tracking_source,
    rs.forward_tracking_snapshot AS forward_tracking,
    rs.return_event_snapshot AS return_event,
    rs.source_filename_snapshot AS source_filename,
    rs.source_batch_id AS source_batch_id,
    CASE WHEN EXISTS (SELECT 1 FROM receipt_scan_issues x WHERE x.receipt_scan_item_id = rsi.id)
         THEN ARRAY(SELECT x.category_code FROM receipt_scan_issues x WHERE x.receipt_scan_item_id = rsi.id ORDER BY x.id)
         ELSE ARRAY['no_issue']::text[]
    END AS issue_codes,
    ARRAY(
      SELECT ct.status FROM receipt_scan_issues x
      JOIN claim_tickets ct ON ct.id = x.claim_ticket_id
      WHERE x.receipt_scan_item_id = rsi.id
      ORDER BY x.id
    ) AS ticket_statuses,
    (
      SELECT json_agg(json_build_object(
        'categoryCode', x.category_code,
        'categoryLabel', x.category_label,
        'subIssueLabel', x.sub_issue_label,
        'qty', x.qty,
        'notes', x.notes,
        'ticketId', ct.id,
        'ticketCode', ct.ticket_code,
        'ticketStatus', ct.status,
        'rejectionReason', ct.rejection_reason
      ) ORDER BY x.id)
      FROM receipt_scan_issues x
      LEFT JOIN claim_tickets ct ON ct.id = x.claim_ticket_id
      WHERE x.receipt_scan_item_id = rsi.id
    ) AS issues
  FROM receipt_scan_items rsi
  JOIN receipt_scans rs ON rs.id = rsi.receipt_scan_id
  JOIN expected_returns er ON er.id = rs.expected_return_id
  JOIN marketplaces m ON m.id = er.marketplace_id
  JOIN users scanner ON scanner.id = rs.scanned_by
  UNION ALL
  SELECT
    'legacy'::text,
    (eri.id::text || '-' || rs.id::text),
    rs.id,
    rs.scanned_at,
    to_char((rs.scanned_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD'),
    rs.scanned_time_label,
    rs.status,
    scanner.name,
    rs.scanned_by,
    m.id,
    m.name,
    er.tracking_id,
    er.alt_tracking_id,
    er.order_number,
    COALESCE(NULLIF(eri.display_order_item_id, ''), eri.order_line_id, '')::text,
    COALESCE(eri.channel_listing_id, '')::text,
    COALESCE(s.code, '')::text,
    'unrecorded'::text,
    COALESCE(eri.marketplace_sku_identifier, '')::text,
    COALESCE(s.name, '')::text,
    er.return_type,
    COALESCE(er.return_reason, '')::text,
    eri.qty,
    NULL::integer,
    eri.sort_order,
    er.logistic_partner_name,
    er.partner_detection_method,
    ''::text,
    'unknown'::text,
    er.tracking_validation,
    COALESCE(eri.display_identifier_kind, '')::text,
    er.return_type_raw,
    ''::text,
    COALESCE(er.csv_tracking_id, er.tracking_id),
    er.url_tracking_id,
    er.tracking_source,
    er.forward_tracking_id,
    er.return_event_id,
    COALESCE((SELECT b.filename FROM upload_batches b WHERE b.id = er.upload_batch_id), '')::text,
    er.upload_batch_id,
    CASE WHEN rs.outcome = 'clear' THEN ARRAY['no_issue']::text[] ELSE ARRAY['legacy']::text[] END,
    CASE WHEN ct.id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[ct.status]::text[] END,
    json_build_array(json_build_object(
      'categoryCode', CASE WHEN rs.outcome = 'clear' THEN 'no_issue' ELSE 'legacy' END,
      'categoryLabel', rs.issue_label,
      'subIssueLabel', '',
      'qty', eri.qty,
      'notes', COALESCE(rs.notes, ''),
      'ticketId', ct.id,
      'ticketCode', ct.ticket_code,
      'ticketStatus', ct.status,
      'rejectionReason', ct.rejection_reason
    ))
  FROM receipt_scans rs
  JOIN expected_returns er ON er.id = rs.expected_return_id
  JOIN expected_return_items eri ON eri.expected_return_id = er.id
  JOIN marketplaces m ON m.id = er.marketplace_id
  JOIN users scanner ON scanner.id = rs.scanned_by
  LEFT JOIN skus s ON s.id = eri.sku_id
  LEFT JOIN claim_tickets ct ON ct.receipt_scan_id = rs.id
    AND eri.id = (SELECT MIN(e2.id) FROM expected_return_items e2 WHERE e2.expected_return_id = er.id)
  WHERE NOT EXISTS (SELECT 1 FROM receipt_scan_items x WHERE x.receipt_scan_id = rs.id)`

// Builds the WHERE clause over the register rows. Every value is a bound parameter. The account scope is always
// applied, so a restricted user's filters can only narrow the rows they are allowed to see.
export function buildRegisterWhere(
  filters: RegisterFilters,
  scope: AccountScope = ALL_ACCOUNTS,
): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  const add = (value: unknown, clause: (placeholder: string) => string) => {
    params.push(value)
    clauses.push(clause(`$${params.length}`))
  }
  clauses.push(accountCondition(scope, "r.marketplace_id", params))
  if (filters.marketplaceId) add(filters.marketplaceId, (p) => `r.marketplace_id = ${p}`)
  if (filters.tracking) {
    add(
      filters.tracking,
      (p) =>
        `(position(lower(${p}::text) in lower(r.tracking_id)) > 0 OR position(lower(${p}::text) in lower(COALESCE(r.alt_tracking_id, ''))) > 0 OR position(lower(${p}::text) in lower(COALESCE(r.csv_tracking, ''))) > 0 OR position(lower(${p}::text) in lower(COALESCE(r.scanned_tracking, ''))) > 0)`,
    )
  }
  if (filters.order) {
    add(
      filters.order,
      (p) =>
        `(position(lower(${p}::text) in lower(r.order_number)) > 0 OR position(lower(${p}::text) in lower(r.order_item_id)) > 0)`,
    )
  }
  if (filters.sku) {
    add(
      filters.sku,
      (p) =>
        `(position(lower(${p}::text) in lower(r.marketplace_sku)) > 0 OR position(lower(${p}::text) in lower(r.product_sku)) > 0)`,
    )
  }
  if (filters.issue) add(filters.issue, (p) => `${p}::text = ANY(r.issue_codes)`)
  if (filters.ticketStatus) add(filters.ticketStatus, (p) => `${p}::text = ANY(r.ticket_statuses)`)
  if (filters.scannerId) add(filters.scannerId, (p) => `r.scanner_id = ${p}`)
  if (filters.partner) add(filters.partner, (p) => `lower(r.logistic_partner_name) = lower(${p}::text)`)
  if (filters.dateFrom) add(filters.dateFrom, (p) => `r.scan_day >= ${p}::text`)
  if (filters.dateTo) add(filters.dateTo, (p) => `r.scan_day <= ${p}::text`)
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params }
}

// Columns the register can be sorted by. Anything else falls back to the scan date. Only these SQL expressions are ever
// placed in the query text, so a sort value from the browser cannot change the SQL.
const SORT_COLUMNS: Record<string, string> = {
  scanned_at: "r.scanned_at",
  marketplace: "r.marketplace",
  tracking_id: "r.tracking_id",
  order_number: "r.order_number",
  order_item_id: "r.order_item_id",
  marketplace_sku: "r.marketplace_sku",
  product_sku: "r.product_sku",
  logistic_partner_name: "r.logistic_partner_name",
  return_type: "r.return_type",
  expected_qty: "r.expected_qty",
}

export function sortClauseFor(sort: string, direction: string): string {
  const column = Object.prototype.hasOwnProperty.call(SORT_COLUMNS, sort) ? SORT_COLUMNS[sort] : "r.scanned_at"
  const order = direction === "asc" ? "ASC" : "DESC"
  return ` ORDER BY ${column} ${order}, r.scan_id DESC, r.line_no ASC`
}

export const MAX_EXPORT_ROWS = 50000

export type RegisterSort = { sort?: string; direction?: string }

// A scan saved before the product master was loaded keeps an empty product SKU. The master is read once
// for the rows on screen, including the parent listing when the file added an article suffix.
async function overlayProductSkus(db: { query: pg.PoolClient["query"] }, rows: RegisterRow[]) {
  const pairs = rows
    .filter((row) => !row.productSku && row.marketplaceSku)
    .map((row) => ({ listing: row.marketplaceSku, marketplace: row.marketplace }))
  if (!pairs.length) return
  const masters = await masterSkusForListings(db, pairs)
  for (const row of rows) {
    if (row.productSku) continue
    const hit = masters.get(`${row.marketplace.toLowerCase()}|${row.marketplaceSku}`)
    if (hit) row.productSku = hit.masterSku
  }
}

export async function listRegister(
  db: pg.Pool,
  filters: RegisterFilters,
  page: number,
  pageSize: number,
  sort: RegisterSort = {},
  scope: AccountScope = ALL_ACCOUNTS,
): Promise<{ rows: RegisterRow[]; total: number; page: number; pageSize: number; sort: string; direction: string }> {
  const size = Math.min(200, Math.max(1, Math.floor(pageSize) || 50))
  const current = Math.max(1, Math.floor(page) || 1)
  const where = buildRegisterWhere(filters, scope)
  const order = sortClauseFor(sort.sort ?? "", sort.direction ?? "")
  return withClient(db, async (client) => {
    const count = await client.query(
      `SELECT COUNT(*)::int AS total FROM (${REGISTER_UNION_SQL}) r${where.sql}`,
      where.params,
    )
    const params = [...where.params, size, (current - 1) * size]
    const limitAt = params.length - 1
    const result = await client.query(
      `SELECT r.* FROM (${REGISTER_UNION_SQL}) r${where.sql}${order}
       LIMIT $${limitAt} OFFSET $${limitAt + 1}`,
      params,
    )
    const rows = result.rows.map((row) => mapRegisterRow(row as RawRegisterRow))
    await overlayProductSkus(client, rows)
    return {
      rows,
      total: Number(count.rows[0].total),
      page: current,
      pageSize: size,
      sort: Object.prototype.hasOwnProperty.call(SORT_COLUMNS, sort.sort ?? "") ? String(sort.sort) : "scanned_at",
      direction: sort.direction === "asc" ? "asc" : "desc",
    }
  })
}

// The same rows as the screen, for the CSV and Excel exports. Capped, so a huge export is refused, not truncated.
export async function exportRegisterRows(
  db: pg.Pool,
  filters: RegisterFilters,
  scope: AccountScope = ALL_ACCOUNTS,
): Promise<RegisterRow[]> {
  const where = buildRegisterWhere(filters, scope)
  return withClient(db, async (client) => {
    const result = await client.query(
      `SELECT r.* FROM (${REGISTER_UNION_SQL}) r${where.sql}
       ORDER BY r.scanned_at DESC, r.scan_id DESC, r.line_no ASC
       LIMIT ${MAX_EXPORT_ROWS + 1}`,
      where.params,
    )
    if (result.rows.length > MAX_EXPORT_ROWS) {
      throw new ServiceError(400, `More than ${formatCount(MAX_EXPORT_ROWS)} rows match. Narrow the filters first.`)
    }
    const rows = result.rows.map((row) => mapRegisterRow(row as RawRegisterRow))
    await overlayProductSkus(client, rows)
    return rows
  })
}

export async function exportRegister(db: pg.Pool, filters: RegisterFilters, scope: AccountScope = ALL_ACCOUNTS): Promise<string> {
  return registerCsv(await exportRegisterRows(db, filters, scope), "extended")
}

export async function registerOptions(db: pg.Pool, scope: AccountScope = ALL_ACCOUNTS) {
  return withClient(db, async (client) => {
    const accountParams: unknown[] = []
    const accountSql = accountCondition(scope, "m.id", accountParams)
    const marketplaces = await client.query(
      `SELECT m.id, m.name FROM marketplaces m WHERE ${accountSql} ORDER BY m.sort_order, m.id`,
      accountParams,
    )
    const scannerParams: unknown[] = []
    const scannerSql = accountCondition(scope, "er.marketplace_id", scannerParams)
    const scanners = await client.query(
      `SELECT DISTINCT u.id, u.name
       FROM users u
       JOIN receipt_scans rs ON rs.scanned_by = u.id
       JOIN expected_returns er ON er.id = rs.expected_return_id
       WHERE ${scannerSql}
       ORDER BY u.name`,
      scannerParams,
    )
    const partnerParams: unknown[] = []
    const partnerSql = accountCondition(scope, "er.marketplace_id", partnerParams)
    const partners = await client.query(
      `SELECT DISTINCT er.logistic_partner_name AS name
       FROM expected_returns er
       WHERE er.logistic_partner_name <> '' AND ${partnerSql}
       ORDER BY er.logistic_partner_name`,
      partnerParams,
    )
    const categories = await client.query(
      "SELECT code, label FROM receipt_issue_categories WHERE active ORDER BY sort_order, code",
    )
    return {
      marketplaces: marketplaces.rows.map((row) => ({ id: Number(row.id), name: String(row.name) })),
      scanners: scanners.rows.map((row) => ({ id: Number(row.id), name: String(row.name) })),
      partners: partners.rows.map((row) => String(row.name)),
      issueCategories: categories.rows.map((row) => ({ code: String(row.code), label: String(row.label) })),
      ticketStatuses: [...TICKET_STATUSES],
      today: istDay(new Date()),
      todayLabel: formatDay(new Date()),
    }
  })
}

// Used by the register screen to show the same shift figures as the scan screen.
export async function todayShift(db: pg.Pool, scope: AccountScope = ALL_ACCOUNTS) {
  return withClient(db, async (client) => presentShift(await shiftCounts(client, scope)))
}

// Used by the routes to turn a scope into the account list parameter, when a route needs it directly.
export { accountListParam, legFor, NO_ACCESS_MESSAGE }
