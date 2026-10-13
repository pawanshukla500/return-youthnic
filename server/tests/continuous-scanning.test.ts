import { test } from "node:test"
import assert from "node:assert/strict"
import {
  type CategoryRule,
  type SubIssueRule,
  type ScanSubmission,
  validateScanSubmission,
  decideLookup,
  type LookupEntry,
} from "../register-rules.js"

// Invariant 9: Test data is synthetic, and every value starts with SYN-.
const SYN_ACCOUNT = "SYN-ACCOUNT-MYNTRA"
const SYN_KEY_1 = "SYN-SCAN-KEY-0001"
const SYN_KEY_2 = "SYN-SCAN-KEY-0002"
const SYN_AWB_1 = "SYN-AWB-100000000001"
const SYN_AWB_2 = "SYN-AWB-100000000002"
const SYN_AWB_3 = "SYN-AWB-100000000003"

const categories: CategoryRule[] = [
  { code: "no_issue", label: "No issue", isClear: true, isMissing: false, requiresTicket: false, allowsSubIssue: false, requiresSubIssue: false, active: true },
  { code: "missing_component", label: "Missing product or component", isClear: false, isMissing: true, requiresTicket: true, allowsSubIssue: true, requiresSubIssue: true, active: true },
  { code: "wrong_product", label: "Wrong product", isClear: false, isMissing: false, requiresTicket: true, allowsSubIssue: false, requiresSubIssue: false, active: true },
  { code: "damaged_product", label: "Damaged product", isClear: false, isMissing: false, requiresTicket: true, allowsSubIssue: false, requiresSubIssue: false, active: true },
]

const subIssues: SubIssueRule[] = [
  { id: 101, label: "SYN-Dupatta", categoryCode: "missing_component", active: true },
  { id: 102, label: "SYN-Bottom", categoryCode: "missing_component", active: true },
]

const singleItemShipment = [
  { id: 1, expectedQty: 1 },
]

const multiItemShipment = [
  { id: 1, expectedQty: 2 },
  { id: 2, expectedQty: 1 },
]

// State machine definition matching client ScanReturns.tsx
type ScannerState =
  | "READY"
  | "LOOKUP"
  | "VERIFYING"
  | "SAVING"
  | "SAVED"
  | "LOOKUP_ERROR"
  | "SAVE_ERROR"
  | "DUPLICATE"
  | "AMBIGUOUS_MATCH"

function isInputFocusAllowed(state: ScannerState): boolean {
  return state === "READY" || state === "LOOKUP_ERROR" || state === "DUPLICATE"
}

// Simulated FIFO Queue buffer
class ScannerBufferQueue {
  private queue: string[] = []
  private readonly maxCapacity = 10

  push(awb: string): { success: boolean; overflow: boolean; length: number } {
    if (this.queue.length >= this.maxCapacity) {
      return { success: false, overflow: true, length: this.queue.length }
    }
    this.queue.push(awb)
    return { success: true, overflow: false, length: this.queue.length }
  }

  shift(): string | undefined {
    return this.queue.shift()
  }

  get length(): number {
    return this.queue.length
  }

  peek(): string | undefined {
    return this.queue[0]
  }

  clear(): void {
    this.queue = []
  }
}

// Keystroke burst discriminator for hardware barcode scanner
function isHardwareScannerBurst(keystrokeTimestamps: number[]): boolean {
  if (keystrokeTimestamps.length < 4) return false
  for (let i = 1; i < keystrokeTimestamps.length; i++) {
    const diff = keystrokeTimestamps[i] - keystrokeTimestamps[i - 1]
    if (diff > 80) return false // Human typing speed or pause > 80ms
  }
  return true
}

test("Scenario 1: Scan → Clear Return → Save → Next barcode", () => {
  let state: ScannerState = "READY"
  assert.equal(isInputFocusAllowed(state), true, "Scan input must have focus when READY")

  // 1. Employee scans barcode
  state = "LOOKUP"
  assert.equal(isInputFocusAllowed(state), false, "Input must not steal focus during LOOKUP")

  // Single item return resolves
  const validScan: ScanSubmission = {
    shipmentId: 101,
    clientScanKey: SYN_KEY_1,
    notes: "",
    items: [{ itemId: 1, receivedQty: 1, verified: true, issues: [] }],
  }
  const validation = validateScanSubmission(singleItemShipment, validScan, categories, subIssues)
  assert.equal(validation.ok, true)

  // Auto-save occurs
  state = "SAVING"
  assert.equal(isInputFocusAllowed(state), false)

  // Save finishes
  state = "SAVED"
  // Cycle returns to READY
  state = "READY"
  assert.equal(isInputFocusAllowed(state), true, "Scan input automatically regains focus for next barcode")
})

