<!-- Updated 2026-10-10 from the route definitions and parser tests. A running upload route and browser have not been exercised. -->
# API reference

The API is an Express 4 server. It serves JSON under `/api`. The routes are in `server/index.ts` (sign-in, dashboard, claims, administrator pages), `server/upload-routes.ts` (uploads) and `server/register-routes.ts` (accounts, scanning, the register, tickets, and partner and category administration). The code is the contract. The shapes below are taken from the service functions in `server/register-service.ts`, `server/dashboard.ts`, `server/admin-config.ts` and `server/upload-routes.ts`. There is no OpenAPI or Swagger file.

Status: written from the code. **No request in this document has been sent to a running server.** Run the server and check a route before you rely on its shape.

## Authentication

Sign in with `POST /api/auth/login`. The response contains a `token`. Send it on every later request:

```http
Authorization: Bearer <token>
```

The token is a random 32-byte value stored in the `sessions` table. `POST /api/auth/logout` deletes it. The check on each request reads the session row and the user row. It does **not** check the session's age, so a session does not expire on its own. See [agent-handoff.md](notes/agent-handoff.md#known-risks-and-gaps).

There are no API keys.

## Authorization

Every route below except the health check and sign-in needs a valid session (`requireUser`). Two more rules apply:

**Account scope.** Every route that reads or changes account data limits its query to the accounts the user may use. The rule is in `server/access.ts`:

| User | Accounts they can see |
|---|---|
| Role `Admin` (any letter case) | Every account, and may change configuration |
| `users.has_all_marketplaces` is true | Every account |
| Otherwise | The accounts in `user_marketplaces` |
| No assignment | None |

The scope is applied in SQL, with the account list as a bound parameter. A request cannot widen it by changing a filter, an ID or a URL.

**Administrator routes.** The routes marked **Admin** below need the role `Admin`. Any other role gets HTTP 403 with `Only an administrator can use this.`

## Errors

Errors are JSON with the message in `error`. Rule failures also list each problem in `details`:

```json
{ "error": "The scan is not complete. Fix the items listed below.", "details": ["Item 2: the issue category \"retired\" is not available."] }
```

| Status | Meaning |
|---|---|
| 400 | Bad input or a rule failure. Nothing is saved. `error` says what is wrong, and `details` lists each problem when there are several. |
| 401 | No valid session. The message is `Sign in required`. A wrong email or password on sign-in returns 401 with `Incorrect email or password.` |
| 403 | A named account the user may not use (`You do not have access to this account. Ask an administrator to assign it.`), or an Admin route for another role (`Only an administrator can use this.`). |
| 404 | The record was not found, or it is outside the user's accounts. The response does not say which. |
| 409 | A conflict. The AWB was already received (the body has `time` and `scannedBy`), a scan key was reused for another return, a ticket ID is already recorded, the return is no longer in the active lookup data, or an upload cannot be activated (see the upload routes). |
| 500 | An unexpected error. The response carries the server's error message as it is. See [known risks](notes/agent-handoff.md#known-risks-and-gaps). |
| 503 | The database is not connected yet. |

An upload larger than 25 MB returns HTTP 400 with `File is larger than 25 MB`.

## Rate limits and CORS

No rate limiting is configured. No rate-limit package is in `package.json`. CORS is enabled with the defaults of the `cors` package, which allow any origin. The JSON body limit is 2 MB.

## Endpoint index

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | No | Database connection status. |
| GET | `/api/catalog-image` | No | A stored catalog image. Query `url` must be an http(s) link already saved on a product-master row, a SKU, or the catalog. |
| POST | `/api/auth/login` | No | Signs in and returns a token. |
| GET | `/api/auth/me` | Yes | The signed-in user, with the claims badge and header date. |
| POST | `/api/auth/logout` | Yes | Ends the session. |
| GET | `/api/dashboard` | Yes | Overview figures for the user's accounts. |
| GET | `/api/claims` | Yes | Claim figures for the user's accounts. |
| GET | `/api/accounts` | Yes | The accounts the user may use. |
| GET | `/api/uploads` | Yes | Upload history for the user's accounts. |
| GET | `/api/uploads/template` | Yes | The generic template, a header row only. |
| POST | `/api/uploads/preview` | Yes | Reads one file for one account and stages it. Changes no lookup data. |
| POST | `/api/uploads/import` | Yes | Activates a staged file as the account's lookup data. |
| POST | `/api/uploads/scanner-list/preview` | Yes | Reads a multi-sheet scanner list and validates entries against active lookups. It never activates data or creates scans. |
| POST | `/api/scan/lookup` | Yes | Finds the return for an AWB: found, duplicate, choose, or not found. |
| GET | `/api/scan/session` | Yes | Today's scan counts, the accounts, the active issue categories, and the active sub-issues. |
| POST | `/api/scan/complete` | Yes | Records one physical scan with every item verified. A retry with the same key is safe. |
| GET | `/api/register` | Yes | The return register: one row per verified item, with filters, sorting and paging. |
| GET | `/api/register/export` | Yes | The register rows that match the filters, as CSV or Excel. |
| GET | `/api/register/options` | Yes | Accounts, scanners, partners, active categories and ticket statuses for the filters. |
| PATCH | `/api/tickets/:id/status` | Yes | Changes a ticket's status. A rejection needs a reason. Every change is kept. |
| GET | `/api/tickets/:id/history` | Yes | The status history of one ticket, oldest first. |
| GET | `/api/admin/users` | Admin | Team members, with their email addresses. |
| GET | `/api/admin/issue-options` | Admin | Active missing-item sub-issues. |
| POST | `/api/admin/issue-options` | Admin | Adds a sub-issue to a category that takes sub-issues. |
| DELETE | `/api/admin/issue-options/:id` | Admin | Deactivates a sub-issue. Past scans keep their label. |
| GET | `/api/admin/issue-categories` | Admin | All issue categories with their switches. |
| PATCH | `/api/admin/issue-categories/:code` | Admin | Turns a category on or off, or changes whether it needs a ticket ID. "No issue" cannot change. |
| GET | `/api/admin/accounts` | Admin | Marketplace accounts, with upload status. |
| GET | `/api/admin/system` | Admin | Database status and the count of scanned returns. |
| GET | `/api/admin/logistics-partners` | Admin | Partners, with their courier names (aliases) and tracking hosts. |
| POST | `/api/admin/logistics-partners` | Admin | Adds a partner. |
| PATCH | `/api/admin/logistics-partners/:id` | Admin | Switches a partner on or off. |
| POST | `/api/admin/logistics-partners/:id/aliases` | Admin | Adds a courier name, for all accounts or one account. |
| PATCH | `/api/admin/logistics-partner-aliases/:id` | Admin | Switches a courier name on or off. |
| POST | `/api/admin/logistics-partners/:id/domains` | Admin | Adds a verified tracking host. |
| PATCH | `/api/admin/logistics-partner-domains/:id` | Admin | Switches a tracking host on or off. |
| GET | `/api/admin/product-master` | Admin | The VB EXPORT product master as it stands, with sample rows. |
| GET | `/api/admin/product-master/template` | Admin | A header-only CSV for the product SKU master. It has no data rows. |
| POST | `/api/admin/product-master/preview` | Admin | Reads one file and reports what it holds, for a chosen marketplace. Changes nothing. |
| POST | `/api/admin/product-master/import` | Admin | Replaces the whole product master from one file, for a chosen marketplace. Needs `confirm`. |

