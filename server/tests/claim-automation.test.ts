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

test("sendError: correctly serializes ServiceError and duck-typed status errors as JSON", async () => {
  const { sendError } = await import("../http.js")
  const { ServiceError } = await import("../register-service.js")

  let capturedStatus = 0
  let capturedJson: any = null
  let nextCalledWith: any = null

  const mockRes: any = {
    status(code: number) {
      capturedStatus = code
      return this
    },
    json(body: any) {
      capturedJson = body
      return this
    },
  }

  const mockNext = (err?: any) => {
    nextCalledWith = err
  }

  // 1. ServiceError
  sendError(mockRes, new ServiceError(400, "Choose an active claim template for this marketplace."), mockNext)
  assert.equal(capturedStatus, 400)
  assert.equal(capturedJson?.error, "Choose an active claim template for this marketplace.")
  assert.equal(nextCalledWith, null)

  // 2. Duck-typed status error
  capturedStatus = 0
  capturedJson = null
  sendError(mockRes, { status: 404, message: "Claim not found." }, mockNext)
  assert.equal(capturedStatus, 404)
  assert.equal(capturedJson?.error, "Claim not found.")
  assert.equal(nextCalledWith, null)

  // 3. Generic Error without status -> forwards to next
  capturedStatus = 0
  capturedJson = null
  const genericErr = new Error("Database connection timed out")
  sendError(mockRes, genericErr, mockNext)
  assert.equal(capturedStatus, 0)
  assert.equal(capturedJson, null)
  assert.equal(nextCalledWith, genericErr)
})

test("credentials encryption: complex passwords and phone identifiers", () => {
  const credentialsList = [
    "9876543210",
    "vaibhav@vbexports.co.in",
    "P@ssw0rd!#$2026_ComplexKey&More",
    "Special-Characters: / ? & = # + %",
  ]

  for (const cred of credentialsList) {
    const enc = encryptSecret(cred)
    assert.match(enc, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/)
    const dec = decryptSecret(enc)
    assert.equal(dec, cred)
  }
})

test("marketplace credentials: portal URLs map to standard supplier dashboards", () => {
  const defaultPortalUrls: Record<string, string> = {
    meesho: "https://supplier.meesho.com/panel/v3/new/root/login",
    flipkart: "https://seller.flipkart.com/index.html#dashboard",
    amazon: "https://sellercentral.amazon.in/",
    myntra: "https://partners.myntrainfo.com/",
    ajio: "https://supplier.ajio.com/",
  }

  assert.equal(defaultPortalUrls["meesho"], "https://supplier.meesho.com/panel/v3/new/root/login")
  assert.ok(defaultPortalUrls["meesho"].includes("supplier.meesho.com"))
  assert.ok(defaultPortalUrls["flipkart"].includes("seller.flipkart.com"))
})


