// OMSGuru API client for the return app.
//
// Endpoint paths, form fields, paging and the response envelope were checked against the OMSGuru
// SwaggerHub spec (OMSGuru API 1.0.1), pasted into the chat on 2026-10-08. The spec is not saved in the
// project yet. Re-check these against it if OMSGuru publishes a new version.
//
// Rate limit (from the spec): 60 requests per 5 minutes, token bucket, one credit back every 5 seconds.
// Every 200 response carries X-OMS-Remaining. When it drops to PACE_FLOOR or lower, the client waits
// PACE_WAIT_MS before the next call. A 429 (or a small 200 with error -4) is retried after Retry-After.
//
// Credentials come from environment variables only: OMSGURU_API_TOKEN, OMSGURU_CLIENT_ID and optionally
// OMSGURU_BASE_URL. Values are never logged or returned to the browser.

export class OmsError extends Error {}
export class OmsThrottled extends OmsError {}

export type OmsRow = Record<string, unknown>

type QueryValue = string | number | undefined | null
export type OmsConfig = { baseUrl: string; token: string; clientId: string }

// Same default host as the Forward Scan project and the OMSGuru spec. Override with OMSGURU_BASE_URL.
const DEFAULT_BASE_URL = "https://client.omsguru.com"
const MAX_ATTEMPTS = 5
const REQUEST_TIMEOUT_MS = 60_000
// Spec: list endpoints return at most 100 records per request.
export const OMS_PAGE_LIMIT = 100
// Spec: one credit refills every 5 seconds. Wait one refill when this few credits are left in the window.
const PACE_FLOOR = 3
const PACE_WAIT_MS = 5_000

