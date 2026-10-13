import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Request, Response } from "express"
import type { Queryable } from "./logistics.js"

const cacheDir = path.join(os.tmpdir(), "return-catalog-images")
const inflight = new Map<string, Promise<{ type: string; file: string } | null>>()
const MAX_BYTES = 2_000_000

function publicUrl(value: string): URL | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  const host = url.hostname.toLowerCase()
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    return null
  }
  return url
}

// Marketplace CDNs will serve a small image when asked. The stored link stays the original.
function fetchUrlFor(url: URL): string {
  if (url.hostname === "img.fkcdn.com" && url.pathname.startsWith("/image/")) {
    return `https://rukminim2.flixcart.com/image/416/416${url.pathname.slice("/image".length)}${url.search}`
  }
  if (url.hostname === "cdn.shopify.com" && !url.searchParams.has("width")) {
    const copy = new URL(url.href)
    copy.searchParams.set("width", "480")
    return copy.href
  }
  return url.href
}

function imageType(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg"
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png"
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif"
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp"
  return ""
}

async function storedImage(db: Queryable, href: string): Promise<boolean> {
  const found = await db.query(
    `SELECT 1 FROM product_master WHERE image_url = $1
     UNION ALL SELECT 1 FROM skus WHERE image_url = $1
     UNION ALL SELECT 1 FROM sku_catalog WHERE image_url = $1
     LIMIT 1`,
    [href],
  )
  return found.rows.length > 0
}

async function loadImage(db: Queryable, href: string, target: URL): Promise<{ type: string; file: string } | null> {
  fs.mkdirSync(cacheDir, { recursive: true })
  const file = path.join(cacheDir, crypto.createHash("sha256").update(href).digest("hex"))
  const typeFile = `${file}.type`
  if (fs.existsSync(file) && fs.existsSync(typeFile)) {
    return { type: fs.readFileSync(typeFile, "utf8"), file }
  }
  const known = await storedImage(db, href)
  if (!known) return null
  const response = await fetch(fetchUrlFor(target), {
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    headers: { "user-agent": "ReturnApp/1.0" },
  })
  if (!response.ok) return null
  const landed = publicUrl(response.url)
  if (!landed) return null
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return null
  const type = imageType(bytes)
  if (!type) return null
  fs.writeFileSync(file, bytes)
  fs.writeFileSync(typeFile, type)
  return { type, file }
}

// Serves a catalog image the product master or a saved SKU already stores. The file is cached
// on this machine, and Flipkart and Shopify links are asked for a small size.
export async function sendCatalogImage(req: Request, res: Response, db: Queryable): Promise<void> {
  const href = String(req.query.url || "")
  const target = publicUrl(href)
  if (!target) {
    res.status(400).end()
    return
  }
  const key = href
  let pending = inflight.get(key)
  if (!pending) {
    pending = loadImage(db, href, target).catch(() => null)
    inflight.set(key, pending)
  }
  const image = await pending
  inflight.delete(key)
  if (!image) {
    res.status(404).end()
    return
  }
  res.setHeader("Content-Type", image.type)
  res.setHeader("Cache-Control", "public, max-age=86400")
  fs.createReadStream(image.file).pipe(res)
}
