import { useEffect, useState, useTransition } from "react"
import { api, downloadFile } from "../api"
import { DateField } from "../date-field"
import { Loading, PageError } from "../shell"
import type {
  AccountOption,
  ClaimEligibilityStatus,
  ReturnTrackingItem,
  ReturnTrackingResponse,
  ReturnTrackingSummary,
} from "../types"
import { Badge, Icon, MarketplaceBadge, Modal } from "../ui"

const STATUS_TABS: { key: string; label: string; icon?: string; badgeKey?: keyof ReturnTrackingSummary }[] = [
  { key: "all", label: "All Returns" },
  { key: "eligible_rnr", label: "Claim Eligible (60–120d)", badgeKey: "eligibleRnr" },
  { key: "expiring_soon", label: "Expiring Soon (<20d)", badgeKey: "expiringSoon" },
  { key: "delayed_rts_eligible", label: "Delayed RTS (>120d)", badgeKey: "delayedRtsEligible" },
  { key: "transit", label: "In Transit (<60d)", badgeKey: "inTransit" },
  { key: "false_delivery", label: "False Delivery", badgeKey: "falseDeliveryDiscrepancies" },
  { key: "physically_received", label: "Physically Received", badgeKey: "physicallyReceived" },
  { key: "expired_unclaimed", label: "Window Expired", badgeKey: "expiredUnclaimed" },
]