export function omsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OmsConfig {
  return {
    baseUrl: (env.OMSGURU_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    token: env.OMSGURU_API_TOKEN?.trim() || "",
    clientId: env.OMSGURU_CLIENT_ID?.trim() || "",
  }
}

function isRow(value: unknown): value is OmsRow {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// OMSGuru returns either a bare array or an envelope { error, message, data }.
// A non-zero error without data is a failure, except "no ... found" answers, which mean an empty list.
export function rowsFrom(body: unknown): OmsRow[] {
  if (Array.isArray(body)) return body.filter(isRow)
  if (!isRow(body)) return []
  const err = body.error
  const hasError = err !== undefined && err !== null && err !== 0 && err !== "0" && err !== false
  if (hasError && !body.data) {
    const message = String(body.message || `error ${String(err)}`)
    const lower = message.toLowerCase()
    if (lower.includes("no ") && lower.includes("found")) return []
    throw new OmsError(`OMSGuru error ${String(err)}: ${message}`)
  }
  if (Array.isArray(body.data)) return body.data.filter(isRow)
  return []
}

// A small 200 response whose error is "-4" means the shared rate limit was hit (Forward Scan rule).
export function isThrottleBody(body: unknown, bodyLength: number): boolean {
  return bodyLength <= 200 && isRow(body) && String(body.error) === "-4"
}

// Uppercase, whitespace collapsed. Used for every SKU join, so the same listing matches everywhere.
export function normalizeSkuKey(value: unknown): string {
  if (!value) return ""
  return String(value).replace(/\s+/g, " ").trim().toUpperCase()
}

// Keeps only absolute http(s) image links. Protocol-relative links (//host/...) get https.
export function normalizeImageUrl(value: unknown): string {
  if (typeof value !== "string") return ""
  let url = value.trim()
  if (!url) return ""
  if (url.startsWith("//")) url = `https:${url}`
  return /^https?:\/\//i.test(url) ? url : ""
}

// First non-empty value among the keys. Numbers are read as text.
export function firstText(row: OmsRow, keys: string[]): string {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return ""
}

// A price or cost as a number rounded to two decimals. Null when absent, blank, not a number, or negative.
export function moneyOrNull(value: unknown): number | null {
  let number: number
  if (typeof value === "number") number = value
  else if (typeof value === "string" && value.trim() !== "") number = Number(value)
  else return null
  if (!Number.isFinite(number) || number < 0) return null
  return Math.round(number * 100) / 100
}

// Listing fields, in the same priority order as the Forward Scan project.
export function listingSku(row: OmsRow): string {
  return normalizeSkuKey(firstText(row, ["sku_name", "sku_code", "sku", "product_sku"]))
}

export function listingImage(row: OmsRow): string {
  return normalizeImageUrl(firstText(row, ["img_url", "image_url", "imageUrl", "image"]))
}

export function listingTitle(row: OmsRow): string {
  return firstText(row, ["title", "name"])
}

export function listingId(row: OmsRow): number | null {
  const value = Number(row.id)
  return Number.isFinite(value) && value > 0 ? value : null
}

// Credits left in the rate-limit window from X-OMS-Remaining, or null when the header is absent.
export function remainingCredits(response: Response): number | null {
  const raw = response.headers.get("x-oms-remaining")
  if (raw === null || raw.trim() === "") return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Backoff grows with each attempt, capped at one minute. A Retry-After header is honoured if larger.
function backoffMs(attempt: number, retryAfterSeconds = 0) {
  return Math.max(Math.min(60_000, 2 ** attempt * 1000), retryAfterSeconds * 1000)
}

export class OmsClient {
  constructor(
    private readonly config: OmsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleepImpl: (ms: number) => Promise<void> = sleep,
  ) {}

  private assertConfigured() {
    if (!this.config.token || !this.config.clientId) {
      throw new OmsError("OMSGURU_API_TOKEN and OMSGURU_CLIENT_ID are not set in .env")
    }
  }

  // One request with retries for network errors, 5xx and rate limits. Never logs headers or the token.
  async request(
    method: "GET" | "POST",
    path: string,
    options: { form?: Record<string, QueryValue>; query?: Record<string, QueryValue> } = {},
  ): Promise<unknown> {
    this.assertConfigured()
    for (let attempt = 1; ; attempt++) {
      const url = new URL(this.config.baseUrl + path)
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.config.token}`,
        "Oms-Cid": this.config.clientId,
        Accept: "application/json",
        "User-Agent": "ReturnApp/1.0",
      }
      let body: URLSearchParams | undefined
      if (method === "POST") {
        body = new URLSearchParams()
        for (const [key, value] of Object.entries(options.form ?? {})) {
          if (value !== undefined && value !== null) body.set(key, String(value))
        }
        headers["Content-Type"] = "application/x-www-form-urlencoded"
      }

      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw new OmsError(`Network error on ${path}: ${(error as Error).message}`)
        await this.sleepImpl(backoffMs(attempt))
        continue
      }

      if (response.status === 401) {
        throw new OmsError("401 Unauthorized. Check OMSGURU_API_TOKEN and OMSGURU_CLIENT_ID in .env")
      }
      const text = await response.text()
      let parsed: unknown
      try {
        parsed = text ? JSON.parse(text) : undefined
      } catch {
        parsed = undefined
      }
      const retryAfter = Number(response.headers.get("retry-after")) || 0
      const throttled = response.status === 429 || (response.status === 200 && isThrottleBody(parsed, text.length))
      if (throttled) {
        if (attempt >= MAX_ATTEMPTS) throw new OmsThrottled("OMSGuru API throttled. Try again later.")
        await this.sleepImpl(backoffMs(attempt, retryAfter))
        continue
      }
      if (response.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) throw new OmsError(`HTTP ${response.status} on ${path}`)
        await this.sleepImpl(backoffMs(attempt, retryAfter))
        continue
      }
      if (response.status >= 400) {
        throw new OmsError(`HTTP ${response.status} on ${path}: ${text.slice(0, 200)}`)
      }
      if (parsed === undefined) throw new OmsError(`Non-JSON response from ${path}`)
      // Spec: X-OMS-Remaining is the credits left. Near zero, wait one refill before the next call.
      const remaining = remainingCredits(response)
      if (remaining !== null && remaining <= PACE_FLOOR) await this.sleepImpl(PACE_WAIT_MS)
      return parsed
    }
  }

  async listChannels(): Promise<OmsRow[]> {
    return rowsFrom(await this.request("GET", "/order_api/list_channels"))
  }

  async listWarehouses(): Promise<OmsRow[]> {
    return rowsFrom(await this.request("GET", "/order_api/warehouses"))
  }

  // Listings of one sales channel, paged by last_id. The spec returns up to 100 per request and has no limit field.
  async listChannelListings(channelCompanyId: number, lastId = 0): Promise<OmsRow[]> {
    return rowsFrom(
      await this.request("POST", "/order_api/list_channel_listings", {
        form: { channel_company_id: channelCompanyId, last_id: lastId },
      }),
    )
  }

  // Master SKUs of the client, paged by last_id (GET with a query string, per the spec). No image field.
  async listSkus(lastId = 0): Promise<OmsRow[]> {
    return rowsFrom(await this.request("GET", "/order_api/skus", { query: { last_id: lastId } }))
  }

  // OMSGuru answers order lookups by order id or sub-order id only, never by AWB (Forward Scan rule).
  async orderDetails(lookup: { orderId?: string; subOrderId?: string }): Promise<OmsRow[]> {
    return rowsFrom(
      await this.request("POST", "/order_api/order_details", {
        form: { order_id: lookup.orderId, sub_order_id: lookup.subOrderId },
      }),
    )
  }
}
