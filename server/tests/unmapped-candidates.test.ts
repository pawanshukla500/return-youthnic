// SYNTHETIC ONLY. Phantom unmapped queue: scan-time resolution (listingSkuCandidates)
// resolves spaceless and parent article-suffix forms, so the queue flip must too.
// Pure helper tests only — no database, no .env, every value starts with SYN-.
//
// Run: node --import tsx --test server/tests/unmapped-candidates.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"
import { compactSkuKey, listingSkuCandidates } from "../marketplace-rules.js"
import { unmappedIsResolved } from "../product-master.js"

// Same key format as loadMasterLookupKeys: `${scopeLower}|${compactCandidate}` for
// every candidate of every stored listing.
function keysFor(entries: { marketplace: string; listing: string }[]): Set<string> {
  const keys = new Set<string>()
  for (const entry of entries) {
    const scope = entry.marketplace.trim().toLowerCase()
    for (const candidate of listingSkuCandidates(entry.listing)) {
      keys.add(`${scope}|${compactSkuKey(candidate)}`)
    }
  }
  return keys
}

test("[synthetic] exact listing resolves for its own account", () => {
  const keys = keysFor([{ marketplace: "Myntra VB", listing: "SYN-T87-Sinha-Bottle Green_S" }])
  assert.equal(unmappedIsResolved("SYN-T87-Sinha-Bottle Green_S", "Myntra VB", keys), true)
})

test("[synthetic] _KL article-suffix child resolves against the stored parent", () => {
  const keys = keysFor([{ marketplace: "Myntra VB", listing: "SYN-T87-Sinha-Bottle Green_S" }])
  assert.equal(unmappedIsResolved("SYN-T87-Sinha-Bottle Green_S_KL", "Myntra VB", keys), true)
})

test("[synthetic] _A article-suffix child resolves against the stored parent", () => {
  const keys = keysFor([{ marketplace: "Myntra VB", listing: "SYN-B126-Kabira-Bottle Green_S" }])
  assert.equal(unmappedIsResolved("SYN-B126-Kabira-Bottle Green_S_A", "Myntra VB", keys), true)
})

test("[synthetic] spaceless variant resolves", () => {
  const keys = keysFor([{ marketplace: "Myntra VB", listing: "SYN-T87-Sinha-BottleGreen_S" }])
  assert.equal(unmappedIsResolved("SYN-T87-Sinha-Bottle Green_S", "Myntra VB", keys), true)
})

test("[synthetic] resolution is case-insensitive", () => {
  const keys = keysFor([{ marketplace: "Myntra VB", listing: "SYN-T87-SINHA-BOTTLE GREEN_S" }])
  assert.equal(unmappedIsResolved("syn-t87-sinha-bottle green_s", "myntra vb", keys), true)
})

test("[synthetic] 'all' scope resolves every account", () => {
  const keys = keysFor([{ marketplace: "all", listing: "SYN-T87-Sinha-Bottle Green_S" }])
  assert.equal(unmappedIsResolved("SYN-T87-Sinha-Bottle Green_S_KL", "Myntra VB", keys), true)
  assert.equal(unmappedIsResolved("SYN-T87-Sinha-Bottle Green_S_KL", "Meesho", keys), true)
})

test("[synthetic] account-specific rows do not leak across accounts", () => {
  const myntraOnly = keysFor([{ marketplace: "Myntra VB", listing: "SYN-T87-Sinha-Bottle Green_S" }])
  assert.equal(unmappedIsResolved("SYN-T87-Sinha-Bottle Green_S", "Myntra VB", myntraOnly), true)
  assert.equal(unmappedIsResolved("SYN-T87-Sinha-Bottle Green_S", "Meesho", myntraOnly), false)
  assert.equal(unmappedIsResolved("SYN-T87-Sinha-Bottle Green_S_KL", "Meesho", myntraOnly), false)

  const meeshoOnly = keysFor([{ marketplace: "Meesho", listing: "SYN-T91-Zoe-Rust_AI1" }])
  assert.equal(unmappedIsResolved("SYN-T91-Zoe-Rust_AI1", "Meesho", meeshoOnly), true)
  assert.equal(unmappedIsResolved("SYN-T91-Zoe-Rust_AI1", "Myntra VB", meeshoOnly), false)
})

test("[synthetic] truly-unknown SKU stays unmapped", () => {
  const keys = keysFor([{ marketplace: "Myntra VB", listing: "SYN-T87-Sinha-Bottle Green_S" }])
  assert.equal(unmappedIsResolved("SYN-Unknown-Sku-999_XZ9", "Myntra VB", keys), false)
  assert.equal(unmappedIsResolved("SYN-Unknown-Sku-999_XZ9", "Myntra VB", new Set()), false)
})

test("[synthetic] exact-first ordering of candidates is preserved", () => {
  const candidates = listingSkuCandidates("SYN-T87-Sinha-Bottle Green_S_KL")
  assert.equal(candidates[0], "SYN-T87-Sinha-Bottle Green_S_KL")
  assert.ok(candidates.includes("SYN-T87-Sinha-Bottle Green_S"))
})
