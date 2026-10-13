// Header maps for marketplace export layouts.
//
// Mapping is by header TEXT (normalized: lowercase, spaces, hyphens and underscores collapsed; see normalizeHeader in
// server/marketplace-rules.ts), never by column position. The header row is located by its required names, so lines
// above it (Meesho has a supplier block) and a moved column do not break the import. A required header that is
// renamed or removed rejects the file, and the error names the missing header.
//
// Which layouts are confirmed by a real file in the project's sample set (Desktop): Flipkart.csv, Meesho.csv,
// Amazon.csv and Ajio return .xlsx. Myntra EJ .xlsx is still not confirmed. Use `npm run layout:inspect -- "<file>"`
// to print the headers of any file.
//
// Column letters in comments are for the Myntra export checked on 2026-10-08 (reference only).

// Which columns hold the return lifecycle dates (and which holds status text), per marketplace.
// Used by server/lifecycle.ts to count each stage per day.
export type LifecycleConfig = {
  requested?: string
  approved?: string
  pickedUp?: string
  completed?: string
  statusColumn?: string
}

export type ImportProfile = {
  id: string
  label: string
  version?: string
  // Marketplace names (as stored in the marketplaces table) that use this layout.
  marketplaces: string[]
  // Normalized header names that must appear in the header row. Missing any rejects the file.
  requiredHeaders: string[]
  // Optional aliases for required/known header fields
  headerAliases?: Record<string, string[]>
  // Header names that can hold the return type, in order of preference. The first one present is read.
  returnTypeHeaders: string[]
  // Seller account per marketplace. A file for another seller is rejected with nothing saved.
  sellerIds?: Record<string, string>
  // Where the seller is read from: a column in every row (Myntra seller_id) ...
  sellerColumn?: string
  // ... or a key in the block above the header row (Meesho Supplier ID).
  sellerPreambleKey?: string
  // Name shown in the seller error message.
  sellerLabel?: string
  // Return lifecycle columns for daily counts.
  lifecycle?: LifecycleConfig
  // Columns dropped before a row's full data is stored (buyer tax and company details).
  redactColumns?: string[]
}

// Myntra seller returns report (EJ and VB share this layout).
export const MYNTRA_SELLER_RETURNS = {
  sellerId: "seller_id", // A   10708 = Myntra VB account, 45833 = Myntra EJ account
  returnTracking: "return_tracking_number", // AG  return AWB, scanned at the warehouse
  forwardTracking: "forward_tracking_number", // AF  outbound AWB, also accepted at scan
  orderId: "order_id", // S   order number. Can be damaged in the export
  orderLineId: "order_line_id", // U   channel order item id
  channelListing: "seller_sku_code", // F   channel listing id (seller SKU code)
  quantity: "quantity", // AA  units on this line
  returnType: "type", // W   "Return" (customer return) or "RTO"
  returnReason: "return_reason", // AD  reason text
} as const

// Myntra columns that are read when present but are not required.
export const MYNTRA_OPTIONAL = {
  skuIdentifier: "myntra_sku_code", // E   Myntra SKU code, the marketplace SKU identification
  returnId: "return_id", // Return event id. Two returns of one AWB with different ids are two return events
} as const

// Flipkart returns report. Sample: Flipkart.csv (1,152 rows, 43 columns, text-quoted IDs). Confirmed by the sample.
export const FLIPKART_RETURNS = {
  trackingId: "tracking_id", // Tracking ID: return AWB, FMPC, FMPP or FMPR prefix in the sample
  orderId: "order_id", // Order ID: OD prefix in the sample
  orderItemId: "order_item_id", // Order Item ID: 18-digit text in the sample
  sku: "sku", // SKU: seller SKU, e.g. B126-kabira-Bottle Green_M
  product: "product", // Product name
  quantity: "quantity", // Quantity
  returnType: "return_type", // customer_return (651 rows) or courier_return (501 rows)
  returnReason: "return_reason", // e.g. order_cancelled, mind_changed
  returnSubReason: "return_sub_reason", // e.g. different_size_color
  vendorName: "vendor_name", // carrier in the sample, e.g. flipkartlogistics
} as const

