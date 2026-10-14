// Unit tests for Return Reason Standardization & Garment Sizing Intelligence.
// All test fixtures use SYN- synthetic identifiers and never contain real customer PII or credentials.
//
// Run: node --import tsx --test server/tests/return-reasons.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  extractGarmentSize,
  normalizeReturnReason,
  CANONICAL_REASONS,
} from "../return-reasons.js"
import {
  renderWeeklyReasonsEmail,
  type WeeklyReasonsReportData,
} from "../return-reasons-report.js"

// ---------------------------------------------------------------------------------------------------------------
// 1. Garment Size Extraction Tests
// ---------------------------------------------------------------------------------------------------------------

test("[synthetic] extracts apparel size from delimited listing SKU strings", () => {
  assert.equal(extractGarmentSize("SYN-SKU-BT218-Blue_S_You"), "S")
  assert.equal(extractGarmentSize("SYN-SKU-BT218-Blue_M_You"), "M")
  assert.equal(extractGarmentSize("SYN-SKU-BT218-Blue_L_You"), "L")
  assert.equal(extractGarmentSize("SYN-SKU-BT218-Blue_XL_You"), "XL")
  assert.equal(extractGarmentSize("SYN-SKU-BT218-Blue_XXL_You"), "XXL")
  assert.equal(extractGarmentSize("SYN-SKU-BT218-Blue_2XL_You"), "XXL")
  assert.equal(extractGarmentSize("SYN-SKU-BT218-Blue_3XL_You"), "3XL")
  assert.equal(extractGarmentSize("SYN-SKU-BT218-Blue_4XL_You"), "4XL")
  assert.equal(extractGarmentSize("SYN-SKU-BT218-Blue_5XL_You"), "5XL")
  assert.equal(extractGarmentSize("SYN-SKU-BT218-Blue_XS_You"), "XS")
})

test("[synthetic] extracts apparel size from trailing tokens and labels", () => {
  assert.equal(extractGarmentSize("SYN-KURTI-BLACK-M"), "M")
  assert.equal(extractGarmentSize("SYN-KURTI-BLACK_XL"), "XL")
  assert.equal(extractGarmentSize("SYN-KURTA-SET 3XL"), "3XL")
  assert.equal(extractGarmentSize("SYN-DRESS - Free Size"), "Free Size")
  assert.equal(extractGarmentSize("SYN-DRESS (Size: XXL)"), "XXL")
  assert.equal(extractGarmentSize("SYN-TOP Size - S"), "S")
})

test("[synthetic] returns empty string when no garment size is present", () => {
  assert.equal(extractGarmentSize("SYN-HANDBAG-BROWN"), "")
  assert.equal(extractGarmentSize("SYN-BOTTLE-1000ML"), "")
  assert.equal(extractGarmentSize(""), "")
  assert.equal(extractGarmentSize(null), "")
})

// ---------------------------------------------------------------------------------------------------------------
// 2. Canonical Reason Normalization Tests Across All 5 Marketplaces
// ---------------------------------------------------------------------------------------------------------------

test("[synthetic] Myntra: standardizes seller faults vs sizing vs remorse", () => {
  // Seller fault: wrong item delivered
  const wrong1 = normalizeReturnReason("Myntra", "Different product was delivered")
  assert.equal(wrong1.categoryCode, "SELLER_FAULT_WRONG_ITEM")
  assert.equal(wrong1.isSellerFault, true)

  const wrong2 = normalizeReturnReason("Myntra", "Received a completely different product")
  assert.equal(wrong2.categoryCode, "SELLER_FAULT_WRONG_ITEM")
  assert.equal(wrong2.isSellerFault, true)

  // Seller fault: defective product
  const def1 = normalizeReturnReason("Myntra", "Product was damaged")
  assert.equal(def1.categoryCode, "SELLER_FAULT_DEFECTIVE")
  assert.equal(def1.isSellerFault, true)

  const def2 = normalizeReturnReason("Myntra", "Product was dirty and had stains")
  assert.equal(def2.categoryCode, "SELLER_FAULT_DEFECTIVE")
  assert.equal(def2.isSellerFault, true)

  // Sizing issues
  const small = normalizeReturnReason("Myntra", "Size too small")
  assert.equal(small.categoryCode, "SIZE_FIT_TOO_SMALL")
  assert.equal(small.isSizeIssue, true)
  assert.equal(small.isSellerFault, false)

  const big = normalizeReturnReason("Myntra", "Size too big")
  assert.equal(big.categoryCode, "SIZE_FIT_TOO_LARGE")
  assert.equal(big.isSizeIssue, true)

  const fit = normalizeReturnReason("Myntra", "I did not like the fit")
  assert.equal(fit.categoryCode, "SIZE_FIT_GENERAL")
  assert.equal(fit.isSizeIssue, true)

  // Customer remorse
  const remorse = normalizeReturnReason("Myntra", "Found a better price on Myntra")
  assert.equal(remorse.categoryCode, "CUSTOMER_REMORSE")
  assert.equal(remorse.isSellerFault, false)

  // Logistics
  const delayed = normalizeReturnReason("Myntra", "Delivery was delayed")
  assert.equal(delayed.categoryCode, "LOGISTICS_COURIER_RTO")
})

