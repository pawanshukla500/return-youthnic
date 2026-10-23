export type Page = "dashboard" | "scan" | "reports" | "iron" | "claims" | "uploads" | "admin"

export type IconName =
  | "grid"
  | "scan"
  | "report"
  | "claim"
  | "upload"
  | "users"
  | "chevron"
  | "search"
  | "bell"
  | "calendar"
  | "arrow"
  | "box"
  | "alert"
  | "check"
  | "close"
  | "file"
  | "settings"
  | "logout"
  | "video"
  | "iron"
  | "wifi"

export type SessionUser = {
  id: number
  initials: string
  name: string
  email: string
  role: string
  sidebarLabel: string
  assignedMarketplaces: string
  scansToday: string
  status: string
  lastActive: string
}

// A marketplace account the signed-in user may use. Lists of accounts come from /api/accounts, never from a fixed list.
export type AccountOption = { id: number; name: string }

// Dashboard "recent scans" row.
export type ReturnRow = {
  id: string
  order: string
  sku: string
  market: string
  courier: string
  type: string
  issue: string
  ticket: string
  status: string
  time: string
}

export type Stat = {
  label: string
  value: string
  delta: string
  icon: IconName
  tone: string
}

export type OperatorPerf = {
  operator_id: number
  operator_name: string
  shipments_count: number
  items_qty: number
  clear_count: number
  issue_count: number
  clear_rate: string
}

export type MarketplaceProcessing = {
  marketplace_id: number
  marketplace_name: string
  shipments_count: number
  items_qty: number
  clear_count: number
  issue_count: number
}

export type HourlyThroughput = {
  hour: number
  label: string
  shipments: number
  items_qty: number
}

export type WarehouseOperations = {
  scanned_qty_today: number
  scanned_shipments_today: number
  clear_today: number
  issues_today: number
  clear_total: number
  issues_total: number
  duplicate_attempts_today: number
  unmatched_awbs_today: number
  pending_validation_rows: number
  operators: OperatorPerf[]
  marketplaces: MarketplaceProcessing[]
  hourlyThroughput: HourlyThroughput[]
}

export type ShiftCard = {
  scanned: string
  correct: string
  issues: string
  // Units sent for ironing today. Iron Send is operational, so these returns are counted as correct.
  ironSend?: string
  accuracy: string
  progress: number
  targetLabel: string
}

export type IssueCategory = {
  code: string
  label: string
  isClear: boolean
  isMissing: boolean
  requiresTicket: boolean
  allowsSubIssue: boolean
  requiresSubIssue: boolean
  // Iron Send: recorded, but not a return issue (not in the issue figures, the claims or OMSGuru).
  isOperational?: boolean
}

export type SubIssue = { id: number; label: string; categoryCode: string }

// One line of a return, as the scan screen verifies it.
export type LookupItem = {
  itemId: number
  // The display identifier when there is one (Ajio return order number, Amazon shipment id), otherwise the order line.
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
  shipmentId?: string
}

// The return the scanned AWB matched. The scanned AWB and the leg it matched are shown to the scanner and saved with
// the scan.
export type LookupShipment = {
  shipmentId: number
  trackingId: string
  csvTrackingId: string
  urlTrackingId: string
  altTrackingId: string
  forwardTrackingId: string
  returnEventId: string
  trackingSource: string
  trackingValidation: string
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
  items: LookupItem[]
}

export type LookupCandidate = {
  shipmentId: number | null
  accountId: number
  accountName: string
  alreadyReceived: boolean
  orderId: string
  itemCount: number
  receivedAt: string
  scannedBy: string
}

export type LookupResponse =
  | { status: "found"; trackingId: string; shipment: LookupShipment }
  | { status: "duplicate"; trackingId: string; marketplace: string; time: string; scannedBy: string }
  | { status: "choose"; trackingId: string; candidates: LookupCandidate[] }
  | { status: "not_found"; trackingId: string }