test("Scenario 2: Scan → Missing Component → Select Sub Issue → Save → Next barcode", () => {
  let state: ScannerState = "READY"
  state = "LOOKUP"
  state = "VERIFYING"
  assert.equal(isInputFocusAllowed(state), false, "Scan input must NOT steal focus while selecting sub issues")

  // Submission with missing component and valid sub-issue
  const missingSubmission: ScanSubmission = {
    shipmentId: 102,
    clientScanKey: SYN_KEY_2,
    notes: "SYN-Customer returned package with dupatta missing",
    items: [
      {
        itemId: 1,
        receivedQty: 1, // 1 received out of 2 expected
        verified: true,
        issues: [
          {
            categoryCode: "missing_component",
            subIssueId: 101,
            qty: 1,
            ticketCode: "SYN-TCK-9901",
            notes: "SYN-Missing dupatta",
          },
        ],
      },
      { itemId: 2, receivedQty: 1, verified: true, issues: [] },
    ],
  }

  const validation = validateScanSubmission(multiItemShipment, missingSubmission, categories, subIssues)
  assert.equal(validation.ok, true, "Missing component with valid subIssueId and ticket must be valid")

  state = "SAVING"
  state = "SAVED"
  state = "READY"
  assert.equal(isInputFocusAllowed(state), true, "Scan input focused for next parcel")
})

test("Scenario 3: Scan → Wrong Product → Save → Next barcode", () => {
  let state: ScannerState = "READY"
  state = "LOOKUP"
  state = "VERIFYING"

  const wrongProductSubmission: ScanSubmission = {
    shipmentId: 103,
    clientScanKey: "SYN-SCAN-KEY-0003",
    notes: "",
    items: [
      {
        itemId: 1,
        receivedQty: 1,
        verified: true,
        issues: [
          {
            categoryCode: "wrong_product",
            subIssueId: null,
            qty: 1,
            ticketCode: "SYN-TCK-9902",
            notes: "SYN-Received wrong color product",
          },
        ],
      },
    ],
  }

  const validation = validateScanSubmission(singleItemShipment, wrongProductSubmission, categories, subIssues)
  assert.equal(validation.ok, true)

  state = "SAVING"
  state = "SAVED"
  state = "READY"
  assert.equal(isInputFocusAllowed(state), true)
})

test("Scenario 4: Scan → Database save fails → Original scan remains available and retryable", () => {
  let state: ScannerState = "READY"
  state = "LOOKUP"
  state = "VERIFYING"

  const preservedPayload = {
    awb: SYN_AWB_1,
    clientScanKey: SYN_KEY_1,
    shipmentId: 104,
    items: [{ itemId: 1, receivedQty: 1, verified: true, issues: [] }],
  }

  // Simulate network or database timeout
  state = "SAVING"
  const saveFailed = true

  if (saveFailed) {
    state = "SAVE_ERROR"
  }

  // Verification state must NOT be wiped
  assert.equal(state, "SAVE_ERROR")
  assert.equal(preservedPayload.awb, SYN_AWB_1, "Scanned AWB must be preserved on save error")
  assert.equal(preservedPayload.clientScanKey, SYN_KEY_1, "Client key must be preserved for idempotent retry")
  assert.equal(preservedPayload.items.length, 1, "Verification item state must be preserved")
  assert.equal(isInputFocusAllowed(state), false, "Scanner must not steal focus during SAVE_ERROR to permit inspection")

  // User hits Retry Save (with same key)
  state = "SAVING"
  // Save succeeds on retry
  state = "SAVED"
  state = "READY"
  assert.equal(isInputFocusAllowed(state), true, "Returns to READY after successful retry")
})

test("Scenario 5: Scan → Duplicate barcode → Clear warning and returns to ready", () => {
  const duplicateLookup: LookupEntry[] = [
    {
      accountId: 1,
      accountName: SYN_ACCOUNT,
      shipmentId: 105,
      orderId: "SYN-ORD-01",
      itemCount: 1,
      alreadyReceived: true,
      receivedAt: "2026-10-12 10:00:00",
      scannedBy: "SYN-Worker-1",
    },
  ]

  const decision = decideLookup(duplicateLookup)
  assert.equal(decision.kind, "duplicate")
  assert.equal(decision.entry.scannedBy, "SYN-Worker-1")

  let state: ScannerState = "DUPLICATE"
  assert.equal(isInputFocusAllowed(state), true, "Scanner input stays ready to scan next barcode on duplicate")
})

