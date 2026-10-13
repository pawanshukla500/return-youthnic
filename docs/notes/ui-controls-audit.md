# UI controls audit (2026-10-10)

Scope: every button, toggle, select, tab, filter, link-like control and modal in `src/`. Each control is listed with where it is, what it calls, and its status. The 2026-10-08 audit was replaced. Its scan-screen rows described an earlier version of the screen, so they no longer matched the code.

How it was checked: by reading the code on 2026-10-10. **Nothing was run in a browser, and nothing was compiled.** The sessions that made these changes had no shell. Run `npm run typecheck` and `npm run build` first. Then run `npm run dev`, open each page as an administrator and as a scanner, and try each control below.

Status key:

- **Works (code):** calls the route shown, and the route exists in `server/`.
- **Local:** changes only what is on the screen, or what will be sent with the next request.
- **Label:** looks like a control but is not one. Listed so that it is not mistaken for one.
- **Disabled:** shown disabled, with a title that says why.
- **Dead path:** code that no page reaches today. It must be wired or removed before a page uses it.

## Shell (`src/shell.tsx`, `src/App.tsx`)

| Control | Where | Calls or effect | Status |
|---|---|---|---|
| Overview, Scan returns, Return register, Claims, Data uploads | Sidebar | Opens `/`, `/scan`, `/register`, `/claims`, `/uploads`. The address stays on refresh | Local |
| Admin | Sidebar, administrators only | Opens `/admin`. Other roles do not see the item, and the page says `Only an administrator can open this page.` | Local |
| Claims count | Claims item in the sidebar | The claims badge from the server | Label |
| Sign out | Sidebar, bottom | `POST /api/auth/logout`, then removes the token and returns to sign-in | Works (code) |
| Collapse menu | Sidebar, bottom | Collapses the sidebar (`aria-expanded`) | Local |
| Header date | Header | The date from the server | Label |
| Notifications bell | Header | None | Disabled (title: Notifications are not connected yet) |
| Scan return | Header, on every page except Scan | Opens `/scan` | Local |

## Sign in (`src/pages/Login.tsx`)

| Control | Where | Calls or effect | Status |
|---|---|---|---|
| Email address, Password | Form | Required fields. The email is not pre-filled | Local |
| Show / Hide | Password field | Shows or hides the password (`aria-pressed`) | Local |
| Sign in | Form | `POST /api/auth/login`. A 401 shows `Incorrect email or password.` | Works (code) |

## Overview (`src/pages/Dashboard.tsx`)

| Control | Where | Calls or effect | Status |
|---|---|---|---|
| Last 7 days | Return volume header | A label. The chart always covers seven days | Label |
| View report | Top return reasons | Opens Return register | Local |
| Chart settings | Issues by marketplace | None | Disabled (title: Chart settings are not available yet) |
| View all | High-risk SKUs | None | Disabled (title: The full SKU list is not available yet) |
| View all returns | Recent scans | Opens Return register | Local |
| Recent-scan rows | Recent scans (compact table in `src/returns-table.tsx`) | Read-only | Local |

The figures on this page are read from `GET /api/dashboard`, limited to the accounts the user can see.

## Claims (`src/pages/Claims.tsx`)

| Control | Where | Calls or effect | Status |
|---|---|---|---|
| All time | Claim status header | A label. Every claim ticket is counted | Label |
| Export CSV | Marketplace performance | Saves the table on this page as `claims-by-marketplace.csv`, built in the browser. Disabled when the table is empty | Works (code) |

## Scan returns (`src/pages/ScanReturns.tsx`)

| Control | Where | Calls or effect | Status |
|---|---|---|---|
| Marketplace account | Scan controls | `Auto detect`, or an account from `GET /api/accounts`. Sent with the lookup | Works (code) |
| Scan input | Scan controls | Typed or scanned AWB. Autofocus. Enter searches | Works (code) |
| Look up | Scan controls | `POST /api/scan/lookup` | Works (code) |
| Use {account} | Choose panel, one per candidate | `POST /api/scan/lookup` with the chosen `shipmentId` | Works (code) |
| Already received | Choose panel | Shows when and by whom the AWB was received | Label |
| Clear & scan next | Duplicate panel | Clears the lookup. Nothing is sent | Local |
| Open uploads | Not-found panel | Opens Data uploads | Local |
| Item N of M | Item buttons | Selects the item to verify | Local |
| Issue chips | Item form | One tap sets the physical check and the quantity for the whole expected amount. Normal Return clears issues. Inactive categories are not offered | Local |
| Missing-item chips | Item form, after Missing Item | The sub-issue, from `GET /api/scan/session` | Local |
| Ticket ID | Item form, only when that category still requires one | Sent with the save. Damaged, Wrong product and Missing item do not require one after a server start | Local |
| Received as expected | Action row | Marks every item checked, with the expected quantity, and clears its issues | Local |
| Cancel | Action row | Clears the lookup. Nothing is saved | Local |
| Notes for the claim team | Notes area | Sent with the save | Local |
| Save return | Action row | A found return is saved at once as a normal return (`POST /api/scan/complete`). The button retries only when that save failed. An issue tap on a clear scan calls `POST /api/scan/correct` | Works (code) |
| Multi return popup | After lookup, when the return has more than one piece (two items, or one item with quantity 2 or more) | Opens for 2 seconds, then closes. The return is already saved | Local |
| Catalog photo | Item, when the product master has an image link | Click opens the larger photo. The words "Catalog image" and "Enlarge" are not shown | Local |
| Close (×) | Image modal | Closes the modal | Local |
| Connect webcam | Evidence panel | Asks the browser for camera access | Local |
| Capture photo | Evidence panel, while recording | Takes a still image on this workstation | Local |
| Stop recording | Evidence panel, while recording | Stops the recorder. The video stays on this workstation | Local |
| Disconnect camera | Evidence panel | Stops the camera | Local |