export function ReturnTracking() {
  const [, startTransition] = useTransition()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState<string>("all")
  const [statusTab, setStatusTab] = useState<string>("all")
  const [returnTypeFilter, setReturnTypeFilter] = useState<string>("all")
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [dateFrom, setDateFrom] = useState<string>("")
  const [dateTo, setDateTo] = useState<string>("")
  const [page, setPage] = useState<number>(1)
  const [data, setData] = useState<ReturnTrackingResponse | null>(null)

  // Upload modal state
  const [uploadModalOpen, setUploadModalOpen] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadAccountId, setUploadAccountId] = useState<string>("auto")
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadSuccess, setUploadSuccess] = useState<any | null>(null)

  // 1-Click Claim Modal
  const [claimModalRecord, setClaimModalRecord] = useState<ReturnTrackingItem | null>(null)
  const [filingClaim, setFilingClaim] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Load available marketplace accounts
  useEffect(() => {
    api<{ accounts: AccountOption[] }>("/api/accounts")
      .then((res) => setAccounts(res.accounts || []))
      .catch((err) => console.error("Failed to load accounts", err))
  }, [])

  // Load tracking data
  const loadTrackingData = async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (selectedAccountId !== "all") params.set("marketplaceId", selectedAccountId)
      if (statusTab !== "all") params.set("status", statusTab)
      if (returnTypeFilter !== "all") params.set("returnType", returnTypeFilter)
      if (searchQuery.trim()) params.set("search", searchQuery.trim())
      if (dateFrom) params.set("dateFrom", dateFrom)
      if (dateTo) params.set("dateTo", dateTo)
      params.set("page", String(page))
      params.set("limit", "50")

      const res = await api<ReturnTrackingResponse>(`/api/returns/tracking?${params.toString()}`)
      startTransition(() => {
        setData(res)
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load return tracking records")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadTrackingData()
  }, [selectedAccountId, statusTab, returnTypeFilter, dateFrom, dateTo, page])

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(1)
    void loadTrackingData()
  }

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    })
  }

  // Handle Return Report CSV Upload
  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!uploadFile) {
      setUploadError("Please choose a CSV file to upload.")
      return
    }

    setUploading(true)
    setUploadError(null)
    setUploadSuccess(null)

    try {
      const formData = new FormData()
      formData.append("file", uploadFile)
      formData.append("marketplaceId", uploadAccountId)

      const res = await api<{
        success: boolean
        marketplaceName: string
        detectedSellerId: string
        totalRowsParsed: number
        inserted: number
        matchedScans: number
        summary: ReturnTrackingSummary
        warnings: string[]
      }>("/api/returns/tracking/upload", {
        method: "POST",
        body: formData,
      })

      setUploadSuccess(res)
      setUploadFile(null)
      void loadTrackingData()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to upload return report.")
    } finally {
      setUploading(false)
    }
  }

  // Handle 1-Click File SPF Claim
  const handleConfirmFileClaim = async () => {
    if (!claimModalRecord) return
    setFilingClaim(true)
    try {
      await api("/api/returns/tracking/claim", {
        method: "POST",
        body: JSON.stringify({
          trackingRecordId: claimModalRecord.id,
        }),
      })
      setClaimModalRecord(null)
      void loadTrackingData()
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to file SPF claim.")
    } finally {
      setFilingClaim(false)
    }
  }

  // Handle CSV Export
  const handleExport = () => {
    const params = new URLSearchParams()
    if (selectedAccountId !== "all") params.set("marketplaceId", selectedAccountId)
    if (statusTab !== "all") params.set("status", statusTab)
    if (returnTypeFilter !== "all") params.set("returnType", returnTypeFilter)
    if (searchQuery.trim()) params.set("search", searchQuery.trim())
    if (dateFrom) params.set("dateFrom", dateFrom)
    if (dateTo) params.set("dateTo", dateTo)

    downloadFile(`/api/returns/tracking/export?${params.toString()}`, `return-tracking-${new Date().toISOString().slice(0, 10)}.csv`)
  }

  const summary = data?.summary || {
    totalTracked: 0,
    inTransit: 0,
    eligibleRnr: 0,
    expiringSoon: 0,
    expiredUnclaimed: 0,
    delayedRtsEligible: 0,
    delayedRtsExpired: 0,
    physicallyReceived: 0,
    falseDeliveryDiscrepancies: 0,
    claimsFiled: 0,
  }

  return (
    <div className="page-content tracking-page">
      {/* Top Header & Actions */}
      <div className="tracking-header-row">
        <div>
          <h2>Return Tracking & SPF Claim Aging</h2>
          <p className="subtitle">
            Ingest monthly created returns (Myntra EJ & VB, Flipkart), reconcile against warehouse scan receipts, and monitor Annexure 1 SPF policy claim deadlines.
          </p>
        </div>
        <div className="tracking-header-actions">
          <button className="btn secondary" onClick={handleExport} title="Export filtered records to CSV">
            <Icon name="file" />
            <span>Export CSV</span>
          </button>
          <button className="btn primary" onClick={() => setUploadModalOpen(true)}>
            <Icon name="upload" />
            <span>Upload Returns Report</span>
          </button>
        </div>
      </div>

      {/* Summary Stat Cards */}
      <div className="stats-grid tracking-kpi-grid">
        <div className="stat-card" onClick={() => setStatusTab("all")} style={{ cursor: "pointer" }}>
          <div className="stat-card-top">
            <span className="stat-label">Total Tracked Returns</span>
            <Icon name="box" />
          </div>
          <div className="stat-value">{summary.totalTracked.toLocaleString()}</div>
          <div className="stat-subtext">All uploaded return & RTO records</div>
        </div>

        <div
          className={`stat-card kpi-highlight-amber ${statusTab === "eligible_rnr" ? "active-kpi" : ""}`}
          onClick={() => setStatusTab("eligible_rnr")}
          style={{ cursor: "pointer" }}
        >
          <div className="stat-card-top">
            <span className="stat-label">Claim Eligible (60–120d)</span>
            <span className="kpi-chip kpi-chip-amber">Action Needed</span>
          </div>
          <div className="stat-value">{summary.eligibleRnr.toLocaleString()}</div>
          <div className="stat-subtext">Undelivered RNR window open</div>
        </div>

        <div
          className={`stat-card kpi-highlight-red ${statusTab === "expiring_soon" ? "active-kpi" : ""}`}
          onClick={() => setStatusTab("expiring_soon")}
          style={{ cursor: "pointer" }}
        >
          <div className="stat-card-top">
            <span className="stat-label">Expiring Soon (&lt;20d)</span>
            <span className="kpi-chip kpi-chip-red">Urgent</span>
          </div>
          <div className="stat-value">{summary.expiringSoon.toLocaleString()}</div>
          <div className="stat-subtext">Approaching 120-day SLA cutoff</div>
        </div>

        <div
          className={`stat-card kpi-highlight-blue ${statusTab === "delayed_rts_eligible" ? "active-kpi" : ""}`}
          onClick={() => setStatusTab("delayed_rts_eligible")}
          style={{ cursor: "pointer" }}
        >
          <div className="stat-card-top">
            <span className="stat-label">Delayed RTS (&gt;120d)</span>
            <span className="kpi-chip kpi-chip-blue">7-day Window</span>
          </div>
          <div className="stat-value">{summary.delayedRtsEligible.toLocaleString()}</div>
          <div className="stat-subtext">Delivered late (&gt;120d from return)</div>
        </div>

        <div
          className={`stat-card ${statusTab === "false_delivery" ? "active-kpi" : ""}`}
          onClick={() => setStatusTab("false_delivery")}
          style={{ cursor: "pointer" }}
        >
          <div className="stat-card-top">
            <span className="stat-label">False Delivery Alert</span>
            <span className="kpi-chip kpi-chip-warn">Discrepancy</span>
          </div>
          <div className="stat-value">{summary.falseDeliveryDiscrepancies.toLocaleString()}</div>
          <div className="stat-subtext">Portal says Delivered, Not Received</div>
        </div>

        <div
          className={`stat-card ${statusTab === "transit" ? "active-kpi" : ""}`}
          onClick={() => setStatusTab("transit")}
          style={{ cursor: "pointer" }}
        >
          <div className="stat-card-top">
            <span className="stat-label">In Transit (&lt;60d)</span>
            <Icon name="arrow" />
          </div>
          <div className="stat-value">{summary.inTransit.toLocaleString()}</div>
          <div className="stat-subtext">Normal courier transit SLA</div>
        </div>

        <div
          className={`stat-card ${statusTab === "physically_received" ? "active-kpi" : ""}`}
          onClick={() => setStatusTab("physically_received")}
          style={{ cursor: "pointer" }}
        >
          <div className="stat-card-top">
            <span className="stat-label">Physically Received</span>
            <Icon name="check" />
          </div>
          <div className="stat-value">{summary.physicallyReceived.toLocaleString()}</div>
          <div className="stat-subtext">
            {summary.totalTracked > 0
              ? `${Math.round((summary.physicallyReceived / summary.totalTracked) * 100)}% verified at scan bench`
              : "0%"}
          </div>
        </div>
      </div>

      {/* Account Selector Filter Bar */}
      <div className="tracking-account-bar">
        <span className="account-bar-label">Marketplace:</span>
        <button
          className={`account-pill ${selectedAccountId === "all" ? "active" : ""}`}
          onClick={() => {
            setSelectedAccountId("all")
            setPage(1)
          }}
        >
          All Accounts
        </button>
        {accounts.map((acc) => (
          <button
            key={acc.id}
            className={`account-pill ${selectedAccountId === String(acc.id) ? "active" : ""}`}
            onClick={() => {
              setSelectedAccountId(String(acc.id))
              setPage(1)
            }}
          >
            {acc.name}
          </button>
        ))}
      </div>

      {/* Status Filter Tab Pills */}
      <div className="tracking-status-tabs">
        {STATUS_TABS.map((tab) => {
          const count = tab.badgeKey ? summary[tab.badgeKey] : null
          return (
            <button
              key={tab.key}
              className={`status-tab-btn ${statusTab === tab.key ? "active" : ""}`}
              onClick={() => {
                setStatusTab(tab.key)
                setPage(1)
              }}
            >
              <span>{tab.label}</span>
              {count !== null && count > 0 && <span className="tab-count-badge">{count}</span>}
            </button>
          )
        })}
      </div>

      {/* Filter Row: Search, Type, Dates */}
      <div className="filters-card tracking-filter-box">
        <form onSubmit={handleSearchSubmit} className="tracking-search-form">
          <div className="search-input-wrap">
            <Icon name="search" />
            <input
              type="text"
              placeholder="Search by Tracking AWB, Forward AWB, Order ID, or SKU…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="btn-clear-search"
                onClick={() => {
                  setSearchQuery("")
                  setPage(1)
                }}
              >
                ✕
              </button>
            )}
          </div>
          <button type="submit" className="btn secondary">
            Search
          </button>
        </form>

        <div className="tracking-secondary-filters">
          <div className="filter-group">
            <label>Return Type:</label>
            <select
              value={returnTypeFilter}
              onChange={(e) => {
                setReturnTypeFilter(e.target.value)
                setPage(1)
              }}
            >
              <option value="all">All Types (Customer + RTO)</option>
              <option value="Return">Customer Return</option>
              <option value="RTO">Courier RTO</option>
            </select>
          </div>

          <div className="filter-group">
            <label>Effective Date From:</label>
            <DateField label="Effective date from" value={dateFrom} onChange={(val) => { setDateFrom(val); setPage(1) }} />
          </div>

          <div className="filter-group">
            <label>Effective Date To:</label>
            <DateField label="Effective date to" value={dateTo} onChange={(val) => { setDateTo(val); setPage(1) }} />
          </div>

          {(dateFrom || dateTo || searchQuery || returnTypeFilter !== "all") && (
            <button
              className="btn-reset-filters"
              onClick={() => {
                setDateFrom("")
                setDateTo("")
                setSearchQuery("")
                setReturnTypeFilter("all")
                setPage(1)
              }}
            >
              Reset Filters
            </button>
          )}
        </div>
      </div>

      {/* Content Area */}
      {loading ? (
        <Loading label="Loading return tracking & SPF policy records…" />
      ) : error ? (
        <PageError message={error} />
      ) : !data || data.records.length === 0 ? (
        <div className="empty-state tracking-empty-box">
          <Icon name="box" />
          <h3>No Return Tracking Records Found</h3>
          <p>
            {searchQuery || statusTab !== "all" || selectedAccountId !== "all"
              ? "No returns matched the selected filters. Try broadening your criteria."
              : "No return tracking records uploaded yet. Click 'Upload Returns Report' to ingest monthly return created data for Myntra EJ or VB."}
          </p>
          <button className="btn primary" onClick={() => setUploadModalOpen(true)}>
            <Icon name="upload" />
            <span>Upload Returns Report Now</span>
          </button>
        </div>
      ) : (
        <div className="table-container tracking-table-wrapper">
          <table className="data-table tracking-table">
            <thead>
              <tr>
                <th>Effective Date</th>
                <th>Type</th>
                <th>Tracking AWB</th>
                <th>Order Details</th>
                <th>Item / SKU</th>
                <th>Portal Status</th>
                <th>Physical Verification</th>
                <th>Claim Eligibility & Deadline</th>
                <th style={{ textAlign: "right" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.records.map((r) => {
                const isRto = r.returnType === "RTO"
                return (
                  <tr key={r.id} className={r.isFalseDelivery ? "row-false-delivery" : undefined}>
                    {/* Date & Aging */}
                    <td>
                      <div className="date-cell">
                        <strong>{r.effectiveReturnDate}</strong>
                        <span className={`age-pill ${r.ageDays >= 60 && r.ageDays <= 120 ? "age-eligible" : r.ageDays > 120 ? "age-expired" : "age-transit"}`}>
                          {r.ageDays}d old
                        </span>
                      </div>
                    </td>

                    {/* Return Type */}
                    <td>
                      <span className={`return-type-badge ${isRto ? "badge-rto" : "badge-return"}`}>
                        {r.returnType}
                      </span>
                    </td>

                    {/* Tracking AWB */}
                    <td>
                      <div className="tracking-cell">
                        <div className="copy-row">
                          <code className="awb-code">{r.trackingId}</code>
                          <button
                            className="btn-icon-copy"
                            title="Copy AWB"
                            onClick={() => copyToClipboard(r.trackingId, `trk-${r.id}`)}
                          >
                            {copiedId === `trk-${r.id}` ? "✓" : "📋"}
                          </button>
                        </div>
                        {r.forwardTrackingNumber && r.forwardTrackingNumber !== r.trackingId && (
                          <small className="fwd-tag" title="Forward Dispatch AWB">
                            Fwd: {r.forwardTrackingNumber}
                          </small>
                        )}
                      </div>
                    </td>

                    {/* Order Details */}
                    <td>
                      <div className="order-cell">
                        <div className="copy-row">
                          <span>{r.orderId}</span>
                          <button
                            className="btn-icon-copy"
                            title="Copy Order ID"
                            onClick={() => copyToClipboard(r.orderId, `ord-${r.id}`)}
                          >
                            {copiedId === `ord-${r.id}` ? "✓" : "📋"}
                          </button>
                        </div>
                        <MarketplaceBadge name={r.marketplaceName} />
                      </div>
                    </td>

                    {/* SKU */}
                    <td>
                      <div className="sku-cell">
                        <strong>{r.sku || "—"}</strong>
                        {r.myntraSkuCode && <small className="muted-text">Myntra: {r.myntraSkuCode}</small>}
                      </div>
                    </td>

                    {/* Portal Status */}
                    <td>
                      <div className="portal-cell">
                        <span className="portal-status-badge">{r.portalStatus || "—"}</span>
                        {r.portalSubStatus && <small className="sub-status-tag">{r.portalSubStatus}</small>}
                        {r.portalDeliveryDate && (
                          <small className="muted-text">Delivered: {r.portalDeliveryDate}</small>
                        )}
                      </div>
                    </td>

                    {/* Physical Verification */}
                    <td>
                      {r.isPhysicallyReceived ? (
                        <div className="received-chip verified-chip">
                          <span className="chip-icon">✓</span>
                          <span>Scanned at Warehouse</span>
                          {r.physicalOutcome && (
                            <small className="outcome-pill">{r.physicalOutcome}</small>
                          )}
                        </div>
                      ) : r.isFalseDelivery ? (
                        <div className="false-delivery-badge" title="Portal marked Delivered, but package was never physically received!">
                          <span className="alert-dot">●</span>
                          <span>Portal Delivered, Not Received</span>
                        </div>
                      ) : (
                        <div className="received-chip unreceived-chip">
                          <span>Unreceived</span>
                        </div>
                      )}
                    </td>

                    {/* Claim Eligibility & Aging */}
                    <td>
                      <EligibilityBadge item={r} />
                    </td>

                    {/* Action */}
                    <td style={{ textAlign: "right" }}>
                      {r.claimId ? (
                        <span className="claim-ticket-label">Claim #{r.claimId}</span>
                      ) : r.claimEligibilityStatus === "eligible_rnr" ||
                        r.claimEligibilityStatus === "expiring_soon" ||
                        r.claimEligibilityStatus === "delayed_rts_eligible" ? (
                        <button
                          className="btn-action-claim"
                          onClick={() => setClaimModalRecord(r)}
                          title="1-Click prepare SPF claim under Policy v5.1"
                        >
                          File SPF Claim
                        </button>
                      ) : (
                        <span className="muted-text">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* Pagination Controls */}
          {data.total > data.limit && (
            <div className="table-pagination">
              <span className="pagination-info">
                Showing {((data.page - 1) * data.limit) + 1}–{Math.min(data.page * data.limit, data.total)} of {data.total.toLocaleString()} records
              </span>
              <div className="pagination-buttons">
                <button
                  className="btn secondary"
                  disabled={data.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </button>
                <span className="page-current">Page {data.page}</span>
                <button
                  className="btn secondary"
                  disabled={data.page * data.limit >= data.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Upload Modal */}
      {uploadModalOpen && (
        <Modal
          onClose={() => {
            if (!uploading) {
              setUploadModalOpen(false)
              setUploadError(null)
              setUploadSuccess(null)
            }
          }}
        >
          <div className="tracking-upload-modal-content">
            <h3>Upload Returns Report (Myntra EJ & VB, Flipkart)</h3>
            <div className="policy-note-banner">
              <strong>Myntra Seller Protection Fund (SPF) Policy v5.1 Notice:</strong>
              <p>
                Upload your monthly or period <code>Seller_Returns_Report_*.csv</code>. The system automatically
                maps return creation dates, reconciles with warehouse scan receipts, and alerts you when shipments
                enter the <strong>60 to 120-day claim window</strong> for Return Not Received (RNR), or the
                <strong>7-day window</strong> for Delayed RTS deliveries (&gt;120d).
              </p>
            </div>

            {uploadError && <div className="form-error">{uploadError}</div>}

            {uploadSuccess ? (
              <div className="upload-success-panel">
                <div className="success-header">
                  <Icon name="check" />
                  <h4>Returns Ingested Successfully!</h4>
                </div>
                <div className="success-details-grid">
                  <div>
                    <label>Account:</label> <strong>{uploadSuccess.marketplaceName}</strong>
                  </div>
                  <div>
                    <label>Seller Code:</label> <code>{uploadSuccess.detectedSellerId || "Auto"}</code>
                  </div>
                  <div>
                    <label>Rows Processed:</label> <strong>{uploadSuccess.totalRowsParsed.toLocaleString()}</strong>
                  </div>
                  <div>
                    <label>Matched Physical Scans:</label> <strong>{uploadSuccess.matchedScans.toLocaleString()}</strong>
                  </div>
                </div>

                <div className="success-summary-bar">
                  <span className="tag-summary-item amber">
                    Claim Eligible (60-120d): {uploadSuccess.summary.eligibleRnr}
                  </span>
                  <span className="tag-summary-item red">
                    Expiring Soon: {uploadSuccess.summary.expiringSoon}
                  </span>
                  <span className="tag-summary-item blue">
                    Delayed RTS: {uploadSuccess.summary.delayedRtsEligible}
                  </span>
                </div>

                <button
                  className="btn primary"
                  onClick={() => {
                    setUploadModalOpen(false)
                    setUploadSuccess(null)
                  }}
                >
                  View Ingested Records
                </button>
              </div>
            ) : (
              <form onSubmit={handleUploadSubmit} className="upload-form">
                <div className="form-field">
                  <label>Marketplace Account:</label>
                  <select
                    value={uploadAccountId}
                    onChange={(e) => setUploadAccountId(e.target.value)}
                    disabled={uploading}
                  >
                    <option value="auto">Auto-detect from Seller ID (45833 = EJ, 10708 = VB)</option>
                    {accounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>Select Returns Report CSV:</label>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                    disabled={uploading}
                  />
                  {uploadFile && (
                    <div className="selected-file-info">
                      <span>📄 {uploadFile.name}</span>
                      <small>({(uploadFile.size / 1024 / 1024).toFixed(2)} MB)</small>
                    </div>
                  )}
                </div>

                <div className="modal-actions">
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => setUploadModalOpen(false)}
                    disabled={uploading}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="btn primary" disabled={uploading || !uploadFile}>
                    {uploading ? "Ingesting & Reconciling…" : "Start Ingestion"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </Modal>
      )}

      {/* 1-Click File Claim Confirmation Modal */}
      {claimModalRecord && (
        <Modal onClose={() => setClaimModalRecord(null)}>
          <div className="claim-confirm-modal">
            <h3>File SPF Compensation Claim</h3>
            <p>
              Are you sure you want to raise a Seller Protection Fund (SPF) claim under Myntra Policy v5.1 for this return?
            </p>

            <div className="claim-item-summary">
              <div><strong>Order ID:</strong> {claimModalRecord.orderId}</div>
              <div><strong>Tracking AWB:</strong> {claimModalRecord.trackingId}</div>
              <div><strong>SKU:</strong> {claimModalRecord.sku || claimModalRecord.myntraSkuCode}</div>
              <div><strong>Effective Date:</strong> {claimModalRecord.effectiveReturnDate} ({claimModalRecord.ageDays} days ago)</div>
              <div>
                <strong>Claim Category:</strong>{" "}
                <span className="badge-highlight">
                  {claimModalRecord.claimEligibilityStatus === "delayed_rts_eligible"
                    ? "Annexure 1 Item 2: Delayed RTS/RTO Delivery (>120 days)"
                    : "Annexure 1 Item 8: Undelivered Shipment / Return Not Received (RNR)"}
                </span>
              </div>
            </div>

            <p className="policy-reminder">
              This action prepares the claim in the system and links it for the automated desktop claim filing agent.
            </p>

            <div className="modal-actions">
              <button
                type="button"
                className="btn secondary"
                onClick={() => setClaimModalRecord(null)}
                disabled={filingClaim}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={handleConfirmFileClaim}
                disabled={filingClaim}
              >
                {filingClaim ? "Filing Claim…" : "Confirm & File Claim"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function EligibilityBadge({ item }: { item: ReturnTrackingItem }) {
  switch (item.claimEligibilityStatus) {
    case "eligible_rnr":
      return (
        <div className="eligibility-badge badge-eligible-rnr">
          <span className="badge-title">Eligible (RNR 60–120d)</span>
          <span className="badge-timer">{item.daysRemaining !== null ? `${item.daysRemaining}d left` : "Active"}</span>
        </div>
      )
    case "expiring_soon":
      return (
        <div className="eligibility-badge badge-expiring-soon">
          <span className="badge-title">⚠️ Expiring Soon</span>
          <span className="badge-timer">{item.daysRemaining !== null ? `${item.daysRemaining}d left` : "Urgent"}</span>
        </div>
      )
    case "delayed_rts_eligible":
      return (
        <div className="eligibility-badge badge-delayed-rts">
          <span className="badge-title">Delayed RTS (&gt;120d)</span>
          <span className="badge-timer">{item.daysRemaining !== null ? `${item.daysRemaining}d left` : "7d window"}</span>
        </div>
      )
    case "delayed_rts_expired":
      return (
        <div className="eligibility-badge badge-muted">
          <span className="badge-title">Delayed RTS Expired</span>
          <span className="badge-timer">&gt;7d from delivery</span>
        </div>
      )
    case "transit":
      return (
        <div className="eligibility-badge badge-transit">
          <span className="badge-title">In Transit (&lt;60d)</span>
          <span className="badge-timer">{item.daysRemaining !== null ? `${item.daysRemaining}d to eligible` : "Waiting"}</span>
        </div>
      )
    case "expired_unclaimed":
      return (
        <div className="eligibility-badge badge-muted">
          <span className="badge-title">120d SLA Expired</span>
          <span className="badge-timer">Unclaimed</span>
        </div>
      )
    case "delivered_normal":
      return (
        <div className="eligibility-badge badge-delivered">
          <span className="badge-title">Delivered in SLA</span>
          <span className="badge-timer">Normal</span>
        </div>
      )
    case "claim_filed":
      return (
        <div className="eligibility-badge badge-claim-filed">
          <span className="badge-title">Claim Filed</span>
          <span className="badge-timer">{item.claimTicketCode || "Pending"}</span>
        </div>
      )
    default:
      return <span className="muted-text">—</span>
  }
}