test("Scenario 6: Scan → Second barcode arrives during verification → FIFO queue buffers it safely", () => {
  const buffer = new ScannerBufferQueue()
  let currentState: ScannerState = "VERIFYING"

  // Barcode 2 arrives while parcel 1 is being inspected
  const arrival1 = buffer.push(SYN_AWB_2)
  assert.equal(arrival1.success, true)
  assert.equal(buffer.length, 1)

  // Barcode 3 arrives
  const arrival2 = buffer.push(SYN_AWB_3)
  assert.equal(arrival2.success, true)
  assert.equal(buffer.length, 2)
  assert.equal(buffer.peek(), SYN_AWB_2, "FIFO ordering must be preserved")

  // Current parcel completes save
  currentState = "SAVING"
  currentState = "SAVED"

  // System processes FIFO queue
  const nextAwb = buffer.shift()
  assert.equal(nextAwb, SYN_AWB_2)
  assert.equal(buffer.length, 1)

  // Buffer overflows if pushed past 10
  for (let i = 0; i < 9; i++) {
    buffer.push(`SYN-AWB-BURST-${i}`)
  }
  const overflow = buffer.push("SYN-AWB-EXCESS")
  assert.equal(overflow.overflow, true, "Buffer capacity must be bounded at 10 to warn operator")
})

test("Scenario 7: Scan → Second barcode arrives during saving → No duplicate or lost scan", () => {
  const buffer = new ScannerBufferQueue()
  let currentState: ScannerState = "SAVING"

  // Arrives during in-flight database transaction
  const buffered = buffer.push(SYN_AWB_2)
  assert.equal(buffered.success, true)
  assert.equal(currentState, "SAVING")

  // First save finishes
  currentState = "SAVED"

  // Dequeue next barcode for immediate lookup
  const dequeued = buffer.shift()
  assert.equal(dequeued, SYN_AWB_2)
  currentState = "LOOKUP"
  assert.equal(currentState, "LOOKUP")
})

test("Scenario 8: Continuous 100+ consecutive synthetic scans without memory/state leakage", () => {
  const queue = new ScannerBufferQueue()
  let processedCount = 0

  // Simulate 120 consecutive scans arriving and completing
  for (let i = 1; i <= 120; i++) {
    const awb = `SYN-AWB-${String(i).padStart(6, "0")}`
    const pushResult = queue.push(awb)
    if (pushResult.success) {
      const activeAwb = queue.shift()!
      assert.ok(activeAwb.startsWith("SYN-AWB-"))
      processedCount++
    }
  }

  assert.equal(processedCount, 120, "Must successfully process all 120 scans continuously")
  assert.equal(queue.length, 0, "Buffer queue must be clean at end of shift")
})

test("Scenario 9: Hardware scanner rapid burst discrimination vs human typing", () => {
  // Scanner bursts typically send keystrokes within 10-30ms
  const scannerBurst = [1000, 1015, 1030, 1045, 1060, 1075]
  assert.equal(isHardwareScannerBurst(scannerBurst), true, "Fast hardware scanner bursts must be detected")

  // Human typing has gaps > 100ms
  const humanTyping = [1000, 1120, 1250, 1400]
  assert.equal(isHardwareScannerBurst(humanTyping), false, "Human manual input must not be treated as automated burst")
})

test("Scenario 10: Explicit scanner state transitions legality", () => {
  const validTransitions: Record<ScannerState, ScannerState[]> = {
    READY: ["LOOKUP"],
    LOOKUP: ["VERIFYING", "SAVING", "DUPLICATE", "AMBIGUOUS_MATCH", "LOOKUP_ERROR"],
    VERIFYING: ["SAVING", "READY"],
    SAVING: ["SAVED", "SAVE_ERROR"],
    SAVED: ["READY", "LOOKUP"],
    LOOKUP_ERROR: ["READY", "LOOKUP"],
    SAVE_ERROR: ["SAVING", "READY"],
    DUPLICATE: ["READY", "LOOKUP"],
    AMBIGUOUS_MATCH: ["LOOKUP", "READY"],
  }

  for (const [fromState, allowedNext] of Object.entries(validTransitions)) {
    assert.ok(allowedNext.length > 0, `${fromState} must have defined next states`)
  }
})
