import type pg from "pg"
import { accountCondition, type AccountScope } from "./access.js"
import { ServiceError } from "./register-service.js"

export const MEESHO_PACKET_STATE = "Tampered"
export const MEESHO_TAT_DAYS = 7

export const MEESHO_ISSUES = {
  wrong_return: "I have received wrong return",
  missing_items: "Item/s are missing in my return",
  wrong_barcode_rto: "I have received a wrong barcoded package in RTO",
} as const

export type MeeshoIssueCode = keyof typeof MEESHO_ISSUES

export type MeeshoMissingItem = {
  label: string
  quantity: number
  amountEach: number
  amount: number
}

export type MeeshoClaimDraft = {
  scanId: number
  marketplaceId: number
  marketplace: string
  subOrderId: string
  orderId: string
  awb: string
  packetState: string
  packetId: string
  flyerState: string
  returnType: string
  receivedAt: string
  receivedDate: string
  dueDate: string
  tatDays: number
  daysRemaining: number
  overdue: boolean
  productNames: string[]
  missingItems: MeeshoMissingItem[]
  missingAmount: number
  issueOptions: Array<{ code: MeeshoIssueCode; label: string; description: string }>
}

type Queryable = pg.Pool | pg.PoolClient

function istDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || ""
  return `${part("year")}-${part("month")}-${part("day")}`
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function meeshoClaimDueDate(receivedAt: Date | string): string {
  // Seven calendar days inclusive: received on 1 January means file by 7 January.
  return addDays(istDate(receivedAt), MEESHO_TAT_DAYS - 1)
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`)
  const end = Date.parse(`${to}T00:00:00.000Z`)
  return Math.floor((end - start) / 86_400_000)
}

function rupees(value: number): string {
  return `₹${value.toFixed(2)}`
}

export function meeshoClaimDescription(
  issueCode: MeeshoIssueCode,
  input: {
    subOrderId: string
    awb: string
    packetId: string
    missingItems: MeeshoMissingItem[]
    missingAmount: number
  },
): string {
  const reference =
    `Sub Order ID: ${input.subOrderId}. AWB Number: ${input.awb}. ` +
    `State of the packet: ${MEESHO_PACKET_STATE}. Packet ID: ${input.packetId}.`
  if (issueCode === "missing_items") {
    const missing = input.missingItems
      .map((item) => `${item.label} (${item.quantity} × ${rupees(item.amountEach)} = ${rupees(item.amount)})`)
      .join(", ")
    return `Item/s are missing in my return: ${missing}. Total claim amount: ${rupees(input.missingAmount)}. ${reference}`
  }
  if (issueCode === "wrong_barcode_rto") {
    return `I have received a wrong barcoded package in RTO. ${reference}`
  }
  return `I have received the wrong return. ${reference}`
}

export async function getMeeshoClaimDraft(
  db: Queryable,
  scope: AccountScope,
  scanId: number,
): Promise<MeeshoClaimDraft> {
  const params: unknown[] = [scanId]
  const scoped = accountCondition(scope, "er.marketplace_id", params)
  const scanResult = await db.query(
    `SELECT rs.id, er.marketplace_id, m.name AS marketplace,
            COALESCE(NULLIF(rs.order_number_snapshot, ''), er.order_number, '') AS order_id,
            COALESCE(NULLIF(rs.scanned_tracking, ''), NULLIF(rs.original_tracking_snapshot, ''),
                     NULLIF(rs.csv_tracking_snapshot, ''), er.tracking_id, '') AS awb,
            COALESCE(rs.flyer_id, '') AS flyer_id, COALESCE(rs.flyer_state, 'not_required') AS flyer_state,
            rs.scanned_at
     FROM receipt_scans rs
     JOIN expected_returns er ON er.id = rs.expected_return_id
     JOIN marketplaces m ON m.id = er.marketplace_id
     WHERE rs.id = $1 AND lower(m.name) = 'meesho' AND ${scoped}`,
    params,
  )
  const scan = scanResult.rows[0]
  if (!scan) throw new ServiceError(404, "Meesho scanned return not found.")

  const itemsResult = await db.query(
    `SELECT rsi.id, rsi.order_item_id, rsi.product_name, rsi.return_type,
            rsi_issue.category_code, rsi_issue.sub_issue_label, rsi_issue.qty,
            COALESCE(option.claim_amount, 0)::numeric AS claim_amount
     FROM receipt_scan_items rsi
     LEFT JOIN receipt_scan_issues rsi_issue ON rsi_issue.receipt_scan_item_id = rsi.id
     LEFT JOIN missing_component_options option ON option.id = rsi_issue.sub_issue_id
     WHERE rsi.receipt_scan_id = $1
     ORDER BY rsi.line_no, rsi_issue.id`,
    [scanId],
  )

  const subOrders = new Set<string>()
  const productNames = new Set<string>()
  const returnTypes = new Set<string>()
  const categories = new Set<string>()
  const missingItems: MeeshoMissingItem[] = []
  for (const row of itemsResult.rows) {
    const subOrder = String(row.order_item_id || "").trim()
    if (subOrder) subOrders.add(subOrder)
    const product = String(row.product_name || "").trim()
    if (product) productNames.add(product)
    const returnType = String(row.return_type || "").trim()
    if (returnType) returnTypes.add(returnType)
    const category = String(row.category_code || "").trim()
    if (category) categories.add(category)
    if (category === "missing_component") {
      const quantity = Number(row.qty || 0)
      const amountEach = Number(row.claim_amount || 0)
      missingItems.push({
        label: String(row.sub_issue_label || "Missing item"),
        quantity,
        amountEach,
        amount: quantity * amountEach,
      })
    }
  }

  const returnType = [...returnTypes].join(", ")
  const isRto = /\brto\b/i.test(returnType)
  const available: MeeshoIssueCode[] = []
  if (categories.has("wrong_product") && !isRto) available.push("wrong_return")
  if (categories.has("missing_component")) available.push("missing_items")
  if (categories.has("wrong_product") && isRto) available.push("wrong_barcode_rto")
  if (available.length === 0) {
    throw new ServiceError(409, "This Meesho scan does not have a supported wrong-product, missing-item, or wrong-RTO issue.")
  }

  const receivedAt = scan.scanned_at instanceof Date ? scan.scanned_at.toISOString() : String(scan.scanned_at)
  const receivedDate = istDate(receivedAt)
  const dueDate = meeshoClaimDueDate(receivedAt)
  const today = istDate(new Date())
  const daysRemaining = daysBetween(today, dueDate)
  const missingAmount = missingItems.reduce((total, item) => total + item.amount, 0)
  const base = {
    subOrderId: [...subOrders].join(", ") || String(scan.order_id || ""),
    awb: String(scan.awb || ""),
    packetId: String(scan.flyer_id || ""),
    missingItems,
    missingAmount,
  }

  return {
    scanId: Number(scan.id),
    marketplaceId: Number(scan.marketplace_id),
    marketplace: String(scan.marketplace),
    subOrderId: base.subOrderId,
    orderId: String(scan.order_id || ""),
    awb: base.awb,
    packetState: MEESHO_PACKET_STATE,
    packetId: base.packetId,
    flyerState: String(scan.flyer_state),
    returnType,
    receivedAt,
    receivedDate,
    dueDate,
    tatDays: MEESHO_TAT_DAYS,
    daysRemaining,
    overdue: daysRemaining < 0,
    productNames: [...productNames],
    missingItems,
    missingAmount,
    issueOptions: available.map((code) => ({
      code,
      label: MEESHO_ISSUES[code],
      description: meeshoClaimDescription(code, base),
    })),
  }
}

export async function prepareMeeshoClaim(
  db: Queryable,
  scope: AccountScope,
  scanId: number,
  issueCode: string,
): Promise<{
  reason: string
  title: string
  description: string
  issueCode: MeeshoIssueCode
  issueLabel: string
  subOrderId: string
  awb: string
  packetState: string
  packetId: string
  returnType: string
  receivedDate: string
  dueDate: string
  missingAmount: number
}> {
  const draft = await getMeeshoClaimDraft(db, scope, scanId)
  const selected = draft.issueOptions.find((option) => option.code === issueCode)
  if (!selected) throw new ServiceError(400, "Choose an issue that matches the saved Meesho scan.")
  if (draft.flyerState !== "scanned" || !draft.packetId) {
    throw new ServiceError(409, "The Meesho Packet ID is missing. Scan the flyer ID before creating this claim.")
  }
  if (selected.code === "missing_items" && draft.missingItems.some((item) => item.amountEach <= 0)) {
    const missing = draft.missingItems.filter((item) => item.amountEach <= 0).map((item) => item.label).join(", ")
    throw new ServiceError(409, `Set the Admin claim amount for: ${missing}.`)
  }
  return {
    reason: selected.label,
    title: selected.label,
    description: selected.description,
    issueCode: selected.code,
    issueLabel: selected.label,
    subOrderId: draft.subOrderId,
    awb: draft.awb,
    packetState: draft.packetState,
    packetId: draft.packetId,
    returnType: draft.returnType,
    receivedDate: draft.receivedDate,
    dueDate: draft.dueDate,
    missingAmount: draft.missingAmount,
  }
}