export type ScanReceipt = {
  replayed: boolean
  scan: {
    id: number
    marketplaceId?: number
    shipmentId?: number
    outcome?: string
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
  ironSendQty?: number
  flyerId?: string
  flyerState?: string
  shift: ShiftCard
  claimsBadge: string
}

// ---- Iron Send tracking (server/iron.ts) ----

export type IronState = "pending" | "partial" | "overdue" | "received" | "cancelled"

export type IronRecord = {
  id: number
  scanId: number
  state: IronState
  marketplace: string
  marketplaceId: number | null
  trackingId: string
  orderId: string
  marketplaceSku: string
  productSku: string
  productName: string
  size: string
  imageUrl: string
  qtySent: number
  qtyReceived: number
  qtyPending: number
  sentAt: string
  sentBy: string
  ageDays: number
  lastReceivedAt: string | null
  notes: string
  batchId: number | null
  batchNo: string | null
  // When the line is due back: its batch's expected return date. Null until it is in a batch.
  dueAt: string | null
  receipts: { id: number; qty: number; receivedAt: string; receivedBy: string; notes: string }[]
}

export type IronBatchState = "open" | "partial" | "overdue" | "received"

export type IronBatch = {
  id: number
  batchNo: string
  // khaata: sent out on a challan. in_house: high-running pieces ironed at the return desk.
  location: "khaata" | "in_house"
  khaataName: string
  challanNo: string
  expectedDays: number
  expectedReturnAt: string
  notes: string
  createdBy: string
  createdAt: string
  state: IronBatchState
  lines: number
  qtySent: number
  qtyReceived: number
  qtyPending: number
  lastReceivedAt: string | null
}

export type IronSummary = {
  overdueAfterDays: number
  records: { open: number; pending: number; partial: number; overdue: number; received: number }
  units: { sent: number; received: number; pending: number; overdue: number }
  receivedToday: number
  unbatched?: { lines: number; units: number }
}

// ---- Return analytics (server/analytics.ts) ----

export type AnalyticsCounts = {
  scans: number
  issueScans: number
  units: number
  issueUnits: number
  ironUnits: number
  rtoScans?: number
  customerScans?: number
  rtoUnits?: number
  customerUnits?: number
}

export type StructuredInsight = {
  id: string
  category: "alert" | "trend" | "catalog" | "channel" | "ops"
  severity: "critical" | "warning" | "info" | "positive"
  badge: string
  title: string
  detail: string
  metric?: string
  action?: string
}

export type AnalyticsReport = {
  filters: { dateFrom: string; dateTo: string; marketplaceId: number | null; categoryCode: string }
  totals: AnalyticsCounts & {
    clearScans: number
    expectedUnits: number
    missingUnits: number
    issueRatePct: number
    rtoRatioPct?: number
    customerRatioPct?: number
    skus: number
  }
  previous: AnalyticsCounts & {
    dateFrom: string
    dateTo: string
    rtoRatioPct?: number
    customerRatioPct?: number
  }
  byDay: (AnalyticsCounts & { day: string; rtoRatioPct?: number; customerRatioPct?: number })[]
  byWeek: (AnalyticsCounts & { weekStart: string; rtoRatioPct?: number; customerRatioPct?: number })[]
  byMarketplace: (AnalyticsCounts & {
    marketplaceId: number
    marketplace: string
    issueRatePct: number
    rtoRatioPct?: number
    customerRatioPct?: number
  })[]
  bySku: (AnalyticsCounts & { sku: string; marketplaceSku: string; productName: string; size: string; topReason: string })[]
  bySize: (AnalyticsCounts & { size: string; sharePct: number })[]
  byIssueCategory: { code: string; label: string; units: number; lines: number; operational: boolean }[]
  byReason: { reason: string; canonical: string; units: number; scans: number; issueUnits: number }[]
  insights: string[]
  detailedInsights?: StructuredInsight[]
  iron: IronSummary
}

export type RegisterTicket = {
  id: number
  code: string
  status: string
  rejectionReason: string
}

export type RegisterIssue = {
  categoryCode: string
  categoryLabel: string
  subIssueLabel: string
  qty: number
  notes: string
  ticket: RegisterTicket | null
}

// One row of the register: one verified item of a scan (or one legacy line). The first fields are the 19 approved columns;
// the rest are the service and traceability columns shown in the record view and the operational export.
export type RegisterRow = {
  key: string
  source: "item" | "legacy"
  scanId: number
  scannedAt: string
  scanDay: string
  scanTime: string
  scanStatus: string
  scannedBy: string
  marketplaceId: number
  marketplace: string
  trackingId: string
  originalTrackingId: string
  urlTrackingId: string
  trackingSource: string
  forwardTrackingId: string
  returnEventId: string
  scannedTracking: string
  orderId: string
  orderItemId: string
  displayIdentifierKind: string
  marketplaceSku: string
  productSku: string
  productSkuSource: string
  marketplaceSkuIdentifier: string
  productName: string
  logisticPartner: string
  partnerMethod: string
  trackingValidation: string
  matchedTrackingField: string
  matchedLeg: string
  returnType: string
  returnTypeRaw: string
  returnReason: string
  expectedQty: number
  receivedQty: number | null
  sourceFile: string
  sourceBatchId: number | null
  amount: number | null
  claimAmount: number | null
  issues: RegisterIssue[]
  // Units sent for ironing on this line. Iron Send is operational and never listed in issues.
  ironSendQty?: number
  // Meesho flyer ID captured at the bench for an issue return (permanent claim evidence).
  flyerId?: string
  flyerState?: string
}

export type RegisterPage = {
  rows: RegisterRow[]
  total: number
  page: number
  pageSize: number
  sort: string
  direction: string
}

export type RegisterOptions = {
  marketplaces: AccountOption[]
  scanners: { id: number; name: string }[]
  partners: string[]
  issueCategories: { code: string; label: string }[]
  ticketStatuses: string[]
  today: string
  todayLabel: string
}

export type TicketHistoryEntry = {
  fromStatus: string
  toStatus: string
  reason: string
  changedBy: string
  changedAt: string
}

export type AdminIssueCategory = {
  code: string
  label: string
  isClear: boolean
  isMissing: boolean
  requiresTicket: boolean
  allowsSubIssue: boolean
  requiresSubIssue: boolean
  active: boolean
}

// Upload history row (GET /api/uploads). Only the accounts the user can see are listed.
export type UploadHistoryRow = {
  id: number
  filename: string
  marketplace: string
  rowCount: string
  scannableRows: number
  pendingRows: number
  rejectedRows: number
  uploadedAt: string
  status: string
  format: string
}

export type UploadCounts = {
  rows: number
  validRows: number
  scannableRows: number
  pendingRows: number
  duplicateRows: number
  unverifiedTrackingRows: number
  blankTrackingRows: number
  zeroQuantityRows: number
  errorRows: number
  cancelledRows: number
  exactDuplicateRows: number
  repeatedRows: number
  untrustedIdentifierRows: number
  trackingCorrectedRows: number
  trackingKeptRows: number
  trackingUncheckedRows: number
  warningRows: number
}

// The result of POST /api/uploads/preview. uploadId is null when the file is fatal, so there is nothing to activate.
export type UploadPreview = {
  uploadId: string | null
  filename: string
  marketplace: string
  profile: string
  profileVersion?: string
  headerRow?: number
  currentActiveRows?: number
  fatal: string
  headers: { found: string[]; missing: string[] }
  counts: UploadCounts
  blockers: string[]
  confirmations: string[]
  canActivate: boolean
  exceptions: UploadException[]
  errors: { line: number | null; message: string }[]
  trackingCorrections: {
    line: number | null
    trackingId: string
    csvTrackingId: string
    urlTrackingId: string
    validation: string
  }[]
  partners: { name: string; rows: number }[]
  productMapping: {
    checked: number
    mappedRows: number
    titledRows: number
    unmappedCount: number
    unmappedSample: string[]
    unmappedSkus?: string[]
  } | null
  warnings: string[]
  message: string
}

export type UploadException = {
  line: number | null
  status: "pending" | "rejected" | "duplicate" | "cancelled"
  reasons: string[]
  trackingId: string
  sourceTrackingId: string
  orderId: string
  shipmentId: string
  quantity: number
  returnType: string
  carrier: string
  listingSku: string
}

export type ScannerListCandidate = {
  expectedReturnId: number
  accountId: number
  accountName: string
  matchedTrackingField: string
  matchedLeg: string
  alreadyScanned: boolean
}

export type ScannerListEntry = {
  sheet: string
  sourceRow: number
  sourceColumn: number
  sourceValue: string
  normalizedValue: string
  status: string
  duplicate: boolean
  matchStatus: string
  candidates: ScannerListCandidate[]
  mappedAccount: string
}

export type ScannerListPreview = {
  kind: "scanner_list"
  filename: string
  sheets: {
    name: string
    sourceRows: number
    nonEmptyCells: number
    columns: number[]
    mappedAccount: string
  }[]
  accounts: AccountOption[]
  counts: {
    sheets: number
    entries: number
    matched: number
    unmatched: number
    ambiguous: number
    previouslyScanned: number
    unassigned: number
    malformed: number
    duplicateEntries: number
  }
  entries: ScannerListEntry[]
  message: string
}

// The result of POST /api/uploads/import.
export type UploadImportResult = {
  row: UploadHistoryRow
  activatedRows: number
  scannableRows: number
  pendingRows: number
  rejectedRows: number
  supersededRows: number
  cancelledRows: number
  confirmed: string[]
}

// The VB EXPORT product master (Admin "Product SKU master" tab). state is GET /api/admin/product-master.
export type ProductMasterRow = {
  marketplace: string
  listingSku: string
  masterSku: string
  category: string
  imageUrl: string
}

export type ProductMasterState = {
  rows: number
  listings: number
  masters: number
  withImage: number
  lastLoadedAt: string
  marketplaces: { marketplace: string; rows: number }[]
  sample: ProductMasterRow[]
}

// The result of POST /api/admin/product-master/preview. A fatal error means the file cannot be read.
export type ProductMasterPreview = {
  fatal: string
  rows: number
  listings: number
  masters: number
  withImage: number
  withoutImage: number
  invalidImages: number
  categories: number
  skipped: number
  // Listing SKUs the file gives more than one product SKU for. The last row wins; these are reported, never guessed.
  conflictCount: number
  conflictSample: { listingSku: string; marketplace: string; masterSkus: string[] }[]
  // The marketplace scope the rows will be stored under, with the row count for each.
  scopes: { marketplace: string; rows: number }[]
  sample: { listingSku: string; masterSku: string; category: string; imageUrl: string }[]
}

// The result of POST /api/admin/product-master/import/start: a staged upload the client drains in batches.
export type ProductMasterImportStart = {
  uploadId: string
  total: number
  filename: string
  marketplace: string
  mode: "merge" | "replace"
  preview: ProductMasterPreview
}

// The result of one POST /api/admin/product-master/import/batch call. When done is true the
// response also carries the final import result and the refreshed master state.
export type ProductMasterImportBatch = {
  uploadId: string
  processed: number
  total: number
  done: boolean
  batchInserted: number
  result?: { inserted: number; updated?: number; removed?: number; resolvedUnmapped?: number; imagesFilled?: number }
  state?: ProductMasterState
}

// Client-side progress for the staged product-master import loop (500 rows per batch call).
export type ProductMasterImportProgress = {
  uploadId: string
  processed: number
  total: number
  batches: number
}

export type UnmappedSkuSummary = {
  total: number
  totalUnmapped: number
  pendingResolution: number
  byMarketplace: { marketplace: string; count: number }[]
  sample: { marketplace: string; listingSku: string; lastSeenAt: string; sampleOrderNumber?: string; sampleTrackingId?: string }[]
}

export type UnmappedSkuItem = {
  id: number
  marketplace: string
  listingSku: string
  sampleOrderNumber: string
  sampleTrackingId: string
  firstSeenAt: string
  lastSeenAt: string
  status: string
}

export type UnmappedListResult = {
  items: UnmappedSkuItem[]
  total: number
  page: number
  pageSize: number
}

// ---- Claims foundation (server/claims-service.ts) ----

export type ClaimStatus =
  | "pending_evidence"
  | "ready_for_claim"
  | "waiting_for_approval"
  | "processing"
  | "submitted"
  | "under_review"
  | "approved"
  | "rejected"
  | "reconciled"
  | "paid"
  | "reclaim"
  | "escalated"
  | "failed"
  | "manual_action_required"

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  pending_evidence: "Pending Evidence",
  ready_for_claim: "Ready for Claim",
  waiting_for_approval: "Waiting for Approval",
  processing: "Processing",
  submitted: "Submitted",
  under_review: "Under Review",
  approved: "Approved",
  rejected: "Rejected",
  reconciled: "Reconciled",
  paid: "Paid",
  reclaim: "Re-claim",
  escalated: "Escalated",
  failed: "Failed",
  manual_action_required: "Manual Action Required",
}

