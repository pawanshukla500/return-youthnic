// SYNTHETIC FIXTURES ONLY. Invented channel labels (SYN- prefix except the exact account names
// under test) checked against the pure marketplace mapper. No live OMSGuru API, no database.
//
// Run: npm test

import { test } from "node:test"
import assert from "node:assert/strict"
import { marketplaceForChannel } from "../oms/master-bridge.js"

test("[synthetic] marketplaceForChannel maps the five unambiguous accounts from channel_name", () => {
  assert.equal(marketplaceForChannel("Amazon", ""), "Amazon")
  assert.equal(marketplaceForChannel("Flipkart", ""), "Flipkart")
  assert.equal(marketplaceForChannel("Meesho", ""), "Meesho")
  assert.equal(marketplaceForChannel("Ajio", ""), "Ajio")
  assert.equal(marketplaceForChannel("Shopify", ""), "Shopify")
})

test("[synthetic] marketplaceForChannel returns null for Myntra VB and Myntra EJ (ambiguous)", () => {
  assert.equal(marketplaceForChannel("Myntra VB", ""), null)
  assert.equal(marketplaceForChannel("Myntra EJ", ""), null)
  assert.equal(marketplaceForChannel("", "Myntra VB"), null)
  assert.equal(marketplaceForChannel("SYN-Myntra Fashion", "SYN-Store"), null)
})

test("[synthetic] marketplaceForChannel returns null for a bare myntra in either label", () => {
  assert.equal(marketplaceForChannel("Myntra", ""), null)
  assert.equal(marketplaceForChannel("", "SYN-Myntra Outlet"), null)
  assert.equal(marketplaceForChannel("SYN-Amazon Store", "SYN-Myntra"), null)
})

test("[synthetic] marketplaceForChannel matches case-insensitively on whole words", () => {
  assert.equal(marketplaceForChannel("AMAZON", ""), "Amazon")
  assert.equal(marketplaceForChannel("SYN-amazon india store", ""), "Amazon")
  assert.equal(marketplaceForChannel("FlipKart Seller", ""), "Flipkart")
  assert.equal(marketplaceForChannel("", "SYN-MEESHO official"), "Meesho")
  assert.equal(marketplaceForChannel("", "SYN-ajio BUSINESS"), "Ajio")
  assert.equal(marketplaceForChannel("SYN-Shopify Plus", ""), "Shopify")
})

test("[synthetic] marketplaceForChannel needs a whole word, not a substring", () => {
  assert.equal(marketplaceForChannel("SYN-Amazonian Goods", ""), null)
  assert.equal(marketplaceForChannel("SYN-MyAmazonStore", ""), null)
  assert.equal(marketplaceForChannel("SYN-FlipkartClone", "SYN-Nowhere"), null)
})

test("[synthetic] marketplaceForChannel reads channel_name first, then falls back to name", () => {
  assert.equal(marketplaceForChannel("Amazon", "Flipkart"), "Amazon")
  assert.equal(marketplaceForChannel("SYN-Unknown", "SYN-Meesho Official"), "Meesho")
  assert.equal(marketplaceForChannel("", "SYN-Ajio Business"), "Ajio")
})

test("[synthetic] marketplaceForChannel returns null for unknown or blank labels", () => {
  assert.equal(marketplaceForChannel("SYN-Unknown", "SYN-Nowhere"), null)
  assert.equal(marketplaceForChannel("", ""), null)
  assert.equal(marketplaceForChannel("   ", "  "), null)
})
