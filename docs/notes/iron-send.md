# Iron Send

Status date: 2026-10-17. Code: `server/schema-iron.sql`, `server/iron.ts`, `server/iron-routes.ts`, `src/pages/IronTracking.tsx`, `src/pages/IronBatches.tsx`.

## What it is

Iron Send is an operational step, not a return issue. A unit that was received but needs ironing (pressing) is sent out and comes back in about 2-3 days.

| Rule | Where it is enforced |
|---|---|
| Iron Send is not Wrong, Missing or Damaged. A scan with only Iron Send is a clear return (`outcome = 'clear'`, `status = 'Clear'`), never a claim. | `countsAsReturnIssue` (`server/register-rules.ts`), `recordScan` and `correctScanIssue` (`server/register-service.ts`) |
| Iron Send is never counted in issue figures (overview, shift, claims, email, analytics issue units). | `outcome`-based figures; `is_operational` excluded in `server/analytics.ts` and `server/email-reports.ts` |
| Iron Send units are never sent to OMSGuru. | A scanned return with any non-missing issue, including Iron Send, is left out of `UpdateInStockQtyAnd_orLastPurchasePrice.csv` entirely (`aggregateInventoryByProductSku` in `server/omsguru-daily.ts`). A missing-only line still counts the units that arrived. |
| The Return Team only records Iron Send (a tap at the scan bench, web or Android). | Scan bench |
| Only the Inward Team (role `Inward`) or an Admin records units received back, by hand. | `receiveIron` / `canReceiveIron` (`server/iron.ts`), 403 for every other role |
| Nothing marks Iron Send received automatically. | No scheduler or code path writes `iron_receive_events` except `POST /api/iron/:id/receive` |
| Pending, Received and Overdue quantities are tracked separately. | `ironSummary`, `ironStateOf` |

## States of one line sent for ironing

| State | Meaning |
|---|---|
| Pending | Nothing received back yet, and not older than the overdue setting |
| Part received | Some units received back, some still pending |
| Overdue | Units still pending after the overdue setting (default 3 days; Admin can change it on the Iron tracking page) |
| Received | Every unit received back |
| Cancelled | The scan bench changed the Iron Send before anything came back. The record is kept |

A bench correction that would change an Iron Send that the Inward Team has already received is refused (409).

## Daily use

1. Return Team: scan the parcel, tap **Iron Send** for the units that need ironing. The banner turns blue: "Saved · N units to Iron Send".
2. Inward Team: open **Iron tracking**, find the line (AWB, order or SKU), tap **Receive**, enter the units that came back. Part quantities are allowed; the rest stays pending.
3. Overdue lines are red. The weekly email lists pending and overdue units.

## Batches (khaata challan)

1. Return Team: Iron tracking > **Create batch**. Every pending line not yet in a batch is ticked; untick what is not going now. Enter the khaata, the challan number if you have it, and expected back in (2-7 days).
2. Write the batch number (for example `IRN-261014-004`) on the khaata challan. **Download Excel** gives the sheet to send with the goods. The challan number can be added later (Batches > Open > Add).
3. Batches view: Out with khaata, Overdue (past the batch's own date), Part received, Received.
4. Inward Team: open the batch, **Receive** a line (part quantities allowed) or **Receive whole batch**.
5. A line that has gone out in a batch cannot be changed from the scan bench.

## In-house ironing (high-running pieces)

High-running pieces are ironed at the return desk instead of going out to a khaata. `iron_batches.iron_location` holds the choice: `khaata` (default, sent out) or `in_house` (`server/schema-iron.sql`).

- **Create batch** has two tabs: **Send to khaata** (the flow above) and **Iron at return desk (high-running)**.
- An in-house batch starts with nothing ticked. Use the SKU/AWB search and **Tick shown** to pick only the high-running pieces. It gets the fixed name "Return desk (in-house)" instead of a khaata, there is no challan, and the expected-back choice is 1-3 days.
- The batch list labels where the batch is ironed ("Ironing at return desk"), and the Excel sheet's second row says `Ironed at: Return desk (in-house, high-running pieces)` or `Khaata (sent out)`.
- Receiving is unchanged for both locations: only the Inward Team (role `Inward`) or an Admin records units received back, by hand. Iron Send units are still never sent to OMSGuru.

## Creating an Inward user

Admin > Team members > Add user, role **Inward Team**, with the accounts the team works on (or all accounts).

## Earlier data

Scans saved before 2026-10-14 with only Iron Send were stored as issue returns (`Draft`). The schema run reclassifies each one to clear once, and writes an audit row (`scan.reclassify_operational`) with the values it replaced. Their Iron Send records are backfilled with the original tap time.