Removed: `GET /api/returns`, `GET /api/returns/export` and `PATCH /api/returns/:id/ticket`. Use `/api/register`, `/api/register/export` and `/api/tickets/:id/status`.

Any other path under `/api` returns Express's default 404 response. Paths outside `/api` return the web app, when the built `dist/` folder exists.

## Health and sign-in

`GET /api/health` returns HTTP 200 when the database is connected:

```json
{ "ok": true, "database": "connected", "name": "<database name>" }
```

It returns HTTP 503 with `{ "ok": false, "database": "disconnected", "message": "<reason>" }` otherwise. The name of the database is shown to anyone who calls this route.

`GET /api/catalog-image?url=<encoded link>` returns the image bytes for a link this app already stored. The link must be http or https, and the host must not be a private address. Flipkart links on `img.fkcdn.com` whose path starts with `/image/` are fetched at 416 pixels. A Shopify link on `cdn.shopify.com` is fetched with `width=480` when it has no width yet. The bytes are cached in the machine temp folder. A second request for the same link does not call the marketplace again. The route is not a general image proxy: a link that is not in `product_master.image_url`, `skus.image_url`, or `sku_catalog.image_url` returns 404. Do not log the `url` query.

`POST /api/auth/login` takes the email (or the login alias) and the password:

```json
{ "email": "<email>", "password": "<password>" }
```

It returns:

```json
{
  "token": "<64 hex characters>",
  "user": { "id": 1, "initials": "...", "name": "...", "email": "...", "role": "Admin", "sidebarLabel": "...", "assignedMarketplaces": "All marketplaces", "scansToday": "0", "status": "Active", "lastActive": "..." },
  "claimsBadge": "<count of claim tickets not yet approved or rejected, for the user's accounts>",
  "headerDate": "<date label>"
}
```

`GET /api/auth/me` returns `{ "user", "claimsBadge", "headerDate" }` for the signed-in user. `POST /api/auth/logout` returns `{ "ok": true }`.

`assignedMarketplaces` is `All marketplaces` when the user has the all-accounts flag, otherwise the names of the assigned accounts.

## Accounts

`GET /api/accounts` returns the accounts the signed-in user may use, in the order the screens show them:

```json
{ "accounts": [{ "id": 5, "name": "Myntra EJ" }, { "id": 6, "name": "Myntra VB" }] }
```

The scan, upload and register screens fill their account lists from this route. A user with no assignment gets `{ "accounts": [] }`.

## Overview and claims

`GET /api/dashboard` returns the overview figures, counted from the scans of the user's accounts on each request:

```json
{
  "stats": [
    { "label": "Returns received", "value": "12", "delta": "3 scanned today", "icon": "box", "tone": "blue" },
    { "label": "Issue returns", "value": "4", "delta": "1 issues today", "icon": "alert", "tone": "orange" },
    { "label": "Claims raised", "value": "2", "delta": "1 open", "icon": "claim", "tone": "purple" },
    { "label": "Clear rate", "value": "66.7%", "delta": "Clear returns out of all scans", "icon": "check", "tone": "green" }
  ],
  "dailyAvg": "1.7",
  "chartBars": [{ "weekday": "Sat", "d": "4", "received": 2, "issues": 1, "v": 40, "i": 20 }],
  "reasons": [{ "name": "Damaged product", "count": "3", "width": 100 }],
  "marketIssues": { "total": "4", "subtitle": "4 issue returns across the accounts you can see", "slices": [{ "name": "Myntra EJ", "count": "4", "pct": "100.0%", "share": 100 }] },
  "skus": [{ "sku": "SYN-SKU-1", "name": "SYN product", "issues": "2", "rate": "50.0%" }],
  "recent": [{ "id": "SYN-AWB-1", "order": "SYN-ORDER-1", "sku": "SYN-SKU-1", "market": "Myntra EJ", "courier": "SYN-COURIER", "type": "Customer Return", "issue": "No issue", "ticket": "", "status": "Clear", "time": "10:31 AM" }]
}
```

`chartBars` covers the last seven IST days, oldest first. `weekday` is the day name, `d` is the day of the month, and `received` and `issues` are the counts. `v` and `i` are those counts as percentages of the busiest day, used only to draw the bars. A day with no scans is zero, not a minimum bar. `share` on each marketplace slice is the percentage used to draw the ring. `dailyAvg` is the seven-day total divided by seven. `recent` has the four latest scans, with the first ticket of each scan. The `recent` rows use the field names shown above, not the register's.

