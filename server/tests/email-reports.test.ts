import { test } from "node:test"
import assert from "node:assert/strict"
import {
  getIstDateParts,
  renderDailyEmail,
  renderWeeklyEmail,
  sendEmailViaResend,
  SENDER_EMAIL,
  type DailyReportData,
  type WeeklyReportData,
} from "../email-reports.js"

test("getIstDateParts calculates correct Indian Standard Time fields", () => {
  // 2026-10-12T10:30:00Z + 5:30 = 16:00:00 IST
  const utcDate = new Date("2026-10-12T10:30:00Z")
  const ist = getIstDateParts(utcDate)
  assert.equal(ist.year, 2026)
  assert.equal(ist.month, 10)
  assert.equal(ist.day, 12)
  assert.equal(ist.hour, 16)
  assert.equal(ist.minute, 0)
  assert.equal(ist.dateStr, "2026-10-12")
  assert.equal(ist.timeStr, "16:00")
  assert.equal(ist.dayOfWeek, 1) // Monday
})

test("renderDailyEmail outputs valid HTML and plain text with all required metrics", () => {
  const mockDailyData: DailyReportData = {
    dateIst: "2026-10-12",
    periodStartIso: "2026-10-12T00:00:00+05:30",
    periodEndIso: "2026-10-12T23:59:59.999+05:30",
    totalShipments: 2150,
    totalUnits: 2185,
    clearReturns: 2010,
    returnsWithIssues: 140,
    issueRatePct: "6.5%",
    duplicateAttempts: 4,
    previousDay: {
      dateIst: "2026-10-11",
      totalShipments: 1980,
      totalUnits: 2010,
      deltaShipmentsPct: "+8.6%",
    },
    marketplaces: [
      {
        marketplace: "Myntra EJ",
        shipments: 450,
        units: 455,
        withIssues: 25,
        clearReturns: 425,
        issueRate: "5.6%",
      },
      {
        marketplace: "Myntra VB",
        shipments: 500,
        units: 510,
        withIssues: 30,
        clearReturns: 470,
        issueRate: "6.0%",
      },
      {
        marketplace: "Flipkart",
        shipments: 600,
        units: 610,
        withIssues: 45,
        clearReturns: 555,
        issueRate: "7.5%",
      },
      {
        marketplace: "Meesho",
        shipments: 350,
        units: 355,
        withIssues: 20,
        clearReturns: 330,
        issueRate: "5.7%",
      },
      {
        marketplace: "Amazon",
        shipments: 150,
        units: 155,
        withIssues: 12,
        clearReturns: 138,
        issueRate: "8.0%",
      },
      {
        marketplace: "Ajio",
        shipments: 100,
        units: 100,
        withIssues: 8,
        clearReturns: 92,
        issueRate: "8.0%",
      },
    ],
    operators: [
      {
        operator: "Pawan Shukla",
        shipments: 1200,
        units: 1220,
        firstScan: "09:15",
        lastScan: "18:45",
      },
      {
        operator: "Rajesh Kumar",
        shipments: 950,
        units: 965,
        firstScan: "09:30",
        lastScan: "18:30",
      },
    ],
    warnings: ["Elevated volume on Flipkart returns."],
  }

  const { html, text } = renderDailyEmail(mockDailyData)

  // Validate plain text
  assert.match(text, /Total Shipments Scanned: 2,150/)
  assert.match(text, /Total Units Scanned: 2,185/)
  assert.match(text, /Clear Returns: 2,010/)
  assert.match(text, /Returns with Issues: 140 \(6.5%\)/)
  assert.match(text, /Myntra EJ: 450 shipments/)
  assert.match(text, /Myntra VB: 500 shipments/)
  assert.match(text, /Pawan Shukla: 1,200 shipments/)
  assert.match(text, /return\.scan@youthnic\.shop/)

  // Validate HTML
  assert.match(html, /Return Operations Daily Report/)
  assert.match(html, /2,150/)
  assert.match(html, /2,185/)
  assert.match(html, /6\.5%/)
  assert.match(html, /Myntra EJ/)
  assert.match(html, /Myntra VB/)
  assert.match(html, /return\.youthnic\.shop/)
})

test("renderWeeklyEmail outputs complete weekly management summary", () => {
  const mockWeeklyData: WeeklyReportData = {
    weekLabel: "2026-10-05 to 2026-10-11",
    periodStartIst: "2026-10-05",
    periodEndIst: "2026-10-11",
    periodStartIso: "2026-10-05T00:00:00+05:30",
    periodEndIso: "2026-10-11T23:59:59.999+05:30",
    totalShipments: 14200,
    totalUnits: 14450,
    clearReturns: 13350,
    returnsWithIssues: 850,
    overallIssueRatePct: "6.0%",
    previousWeek: {
      totalShipments: 13500,
      totalUnits: 13700,
      deltaShipmentsPct: "+5.2%",
      deltaUnitsPct: "+5.5%",
    },
    dailyTrend: [
      { dayName: "Mon", dateIst: "2026-10-05", shipments: 2000, units: 2040, withIssues: 120 },
      { dayName: "Tue", dateIst: "2026-10-06", shipments: 2100, units: 2130, withIssues: 125 },
      { dayName: "Wed", dateIst: "2026-10-07", shipments: 2050, units: 2090, withIssues: 115 },
      { dayName: "Thu", dateIst: "2026-10-08", shipments: 2150, units: 2190, withIssues: 130 },
      { dayName: "Fri", dateIst: "2026-10-09", shipments: 2200, units: 2240, withIssues: 140 },
      { dayName: "Sat", dateIst: "2026-10-10", shipments: 1900, units: 1930, withIssues: 110 },
      { dayName: "Sun", dateIst: "2026-10-11", shipments: 1800, units: 1830, withIssues: 110 },
    ],
    marketplaces: [
      { marketplace: "Myntra EJ", shipments: 3000, units: 3050, withIssues: 180, clearReturns: 2820, issueRate: "6.0%" },
      { marketplace: "Myntra VB", shipments: 3200, units: 3260, withIssues: 190, clearReturns: 3010, issueRate: "5.9%" },
    ],
    operators: [
      { operator: "Pawan Shukla", shipments: 7800, units: 7940, firstScan: "—", lastScan: "—" },
    ],
    topIssues: [
      { category: "Wrong product received", count: 420, ratePct: "3.0%" },
      { category: "Damaged / Torn", count: 280, ratePct: "2.0%" },
      { category: "Missing component", count: 150, ratePct: "1.1%" },
    ],
    managementSummary: "Weekly scanning volume reached 14,200 shipments with 6.0% issue rate (+5.2% vs previous week).",
    warnings: [],
  }

  const { html, text } = renderWeeklyEmail(mockWeeklyData)
  assert.match(text, /Weekly Operations Report/)
  assert.match(text, /14,200 shipments/)
  assert.match(text, /Wrong product received/)
  assert.match(html, /Weekly Return Operations Report/)
  assert.match(html, /14,200/)
})

test("sendEmailViaResend returns dryRun when RESEND_API_KEY is not configured", async () => {
  const originalKey = process.env.RESEND_API_KEY
  delete process.env.RESEND_API_KEY
  try {
    const res = await sendEmailViaResend({
      to: ["admin@youthnic.shop"],
      subject: "Test",
      html: "<p>Test</p>",
      text: "Test",
    })
    assert.deepEqual(res, { dryRun: true })
  } finally {
    if (originalKey) process.env.RESEND_API_KEY = originalKey
  }
})

test("SENDER_EMAIL is return.scan@youthnic.shop", () => {
  assert.equal(SENDER_EMAIL, "return.scan@youthnic.shop")
})
