# OMSGuru order details for returns: how the pull works

Last updated: 2026-10-08.

## What it does

`npm run oms:orders` takes the return rows already in the app (uploaded from Myntra, Flipkart and Meesho) and asks OMSGuru for each order's details. The results go into a new table, `oms_order_snapshots`, and optionally a CSV in `exports\`.

Return data stays where it is, in `expected_returns` (from the uploads). The snapshot table links each return to OMSGuru's order by a lookup key.

## Lookup order per return

1. The order line id as `sub_order_id` (the Myntra `order_line_id`, Flipkart's Order Item ID, Meesho's Suborder Number). It's the most specific key.
2. The order number as `order_id`, if the first lookup finds nothing. Order numbers that Excel has already damaged (scientific notation) are skipped.

The first lookup that returns an order is kept. A "NOT_FOUND" or an error is recorded, so the next run doesn't repeat it. A throttled answer stops the run cleanly.

Which key OMSGuru matches for each marketplace is an assumption until the first run shows it.

## What is stored

Normalized columns, from the first response fields the Forward Scan project reads:
`channel_order_id`, `sub_order_ids`, `item_statuses`, `shipment_tracker`, `invoice_id`, `invoice_date`, `warehouse`, `channel_label`, `skus`, plus `last_error` and `fetched_at`.

`raw_json` keeps the full response with buyer and contact fields removed. Removed keys: anything containing phone, mobile, email, address, customer, buyer, consignee, receiver, recipient, pin code, zip code, or GSTIN.

## Steps

1. Export the SwaggerHub spec (JSON or YAML) and save it to `docs\layouts\` if you haven't yet.
2. Start the app once with `npm run dev`, so the tables exist.
3. Pull a small sample and check the field names:

```bash
npm run oms:orders -- --sample --limit 20
```

4. Check the summary table it prints, then send me the output. The `--sample` part shows field names only, never values.
5. Pull more, for one marketplace at a time, and write a CSV:

```bash
npm run oms:orders -- --limit 200 --marketplace Flipkart --csv
```

## What to send back

- The summary and the table from step 3 (lookup, result, and order ids are fine to share; buyer details are not in the output)
- The field-name lines from `--sample`
- Any `error:` results, with their text

## Not done yet

- A UI table in the app. I'll add it once a real response shows the field names.
- Scheduling. The command runs by hand.
- Matching OMSGuru's order status against the scan result (for example, flagging a return whose order was cancelled).
- Keeping buyer details at all. Right now they are removed before storage. Decide whether they're needed for claims before any table shows them.