// Flipkart columns that are read when present but are not required.
export const FLIPKART_OPTIONAL = {
  fsn: "fsn", // FSN: the Flipkart marketplace SKU identification (confirmed in the sample)
  returnId: "return_id", // Return ID: the return event id (confirmed in the sample)
  shipmentId: "shipment_id", // Shipment ID: preserved per requirement
} as const

// Meesho supplier returns report. Sample: Meesho.csv (1,708 rows, 22 columns after an 8-line block). Confirmed.
// The supplier block above the header is read for the seller check, not as headers.
export const MEESHO_SUPPLIER_KEY = "supplier_id"
export const MEESHO_RETURNS = {
  awbNumber: "awb_number", // AWB Number: format depends on the courier (R...FPL, SF...FPL, VLR..., 16 digits for Delhivery)
  orderNumber: "order_number", // Order Number: 18-digit text in the sample
  suborderNumber: "suborder_number", // Suborder Number: "<order>_1", used as the order line id
  sku: "sku", // SKU, e.g. T91-Zoe-Rust_AI1
  variation: "variation", // Variation: the size, combined with the SKU (see skuWithVariation)
  productName: "product_name", // Product Name
  qty: "qty", // Qty
  typeOfReturn: "type_of_return", // Customer Return (1,369 rows) or Courier Return (RTO) (339 rows)
  courierPartner: "courier_partner", // Shadowfax, Valmo, PocketShip, Delhivery, Xpress Bees
  trackingLink: "tracking_link", // Tracking Link: carrier URL. Shadowfax: ...trackingId=<AWB>; Delhivery: /p/<AWB> or /track/package/<AWB>
  returnReason: "return_reason", // e.g. Changed my mind
  detailedReturnReason: "detailed_return_reason", // e.g. Did not like the fit
} as const

// Ajio returns report. Confirmed by "Ajio return .xlsx" on the Desktop. The return type is return_type in that file.
export const AJIO_RETURNS = {
  trackingId: "return_awb_no", // Return AWB No
  orderId: "cust_order_no", // Cust Order No
  returnOrderNumber: "return_order_number", // RETURN ORDER NUMBER: the display Order Item ID. Not an order line
  channelListing: "seller_sku", // SELLER SKU
  identifier: "jiocode", // JioCode, the marketplace SKU identification
  quantity: "return_qty", // Return QTY
  returnReason: "cust_return_reason", // Cust Return Reason
} as const

// Ajio columns that are read when present but are not required. A blank carrier is allowed because some rows have
// no carrier assigned yet.
export const AJIO_OPTIONAL = {
  carrier: "return_carrier_name", // Return Carrier Name
  shipmentId: "return_shipment_id", // Return Shipment ID: preserved per requirement
} as const

// Amazon returns report. Confirmed by Amazon.csv on the Desktop: every header below is present in that file.
// Shipment ID is shown as the display Order Item ID. It is not an order line, so it is never used for matching.
export const AMAZON_RETURNS = {
  trackingId: "reverse_leg_tracking_id", // Reverse Leg Tracking ID (the lookup AWB)
  orderId: "customer_order_id", // Customer Order ID
  shipmentId: "shipment_id", // Shipment ID: the display Order Item ID
  channelListing: "msku", // mSKU, e.g. B143-Yamuna-Pink_XL
  identifier: "asin", // ASIN, the marketplace SKU identification, e.g. B0FC67BXZ5
  quantity: "units", // Units
  returnReason: "return_reason", // Return Reason
} as const

