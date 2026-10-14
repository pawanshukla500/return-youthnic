import { useEffect, useState, useMemo } from "react"
import { api } from "./api"
import { Loading, PageError } from "./shell"
import { Badge, Icon, Modal } from "./ui"

export type ReasonCategorySummary = {
  categoryCode: string
  label: string
  department: string
  isSellerFault: boolean
  isSizeIssue: boolean
  severity: string
  count: number
  percentage: string
  actionRecommendation: string
}

export type MarketplaceReasonSlice = {
  marketplace: string
  totalReturns: number
  sellerFaultCount: number
  sellerFaultPct: string
  sizeIssueCount: number
  sizeIssuePct: string
  customerRemorseCount: number
}

export type WeeklyReasonSummary = {
  totalReturns: number
  sellerFaultCount: number
  sellerFaultPct: string
  sizeIssueCount: number
  sizeIssuePct: string
  customerRemorseCount: number
  customerRemorsePct: string
  logisticsRtoCount: number
  logisticsRtoPct: string
  otherCount: number
  categories: ReasonCategorySummary[]
  marketplaces: MarketplaceReasonSlice[]
}

export type SellerFaultSkuEntry = {
  productSku: string
  productTitle: string
  sellerFaultCount: number
  totalReturnCount: number
  faultRatePct: string
  primaryDefect: string
  breakdown: {
    defective: number
    wrongItem: number
    missingItem: number
    poorQuality: number
  }
  marketplaces: string[]
  sampleOrderNumbers: string[]
  severity: "critical" | "high" | "medium"
  recommendation: string
}

export type GarmentSizeDigestEntry = {
  productSku: string
  productTitle: string
  totalSizeReturns: number
  sizeCounts: Record<string, number>
  tooSmallCount: number
  tooSmallPct: string
  tooLargeCount: number
  tooLargePct: string
  generalFitCount: number
  generalFitPct: string
  primaryProblematicSize: string
  actionableRecommendation: string
}

export type ReasonMappingItem = {
  id: number
  marketplace: string
  raw_reason: string
  canonical_code: string
  canonical_label: string
  department: string
  is_seller_fault: boolean
  is_size_issue: boolean
  severity: string
  action_recommendation: string
}