test("[synthetic] Amazon: maps return reasons accurately", () => {
  const defective = normalizeReturnReason("Amazon", "Defective/Does not work properly")
  assert.equal(defective.categoryCode, "SELLER_FAULT_DEFECTIVE")
  assert.equal(defective.isSellerFault, true)

  const missing = normalizeReturnReason("Amazon", "Missing parts or accessories")
  assert.equal(missing.categoryCode, "SELLER_FAULT_MISSING_ITEM")
  assert.equal(missing.isSellerFault, true)

  const small = normalizeReturnReason("Amazon", "Too small")
  assert.equal(small.categoryCode, "SIZE_FIT_TOO_SMALL")
  assert.equal(small.isSizeIssue, true)

  const large = normalizeReturnReason("Amazon", "Too large")
  assert.equal(large.categoryCode, "SIZE_FIT_TOO_LARGE")
  assert.equal(large.isSizeIssue, true)

  const remorse = normalizeReturnReason("Amazon", "No longer needed/wanted")
  assert.equal(remorse.categoryCode, "CUSTOMER_REMORSE")
})

test("[synthetic] Meesho: parses raw and composite sub-reasons", () => {
  const wrong = normalizeReturnReason("Meesho", "Received wrong product (different color / size / product)")
  assert.equal(wrong.categoryCode, "SELLER_FAULT_WRONG_ITEM")
  assert.equal(wrong.isSellerFault, true)

  const def = normalizeReturnReason("Meesho", "Received defective product (stains / damaged / torn)")
  assert.equal(def.categoryCode, "SELLER_FAULT_DEFECTIVE")
  assert.equal(def.isSellerFault, true)

  const compositeSmall = normalizeReturnReason("Meesho", "Have size / fit related issues · Size correct but too tight")
  assert.equal(compositeSmall.categoryCode, "SIZE_FIT_TOO_SMALL")
  assert.equal(compositeSmall.isSizeIssue, true)

  const compositeLarge = normalizeReturnReason("Meesho", "Have size / fit related issues · Size correct but too loose")
  assert.equal(compositeLarge.categoryCode, "SIZE_FIT_TOO_LARGE")
  assert.equal(compositeLarge.isSizeIssue, true)

  const compositeFit = normalizeReturnReason("Meesho", "Have size / fit related issues · Did not like the fit")
  assert.equal(compositeFit.categoryCode, "SIZE_FIT_GENERAL")
})

test("[synthetic] Flipkart: handles codes and compound return reasons", () => {
  const misship = normalizeReturnReason("Flipkart", "MISSHIPMENT")
  assert.equal(misship.categoryCode, "SELLER_FAULT_WRONG_ITEM")
  assert.equal(misship.isSellerFault, true)

  const damaged = normalizeReturnReason("Flipkart", "DAMAGED_PRODUCT")
  assert.equal(damaged.categoryCode, "SELLER_FAULT_DEFECTIVE")
  assert.equal(damaged.isSellerFault, true)

  const missing = normalizeReturnReason("Flipkart", "MISSING_ITEM")
  assert.equal(missing.categoryCode, "SELLER_FAULT_MISSING_ITEM")
  assert.equal(missing.isSellerFault, true)

  const fit = normalizeReturnReason("Flipkart", "SIZE_FIT_ISSUES")
  assert.equal(fit.categoryCode, "SIZE_FIT_GENERAL")
  assert.equal(fit.isSizeIssue, true)

  const remorse = normalizeReturnReason("Flipkart", "CUSTOMER_REMORSE")
  assert.equal(remorse.categoryCode, "CUSTOMER_REMORSE")
})