The evidence panel says that the video is recorded on this workstation only. Only the number of photos, and whether a video exists, is sent with the save. The video is not uploaded, and it is not linked to the return.

## Return register (`src/pages/Reports.tsx`)

| Control | Where | Calls or effect | Status |
|---|---|---|---|
| Tracking ID, Order ID, SKU | Filter bar | `GET /api/register` with the filter, after a 250 ms pause | Works (code) |
| Marketplace | Filter bar | Account filter. Only accounts the user can see are offered | Works (code) |
| Logistic partner | Filter bar | Partner filter | Works (code) |
| Received issue | Filter bar | Category filter, or `no_issue` | Works (code) |
| Ticket status | Filter bar | Ticket status filter | Works (code) |
| Scanner | Filter bar | Scanner filter | Works (code) |
| From, To | Filter bar | Scan-day range in IST | Works (code) |
| Clear filters | Filter bar | Resets the filters. Disabled when none is set | Works (code) |
| Columns (n of 23) | Filter bar | Shows or hides the column chooser on this screen | Local |
| Column checkboxes | Column chooser | Hides or shows a column on this screen only | Local |
| Export choice | Filter bar | `approved` (19 columns, the default) or `operational` (34 columns). Used by the next export | Local |
| Export CSV | Filter bar | `GET /api/register/export?format=csv&columns=…`. Disabled when no row matches | Works (code) |
| Export Excel | Filter bar | `GET /api/register/export?format=xlsx&columns=…`. Disabled when no row matches | Works (code) |
| Sortable column headers | Table | `GET /api/register` with `sort` and `direction`. The screen's keys map to a fixed list on the server | Works (code) |
| Details | Each row, and mobile cards (All fields) | Opens the record view | Local |
| Previous, Next | Pagination | `GET /api/register` with `page`. Disabled at either end | Works (code) |
| New status, Reason | Record view, for each ticket | Local. A rejection needs a reason | Local |
| Save ticket status | Record view | `PATCH /api/tickets/:id/status`. Disabled when nothing changed, or when a rejection has no reason | Works (code) |
| Ticket history | Record view | `GET /api/tickets/:id/history`, read-only | Works (code) |
| Close (×) | Record view | Closes the modal | Local |

The date chips from earlier versions were removed. The register filters by IST scan day, through labeled From and To date fields. Empty dates include every scan day. A From date after the To date shows a note and matches no rows.

## Data uploads (`src/pages/Uploads.tsx`)

| Control | Where | Calls or effect | Status |
|---|---|---|---|
| File type | Upload form | Switches between return-master preview/activation and scanner-list validation; discards the current preview | Works (code) |
| Marketplace | Upload form | The accounts from `GET /api/accounts`. Changing it discards the preview | Local |
| Drop zone | Upload form | Click, Enter or Space opens the file picker. A dropped file is previewed. Return mode is locked until an account is chosen; scanner mode is not | Works (code) |
| File picker (hidden input) | Behind the drop zone | Return mode calls `POST /api/uploads/preview`; scanner mode calls `POST /api/uploads/scanner-list/preview` | Works (code) |
| Confirmation checkbox | Preview, when the preview lists confirmations | Must be ticked before activation. Sent as `confirm` | Local |
| Activate | Footer | `POST /api/uploads/import`. Disabled unless the server said the file can be activated, any confirmation is ticked, and no request is in progress | Works (code) |
| Worksheet account selectors | Scanner-list preview | Select a verified account per worksheet before revalidation | Works (code) |
| Validate against active lookups | Scanner-list preview | Re-runs validation with the selected worksheet account mappings. Creates no scans and activates no data | Works (code) |
| Export CSV | Scanner-list preview and return exceptions | Downloads the structured validation results from the current preview | Works (code) |
| Download generic template | Template card | `GET /api/uploads/template` | Works (code) |
| Upload history | Table | `GET /api/uploads`, read-only | Works (code) |