// Amazon columns that are read when present. Confirmed by the sample.
export const AMAZON_OPTIONAL = {
  forwardLegTracking: "forward_leg_tracking_id", // Forward Leg Tracking ID: kept separately, never used as the lookup AWB
  rmaId: "rma_id", // RMA ID: the return event id
  carrier: "carrier", // Carrier, e.g. ATSPL. Not on the partner list yet, so it is Unknown until added in Admin
  sku: "sku", // SKU: the Amazon listing SKU (for example X002BUXSYP). Kept for audit, not the marketplace SKU
} as const

// Return type column candidates for Amazon, whose specification does not name the column. Ajio's real file confirms
// return_type, but keeping the candidate list lets the mapper tolerate the same export variants as Amazon.
const UNVERIFIED_RETURN_TYPE_HEADERS = ["return_type", "return_mode", "type"]

export const importProfiles: ImportProfile[] = [
  {
    id: "myntra-seller-returns",
    label: "Myntra seller returns report",
    version: "1.0",
    marketplaces: ["Myntra EJ", "Myntra VB"],
    requiredHeaders: Object.values(MYNTRA_SELLER_RETURNS),
    headerAliases: {
      return_tracking_number: ["return_tracking_number", "return_tracking_no", "return_awb_no", "return_tracking"],
      forward_tracking_number: ["forward_tracking_number", "forward_tracking_no", "forward_awb_no", "forward_tracking"],
      order_id: ["order_id", "order_number", "customer_order_id"],
      order_line_id: ["order_line_id", "order_item_id"],
      seller_sku_code: ["seller_sku_code", "seller_sku", "sku"],
      quantity: ["quantity", "qty", "units"],
    },
    returnTypeHeaders: [MYNTRA_SELLER_RETURNS.returnType],
    sellerIds: {
      "Myntra VB": "10708",
      "Myntra EJ": "45833",
    },
    sellerColumn: MYNTRA_SELLER_RETURNS.sellerId,
    sellerLabel: "seller_id",
    // Myntra's report has the creation date and a status text, with no approval or pickup date.
    lifecycle: {
      requested: "return_created_date",
      statusColumn: "status",
    },
  },
  {
    id: "flipkart-returns",
    label: "Flipkart returns report",
    version: "1.0",
    marketplaces: ["Flipkart"],
    requiredHeaders: [
      FLIPKART_RETURNS.trackingId,
      FLIPKART_RETURNS.orderId,
      FLIPKART_RETURNS.orderItemId,
      FLIPKART_RETURNS.sku,
      FLIPKART_RETURNS.quantity,
      FLIPKART_RETURNS.returnType,
      FLIPKART_RETURNS.returnReason,
    ],
    headerAliases: {
      tracking_id: ["tracking_id", "awb_number", "tracking_no", "return_awb_no"],
      order_id: ["order_id", "customer_order_id", "order_number"],
      order_item_id: ["order_item_id", "order_line_id"],
      sku: ["sku", "seller_sku", "seller_sku_code"],
      quantity: ["quantity", "qty", "units"],
      shipment_id: ["shipment_id", "shipment_number"],
      vendor_name: ["vendor_name", "courier_partner", "courier", "carrier"],
    },
    returnTypeHeaders: [FLIPKART_RETURNS.returnType],
    // No seller ID in the Flipkart sample. Add sellerIds here once the account ID is confirmed.
    lifecycle: {
      requested: "return_requested_date",
      approved: "return_approval_date",
      pickedUp: "picked_up_date",
      completed: "completed_date",
      statusColumn: "return_status",
    },
    // Buyer tax number and company name are not stored.
    redactColumns: ["customer_gstin", "customer_company_name"],
  },
  {
    id: "meesho-returns",
    label: "Meesho supplier returns report",
    version: "1.0",
    marketplaces: ["Meesho"],
    requiredHeaders: [
      MEESHO_RETURNS.awbNumber,
      MEESHO_RETURNS.orderNumber,
      MEESHO_RETURNS.suborderNumber,
      MEESHO_RETURNS.sku,
      MEESHO_RETURNS.qty,
      MEESHO_RETURNS.typeOfReturn,
      MEESHO_RETURNS.courierPartner,
      MEESHO_RETURNS.returnReason,
    ],
    headerAliases: {
      awb_number: ["awb_number", "tracking_id", "awb_no", "tracking_number"],
      order_number: ["order_number", "order_id", "customer_order_id"],
      suborder_number: ["suborder_number", "sub_order_number", "order_item_id", "order_line_id"],
      sku: ["sku", "product_sku", "seller_sku"],
      qty: ["qty", "quantity", "units"],
      courier_partner: ["courier_partner", "courier", "carrier", "carrier_name", "vendor_name"],
    },
    returnTypeHeaders: [MEESHO_RETURNS.typeOfReturn],
    sellerIds: {
      Meesho: "10874",
    },
    sellerPreambleKey: MEESHO_SUPPLIER_KEY,
    sellerLabel: "Supplier ID",
    // The Meesho sample has a return-created date and a delivered date, with no approval or pickup date.
    lifecycle: {
      requested: "return_created_date",
      completed: "delivered_date",
    },
  },
  {
    id: "ajio-returns",
    label: "Ajio returns report",
    version: "1.0",
    marketplaces: ["Ajio"],
    requiredHeaders: [
      AJIO_RETURNS.trackingId,
      AJIO_RETURNS.orderId,
      AJIO_RETURNS.returnOrderNumber,
      AJIO_RETURNS.channelListing,
      AJIO_RETURNS.identifier,
      AJIO_RETURNS.quantity,
      AJIO_RETURNS.returnReason,
    ],
    headerAliases: {
      return_awb_no: ["return_awb_no", "tracking_id", "return_tracking_no", "return_tracking_number", "awb_no"],
      cust_order_no: ["cust_order_no", "customer_order_id", "order_id", "order_number"],
      return_order_number: ["return_order_number", "return_order_no", "order_item_id"],
      seller_sku: ["seller_sku", "seller_sku_code", "sku"],
      return_qty: ["return_qty", "quantity", "qty", "units"],
      cust_return_reason: ["cust_return_reason", "return_reason", "reason"],
      return_shipment_id: ["return_shipment_id", "shipment_id"],
    },
    returnTypeHeaders: UNVERIFIED_RETURN_TYPE_HEADERS,
  },
  {
    id: "amazon-returns",
    label: "Amazon returns report",
    version: "1.0",
    marketplaces: ["Amazon"],
    requiredHeaders: [
      AMAZON_RETURNS.trackingId,
      AMAZON_RETURNS.orderId,
      AMAZON_RETURNS.shipmentId,
      AMAZON_RETURNS.channelListing,
      AMAZON_RETURNS.identifier,
      AMAZON_RETURNS.quantity,
      AMAZON_RETURNS.returnReason,
    ],
    headerAliases: {
      reverse_leg_tracking_id: ["reverse_leg_tracking_id", "reverse_tracking_id", "tracking_id", "return_tracking_number", "return_awb_no"],
      forward_leg_tracking_id: ["forward_leg_tracking_id", "forward_tracking_id", "forward_tracking_number"],
      customer_order_id: ["customer_order_id", "order_id", "order_number"],
      shipment_id: ["shipment_id", "order_item_id"],
      msku: ["msku", "merchant_sku", "seller_sku", "seller_sku_code"],
      units: ["units", "quantity", "qty"],
      return_reason: ["return_reason", "reason"],
    },
    returnTypeHeaders: UNVERIFIED_RETURN_TYPE_HEADERS,
  },
]

export function profileForMarketplace(marketplace: string): ImportProfile | null {
  return importProfiles.find((profile) => profile.marketplaces.includes(marketplace)) || null
}

// Marketplace option that loads the VB EXPORT product master instead of returns.
// The master is loaded with server/scripts/load-product-master.ts.
export const PRODUCT_MASTER_FILE = "VB EXPORT Product Category.xlsx"
