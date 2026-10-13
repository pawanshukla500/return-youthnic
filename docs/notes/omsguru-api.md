# OMSGuru API: what the return app uses, and what is still unverified

Last updated: 2026-10-08.

## Sources

| Source | What it gives | Status |
|---|---|---|
| OMSGuru API 1.0.1 (SwaggerHub `ketan9/OMSGuruAPI`), pasted into the chat on 2026-10-08 | Paths, form and query fields, paging, rate limit, response fields, order status IDs | Read. Not saved in the project yet. Save it as `docs\layouts\omsguru-openapi.yaml` to keep a copy |
| Forward Scan project (`backend\app\oms\client.py`, `sync.py`) | Earlier reference for auth, envelope and paging | Read earlier. Where the spec differs, the spec wins. Example: the listing request has no `limit` field in the spec |

The code now follows the spec. Nothing has been run against the live API.

## Daily job: `npm run sync:oms`

This is the only pull meant to run every day. Orders and invoices are on demand.

What a run does, in order:

1. `GET /order_api/list_channels`: the channel list (one request).
2. For each active channel: `POST /order_api/list_channel_listings`, 100 per page, paged by `last_id`, until a page shorter than 100.
3. `GET /order_api/skus`: the master SKU list, 100 per page, paged by `last_id`, until an empty page.

What it writes:

| Table | One row per | Notes |
|---|---|---|
| `oms_listings` | listing record | Every field, plus `oms_sku_id` (NULL when not mapped), `retail_price`, `title`, `image_url`, and the full record in `payload` |
| `oms_skus` | master SKU | No image field in the spec |
| `sku_catalog` | listing SKU (normalized) | One title and one image per SKU. The upload preview and the item label read this |
| `oms_sync_runs` | sync step | Status, pages, rows, new rows, error text |

The script prints, per channel: listings, how many are mapped to a master SKU, and how many are new (and new and mapped). It then prints master SKUs stored and new, and the stored totals.

Request budget (example only): 3,000 listings across two channels and 5,000 master SKUs is about 85 requests. That is roughly 1 + 32 + 51 plus a few extra end-of-list calls. The rate limit is 60 per 5 minutes. The client waits when credits run low, so the run takes a few minutes longer. It does not fail.

Scheduling (Windows Task Scheduler or a `.bat` file) is not built yet. Run it by hand each day until then.

## Endpoints

| Method and path | Fields sent | Used by | Notes |
|---|---|---|---|
| `GET /order_api/list_channels` | none (optional `status`: `active`, `pending`) | `sync:oms` | Response: `success`, `data[]` with `id`, `name`, `channel_name`, `company_name`, `status` |
| `POST /order_api/list_channel_listings` | form: `channel_company_id`, `last_id` | `sync:oms` | Up to 100 per request. No `limit` field. Response fields: `id`, `channel_company_id`, `listing_id`, `sku_name`, `oms_sku_id`, `retail_price`, `title`, `img_url` |
| `GET /order_api/skus` | query: `last_id` (required), `sku_id` (optional, CSV) | `sync:oms` | Up to 100 per request. Fields: `id`, `name`, `sku_code`, `selling_price`, `mrp_price`, `last_purchase_price`, `sku_size_code`, `sku_style_code`, `sku_model_code`, `sku_color_code`, `sku_upc`. No image |
| `POST /order_api/invoices` | `start_invoice_date`, `end_invoice_date` (max 45 days apart), `last_id`, `limit` (max 100) | `oms:daily` (on demand) | Invoices by day, with AWB. Not in the daily job |
| `POST /order_api/order_details` | `order_id` or `sub_order_id` or `id` | `oms:orders` (on demand) | Lookup by order id only. Not by AWB |
| `POST /order_api/return_details` | `start_return_date`, `end_return_date` (max 45 days), `channel_id`, `last_id`, `limit`, `warehouse_id` | not used yet | Returns initiated in a date window. This is the endpoint for the return lifecycle data, once the fields are decided |
| `POST /order_api/orders`, `GET /order_api/order_aging`, `GET /order_api/warehouses` | see spec | not used | |

Write endpoints in the spec (cancel order, create order, stock updates, vendors, purchase orders, gate passes, and the rest) are not used. The return app does not write to OMSGuru.

## Rate limit

- 60 requests per 5 minutes. Token bucket: one credit back every 5 seconds.
- Every response carries `X-OMS-Limit`, `X-OMS-CurUsage`, `X-OMS-Remaining`, `X-OMS-Reset`. A 429 adds `Retry-After`.
- Throttled body: `{ "error": -4, "message": "API Throttled" }`.
- What the client does: waits 5 seconds when `X-OMS-Remaining` is 3 or less. Retries 429 and 5xx responses with backoff, honouring `Retry-After`, up to 5 attempts.

## Joins

- Listing to master SKU: `oms_listings.oms_sku_id = oms_skus.oms_sku_id`.
- Listing to the app's SKU (title and image): `oms_listings.channel_sku` (normalized: uppercase, single spaces) matches `sku_catalog.sku`.
- Image: only from the listing's `img_url`. The SKU record has no image.
- The VB EXPORT product master (`product_master`, from the Excel file) still gives the item code. `sku_catalog` only fills titles and images.

## Order status IDs (reference for later order work, not used yet)

| ID | Status | Stage |
|---|---|---|
| 16 | New | Open |
| 23 | Pending | Open |
| 9 | Packed | Processing |
| 1 | ReadyToShip | Processing |
| 18 | InTransit | Shipped |
| 3 | Delivered | Shipped |
| 10 | ReturnInit | Return |
| 6 | CancelInit | Cancellation |
| 5 | Return Received | Return |
| 13 | Cancelled Return Received | Return |
| 15 | Cancelled | Cancellation |
| 19 | Cancelled Before Shipping | Cancellation |
| 20 | Removed Before Shipping | Cancellation |
| 25 | Partial Return Received | Return |

The spec's item status list also includes Bad Return Received, Return Rejected, and Partial Cancelled Return Received. Those are not in the table above.

## What is not verified

- Not run against the live API. `npm run typecheck` and `npm test` have not been run in this environment (no shell here).
- Listing paging stops at the first page shorter than 100. If OMSGuru returns fewer than 100 on a page that is not the last, the run stops early. Compare the listing count with the OMSGuru panel on the first run.
- The spec's listing request has no `limit` field, so the client no longer sends one. Forward Scan did. Confirm on the first run that OMSGuru still returns up to 100.
- SKU paging stops only on an empty page or when the cursor stops moving. The spec does not state a page size for that call, so a short page does not end the loop.
- Listings have no date filter. Each daily run reads every listing, so title, price and image changes are picked up. "New" means the listing id was not in `oms_listings` before this run.
- The spec is in the chat only. Save it to `docs\layouts\`.
- Return data is not pulled yet. `return_details` is the endpoint to use, after the return fields are chosen.

## Steps for you

1. Save the spec to `docs\layouts\omsguru-openapi.yaml`.
2. In the project folder, run `npm run typecheck`, then `npm test`. If either fails, send the last lines of output.
3. Run `npm run sync:oms -- --list`. Send the channel IDs and names. Do not send any credentials.
4. Run `npm run sync:oms`. Send the summary lines it prints.
5. Run `npm run sync:oms` again the same day. The "new" count should be 0, unless OMSGuru added listings. If it is not 0 and nothing changed, the id key is wrong.
6. If the SKU step fails or is slow, run `npm run sync:oms -- --skip-skus` so the listings still load.
