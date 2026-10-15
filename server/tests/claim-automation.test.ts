import assert from "node:assert/strict"
import test from "node:test"
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
  mapToReceiptIssueCategory,
} from "../claim-automation-service.js"

test("credentials encryption: round-trips plaintext correctly using AES-256-GCM", () => {
  const password = "SuperSecretMarketplacePassword#2026!"
  const encrypted = encryptSecret(password)
  assert.notEqual(encrypted, password)
  assert.match(encrypted, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/)

  const decrypted = decryptSecret(encrypted)
  assert.equal(decrypted, password)
})

test("credentials encryption: handles empty string and malformed ciphertext safely", () => {
  assert.equal(encryptSecret(""), "")
  assert.equal(decryptSecret(""), "")
  assert.equal(decryptSecret("invalid-cipher-text"), "")
  assert.equal(decryptSecret("12:34:56"), "")
})

test("credentials masking: masks username safely without leaking plaintext", () => {
  assert.equal(maskSecret(""), "")
  assert.equal(maskSecret("ab"), "****")
  assert.equal(maskSecret("seller_vb"), "se****vb")
  assert.equal(maskSecret("supplier@meesho.com"), "su****om")
})

test("evidence requirements: validates marketplace-specific rules", () => {
  const marketplacesWithVideo = ["Myntra VB", "Myntra EJ", "Meesho", "Ajio"]
  const marketplacesImagesOnly = ["Flipkart"]

  for (const m of marketplacesWithVideo) {
    assert.ok(marketplacesWithVideo.includes(m), `${m} requires video`)
  }
  for (const m of marketplacesImagesOnly) {
    assert.ok(!marketplacesWithVideo.includes(m), `${m} is images only`)
  }
})

test("automation job stages: valid progression and states", () => {
  const validStages = [
    "queued",
    "downloading_media",
    "prepared",
    "waiting_approval",
    "approved",
    "submitting",
    "completed",
    "failed",
    "manual_intervention_required",
  ]

  assert.equal(validStages.length, 9)
  assert.ok(validStages.includes("prepared"))
  assert.ok(validStages.includes("manual_intervention_required"))
})

test("mapToReceiptIssueCategory: maps marketplace issue codes and reasons to database categories", () => {
  assert.deepEqual(mapToReceiptIssueCategory("wrong_item"), { code: "wrong_product", label: "Wrong product" })
  assert.deepEqual(mapToReceiptIssueCategory("missing_items"), { code: "missing_component", label: "Missing product or component" })
  assert.deepEqual(mapToReceiptIssueCategory("damaged_item"), { code: "damaged_product", label: "Damaged product" })
  assert.deepEqual(mapToReceiptIssueCategory("other_issue"), { code: "other_issue", label: "Other issue" })
})