`GET /api/claims` returns `{ "stats", "total", "slices", "rows" }`. Each slice has `name`, `count`, `pct` and `tone`. Each row has `market`, `raised`, `approved`, `review` (tickets with status `Review` or `Raised`), `rejected`, `value` (always `—`) and `rate`, which is approved as a whole-number percentage of raised. A claim is open until it is approved or rejected.

## Uploads

Every upload route needs the account to be one the user may use.

### `GET /api/uploads`

The upload history for the user's accounts, newest first, at most 200 rows:

```json
{ "rows": [{ "id": 3, "filename": "SYN-EJ.csv", "marketplace": "Myntra EJ", "rowCount": "120", "scannableRows": 118, "pendingRows": 1, "rejectedRows": 1, "uploadedAt": "...", "status": "Imported with exceptions", "format": "myntra-seller-returns" }] }
```

### `GET /api/uploads/template`

The generic template as a CSV download named `return-upload-template.csv`. It is a header row with no sample data:

```text
tracking_id,order_id,channel_sku,product_sku,product_name,quantity,courier,return_type,return_reason,color,key_detail,brand_label,set_contents
```

### `POST /api/uploads/preview`

A multipart form with two fields: `file` (the CSV or Excel file, up to 25 MB) and `marketplace` (the account the file belongs to). The route reads the file, checks it, and stages it for activation. **It changes no lookup data.**

Response (HTTP 200, also for a file that cannot be read):

```json
{
  "uploadId": "<UUID, or null when the file is fatal>",
  "filename": "SYN-EJ.csv",
  "marketplace": "Myntra EJ",
  "profile": "myntra-seller-returns",
  "fatal": "",
  "headers": { "found": ["return_tracking_number", "order_id"], "missing": [] },
  "counts": {
    "rows": 3, "validRows": 2, "scannableRows": 2, "pendingRows": 0, "duplicateRows": 0,
    "errorRows": 1, "cancelledRows": 0,
    "exactDuplicateRows": 0, "repeatedRows": 0, "untrustedIdentifierRows": 0,
    "trackingCorrectedRows": 0, "trackingKeptRows": 0, "trackingUncheckedRows": 0, "warningRows": 1
  },
  "blockers": [],
  "confirmations": ["1 row(s) will remain in upload history but will not become active scan lookups. Confirm the partial activation and review the row exceptions."],
  "canActivate": true,
  "exceptions": [{ "line": 3, "status": "rejected", "reasons": ["..."], "sourceTrackingId": "...", "trackingId": "", "orderId": "...", "shipmentId": "...", "quantity": 1, "returnType": "Return", "carrier": "", "listingSku": "..." }],
  "errors": [{ "line": 3, "message": "..." }],
  "trackingCorrections": [{ "line": 2, "trackingId": "...", "csvTrackingId": "...", "urlTrackingId": "", "validation": "mismatch_kept" }],
  "partners": [{ "name": "Unknown / Pending Verification", "rows": 2 }],
  "productMapping": { "checked": 2, "mappedRows": 2, "titledRows": 0, "unmappedCount": 0, "unmappedSample": [] },
  "warnings": ["..."],
  "message": "2 rows ready. Activating replaces the active Myntra EJ lookup data. Scanned returns stay in the register."
}
```

- `fatal` is set when the file is refused before any row is kept. Two cases give it: no header row at all, and a missing required column for the layout. A seller ID that does not match the chosen account also gives it, and the message lists the account IDs. `uploadId` is then `null`, and `blockers` gives the reason.
- `canActivate` is true only when `blockers` is empty and at least one row is scannable. Pending, rejected, duplicate and cancelled rows remain in `upload_rows` but do not enter active lookup data.
- `confirmations` lists what the person must confirm before activation: partial activation, identifiers Excel stored as numbers, and tracking links that disagree with the file. It is shown only when the file can otherwise be activated.
- `exceptions` contains structured row details for every non-scannable row. The screen groups and searches these rows; a client can export them as CSV.
- `errors` and `trackingCorrections` show at most 20 rows each.

Refusals that return HTTP 4xx:

| Status | `error` |
|---|---|
| 400 | `Choose a CSV or XLSX file` |
| 400 | `Select a marketplace before importing` |
| 400 | `Select a connected marketplace before importing` |
| 400 | `This file has rows for <account>, but <marketplace> is selected. Upload one account per file.` An account the user cannot see is named as `another account`. |
| 403 | `You do not have access to this account. Ask an administrator to assign it.` |

### `POST /api/uploads/import`

Activates a staged file. The request body:

```json
{ "uploadId": "<UUID from the preview>", "confirm": true }
```