export const CLAIM_STATUS_TONES: Record<ClaimStatus, string> = {
  pending_evidence: "warning",
  ready_for_claim: "blue",
  waiting_for_approval: "purple",
  processing: "orange",
  submitted: "green",
  under_review: "purple",
  approved: "green",
  rejected: "danger",
  reconciled: "blue",
  paid: "green",
  reclaim: "warning",
  escalated: "orange",
  failed: "danger",
  manual_action_required: "danger",
}

export type ClaimTemplateField = {
  id: number
  fieldKey: string
  fieldLabel: string
  fieldType: string
  required: boolean
  minCount: number
  maxCount: number
  maxFileSizeMb: number
  sortOrder: number
  active: boolean
}

export type ClaimTemplate = {
  id: number
  marketplaceId: number | null
  marketplaceName: string
  name: string
  description: string
  active: boolean
  sortOrder: number
  fields: ClaimTemplateField[]
}

export type ClaimMediaRow = {
  id: number
  fieldKey: string
  contentHash: string
  sizeBytes: number
  mimeType: string
  originalFilename: string
  capturedAt: string | null
  uploadedBy: string
  uploadedAt: string
  active: boolean
  retentionUntil: string
}

export type ClaimStatusHistoryRow = {
  fromStatus: string
  toStatus: string
  reason: string
  changedBy: string
  changedAt: string
}

