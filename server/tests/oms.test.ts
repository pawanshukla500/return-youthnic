// SYNTHETIC FIXTURES ONLY. Invented listing and SKU rows, invented token values, and a fake fetch.
// These tests check the OMSGuru helpers and request shape. They do not call the real OMSGuru API,
// so they are not evidence that the live API behaves this way.
//
// Run: npm test

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  OmsClient,
  OmsError,
  isThrottleBody,
  listingImage,
  listingSku,
  listingTitle,
  moneyOrNull,
  normalizeImageUrl,
  normalizeSkuKey,
  remainingCredits,
  rowsFrom,
} from "../oms/client.js"
import { catalogEntry, listingRecord } from "../oms/catalog.js"
import { skuRecord } from "../oms/skus.js"

const synConfig = { baseUrl: "https://example.invalid", token: "SYN-TOKEN", clientId: "SYN-CID" }

test("[synthetic] rowsFrom reads a bare array and drops non-object items", () => {
  assert.deepEqual(rowsFrom([{ id: 1 }, "x", null, { id: 2 }]), [{ id: 1 }, { id: 2 }])
})

test("[synthetic] rowsFrom reads the data field of an envelope", () => {
  assert.deepEqual(rowsFrom({ error: 0, message: "ok", data: [{ id: 3 }] }), [{ id: 3 }])
})

test("[synthetic] rowsFrom treats a 'no ... found' answer as an empty list", () => {
  assert.deepEqual(rowsFrom({ error: 1, message: "No channel listings found" }), [])
})

test("[synthetic] rowsFrom throws on an error envelope with no data", () => {
  assert.throws(() => rowsFrom({ error: 7, message: "Something failed" }), OmsError)
})

test("[synthetic] normalizeSkuKey uppercases and collapses whitespace, as the Forward Scan join does", () => {
  assert.equal(normalizeSkuKey("  syn-sku   a  "), "SYN-SKU A")
  assert.equal(normalizeSkuKey(""), "")
  assert.equal(normalizeSkuKey(null), "")
})

test("[synthetic] listing SKU uses the Forward Scan priority: sku_name, then sku_code, sku, product_sku", () => {
  assert.equal(listingSku({ sku_name: "syn one", sku_code: "SYN TWO" }), "SYN ONE")
  assert.equal(listingSku({ sku_code: "syn two" }), "SYN TWO")
  assert.equal(listingSku({ product_sku: "syn four" }), "SYN FOUR")
  assert.equal(listingSku({}), "")
})

test("[synthetic] listing title and image read the same keys as the Forward Scan sync", () => {
  assert.equal(listingTitle({ name: "Synthetic name" }), "Synthetic name")
  assert.equal(listingTitle({ title: "Synthetic title", name: "other" }), "Synthetic title")
  assert.equal(listingImage({ image_url: "https://img.example.invalid/a.jpg" }), "https://img.example.invalid/a.jpg")
})

test("[synthetic] normalizeImageUrl keeps http(s), adds https to protocol-relative links, rejects other values", () => {
  assert.equal(normalizeImageUrl("https://img.example.invalid/a.jpg"), "https://img.example.invalid/a.jpg")
  assert.equal(normalizeImageUrl("//img.example.invalid/b.jpg"), "https://img.example.invalid/b.jpg")
  assert.equal(normalizeImageUrl("ftp://img.example.invalid/c.jpg"), "")
  assert.equal(normalizeImageUrl(42), "")
})

test("[synthetic] isThrottleBody matches error -4 only in a short body", () => {
  assert.equal(isThrottleBody({ error: "-4" }, 12), true)
  assert.equal(isThrottleBody({ error: "-4", message: "x".repeat(300) }, 320), false)
  assert.equal(isThrottleBody({ error: 0 }, 10), false)
})

test("[synthetic] catalog keeps a title-only listing and drops one with neither title nor image", () => {
  assert.deepEqual(catalogEntry({ sku_name: "syn a", title: "Synthetic A" }), {
    sku: "SYN A",
    title: "Synthetic A",
    imageUrl: "",
  })
  assert.equal(catalogEntry({ sku_name: "syn b" }), null)
  assert.equal(catalogEntry({ title: "No sku" }), null)
})

test("[synthetic] listing record keeps the mapped OMSGuru SKU id, the listing reference and the price", () => {
  assert.deepEqual(
    listingRecord({
      id: 501,
      listing_id: "SYN-LST-1",
      sku_name: "syn a",
      oms_sku_id: 9001,
      retail_price: 850.5,
      title: "Synthetic A",
      img_url: "https://img.example.invalid/a.jpg",
    }),
    {
      omsListingId: 501,
      listingRef: "SYN-LST-1",
      channelSku: "SYN A",
      omsSkuId: 9001,
      retailPrice: 850.5,
      title: "Synthetic A",
      imageUrl: "https://img.example.invalid/a.jpg",
    },
  )
})