`confirm` must be `true` when the preview listed any confirmations. The server checks everything again before it commits: the owner of the preview, its age (15 minutes), the account scope, every blocker, and the confirmations. The staged file is removed before the commit starts, so the same preview cannot be activated twice.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ "row", "activatedRows", "supersededRows", "cancelledRows", "confirmed" }` | Activated. Earlier active rows for the account are kept as `superseded`. |
| 400 | `{ "error": "Upload the file again before importing." }` | The preview is unknown, or belongs to another user. |
| 400 | `{ "error": "That file preview expired. Upload it again." }` | Older than 15 minutes. |
| 403 | `{ "error": "You do not have access to this account. ..." }` | The account is outside the user's scope. |
| 409 | `{ "error": "<first blocker>", "blockers": ["..."] }` | A blocker remains. Nothing is activated. |
| 409 | `{ "error": "Confirm the items listed before activating.", "confirmations": ["..."] }` | Confirmation is needed and `confirm` is not `true`. |

The success response:

```json
{
  "row": { "id": 4, "filename": "SYN-EJ.csv", "marketplace": "Myntra EJ", "rowCount": "3", "uploadedAt": "...", "status": "Imported with exceptions" },
  "activatedRows": 2,
  "scannableRows": 2,
  "pendingRows": 0,
  "rejectedRows": 1,
  "supersededRows": 3,
  "cancelledRows": 0,
  "confirmed": []
}
```

If the commit fails, the earlier active data stays in place, and the response is HTTP 500 with the error message. The file must be uploaded again.

### `POST /api/uploads/scanner-list/preview`

This route is separate from return-master imports. It accepts a multipart `file` field containing a CSV or XLSX scanner list and an optional `sheetAccounts` JSON object whose keys are worksheet names and whose values are verified account names:

```json
{ "meesho": "Meesho", "coco": "Meesho" }
```

Every non-empty cell is preserved with its worksheet, row and column. Numeric and scientific-notation cells are reported as malformed and are never used as lookup keys. Valid text values are matched only against active lookup rows in the mapped account. The response includes `sheets`, the scoped `accounts`, every `entries` result, and counts for `matched`, `unmatched`, `ambiguous`, `previouslyScanned`, `unassigned`, `malformed` and `duplicateEntries`. The route does not create a scan, stage an upload, or change any database lookup data.

## Scanning

### `POST /api/scan/lookup`

Finds the return for an AWB. The request:

```json
{ "tracking": "<AWB>", "marketplace": "Auto detect", "shipmentId": null }
```

`marketplace` is `Auto detect` or the name of one account. A named account the user may not use returns 403. `shipmentId` is set only when the employee has chosen one of several matches.

The `status` field says what happened. Nothing is chosen silently:

| `status` | Meaning | Other fields |
|---|---|---|
| `found` | One active return, not yet received | `shipment` (below) |
| `duplicate` | The AWB was already received in that account | `marketplace`, `time`, `scannedBy` |
| `choose` | More than one account or return matches | `candidates`: `shipmentId`, `accountId`, `accountName`, `alreadyReceived`, `orderId`, `itemCount`, `receivedAt`, `scannedBy` |
| `not_found` | No active return matches in the accounts the user may see | none |

An AWB that exists only in an account the user may not use is reported as `not_found`, so the other account is not revealed.

Example of `found`:

```json
{
  "status": "found",
  "trackingId": "SYN-AWB-1",
  "shipment": {
    "shipmentId": 12,
    "trackingId": "SYN-AWB-1",
    "csvTrackingId": "SYN-AWB-1",
    "urlTrackingId": "",
    "altTrackingId": "",
    "forwardTrackingId": "",
    "returnEventId": "SYN-RET-1",
    "trackingSource": "return_tracking",
    "trackingValidation": "not_applicable",
    "scannedTracking": "SYN-AWB-1",
    "matchedTrackingField": "tracking_id",
    "matchedLeg": "return",
    "marketplace": "Myntra EJ",
    "marketplaceId": 5,
    "orderId": "SYN-ORDER-1",
    "courier": "SYN-COURIER",
    "logisticPartner": "Unknown / Pending Verification",
    "partnerMethod": "none",
    "returnType": "Customer Return",
    "returnTypeRaw": "Return",
    "returnReason": "SYN reason",
    "matchedFrom": "<text stored at upload>",
    "sourceFile": "SYN-EJ.csv",
    "sourceBatchId": 3,
    "productTitle": "",
    "itemSummary": "2 items · 3 qty",
    "isMulti": true,
    "items": [
      {
        "itemId": 31,
        "orderItemId": "SYN-LINE-1",
        "displayIdentifierKind": "order_line",
        "marketplaceSku": "SYN-LISTING-1",
        "productSku": "SYN-MASTER-1",
        "productSkuSource": "product_master",
        "marketplaceSkuIdentifier": "",
        "marketplaceSkuIdentifierKind": "",
        "productName": "SYN product",
        "expectedQty": 1,
        "imageUrl": "",
        "colorName": "",
        "keyDetail": "",
        "brandLabel": "",
        "setContents": ""
      }
    ]
  }
}
```

Field notes:

- `scannedTracking` is the AWB as normalized from the request. `matchedTrackingField` is `tracking_id`, `alt_tracking_id`, or empty when nothing matched. `matchedLeg` is `return`, `forward` or `unknown`.
- `csvTrackingId` is the AWB exactly as the file wrote it. `urlTrackingId` is the AWB read from a verified tracking link, or empty.
- `productSku` is empty when `productSkuSource` is `unresolved`. `marketplaceSkuIdentifier` is empty unless the file had an FNSKU, ASIN, FSN, JioCode or Myntra SKU code column.
- `orderItemId` is the display identifier when there is one (`displayIdentifierKind` says which), otherwise the order line.

Lookup errors: 400 `Enter a tracking ID` for an empty value, and 400 with a message for a scientific-notation value (`... is in scientific notation, so its digits were lost. Scan the label again.`).

### `GET /api/scan/session`

```json
{
  "shift": { "scanned": "1", "correct": "0", "issues": "1", "accuracy": "0.0%", "progress": 0, "targetLabel": "No daily target set" },
  "accounts": [{ "id": 5, "name": "Myntra EJ" }],
  "issueCategories": [{ "code": "missing_component", "label": "Missing product or component", "isClear": false, "isMissing": true, "requiresTicket": true, "allowsSubIssue": true, "requiresSubIssue": true }],
  "subIssues": [{ "id": 4, "label": "Dupatta", "categoryCode": "missing_component" }]
}
```

The shift counts today's scans of the user's accounts, in IST. Only active categories and active sub-issues are listed.

### `POST /api/scan/correct`

Adds an issue to a clear scan that this user just saved, using the same body as `POST /api/scan/complete`. The scan row is kept. A second correction is refused, because the first issue stays on the record. The user's account scope still applies.

### `POST /api/scan/complete`

Records one physical scan. Every expected item of the return must be listed once, with its received quantity and its physical check:

```json
{
  "shipmentId": 12,
  "clientScanKey": "<a key made for this scan: 8 to 100 letters, digits, - or _>",
  "notes": "",
  "scannedTracking": "SYN-AWB-1",
  "photoCount": 0,
  "hasVideo": false,
  "items": [
    {
      "itemId": 31,
      "receivedQty": 0,
      "verified": true,
      "issues": [
        { "categoryCode": "missing_component", "subIssueId": 4, "qty": 1, "ticketCode": "SYN-TKT-1", "notes": "" }
      ]
    }
  ]
}
```

Rules, all checked before anything is written:

- Every item of the return must be listed exactly once, and each must be verified.
- Units not received (expected minus received) must equal the units covered by missing-item issues (`missing_component`).
- Issues on received units (any other category) cannot exceed the units received.
- A category that requires a sub-issue needs a `subIssueId`, and the sub-issue must belong to that category. A category that takes a ticket needs a `ticketCode`, and no other category may have one.
- A ticket ID must be new. A ticket already in the register is refused with HTTP 409.
- The scan key identifies the save. A repeated key returns the first result, with `"replayed": true`, and no second scan is made.
- An AWB that is already received in the same account is refused with HTTP 409.

Response:

```json
{
  "replayed": false,
  "scan": {
    "id": 40,
    "scannedAt": "2026-10-10T05:01:22.000Z",
    "timeLabel": "10:31 AM",
    "status": "Raised",
    "marketplace": "Myntra EJ",
    "trackingId": "SYN-AWB-1",
    "originalTrackingId": "SYN-AWB-1",
    "urlTrackingId": "",
    "orderId": "SYN-ORDER-1",
    "scannedTracking": "SYN-AWB-1",
    "matchedTrackingField": "tracking_id",
    "matchedLeg": "return",
    "logisticPartner": "Unknown / Pending Verification",
    "sourceFile": "SYN-EJ.csv",
    "sourceBatchId": 3
  },
  "itemCount": 1,
  "issueCount": 1,
  "shift": { "scanned": "1", "correct": "0", "issues": "1", "accuracy": "0.0%", "progress": 0, "targetLabel": "No daily target set" },
  "claimsBadge": "1"
}
```

Errors:

| Status | `error` | Notes |
|---|---|---|
| 400 | `Choose a return to save.` | `shipmentId` is missing or not a whole number |
| 400 | `The scan key is missing or malformed.` | |
| 400 | `The scan is not complete. Fix the items listed below.` | `details` lists each rule failure. Nothing is saved. |
| 404 | `Return not found` | Not in the user's accounts, or no such return |
| 409 | `This return is no longer in the active lookup data. Look it up again.` | The lookup data was replaced after the lookup |
| 409 | `This AWB has already been received` | `time` and `scannedBy` are included |
| 409 | `This scan key was already used for another return.` | |
| 409 | `The ticket <code> is already recorded. Open it in the register.` | |

## Register

### `GET /api/register`

One row per verified item. Legacy scans, saved before item-level verification, appear as one row per shipment line, with `source: "legacy"` and `receivedQty: null`.

Query parameters, all optional:

| Parameter | Meaning |
|---|---|
| `marketplaceId` | An account the user may use (a whole number) |
| `tracking` | Contains. Matches the tracking ID, the file AWB, the scanned AWB, or the alternate AWB |
| `order` | Contains. Matches the order ID or the order item ID |
| `sku` | Contains. Matches the marketplace SKU or the product SKU |
| `issue` | A category code, or `no_issue` |
| `ticketStatus` | One of `Draft`, `Raised`, `Review`, `Approved`, `Rejected` |
| `scannerId` | The user who saved the scan |
| `partner` | The logistic partner name |
| `dateFrom`, `dateTo` | `YYYY-MM-DD`, by IST scan day |
| `sort` | `scanned_at` (default), `marketplace`, `tracking_id`, `order_number`, `order_item_id`, `marketplace_sku`, `product_sku`, `logistic_partner_name`, `return_type` or `expected_qty`. Any other value falls back to `scanned_at`. |
| `direction` | `desc` (default) or `asc` |
| `page` | Starts at 1 |
| `pageSize` | 50 by default, at most 200 |

Response:

```json
{
  "rows": [
    {
      "key": "17",
      "source": "item",
      "scanId": 40,
      "scannedAt": "2026-10-10T05:01:22.000Z",
      "scanDay": "2026-10-10",
      "scanTime": "10:31 AM",
      "scanStatus": "Raised",
      "scannedBy": "SYN Scanner",
      "marketplaceId": 5,
      "marketplace": "Myntra EJ",
      "trackingId": "SYN-AWB-1",
      "originalTrackingId": "SYN-AWB-1",
      "urlTrackingId": "",
      "trackingSource": "return_tracking",
      "forwardTrackingId": "",
      "returnEventId": "SYN-RET-1",
      "scannedTracking": "SYN-AWB-1",
      "orderId": "SYN-ORDER-1",
      "orderItemId": "SYN-LINE-1",
      "displayIdentifierKind": "order_line",
      "marketplaceSku": "SYN-LISTING-1",
      "productSku": "SYN-MASTER-1",
      "productSkuSource": "product_master",
      "marketplaceSkuIdentifier": "",
      "productName": "SYN product",
      "logisticPartner": "Unknown / Pending Verification",
      "partnerMethod": "none",
      "trackingValidation": "not_applicable",
      "matchedTrackingField": "tracking_id",
      "matchedLeg": "return",
      "returnType": "Customer Return",
      "returnTypeRaw": "Return",
      "returnReason": "SYN reason",
      "expectedQty": 1,
      "receivedQty": 0,
      "sourceFile": "SYN-EJ.csv",
      "sourceBatchId": 3,
      "amount": null,
      "claimAmount": null,
      "issues": [
        {
          "categoryCode": "missing_component",
          "categoryLabel": "Missing product or component",
          "subIssueLabel": "Dupatta",
          "qty": 1,
          "notes": "",
          "ticket": { "id": 9, "code": "SYN-TKT-1", "status": "Raised", "rejectionReason": "" }
        }
      ]
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 50,
  "sort": "scanned_at",
  "direction": "desc"
}
```

`amount` and `claimAmount` are reserved and always `null`. A line whose product SKU was not resolved has `productSku` empty and `productSkuSource` `unresolved`.

### `GET /api/register/export`

The same filters as `GET /api/register`, and the same rows. The sort is fixed (most recent scan first).

| Parameter | Values | Default |
|---|---|---|
| `format` | `csv` or `xlsx` | `csv` |
| `columns` | `approved`, `extended` or `operational` | `approved` |

The column sets are fixed in `server/register-rules.ts`:

- **approved** (19 columns, in this order): Date, Marketplace, Tracking ID, Order ID, Order Item ID, Marketplace SKU, Product SKU, Marketplace SKU Identification (FNSKU/ASIN/Myntra FSN), Logistic Partner Name, Return Type, Qty, Amount, Return Reason, Return Received Issue, Return Received Sub Issue (Only If Missing), Ticket ID (Only If Return Received Issue), Ticket ID Status, Claim Amount, If Rejected, What the Reason.
- **extended** (23): the approved 19, then Received Qty, Scanned By, Source, Matched Tracking.
- **operational** (34): the extended 23, then Original Tracking ID (file), Link Tracking ID, Scanned Tracking ID, Tracking Source, Forward Tracking ID, Return Event ID, Source File, Import Batch ID, Return Type (as file), Display Identifier Kind, Tracking Validation.

The file is named `return-register-<columns>.<format>`. A cell that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with an apostrophe, in both formats. More than 50,000 matching rows return HTTP 400 with `More than 50,000 rows match. Narrow the filters first.`

Errors: 400 `The export format is csv or xlsx.`, and 400 `Choose approved, extended or operational columns.`

### `GET /api/register/options`

```json
{
  "marketplaces": [{ "id": 5, "name": "Myntra EJ" }],
  "scanners": [{ "id": 2, "name": "SYN Scanner" }],
  "partners": ["Delhivery"],
  "issueCategories": [{ "code": "missing_component", "label": "Missing product or component" }],
  "ticketStatuses": ["Draft", "Raised", "Review", "Approved", "Rejected"],
  "today": "2026-10-10",
  "todayLabel": "10 October 2026"
}
```

`marketplaces`, `scanners` and `partners` are limited to the user's accounts.

## Tickets

### `PATCH /api/tickets/:id/status`

```json
{ "status": "Rejected", "reason": "<text>" }
```

The statuses are `Draft`, `Raised`, `Review`, `Approved` and `Rejected`. A rejection needs a reason, and a status cannot be set to the status it already has. The response is `{ "ticket": { "id", "code", "status", "rejectionReason" } }`. A ticket outside the user's accounts returns 404 `That ticket does not exist.`

Errors (400): `Choose a valid ticket status.`, `The ticket is already <status>.`, `A rejection reason is required when a ticket is rejected.`, and a reason longer than 500 characters.

### `GET /api/tickets/:id/history`

```json
{ "history": [{ "fromStatus": "", "toStatus": "Raised", "reason": "Created from a return scan", "changedBy": "SYN Scanner", "changedAt": "2026-10-10T05:01:22.000Z" }] }
```

Oldest first. The first row has an empty `fromStatus`.

## Administrator routes

Every route in this section needs the role `Admin`. Every change is written to `register_audit_log`.

### Users

`GET /api/admin/users` returns `{ "users": [...] }`. Each user has `id`, `initials`, `name`, `email`, `role`, `marketplaces`, `scansToday`, `status` and `lastActive`. There is no route to add a user. Use `npm run user:create`.

### Missing-item sub-issues

`GET /api/admin/issue-options` returns `{ "options": [{ "id", "label", "categoryCode" }] }`, the active options.

`POST /api/admin/issue-options` takes `{ "label": "<name, at most 60 characters>", "categoryCode": "missing_component" }`. The category must be active and must take sub-issues. The response is `{ "option": { "id", "label", "categoryCode" } }`. Errors: 400 `Enter an option name`, 400 `The option name must be 60 characters or fewer`, 400 `Choose a category that takes sub-issues`.

`DELETE /api/admin/issue-options/:id` deactivates the option and returns `{ "ok": true }`. Scans that used it keep their label.

### Issue categories

`GET /api/admin/issue-categories` returns `{ "categories": [{ "code", "label", "isClear", "isMissing", "requiresTicket", "allowsSubIssue", "requiresSubIssue", "active" }] }`. `PATCH /api/admin/issue-categories/:code` takes `{ "active": true }`, `{ "requiresTicket": false }`, or both. It returns `{ "category": { "code", "label", "active", "requiresTicket" } }`. An empty change returns 400 `Nothing to change.` The category codes and their rules are fixed in code. Only the switches change.

### Accounts and system

`GET /api/admin/accounts` returns `{ "accounts": [{ "id", "name", "status", "lastSynced" }] }`, where `status` is `Uploads received` or `No uploads yet`.

`GET /api/admin/system` returns `{ "items": [{ "title", "detail", "status", "tone" }] }`, with the database connection and the count of scanned returns.

### Logistics partners

A partner, a courier name (alias) and a tracking host is switched off, never deleted.

`GET /api/admin/logistics-partners` returns:

```json
{
  "partners": [
    {
      "id": 1,
      "name": "Delhivery",
      "active": true,
      "aliases": [{ "id": 1, "alias": "delhivery", "aliasKey": "delhivery", "marketplace": "All marketplaces", "active": true }],
      "domains": [{ "id": 1, "host": "track.delhivery.com", "active": true }]
    }
  ]
}
```

`POST /api/admin/logistics-partners` takes `{ "name": "<partner name>" }` and returns `{ "partner": { "id", "name", "active" } }`.

`PATCH /api/admin/logistics-partners/:id` takes `{ "active": false }` and returns `{ "partner": { "id", "name", "active" } }`.

`POST /api/admin/logistics-partners/:id/aliases` takes `{ "alias": "<courier name as the file writes it>", "marketplace": "" }`. An empty `marketplace` applies the name to every account. A name gives a mapping for that account only. It returns `{ "alias": { "id", "partnerId", "alias", "marketplace", "active" } }`. The alias is stored in normalized form.

`PATCH /api/admin/logistics-partner-aliases/:id` takes `{ "active": false }` and returns `{ "alias": { "id", "active" } }`.

`POST /api/admin/logistics-partners/:id/domains` takes `{ "host": "track.example.in" }` and returns `{ "domain": { "id", "partnerId", "host", "active" } }`. The host must be a host name only, in lower case, for example `track.example.in`. Anything else returns 400 `Enter a host name only, for example track.example.in.`

`PATCH /api/admin/logistics-partner-domains/:id` takes `{ "active": false }` and returns `{ "domain": { "id", "host", "active" } }`.

### Product SKU master

The VB EXPORT product master (`product_master`): a channel listing SKU to a product SKU, with its category and channel image link. Loading replaces the whole table in one transaction. Nothing is deleted from scan history, and the change is written to `register_audit_log`. The image link from this file is used ahead of the OMSGuru catalog image when a return file is activated.

Each row has a **marketplace scope**. The product SKU lookup uses the account's own rows first and falls back to the `all` rows, so a specific mapping is never blocked; a row for a different account is never used (`marketplaceRank` in `server/marketplace-rules.ts`). The scope comes from the `marketplace` field of the load, else a `Marketplace` column in the file, else `all`.

`GET /api/admin/product-master/template` returns a CSV attachment named `product-sku-master-template.csv`. The only row is `Channel Listing SKU Code,Product SkuCode,Product Category,Channel Image URL`. It has no data rows.

`GET /api/admin/product-master` returns:

```json
{
  "state": {
    "rows": 35064,
    "listings": 35064,
    "masters": 10496,
    "withImage": 35028,
    "lastLoadedAt": "10 Oct, 3:20 PM",
    "marketplaces": [{ "marketplace": "all", "rows": 35064 }],
    "sample": [{ "marketplace": "all", "listingSku": "SYN-LIST-1", "masterSku": "SYN-MASTER-1", "category": "Sarees", "imageUrl": "https://img.example.invalid/a.jpg" }]
  }
}
```

`lastLoadedAt` is `Never loaded` when the table is empty. `marketplaces` lists the scope of each group of rows (`all` for rows that apply to every account).

`POST /api/admin/product-master/preview` takes a multipart form with one `file` field (`.csv`, `.xlsx` or `.xls`, up to 25 MB) and an optional `marketplace` field (a connected account name, or empty/`all` for every account). It returns `{ "preview": {...}, "filename": "...", "marketplace": "<resolved scope>" }`:

```json
{
  "preview": {
    "fatal": "",
    "rows": 35064,
    "listings": 35064,
    "masters": 10496,
    "withImage": 35028,
    "withoutImage": 36,
    "invalidImages": 0,
    "categories": 22,
    "skipped": 0,
    "conflictCount": 9,
    "conflictSample": [{ "listingSku": "KD4-Bahara_M", "marketplace": "all", "masterSkus": ["KD4-Bahara-Navy_M", "KD4-Bahara-Grey_M"] }],
    "scopes": [{ "marketplace": "myntra vb", "rows": 35064 }],
    "sample": [{ "listingSku": "SYN-LIST-1", "masterSku": "SYN-MASTER-1", "category": "Sarees", "imageUrl": "https://img.example.invalid/a.jpg" }]
  },
  "filename": "Product SKU Codes.xlsx",
  "marketplace": "myntra vb"
}
```

A non-empty `fatal` means the file cannot be read (no header row, or a listing SKU column and a product SKU column that are the same). `invalidImages` counts image cells that were present but not an http(s) link; those are left blank, never repaired. `conflictCount` counts listing SKUs that the file gives more than one product SKU for; the last row wins, and up to 20 are listed in `conflictSample`. A conflict is not a blocker, but it is shown before loading, because the other value is not used. `scopes` is the scope the rows will be stored under, with the row count for each. Two listing SKUs that differ only by whitespace count as one, because spaces inside a SKU are dropped when it is matched.

A `marketplace` that is not a connected account returns 400 `Choose a connected marketplace, or All marketplaces.`

`POST /api/admin/product-master/import` takes the same `file` and `marketplace` fields and `confirm=true`. It parses the file again, so a stale preview cannot decide what is stored. It returns `{ "result": { "inserted", "removed", "lastLoadedAt" }, "state": {...} }`. Without `confirm` it returns 409 `Confirm that this replaces the whole product master before loading.` A file with no listing SKU and product SKU pair returns 400 `No row has both a listing SKU and a product SKU. Nothing was loaded.`

Accepted layouts, matched by header name (never by column letter):

- **Product SKU Codes**: `Channel Listing SKU Code`, `Product SkuCode`, `Product Category`, `Channel Image URL`.
- **VB EXPORT product category workbook**: `Marketplace SKU`, `VB EXPORT SKU's`, `VB Export Product Category`, `COGS`, `Weight Slab`, and an optional `Marketplace` scope column.

The scope of the rows comes from, in order: the `marketplace` field of the load; a `Marketplace` column in the file; otherwise `all` (every account). The `Marketplace` column is **not required**: a file without it and without a chosen marketplace loads as `all`. A row for a different account than the one being scanned is never used, and the `all` rows are the fallback, so a specific mapping is never blocked.

## Shopify Real-Time Integration

Shopify return requests and RTO shipments are synchronized continuously from the external Shopify database configured in `SHOPIFY_DATABASE_URL`. Unlike other marketplaces, manual file uploads are not used for Shopify. Access to the external database is strictly **READ-ONLY** (`SET TRANSACTION READ ONLY` and destructive keyword blocking).

### GET `/api/shopify/status`
Returns connection health, sync status, and scannable lookup counts:
```json
{
  "configured": true,
  "connected": true,
  "message": "Connected (Read-Only)",
  "orderCount": 240,
  "lastSyncedLabel": "Synced 12:00 PM",
  "totalActiveScannable": 14
}
```

### POST `/api/shopify/sync`
Triggers an immediate synchronization run from the external Shopify database into local `expected_returns`. Returns:
```json
{
  "ok": true,
  "returnsSynced": 5,
  "rtosSynced": 9,
  "totalActive": 14,
  "lastSyncedAt": "Synced 12:00 PM"
}
```

### GET `/api/shopify/metrics`
Computes the business formula `Created - Received = Pending`, return/RTO channel breakdowns, and daily 14-day history. Enforces Account Scope (Rule 1).
```json
{
  "formula": {
    "created": 14,
    "received": 0,
    "pending": 14
  },
  "breakdown": {
    "returns": { "created": 5, "received": 0, "pending": 5 },
    "rtos": { "created": 9, "received": 0, "pending": 9 }
  },
  "receiptRate": "0.0%",
  "totalActiveScannable": 14,
  "lastSyncedLabel": "Synced 12:00 PM",
  "dailyStats": [
    {
      "date": "2026-10-13",
      "dayLabel": "2026-10-13",
      "createdReturns": 5,
      "createdRtos": 9,
      "totalCreated": 14,
      "receivedReturns": 0,
      "receivedRtos": 0,
      "totalReceived": 0,
      "pending": 14
    }
  ]
}
```

### GET `/api/shopify/records`
Filterable query endpoint. Query parameters:
- `tab`: `all` | `pending` | `received` | `returns` | `rtos`
- `q`: search text (matches Delhivery return AWB, forward AWB, order number, product title, SKU)
- `from`, `to`: creation date filter (`YYYY-MM-DD`)
- `limit`, `offset`: pagination controls
Returns: `{ "rows": ShopifyRecord[], "total": number }`.

### GET `/api/shopify/export`
Generates and downloads a CSV export of Shopify returns and RTOs matching the current filters.

## Iron Send tracking, analytics and live sync

Iron Send is an operational category (`receipt_issue_categories.is_operational`). It is recorded with the scan, but it never makes a scan an issue return (outcome stays `clear`, status `Clear`, no claim), it is never counted in issue figures, and its units are never in the OMSGuru file. The Inward Team records ironed units that came back. Nothing marks them received automatically. Tables: `iron_send_records`, `iron_receive_events`, `iron_settings` (`server/schema-iron.sql`).

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/iron?state=open\|pending\|overdue\|partial\|received\|cancelled\|all&marketplaceId=&search=&dateFrom=&dateTo=` | Any signed-in user (scoped) | `{rows: IronRecord[], summary}`. `summary.units` has `sent`, `received`, `pending`, `overdue` separately. |
| GET | `/api/iron/summary?marketplaceId=` | Any signed-in user (scoped) | The summary only. |
| GET | `/api/iron/:id` | Any signed-in user (scoped) | One record with every receive entry. 404 outside scope. |
| POST | `/api/iron/:id/receive` `{qty, notes?, clientKey?}` | Role `Inward` or `Admin` | Records units received back. 403 for any other role (the Return Team only sends). 400 when `qty` is not 1..pending. A repeated `clientKey` returns the first result (`replayed: true`). 409 when the record was cancelled at the bench. |
| PATCH | `/api/admin/iron/settings` `{overdueAfterDays}` | Admin | 1-30 days, default 3. Audited. |
| GET | `/api/iron/batches?state=open\|overdue\|partial\|received\|all&search=` | Any signed-in user (scoped) | Batches with sent/received/pending totals and state. |
| POST | `/api/iron/batches` `{recordIds?, khaataName, challanNo?, expectedDays (1-30), notes?, clientKey?}` | Return Team (any role except `Inward`) | Makes batch `IRN-YYMMDD-NNN` from pending, unbatched, not-yet-received lines (all such lines when `recordIds` is omitted). 403 for `Inward`; 409 when a chosen line is already batched or received. A repeated `clientKey` returns the same batch. |
| GET | `/api/iron/batches/:id` and `/api/iron/batches/:id/download?format=xlsx\|csv` | Any signed-in user (scoped) | One batch with its lines; the khaata challan sheet. |
| PATCH | `/api/iron/batches/:id` `{khaataName?, challanNo?, notes?}` | Return Team | Audited (`iron.batch_update`). |
| POST | `/api/iron/batches/:id/receive` `{notes?, clientKey?}` | `Inward` or Admin | Receives every pending unit of the batch, one entry per line. Manual; never automatic. |
| GET | `/api/reports/analytics?dateFrom=&dateTo=&marketplaceId=&category=&format=csv` | Any signed-in user (scoped) | Size-, SKU-, marketplace-, date-, week- and reason-wise figures, received issues (Iron Send flagged `operational`), the previous period and insights. Days are IST. Default: last 30 days; at most 366 days. |
| GET | `/api/sync/state` | Any signed-in user | `{cursor, serverTime, liveClients}`. The cursor is the newest `register_audit_log` id. |
| WS | `/api/live` | Session cookie (browser) or `Authorization: Bearer` (Android) | Messages: `hello` and `tick` (every 15 s) with `cursor`; `change` with `cursor`, `kind` (`scan.saved`, `scan.corrected`, `ticket.updated`, `upload.activated`, `iron.received`, `iron.settings`), `marketplaceId`, `shipmentId`, `scanId`, `actorId`. A change is sent only to users whose scope includes its account. 401 without a session. Clients reload through the normal routes; they poll `/api/sync/state` every 3.5-4 s when the socket is down. |

A bench correction (`POST /api/scan/correct`) writes the issues it replaces to `register_audit_log` (`scan.issues_replaced`) before replacing them, and is refused with 409 when the Inward Team has already received ironed units for that return. `POST /api/scan/complete` and `/correct` now also return `scan.marketplaceId`, `scan.shipmentId`, `scan.outcome` and `ironSendQty`; `issueCount` counts return issues only. `shift.ironSend` is today's Iron Send units.

## Routes outside `/api`

When `dist/` exists (after `npm run build`), every path that does not start with `/api` returns `dist/index.html`, so the web app's own routes work when it is served by the API. The web app is otherwise served by Vite on port 5173, which proxies `/api` to the API.