export type ClaimRow = {
  id: number
  receiptScanId: number
  marketplaceId: number
  marketplace: string
  claimTemplateId: number | null
  claimReason: string
  claimTitle: string
  claimDescription: string
  remarks: string
  status: string
  createdBy: string
  createdAt: string
  updatedAt: string
  trackingId: string
  orderId: string
  mediaCount: number
  marketplaceIssueCode: string
  marketplaceIssueLabel: string
  subOrderId: string
  awb: string
  packetState: string
  packetId: string
  returnType: string
  receivedDate: string
  dueDate: string
  daysRemaining: number | null
  overdue: boolean
  missingAmount: number
  totalPrice: number
  claimAmount: number
  approvedAmount: number
  paidAmount: number
  payoutReference: string
  payoutDate: string
}

export type ClaimDetail = ClaimRow & {
  media: ClaimMediaRow[]
  history: ClaimStatusHistoryRow[]
  evidenceComplete: boolean
  missingEvidence: string[]
}

export type ClaimScanSearchRow = {
  scanId: number
  marketplaceId: number
  marketplace: string
  trackingId: string
  orderId: string
  scannedAt: string
  hasClaim: boolean
  claimId: number | null
}

export type MeeshoClaimIssueOption = {
  code: "wrong_return" | "missing_items" | "wrong_barcode_rto"
  label: string
  description: string
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
  missingItems: Array<{ label: string; quantity: number; amountEach: number; amount: number }>
  missingAmount: number
  issueOptions: MeeshoClaimIssueOption[]
}