The return preview shows what the server checked: the format, the missing required columns, scannable/pending/rejected counts, grouped searchable exceptions with line numbers, the tracking differences, logistics partners, product SKU mapping, blockers, and confirmations. The scanner preview shows per-worksheet mapping and matched, unmatched, ambiguous, previously scanned, malformed and duplicate counts. The screen shows only the missing required columns, not the full list of headers found. The server returns the full list.

## Admin (`src/pages/Admin.tsx`, administrators only)

| Control | Where | Calls or effect | Status |
|---|---|---|---|
| Tabs: Users, Issue configuration, Logistics partners, Product SKU master, Marketplace accounts, System | Tab bar | Shows the tab (`aria-pressed`). Partner rows are cards, so aliases and hosts sit under the partner instead of on top of the next row | Local |
| Download template | Product SKU master | `GET /api/admin/product-master/template`. A header-only CSV | Works (code) |
| Drop zone and file picker | Product SKU master | `POST /api/admin/product-master/preview`. Click, Enter, Space, or a dropped file | Works (code) |
| Replace the whole product master, Load | Product SKU master | `POST /api/admin/product-master/import`. Disabled until the file has rows and the box is ticked, with a title that says why | Works (code) |
| + Add user | Users | None. Users are created with `npm run user:create` | Disabled (title: Adding users is not available yet. Use npm run user:create) |
| New option name, + Add option | Issue configuration | `POST /api/admin/issue-options` | Works (code) |
| Remove option (×) | Issue configuration | Asks for confirmation, then `DELETE /api/admin/issue-options/:id` | Works (code) |
| Category: Active | Issue configuration | `PATCH /api/admin/issue-categories/:code`. Disabled for "No issue" | Works (code) |
| Category: Needs a ticket ID | Issue configuration | `PATCH /api/admin/issue-categories/:code`. Disabled for "No issue" | Works (code) |
| New partner name, + Add partner | Logistics partners | `POST /api/admin/logistics-partners` | Works (code) |
| Switch off / Switch on (partner) | Logistics partners | `PATCH /api/admin/logistics-partners/:id` | Works (code) |
| Courier name, account, + Add courier name | Per partner | `POST /api/admin/logistics-partners/:id/aliases`. An empty account means every account | Works (code) |
| Switch off / Switch on (courier name) | Per courier name | `PATCH /api/admin/logistics-partner-aliases/:id` | Works (code) |
| Tracking host, + Add host | Not on the screen. The route remains | `POST /api/admin/logistics-partners/:id/domains` | Works (code). The Admin screen does not call it |
| Switch off / Switch on (host) | Not on the screen. The route remains | `PATCH /api/admin/logistics-partner-domains/:id` | Works (code). The Admin screen does not call it |
| + Connect account | Marketplace accounts | None | Disabled (title: Connecting accounts is not available yet) |
| Manage | Marketplace accounts, per account | None | Disabled (title: Account management is not available yet) |

The Admin page states that return type mappings, header aliases and validation exceptions are not built.

## Dead paths and stale wording

- **Editable ticket cell** (`src/returns-table.tsx`, the full table, not the compact one). It saves on blur or Enter. No page renders it today. Without an `onTicket` handler its save does nothing, because `noTicketSave` returns without a server call. Wire it to `PATCH /api/tickets/:id/status`, or remove it, before a page uses it.
- **`MARKETPLACES`** (`src/marketplaces.ts`) is no longer used for account lists. Only `MARKETPLACE_CLASS` is used, by `src/ui.tsx`. Remove the list or keep it for badges only.
- **`src/index.css`** still defines a `.demo-note` class and a default swatch colour. Neither is shown to users.

## Changes since 2026-10-08

- The Admin page and its navigation item are shown to administrators only. The admin routes check the role.
- The scan screen sends the scanned AWB with each save. Accounts come from `GET /api/accounts`. The match, the logistic partner and the source file are shown.
- Uploads are previewed, checked, and then activated on the server. Only scannable return rows activate; pending/rejected rows remain in history, and partial activation needs confirmation. Scanner lists are validation-only.
- The register exports the approved 19 columns by default, or the operational set. The record view shows the traceability fields.
- The Admin page has a logistics partner tab, for the partner name, its mark, and courier names. Tracking hosts are not shown. A name that starts with a known alias, such as `delhiveryexpress`, is that partner.

## Server follow-ups from 2026-10-08

1. **Admin routes have no role check.** Done in code on 2026-10-10. Every admin route uses `requireAdmin`.
2. **Date filters on Reports.** Done in code. From and To filter by IST scan day.
3. **`/api/returns/export`.** Removed. The register export replaces it.
4. **Figure definitions** on the Overview, Claims, Reports and scan screens (clear rate, approval rate, open claim, and the seven-day average) are still proposals. They need the user's confirmation.

## Not verified

- Nothing has been compiled or run in this environment.
- The browser flows have not been exercised: the camera and recording, the save path, the upload preview and activation, and the register export.
- The figures on the Overview, Claims and Return register have not been checked against real data.
- The UI tests (`/gsd-add-tests`) were not run. The workflow needs a numbered phase, and this project has no `.planning/` folder. There is no UI test runner in the project.