test("[synthetic] AJio: converts snake_case and sentence reasons", () => {
  const wrong = normalizeReturnReason("Ajio", "Different_Product_Delivered")
  assert.equal(wrong.categoryCode, "SELLER_FAULT_WRONG_ITEM")
  assert.equal(wrong.isSellerFault, true)

  const def = normalizeReturnReason("Ajio", "Received_Defective_Merchandise")
  assert.equal(def.categoryCode, "SELLER_FAULT_DEFECTIVE")
  assert.equal(def.isSellerFault, true)

  const small = normalizeReturnReason("Ajio", "Size_Is_Smaller_Than_Expected")
  assert.equal(small.categoryCode, "SIZE_FIT_TOO_SMALL")
  assert.equal(small.isSizeIssue, true)

  const large = normalizeReturnReason("Ajio", "Size_Is_Larger_than_Expected")
  assert.equal(large.categoryCode, "SIZE_FIT_TOO_LARGE")
  assert.equal(large.isSizeIssue, true)

  const wrongSize = normalizeReturnReason("Ajio", "Delivered_Wrong_Size")
  assert.equal(wrongSize.categoryCode, "SELLER_FAULT_WRONG_ITEM")
  assert.equal(wrongSize.isSellerFault, true)
})

// ---------------------------------------------------------------------------------------------------------------
// 3. Weekly Digest Email Template Rendering Tests
// ---------------------------------------------------------------------------------------------------------------

test("[synthetic] renders weekly email with seller mistake alert and sizing breakdown", () => {
  const mockData: WeeklyReasonsReportData = {
    weekLabel: "13 Oct – 20 Oct 2026",
    periodStartIst: "2026-10-13",
    periodEndIst: "2026-10-20",
    periodStartIso: "2026-10-13T00:00:00.000Z",
    periodEndIso: "2026-10-20T00:00:00.000Z",
    summary: {
      totalReturns: 100,
      sellerFaultCount: 15,
      sellerFaultPct: "15.0%",
      sizeIssueCount: 25,
      sizeIssuePct: "25.0%",
      customerRemorseCount: 50,
      customerRemorsePct: "50.0%",
      logisticsRtoCount: 10,
      logisticsRtoPct: "10.0%",
      otherCount: 0,
      categories: [
        {
          categoryCode: "SELLER_FAULT_DEFECTIVE",
          label: "Defective / Damaged Merchandise",
          department: "Quality Control",
          isSellerFault: true,
          isSizeIssue: false,
          severity: "high",
          count: 15,
          percentage: "15.0%",
          actionRecommendation: "Inspect batch stitching.",
        },
      ],
      marketplaces: [
        {
          marketplace: "Myntra",
          totalReturns: 50,
          sellerFaultCount: 8,
          sellerFaultPct: "16.0%",
          sizeIssueCount: 12,
          sizeIssuePct: "24.0%",
          customerRemorseCount: 30,
        },
      ],
    },
    sellerFaultSkus: [
      {
        productSku: "SYN-SKU-001",
        productTitle: "SYN Synthetic Kurti Set",
        sellerFaultCount: 8,
        totalReturnCount: 20,
        faultRatePct: "40.0%",
        primaryDefect: "Wrong Item Sent",
        breakdown: {
          defective: 2,
          wrongItem: 6,
          missingItem: 0,
          poorQuality: 0,
        },
        marketplaces: ["Myntra"],
        sampleOrderNumbers: ["SYN-ORD-101"],
        severity: "critical",
        recommendation: "Packing audit required.",
      },
    ],
    sizeDigest: [
      {
        productSku: "SYN-SKU-002",
        productTitle: "SYN Synthetic Anarkali",
        totalSizeReturns: 12,
        sizeCounts: { S: 2, M: 8, L: 2 },
        tooSmallCount: 9,
        tooSmallPct: "75.0%",
        tooLargeCount: 1,
        tooLargePct: "8.3%",
        generalFitCount: 2,
        generalFitPct: "16.7%",
        primaryProblematicSize: "M",
        actionableRecommendation: "Garment runs small (75% too small). Pattern team: increase bust/waist ease.",
      },
    ],
  }

  const email = renderWeeklyReasonsEmail(mockData)

  assert.ok(email.html.includes("Weekly Return Reason &amp; Sizing Digest") || email.html.includes("Weekly Return Reason & Sizing Digest"))
  assert.ok(email.html.includes("Mistakes Happened From Our Side"))
  assert.ok(email.html.includes("SYN-SKU-001"))
  assert.ok(email.html.includes("Wrong Item Sent"))
  assert.ok(email.html.includes("SYN-SKU-002"))
  assert.ok(email.html.includes("Garment runs small (75% too small)"))
  assert.ok(email.text.includes("SYN-SKU-001"))
  assert.ok(email.text.includes("SYN-SKU-002"))
})
