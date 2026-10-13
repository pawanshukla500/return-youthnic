import { test } from "node:test"
import assert from "node:assert/strict"
import { matchedFieldFor } from "../register-rules.js"

// Invariant 9: Test data is synthetic, and every value starts with SYN-.
const SYN_ORDER_HYPHEN = "SYN-408-4485117-1368304"
const SYN_ORDER_RAW = "SYN-40844851171368304"
const SYN_TRACKING = "SYN-ATS1234567890"

test("matchedFieldFor matches Amazon Order ID with or without hyphens", () => {
  // Exact hyphenated order number match
  assert.deepEqual(
    matchedFieldFor(SYN_ORDER_HYPHEN, SYN_TRACKING, null, "return_tracking", SYN_ORDER_HYPHEN, []),
    { field: "order_number", leg: "return" },
  )

  // Unhyphenated order number match
  assert.deepEqual(
    matchedFieldFor(SYN_ORDER_RAW, SYN_TRACKING, null, "return_tracking", SYN_ORDER_HYPHEN, []),
    { field: "order_number", leg: "return" },
  )

  // Primary tracking number match
  assert.deepEqual(
    matchedFieldFor(SYN_TRACKING, SYN_TRACKING, null, "return_tracking", SYN_ORDER_HYPHEN, []),
    { field: "tracking_id", leg: "return" },
  )
})