export type ClaimListResult = {
  rows: ClaimRow[]
  total: number
  page: number
  pageSize: number
}

// ---- Desktop Claim Automation & Agent Sync ----

export type AutomationAgent = {
  id: number
  agentUuid: string
  agentName: string
  hostname: string
  platform: string
  version: string
  status: "online" | "busy" | "offline" | "error"
  lastHeartbeatAt: string
  currentTaskInfo: Record<string, unknown>
  isAuthorized: boolean
}

export type AutomationJob = {
  id: number
  claimId: number
  marketplace: string
  accountName: string
  orderNumber: string
  trackingId: string
  claimReason: string
  claimTitle: string
  stage: string
  browserMode: string
  attempts: number
  maxAttempts: number
  marketplaceClaimId: string
  submissionScreenshotPath: string
  manualActionReason: string
  logs: Array<{ timestamp: string; level: string; message: string }>
  agentName: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export type MarketplaceCredential = {
  id: number
  marketplaceId: number | null
  marketplaceName: string
  accountName: string
  portalUrl: string
  usernameMasked: string
  automationMode: string
  requireApprovalBeforeSubmit: boolean
  autoPrepare: boolean
  isActive: boolean
  lastLoginAt: string | null
}

export type ClaimReturnLookup = {
  found: boolean
  scanId: number | null
  expectedReturnId: number
  marketplace: string
  marketplaceId: number
  subOrderId: string
  orderId: string
  trackingNumber: string
  awb: string
  packetState: string
  packetId: string
  customerName: string
  totalPrice: number
  totalAmount: number
  returnStatus: string
  shippedDate: string | null
  daysSinceShipped: number
  tatDays: number
  receivedDate: string | null
  dueDate: string | null
  daysRemaining: number | null
  overdue: boolean
  missingItems: Array<{
    label: string
    quantity: number
    amountEach: number
    amount: number
  }>
  missingAmount: number
  existingClaim: {
    id: number
    status: string
    reason: string
    title: string
    mediaCount: number
  } | null
  items: Array<{
    itemId: number
    sku: string
    masterSku: string
    title: string
    quantity: number
    imageUrl: string
    subOrderId: string
  }>
  templates: Array<{
    id: number
    name: string
    description: string
    fields: Array<{
      fieldKey: string
      fieldLabel: string
      fieldType: string
      required: boolean
      minCount: number
      maxCount: number
      maxFileSizeMb: number
    }>
  }>
  standardReasons: Array<{
    code: string
    label: string
    suggestedTitle: string
    suggestedContent: string
  }>
}