export function ReturnReasonsReport() {
  const [timeRange, setTimeRange] = useState<"week" | "month" | "all">("week")
  const [summary, setSummary] = useState<WeeklyReasonSummary | null>(null)
  const [sellerFaults, setSellerFaults] = useState<SellerFaultSkuEntry[]>([])
  const [sizeDigest, setSizeDigest] = useState<GarmentSizeDigestEntry[]>([])
  const [mappings, setMappings] = useState<ReasonMappingItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  // Search & Filter
  const [skuSearch, setSkuSearch] = useState("")
  const [sizeFilter, setSizeFilter] = useState("all")
  const [mappingSearch, setMappingSearch] = useState("")
  const [showMappingsModal, setShowMappingsModal] = useState(false)

  // Actions
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncFeedback, setSyncFeedback] = useState("")
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [recipientEmails, setRecipientEmails] = useState("")
  const [isSendingEmail, setIsSendingEmail] = useState(false)
  const [emailStatus, setEmailStatus] = useState("")

  const loadData = async () => {
    setLoading(true)
    setError("")
    try {
      const now = new Date()
      let dateFrom = ""
      let dateTo = ""

      if (timeRange === "week") {
        const start = new Date(now)
        start.setDate(now.getDate() - 7)
        dateFrom = start.toISOString().split("T")[0]
        dateTo = now.toISOString().split("T")[0]
      } else if (timeRange === "month") {
        const start = new Date(now)
        start.setDate(now.getDate() - 30)
        dateFrom = start.toISOString().split("T")[0]
        dateTo = now.toISOString().split("T")[0]
      }

      const params = new URLSearchParams()
      if (dateFrom && dateTo) {
        params.set("dateFrom", dateFrom)
        params.set("dateTo", dateTo)
      }

      const queryStr = params.toString() ? `?${params.toString()}` : ""

      const [overviewRes, faultsRes, sizeRes] = await Promise.all([
        api<{ ok: boolean; summary: WeeklyReasonSummary }>(`/api/reports/return-reasons/overview${queryStr}`),
        api<{ ok: boolean; skus: SellerFaultSkuEntry[] }>(`/api/reports/return-reasons/seller-faults${queryStr}`),
        api<{ ok: boolean; sizeDigest: GarmentSizeDigestEntry[] }>(`/api/reports/return-reasons/size-digest${queryStr}`),
      ])

      setSummary(overviewRes.summary)
      setSellerFaults(faultsRes.skus)
      setSizeDigest(sizeRes.sizeDigest)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load return reason intelligence")
    } finally {
      setLoading(false)
    }
  }

  const loadMappings = async () => {
    try {
      const res = await api<{ ok: boolean; mappings: ReasonMappingItem[] }>("/api/reports/return-reasons/mappings")
      setMappings(res.mappings)
    } catch {
      // Non-fatal
    }
  }

  useEffect(() => {
    void loadData()
  }, [timeRange])

  useEffect(() => {
    void loadMappings()
  }, [])

  const handleSync = async () => {
    setIsSyncing(true)
    setSyncFeedback("")
    try {
      const res = await api<{ ok: boolean; backfilledRows: number }>("/api/reports/return-reasons/sync", {
        method: "POST",
      })
      setSyncFeedback(`Successfully normalized & synced ${res.backfilledRows} return rows!`)
      await loadData()
    } catch (err) {
      setSyncFeedback(err instanceof Error ? err.message : "Sync failed")
    } finally {
      setIsSyncing(false)
    }
  }

  const handleSendEmail = async () => {
    setIsSendingEmail(true)
    setEmailStatus("")
    try {
      const recipients = recipientEmails
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)

      const res = await api<{ ok: boolean; message: string; summary: Record<string, unknown> }>(
        "/api/reports/return-reasons/send-digest",
        {
          method: "POST",
          body: JSON.stringify({ recipients: recipients.length ? recipients : undefined }),
        },
      )
      setEmailStatus(res.message || "Weekly digest dispatched successfully!")
      setTimeout(() => {
        setShowEmailModal(false)
        setEmailStatus("")
      }, 2500)
    } catch (err) {
      setEmailStatus(err instanceof Error ? err.message : "Failed to send weekly email digest")
    } finally {
      setIsSendingEmail(false)
    }
  }

  // Filtered Seller Fault SKUs
  const filteredFaults = useMemo(() => {
    if (!skuSearch.trim()) return sellerFaults
    const query = skuSearch.trim().toLowerCase()
    return sellerFaults.filter(
      (s) =>
        s.productSku.toLowerCase().includes(query) ||
        s.productTitle.toLowerCase().includes(query) ||
        s.primaryDefect.toLowerCase().includes(query),
    )
  }, [sellerFaults, skuSearch])

  // Filtered Sizing Entries
  const filteredSizeDigest = useMemo(() => {
    return sizeDigest.filter((entry) => {
      const matchesSearch =
        !skuSearch.trim() ||
        entry.productSku.toLowerCase().includes(skuSearch.trim().toLowerCase()) ||
        entry.productTitle.toLowerCase().includes(skuSearch.trim().toLowerCase())

      if (!matchesSearch) return false

      if (sizeFilter === "all") return true
      if (sizeFilter === "too_small") return parseFloat(entry.tooSmallPct) >= 50
      if (sizeFilter === "too_large") return parseFloat(entry.tooLargePct) >= 50
      return Boolean(entry.sizeCounts[sizeFilter])
    })
  }, [sizeDigest, skuSearch, sizeFilter])

  // Filtered Raw Mappings
  const filteredMappings = useMemo(() => {
    if (!mappingSearch.trim()) return mappings
    const q = mappingSearch.trim().toLowerCase()
    return mappings.filter(
      (m) =>
        m.marketplace.toLowerCase().includes(q) ||
        m.raw_reason.toLowerCase().includes(q) ||
        m.canonical_label.toLowerCase().includes(q) ||
        m.department.toLowerCase().includes(q),
    )
  }, [mappings, mappingSearch])

  if (error) return <PageError message={error} />
  if (loading && !summary) return <Loading label="Compiling Return Reasons & Sizing Intelligence…" />

  return (
    <div className="return-reasons-page" style={{ display: "grid", gap: 20 }}>
      {/* Top Controls & Action Bar */}
      <div
        className="panel"
        style={{
          padding: "16px 20px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 18, color: "#0f172a" }}>
              Return Reason & Sizing Intelligence
            </span>
            <Badge tone="success">Multi-Marketplace Standardized</Badge>
          </div>

          {/* Time Range Pills */}
          <div style={{ display: "flex", background: "#f1f5f9", borderRadius: 8, padding: 2, gap: 2 }}>
            <button
              type="button"
              className={`pill-btn ${timeRange === "week" ? "active" : ""}`}
              onClick={() => setTimeRange("week")}
              style={{
                border: "none",
                background: timeRange === "week" ? "#ffffff" : "transparent",
                color: timeRange === "week" ? "#0f172a" : "#64748b",
                fontWeight: timeRange === "week" ? 600 : 500,
                padding: "6px 12px",
                borderRadius: 6,
                fontSize: 13,
                cursor: "pointer",
                boxShadow: timeRange === "week" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
              }}
            >
              Past 7 Days
            </button>
            <button
              type="button"
              className={`pill-btn ${timeRange === "month" ? "active" : ""}`}
              onClick={() => setTimeRange("month")}
              style={{
                border: "none",
                background: timeRange === "month" ? "#ffffff" : "transparent",
                color: timeRange === "month" ? "#0f172a" : "#64748b",
                fontWeight: timeRange === "month" ? 600 : 500,
                padding: "6px 12px",
                borderRadius: 6,
                fontSize: 13,
                cursor: "pointer",
                boxShadow: timeRange === "month" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
              }}
            >
              Past 30 Days
            </button>
            <button
              type="button"
              className={`pill-btn ${timeRange === "all" ? "active" : ""}`}
              onClick={() => setTimeRange("all")}
              style={{
                border: "none",
                background: timeRange === "all" ? "#ffffff" : "transparent",
                color: timeRange === "all" ? "#0f172a" : "#64748b",
                fontWeight: timeRange === "all" ? 600 : 500,
                padding: "6px 12px",
                borderRadius: 6,
                fontSize: 13,
                cursor: "pointer",
                boxShadow: timeRange === "all" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
              }}
            >
              All Time
            </button>
          </div>
        </div>

        {/* Action Buttons */}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => setShowMappingsModal(true)}
            style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
          >
            <Icon name="search" size={14} />
            <span>Reason Dictionary ({mappings.length})</span>
          </button>

          <button
            type="button"
            className="btn btn-outline"
            onClick={handleSync}
            disabled={isSyncing}
            style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
          >
            <Icon name="arrow" size={14} />
            <span>{isSyncing ? "Normalizing..." : "Normalize Database"}</span>
          </button>

          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowEmailModal(true)}
            style={{
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "#136c57",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              padding: "7px 14px",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            <Icon name="upload" size={14} />
            <span>Share Weekly Digest Email</span>
          </button>
        </div>
      </div>

      {syncFeedback && (
        <div
          style={{
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            color: "#1e40af",
            padding: "10px 16px",
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          {syncFeedback}
        </div>
      )}

      {/* KPI Headline Cards */}
      {summary && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 14,
          }}
        >
          {/* Card 1: Total */}
          <div
            className="panel"
            style={{ padding: 18, borderLeft: "4px solid #64748b", background: "#ffffff" }}
          >
            <div style={{ fontSize: 12, textTransform: "uppercase", color: "#64748b", fontWeight: 600 }}>
              Total Returns
            </div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#0f172a", marginTop: 4 }}>
              {summary.totalReturns.toLocaleString()}
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
              Across Myntra, Amazon, Meesho, Flipkart, Ajio
            </div>
          </div>

          {/* Card 2: Mistakes From Our Side */}
          <div
            className="panel"
            style={{ padding: 18, borderLeft: "4px solid #cf1322", background: "#fff1f0" }}
          >
            <div style={{ fontSize: 12, textTransform: "uppercase", color: "#cf1322", fontWeight: 700 }}>
              ⚠️ Mistakes From Our Side
            </div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#cf1322", marginTop: 4 }}>
              {summary.sellerFaultCount.toLocaleString()}
            </div>
            <div style={{ fontSize: 12, color: "#cf1322", marginTop: 2, fontWeight: 600 }}>
              {summary.sellerFaultPct} of returns · Requires Attention
            </div>
          </div>

          {/* Card 3: Garment Sizing & Fit */}
          <div
            className="panel"
            style={{ padding: 18, borderLeft: "4px solid #4338ca", background: "#eef2ff" }}
          >
            <div style={{ fontSize: 12, textTransform: "uppercase", color: "#4338ca", fontWeight: 700 }}>
              📏 Garment Sizing & Fit
            </div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#4338ca", marginTop: 4 }}>
              {summary.sizeIssueCount.toLocaleString()}
            </div>
            <div style={{ fontSize: 12, color: "#4338ca", marginTop: 2, fontWeight: 600 }}>
              {summary.sizeIssuePct} of returns · Pattern Master Guide
            </div>
          </div>

          {/* Card 4: Customer Remorse */}
          <div
            className="panel"
            style={{ padding: 18, borderLeft: "4px solid #0891b2", background: "#ecfeff" }}
          >
            <div style={{ fontSize: 12, textTransform: "uppercase", color: "#0891b2", fontWeight: 600 }}>
              Customer Remorse / Preference
            </div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#0e7490", marginTop: 4 }}>
              {summary.customerRemorseCount.toLocaleString()}
            </div>
            <div style={{ fontSize: 12, color: "#0891b2", marginTop: 2 }}>
              {summary.customerRemorsePct} · Mind changed / Not needed
            </div>
          </div>

          {/* Card 5: Logistics & RTO */}
          <div
            className="panel"
            style={{ padding: 18, borderLeft: "4px solid #d97706", background: "#fffbeb" }}
          >
            <div style={{ fontSize: 12, textTransform: "uppercase", color: "#d97706", fontWeight: 600 }}>
              Logistics & Courier RTO
            </div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#b45309", marginTop: 4 }}>
              {summary.logisticsRtoCount.toLocaleString()}
            </div>
            <div style={{ fontSize: 12, color: "#d97706", marginTop: 2 }}>
              {summary.logisticsRtoPct} · Delivery delays / Transit issues
            </div>
          </div>
        </div>
      )}

      {/* Search & Filter Bar */}
      <div
        className="panel"
        style={{
          padding: "12px 18px",
          display: "flex",
          gap: 14,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: "1 1 250px", position: "relative" }}>
          <input
            type="text"
            className="input"
            placeholder="Search by SKU, product name, or defect type…"
            value={skuSearch}
            onChange={(e) => setSkuSearch(e.target.value)}
            style={{ width: "100%", paddingLeft: 32, fontSize: 13 }}
          />
          <span style={{ position: "absolute", left: 10, top: 10, color: "#94a3b8" }}>
            <Icon name="search" size={14} />
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, color: "#64748b", fontWeight: 500 }}>Filter Sizing Trend:</span>
          <select
            className="select"
            value={sizeFilter}
            onChange={(e) => setSizeFilter(e.target.value)}
            style={{ fontSize: 13, padding: "6px 12px" }}
          >
            <option value="all">All Sizing Returns</option>
            <option value="too_small">⚠️ Runs Small (&ge; 50% Too Small)</option>
            <option value="too_large">⚠️ Runs Large (&ge; 50% Too Large)</option>
            <option value="XS">Size XS</option>
            <option value="S">Size S</option>
            <option value="M">Size M</option>
            <option value="L">Size L</option>
            <option value="XL">Size XL</option>
            <option value="XXL">Size XXL</option>
            <option value="3XL">Size 3XL</option>
          </select>
        </div>
      </div>

      {/* SECTION 1: SELLER FAULT & FACTORY MISTAKES */}
      <div className="panel" style={{ padding: 20 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
            borderBottom: "1px solid #f1f5f9",
            paddingBottom: 12,
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#0f172a" }}>
              1. Priority Attention: SKUs With Mistakes From Our Side
            </h3>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
              Products returned due to warehouse mis-shipment, defective stitching, fabric damage, or missing components.
            </div>
          </div>
          <Badge tone="error">{filteredFaults.length} Problematic SKUs</Badge>
        </div>

        {filteredFaults.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: "#64748b" }}>
            No seller fault returns found for this criteria. Great job!
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ width: "25%" }}>Product Master SKU</th>
                  <th style={{ width: "18%" }}>Primary Defect</th>
                  <th style={{ textAlign: "center", width: "12%" }}>Fault Units</th>
                  <th style={{ textAlign: "center", width: "10%" }}>Severity</th>
                  <th style={{ width: "35%" }}>Recommended Corrective Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredFaults.map((sku) => {
                  const isCrit = sku.severity === "critical"
                  return (
                    <tr key={sku.productSku}>
                      <td>
                        <strong style={{ color: "#0f172a" }}>{sku.productSku}</strong>
                        <div style={{ color: "#64748b", fontSize: 11, marginTop: 2 }}>{sku.productTitle}</div>
                        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                          {sku.marketplaces.map((m) => (
                            <span
                              key={m}
                              style={{
                                fontSize: 10,
                                background: "#f1f5f9",
                                padding: "1px 5px",
                                borderRadius: 3,
                                color: "#475569",
                              }}
                            >
                              {m}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td style={{ color: "#cf1322", fontWeight: 600 }}>
                        {sku.primaryDefect}
                        <div style={{ fontSize: 11, color: "#64748b", fontWeight: "normal", marginTop: 2 }}>
                          {sku.breakdown.wrongItem > 0 && `Wrong: ${sku.breakdown.wrongItem} `}
                          {sku.breakdown.defective > 0 && `Defect: ${sku.breakdown.defective} `}
                          {sku.breakdown.missingItem > 0 && `Missing: ${sku.breakdown.missingItem} `}
                          {sku.breakdown.poorQuality > 0 && `Quality: ${sku.breakdown.poorQuality}`}
                        </div>
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <span style={{ fontWeight: 700, fontSize: 15, color: "#cf1322" }}>
                          {sku.sellerFaultCount}
                        </span>
                        <div style={{ fontSize: 11, color: "#64748b" }}>{sku.faultRatePct} fault rate</div>
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <Badge tone={isCrit ? "error" : "warning"}>
                          {sku.severity.toUpperCase()}
                        </Badge>
                      </td>
                      <td style={{ fontSize: 12, color: "#334155", lineHeight: 1.4 }}>
                        <div style={{ fontWeight: 500 }}>{sku.recommendation}</div>
                        {sku.sampleOrderNumbers.length > 0 && (
                          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 3 }}>
                            Sample orders: {sku.sampleOrderNumbers.join(", ")}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* SECTION 2: GARMENT SIZING & FIT INTELLIGENCE */}
      <div className="panel" style={{ padding: 20 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
            borderBottom: "1px solid #f1f5f9",
            paddingBottom: 12,
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#0f172a" }}>
              2. Garment Sizing & Fit Intelligence: Which Size Has Issues?
            </h3>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
              Size-level return volume and directional trend (&quot;Runs Small&quot; vs &quot;Runs Large&quot;) for the pattern-making team.
            </div>
          </div>
          <Badge tone="neutral">{filteredSizeDigest.length} Garments Analyzed</Badge>
        </div>

        {filteredSizeDigest.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: "#64748b" }}>
            No garment sizing issues found matching current criteria.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ width: "25%" }}>Garment Master SKU</th>
                  <th style={{ textAlign: "center", width: "10%" }}>Size Returns</th>
                  <th style={{ width: "20%" }}>Returned Sizes</th>
                  <th style={{ textAlign: "center", width: "15%" }}>Sizing Trend</th>
                  <th style={{ width: "30%" }}>Pattern & Grading Guidance</th>
                </tr>
              </thead>
              <tbody>
                {filteredSizeDigest.map((entry) => {
                  const runsSmall = parseFloat(entry.tooSmallPct) >= 50
                  const runsLarge = parseFloat(entry.tooLargePct) >= 50

                  return (
                    <tr key={entry.productSku}>
                      <td>
                        <strong style={{ color: "#0f172a" }}>{entry.productSku}</strong>
                        <div style={{ color: "#64748b", fontSize: 11, marginTop: 2 }}>{entry.productTitle}</div>
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <span style={{ fontWeight: 700, fontSize: 15, color: "#4338ca" }}>
                          {entry.totalSizeReturns}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {Object.entries(entry.sizeCounts)
                            .filter(([sz]) => sz !== "Unknown")
                            .sort((a, b) => b[1] - a[1])
                            .map(([sz, cnt]) => (
                              <span
                                key={sz}
                                style={{
                                  background: "#f1f5f9",
                                  border: "1px solid #e2e8f0",
                                  borderRadius: 4,
                                  padding: "2px 6px",
                                  fontSize: 11,
                                  color: "#334155",
                                }}
                              >
                                <strong>{sz}:</strong> {cnt}
                              </span>
                            ))}
                        </div>
                      </td>
                      <td style={{ textAlign: "center" }}>
                        {runsSmall ? (
                          <span
                            style={{
                              background: "#fee2e2",
                              color: "#991b1b",
                              padding: "3px 8px",
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 700,
                            }}
                          >
                            ⚠️ Runs Small ({entry.tooSmallPct})
                          </span>
                        ) : runsLarge ? (
                          <span
                            style={{
                              background: "#fef3c7",
                              color: "#92400e",
                              padding: "3px 8px",
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 700,
                            }}
                          >
                            ⚠️ Runs Large ({entry.tooLargePct})
                          </span>
                        ) : (
                          <span
                            style={{
                              background: "#e0e7ff",
                              color: "#3730a3",
                              padding: "3px 8px",
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 600,
                            }}
                          >
                            Fit Profile Issue
                          </span>
                        )}
                        <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
                          Top Size: <strong>{entry.primaryProblematicSize}</strong>
                        </div>
                      </td>
                      <td style={{ fontSize: 12, color: "#1e293b", lineHeight: 1.4 }}>
                        {entry.actionableRecommendation}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* SECTION 3: MARKETPLACE COMPARISON */}
      {summary && (
        <div className="panel" style={{ padding: 20 }}>
          <h3 style={{ margin: "0 0 14px 0", fontSize: 16, fontWeight: 700, color: "#0f172a" }}>
            3. Multi-Marketplace Return Distribution
          </h3>
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th>Marketplace</th>
                  <th style={{ textAlign: "center" }}>Total Returns</th>
                  <th style={{ textAlign: "center" }}>Seller Mistakes</th>
                  <th style={{ textAlign: "center" }}>Sizing & Fit Issues</th>
                  <th style={{ textAlign: "center" }}>Buyer Remorse</th>
                </tr>
              </thead>
              <tbody>
                {summary.marketplaces.map((m) => (
                  <tr key={m.marketplace}>
                    <td>
                      <strong>{m.marketplace}</strong>
                    </td>
                    <td style={{ textAlign: "center", fontWeight: 600 }}>{m.totalReturns.toLocaleString()}</td>
                    <td style={{ textAlign: "center", color: "#cf1322", fontWeight: 600 }}>
                      {m.sellerFaultCount.toLocaleString()} ({m.sellerFaultPct})
                    </td>
                    <td style={{ textAlign: "center", color: "#4338ca", fontWeight: 600 }}>
                      {m.sizeIssueCount.toLocaleString()} ({m.sizeIssuePct})
                    </td>
                    <td style={{ textAlign: "center", color: "#64748b" }}>
                      {m.customerRemorseCount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL: REASON MAPPING DICTIONARY */}
      {showMappingsModal && (
        <Modal wide onClose={() => setShowMappingsModal(false)}>
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>Centralized Return Reason Dictionary (105 Mappings)</h3>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setShowMappingsModal(false)}
                style={{ padding: "4px 8px" }}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <div style={{ fontSize: 13, color: "#64748b" }}>
              Standardized catalog of return reasons extracted from <code>Return Resone.xlsx</code> across all 5 marketplaces.
            </div>

            <input
              type="text"
              className="input"
              placeholder="Search marketplace or reason text…"
              value={mappingSearch}
              onChange={(e) => setMappingSearch(e.target.value)}
              style={{ fontSize: 13 }}
            />

            <div style={{ maxHeight: 420, overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 8 }}>
              <table className="table" style={{ width: "100%", fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Marketplace</th>
                    <th>Raw Marketplace Reason</th>
                    <th>Canonical Unified Category</th>
                    <th>Department</th>
                    <th>Fault Flag</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMappings.map((m) => (
                    <tr key={`${m.marketplace}-${m.raw_reason}`}>
                      <td>
                        <strong>{m.marketplace}</strong>
                      </td>
                      <td style={{ color: "#334155" }}>{m.raw_reason}</td>
                      <td style={{ fontWeight: 600, color: "#0f172a" }}>{m.canonical_label}</td>
                      <td style={{ color: "#64748b" }}>{m.department}</td>
                      <td>
                        {m.is_seller_fault ? (
                          <Badge tone="error">Seller Mistake</Badge>
                        ) : m.is_size_issue ? (
                          <Badge tone="warning">Size Issue</Badge>
                        ) : (
                          <Badge tone="neutral">Standard</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Modal>
      )}

      {/* MODAL: EMAIL REPORT SENDER */}
      {showEmailModal && (
        <Modal onClose={() => setShowEmailModal(false)}>
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>Share Weekly Return Reason Digest Over Email</h3>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setShowEmailModal(false)}
                style={{ padding: "4px 8px" }}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
              Dispatches the executive Weekly Digest email to the production and management team via Resend API.
              The email contains priority attention items for <strong>Mistakes From Our Side</strong> and the <strong>Garment Sizing Digest</strong>.
            </div>

            <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 500 }}>
              Recipient Email Addresses (comma separated, leave blank for configured defaults)
              <input
                type="text"
                className="input"
                placeholder="pawan@youthnic.com, production@vbexports.com"
                value={recipientEmails}
                onChange={(e) => setRecipientEmails(e.target.value)}
                style={{ fontSize: 13 }}
              />
            </label>

            {emailStatus && (
              <div
                style={{
                  background: emailStatus.includes("failed") ? "#fff1f0" : "#f6ffed",
                  border: `1px solid ${emailStatus.includes("failed") ? "#ffa39e" : "#b7eb8f"}`,
                  color: emailStatus.includes("failed") ? "#cf1322" : "#389e0d",
                  padding: "10px 14px",
                  borderRadius: 6,
                  fontSize: 13,
                }}
              >
                {emailStatus}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setShowEmailModal(false)}
                disabled={isSendingEmail}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSendEmail}
                disabled={isSendingEmail}
                style={{
                  background: "#136c57",
                  color: "#fff",
                  fontWeight: 600,
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: 6,
                }}
              >
                {isSendingEmail ? "Sending Digest..." : "Send Digest Now"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