test("[synthetic] an unmapped listing has no OMSGuru SKU id, and a listing without an id is not stored", () => {
  const unmapped = listingRecord({ id: 502, sku_name: "syn b", oms_sku_id: 0 })
  assert.equal(unmapped?.omsSkuId, null)
  assert.equal(unmapped?.retailPrice, null)
  assert.equal(listingRecord({ sku_name: "syn c", oms_sku_id: 9002 }), null)
})

test("[synthetic] money values accept numbers and numeric text, and drop blanks and negatives", () => {
  assert.equal(moneyOrNull(12.5), 12.5)
  assert.equal(moneyOrNull("99.999"), 100)
  assert.equal(moneyOrNull(""), null)
  assert.equal(moneyOrNull(null), null)
  assert.equal(moneyOrNull(-4), null)
})

test("[synthetic] SKU record maps the master SKU fields and needs an id", () => {
  assert.deepEqual(
    skuRecord({
      id: 9001,
      name: "Synthetic Shirt M",
      sku_code: " SYN-SHIRT-M ",
      selling_price: 499,
      mrp_price: "999",
      last_purchase_price: 0,
      sku_size_code: "M",
      sku_style_code: "",
      sku_model_code: "SYN-M",
      sku_color_code: "BLUE",
      sku_upc: 1234567890123,
    }),
    {
      omsSkuId: 9001,
      skuCode: "SYN-SHIRT-M",
      name: "Synthetic Shirt M",
      sellingPrice: 499,
      mrpPrice: 999,
      lastPurchasePrice: 0,
      sizeCode: "M",
      styleCode: "",
      modelCode: "SYN-M",
      colorCode: "BLUE",
      upc: "1234567890123",
    },
  )
  assert.equal(skuRecord({ sku_code: "SYN-NO-ID" }), null)
})

test("[synthetic] remaining credits come from X-OMS-Remaining, and are null when the header is missing", () => {
  assert.equal(remainingCredits(new Response("", { headers: { "x-oms-remaining": "42" } })), 42)
  assert.equal(remainingCredits(new Response("")), null)
})

test("[synthetic] client refuses to call OMSGuru without a token and client id", async () => {
  const client = new OmsClient({ baseUrl: "https://example.invalid", token: "", clientId: "" })
  await assert.rejects(client.listChannels(), OmsError)
})

test("[synthetic] client sends the bearer token and client id, and form-encodes the listing page without a limit field", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify({ success: true, data: [{ id: 5, sku_name: "SYN-1", title: "Synthetic" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  const client = new OmsClient(synConfig, fakeFetch as typeof fetch, async () => {})
  const rows = await client.listChannelListings(12, 0)
  assert.equal(rows.length, 1)
  assert.match(calls[0].url, /\/order_api\/list_channel_listings$/)
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers.Authorization, "Bearer SYN-TOKEN")
  assert.equal(headers["Oms-Cid"], "SYN-CID")
  assert.equal(calls[0].init.method, "POST")
  assert.match(String(calls[0].init.body), /channel_company_id=12/)
  assert.match(String(calls[0].init.body), /last_id=0/)
  assert.doesNotMatch(String(calls[0].init.body), /limit=/)
})

test("[synthetic] the master SKU list is a GET with last_id in the query string and no body", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify([{ id: 7, sku_code: "SYN-SKU-7" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  const client = new OmsClient(synConfig, fakeFetch as typeof fetch, async () => {})
  const rows = await client.listSkus(0)
  assert.deepEqual(rows, [{ id: 7, sku_code: "SYN-SKU-7" }])
  assert.match(calls[0].url, /\/order_api\/skus\?last_id=0$/)
  assert.equal(calls[0].init.method, "GET")
  assert.equal(calls[0].init.body, undefined)
})

test("[synthetic] the client waits one credit refill when X-OMS-Remaining is at the floor, and not when it is high", async () => {
  const waits: number[] = []
  const recordWait = async (ms: number) => {
    waits.push(ms)
  }
  const bodyText = JSON.stringify([{ id: 1 }])
  const lowFetch = async () =>
    new Response(bodyText, {
      status: 200,
      headers: { "content-type": "application/json", "x-oms-remaining": "2" },
    })
  const highFetch = async () =>
    new Response(bodyText, {
      status: 200,
      headers: { "content-type": "application/json", "x-oms-remaining": "40" },
    })
  await new OmsClient(synConfig, lowFetch as typeof fetch, recordWait).listSkus(0)
  assert.deepEqual(waits, [5000])
  waits.length = 0
  await new OmsClient(synConfig, highFetch as typeof fetch, recordWait).listSkus(0)
  assert.deepEqual(waits, [])
})
