import { useEffect, useState } from "react"
import { api, downloadFile } from "./api"
import { DateField } from "./date-field"
import { Loading } from "./shell"
import { Badge, Icon, Modal } from "./ui"

export type SkuBreakdownItem = {
  sku: string
  qty: number
  marketplaces: Record<string, number>
}

export type OmsguruDailyUpdateItem = {
  id: number
  requestId: string
  updateDate: string
  dropshipWarehouseId: string
  totalSkus: number
  totalQty: number
  fileName: string
  storagePath: string
  storageUrl: string
  emailSent: boolean
  emailSentAt: string | null
  emailRecipients: string[]
  emailCc: string[]
  generatedBy: number | null
  createdAt: string
}

export type OmsguruSummary = {
  todayDate: string
  todayPendingUnits: number
  todayPendingSkus: number
  scheduledTime: string
  scheduledEnabled: boolean
  warehouseId: string
  firebaseActive: boolean
}

export type OmsguruConfig = {
  dailyEnabled: boolean
  dailyTime: string
  dropshipWarehouseId: string
  retentionDays: number
  storageFolder: string
  ccEmails: string[]
}

export type UnmappedScannedItem = {
  scanId: number
  account: string
  tracking: string
  orderNumber: string
  listingSku: string
  qty: number
}

export function OmsguruDailyReport() {
  const [updates, setUpdates] = useState<OmsguruDailyUpdateItem[]>([])
  const [summary, setSummary] = useState<OmsguruSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)

  // Filtering & Pagination
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [search, setSearch] = useState("")
  const [dateFilter, setDateFilter] = useState("")

  // Modals
  const [selectedUpdate, setSelectedUpdate] = useState<{
    update: OmsguruDailyUpdateItem & { skuBreakdown: SkuBreakdownItem[] }
  } | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detailSkuSearch, setDetailSkuSearch] = useState("")

  // Today Live Preview Modal
  const [previewData, setPreviewData] = useState<{
    date: string
    totalSkus: number
    totalQty: number
    skus: SkuBreakdownItem[]
    unmappedItems?: UnmappedScannedItem[]
  } | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [showPreviewModal, setShowPreviewModal] = useState(false)
  const [previewSkuSearch, setPreviewSkuSearch] = useState("")

  // Unmapped Scanned Returns Alert State
  const [unmappedData, setUnmappedData] = useState<{
    date: string
    hasUnmapped: boolean
    unmappedCount: number
    unmappedItems: UnmappedScannedItem[]
  } | null>(null)
  const [showUnmappedModal, setShowUnmappedModal] = useState(false)
  const [unmappedSearch, setUnmappedSearch] = useState("")

  // Settings Modal
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [config, setConfig] = useState<OmsguruConfig | null>(null)
  const [savingConfig, setSavingConfig] = useState(false)
  const [ccInput, setCcInput] = useState("")

  // Action states
  const [generating, setGenerating] = useState(false)
  const [sendingId, setSendingId] = useState<number | null>(null)

  const loadUnmappedCheck = async () => {
    try {
      const res = await api<{
        date: string
        hasUnmapped: boolean
        unmappedCount: number
        unmappedItems: UnmappedScannedItem[]
      }>("/api/omsguru/unmapped-check")
      setUnmappedData(res)
    } catch {
      // ignore
    }
  }

  const loadData = async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set("page", String(page))
      params.set("pageSize", "20")
      if (search.trim()) params.set("search", search.trim())
      if (dateFilter.trim()) params.set("date", dateFilter.trim())

      const res = await api<{
        updates: OmsguruDailyUpdateItem[]
        summary: OmsguruSummary
        totalPages: number
        totalCount: number
      }>(`/api/omsguru/daily?${params.toString()}`)

      setUpdates(res.updates)
      setSummary(res.summary)
      setTotalPages(res.totalPages)
      setTotalCount(res.totalCount)
    } catch (err: any) {
      setError(err.message || "Failed to load OMSGuru daily updates")
    } finally {
      if (!silent) setLoading(false)
    }
  }

  const loadConfig = async () => {
    try {
      const res = await api<{ config: OmsguruConfig }>("/api/omsguru/config")
      setConfig(res.config)
      setCcInput((res.config.ccEmails || []).join(", "))
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    loadData()
    loadConfig()
    loadUnmappedCheck()
  }, [page, search, dateFilter])

  const handleDownload = async (id: number) => {
    try {
      setActionNotice("Downloading OMSGuru CSV...")
      await downloadFile(
        `/api/omsguru/daily/${id}/download`,
        "UpdateInStockQtyAnd_orLastPurchasePrice.csv",
      )
      setActionNotice(null)
    } catch (err: any) {
      setError(`Download failed: ${err.message}`)
    }
  }

  const handleViewDetail = async (id: number) => {
    setLoadingDetail(true)
    setDetailSkuSearch("")
    try {
      const res = await api<{
        update: OmsguruDailyUpdateItem & { skuBreakdown: SkuBreakdownItem[] }
      }>(`/api/omsguru/daily/${id}`)
      setSelectedUpdate(res)
    } catch (err: any) {
      setError(`Failed to load details: ${err.message}`)
    } finally {
      setLoadingDetail(false)
    }
  }

  const handlePreviewToday = async () => {
    setLoadingPreview(true)
    setPreviewSkuSearch("")
    setShowPreviewModal(true)
    try {
      const res = await api<{
        date: string
        totalSkus: number
        totalQty: number
        skus: SkuBreakdownItem[]
      }>("/api/omsguru/today-preview")
      setPreviewData(res)
    } catch (err: any) {
      setError(`Failed to preview today's returns: ${err.message}`)
      setShowPreviewModal(false)
    } finally {
      setLoadingPreview(false)
    }
  }

  const handleGenerateNow = async (sendEmail = false) => {
    if (unmappedData && unmappedData.hasUnmapped) {
      const confirmed = window.confirm(
        `Pre-generation Alert:\n\nThere are ${unmappedData.unmappedCount} scanned return item(s) without a linked Product Master SKU.\n\n` +
        `These unmapped items will NOT be counted in the OMSGuru stock update until their marketplace listing SKU is mapped in Admin → Product SKU master.\n\n` +
        `Click OK to proceed with only the mapped items, or Cancel to review first.`
      )
      if (!confirmed) return
    }

    setGenerating(true)
    setActionNotice("Aggregating good return scans & uploading to Firebase Storage...")
    try {
      const res = await api<{
        ok: boolean
        update: OmsguruDailyUpdateItem
        unmappedWarning?: string
        unmappedCount?: number
        emailResult?: any
      }>("/api/omsguru/daily/generate", {
        method: "POST",
        body: JSON.stringify({ sendEmail }),
      })
      if (res.unmappedWarning) {
        setActionNotice(`Generated ${res.update.requestId} (${res.update.totalQty} units). Note: ${res.unmappedWarning}`)
      } else {
        setActionNotice(`Success! Generated ${res.update.requestId} with ${res.update.totalQty} units.`)
      }
      await loadData(true)
      await loadUnmappedCheck()
    } catch (err: any) {
      setError(`Generation failed: ${err.message}`)
    } finally {
      setGenerating(false)
      setTimeout(() => setActionNotice(null), 6000)
    }
  }

  const handleSendEmail = async (id: number) => {
    setSendingId(id)
    setActionNotice("Sending update email via Resend...")
    try {
      await api(`/api/omsguru/daily/${id}/send`, { method: "POST" })
      setActionNotice("Email dispatched successfully with CSV attachment!")
      await loadData(true)
    } catch (err: any) {
      setError(`Failed to send email: ${err.message}`)
    } finally {
      setSendingId(null)
      setTimeout(() => setActionNotice(null), 5000)
    }
  }

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!config) return
    setSavingConfig(true)
    try {
      const parsedCc = ccInput
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.includes("@"))

      const res = await api<{ ok: boolean; config: OmsguruConfig }>("/api/omsguru/config", {
        method: "POST",
        body: JSON.stringify({
          ...config,
          ccEmails: parsedCc,
        }),
      })
      setConfig(res.config)
      setShowSettingsModal(false)
      setActionNotice("OMSGuru automation settings updated successfully.")
      setTimeout(() => setActionNotice(null), 4000)
    } catch (err: any) {
      setError(`Failed to save settings: ${err.message}`)
    } finally {
      setSavingConfig(false)
    }
  }

  const filteredDetailSkus = selectedUpdate?.update.skuBreakdown.filter((item) => {
    if (!detailSkuSearch.trim()) return true
    return item.sku.toLowerCase().includes(detailSkuSearch.trim().toLowerCase())
  }) || []

  const filteredPreviewSkus = previewData?.skus.filter((item) => {
    if (!previewSkuSearch.trim()) return true
    return item.sku.toLowerCase().includes(previewSkuSearch.trim().toLowerCase())
  }) || []

  return (
    <div className="omsguru-container">
      {/* Top Header Card */}
      <div className="omsguru-header-card">
        <div className="omsguru-header-main">
          <div className="omsguru-header-badge-row">
            <span className="omsguru-badge-primary">
              <Icon name="upload" size={14} />
              OMSGuru Inventory Engine
            </span>
            {summary?.firebaseActive ? (
              <span className="omsguru-badge-firebase" title="Firebase Storage bucket active: return-scan-app.firebasestorage.app">
                ● Firebase Storage Active (180-Day Archive)
              </span>
            ) : (
              <span className="omsguru-badge-offline" title="Firebase credentials missing in environment">
                ○ Firebase Storage Offline
              </span>
            )}
            <span className="omsguru-badge-schedule">
              🕒 Scheduled Daily: {summary?.scheduledTime || "23:00"} IST
            </span>
          </div>

          <h2 className="omsguru-title">Daily OMSGuru Inventory Updates</h2>
          <p className="omsguru-subtitle">
            Combines all good return scans across marketplaces (Myntra, Flipkart, Meesho, Amazon, Ajio, Shopify),
            aggregates total received quantities per Master Product SKU (excluding damaged/issue units), archives the
            file to Firebase Storage, and dispatches the OMSGuru bulk update CSV at 11:00 PM IST.
          </p>
        </div>

        <div className="omsguru-header-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handlePreviewToday}
            disabled={loadingPreview}
            title="Preview physical good returns scanned today so far"
          >
            <Icon name="report" size={15} />
            <span>Preview Today's Good Returns</span>
          </button>

          <button
            type="button"
            className="btn btn-primary"
            onClick={() => handleGenerateNow(false)}
            disabled={generating}
            title="Force generate today's OMSGuru update file and upload to Firebase now"
          >
            <Icon name="upload" size={15} />
            <span>{generating ? "Generating..." : "Generate Today Now"}</span>
          </button>

          <button
            type="button"
            className="btn btn-secondary btn-icon-only"
            onClick={() => setShowSettingsModal(true)}
            title="Configure Dropship Warehouse ID, schedule time, and audit CC recipients"
          >
            <Icon name="chevron" size={15} />
            <span style={{ fontSize: "12px", fontWeight: 600 }}>Settings</span>
          </button>
        </div>
      </div>

      {actionNotice && (
        <div className="omsguru-alert omsguru-alert-info">
          <span>{actionNotice}</span>
        </div>
      )}

      {error && (
        <div className="omsguru-alert omsguru-alert-danger">
          <span>{error}</span>
          <button type="button" className="btn-link" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {unmappedData && unmappedData.hasUnmapped && (
        <div
          className="omsguru-alert"
          style={{
            background: "#fffbeb",
            border: "1px solid #fde68a",
            color: "#92400e",
            padding: "14px 18px",
            borderRadius: "8px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
            marginBottom: "16px",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: "14px", display: "flex", alignItems: "center", gap: "6px" }}>
              <span>⚠️ Pre-Generation Alert: {unmappedData.unmappedCount} Scanned Return{unmappedData.unmappedCount === 1 ? "" : "s"} Missing Product SKU</span>
            </div>
            <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "#78350f" }}>
              These items were scanned physically in warehouse returns, but their marketplace listing SKUs are not yet linked to any internal VB Export Product SKU.
              OMSGuru cannot increment inventory for these items until they are mapped in Admin → Product SKU master.
            </p>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setShowUnmappedModal(true)}
              style={{ fontWeight: 600 }}
            >
              Inspect Missing ({unmappedData.unmappedCount})
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() =>
                downloadFile("/api/admin/product-master/unmapped/download", "unmapped-listing-skus.csv").catch((err: Error) =>
                  setError(err.message),
                )
              }
              style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
            >
              <Icon name="file" size={13} /> Download Missing SKUs CSV
            </button>
          </div>
        </div>
      )}

      {/* KPI Stat Cards */}
      <div className="omsguru-kpi-grid">
        <div className="omsguru-kpi-card">
          <div className="omsguru-kpi-header">
            <span>Today's Good Returns Ready</span>
            <span className="omsguru-kpi-dot green">●</span>
          </div>
          <div className="omsguru-kpi-value">{summary ? summary.todayPendingUnits.toLocaleString("en-IN") : "0"}</div>
          <div className="omsguru-kpi-sub">
            Across {summary ? summary.todayPendingSkus.toLocaleString("en-IN") : "0"} Master SKUs today
          </div>
        </div>

        <div className="omsguru-kpi-card">
          <div className="omsguru-kpi-header">
            <span>Target Dropship Warehouse</span>
            <span className="omsguru-kpi-dot blue">●</span>
          </div>
          <div className="omsguru-kpi-value">{summary?.warehouseId || "6688"}</div>
          <div className="omsguru-kpi-sub">OMSGuru DropshipWarehouseId</div>
        </div>

        <div className="omsguru-kpi-card">
          <div className="omsguru-kpi-header">
            <span>Scheduled Auto-Dispatch</span>
            <span className="omsguru-kpi-dot amber">●</span>
          </div>
          <div className="omsguru-kpi-value">{summary?.scheduledTime || "23:00"} IST</div>
          <div className="omsguru-kpi-sub">
            {summary?.scheduledEnabled ? "Active daily runner" : "Schedule disabled"}
          </div>
        </div>

        <div className="omsguru-kpi-card">
          <div className="omsguru-kpi-header">
            <span>Archived Files in History</span>
            <span className="omsguru-kpi-dot purple">●</span>
          </div>
          <div className="omsguru-kpi-value">{totalCount.toLocaleString("en-IN")}</div>
          <div className="omsguru-kpi-sub">180-Day retention policy active</div>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="omsguru-filter-bar">
        <div className="omsguru-search-box">
          <Icon name="search" size={16} />
          <input
            type="text"
            placeholder="Search by Request ID or file name..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
          />
          {search && (
            <button type="button" className="omsguru-clear-btn" onClick={() => setSearch("")}>
              ✕
            </button>
          )}
        </div>

        <div className="omsguru-date-picker">
          <Icon name="calendar" size={16} />
          <DateField
            bare
            showIcon={false}
            label="Filter by specific date"
            value={dateFilter}
            onChange={(value) => {
              setDateFilter(value)
              setPage(1)
            }}
          />
          {dateFilter && (
            <button type="button" className="omsguru-clear-btn" onClick={() => setDateFilter("")}>
              ✕
            </button>
          )}
        </div>

        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => loadData()}
          disabled={loading}
          title="Refresh updates list"
        >
          <Icon name="scan" size={14} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Daily Archives Table */}
      {loading ? (
        <Loading label="Loading OMSGuru updates archive..." />
      ) : updates.length === 0 ? (
        <div className="omsguru-empty-card">
          <Icon name="report" size={32} />
          <h3>No OMSGuru updates found</h3>
          <p>
            No daily inventory updates generated yet. Click <strong>Generate Today Now</strong> above to aggregate
            today's good return scans and produce your first OMSGuru CSV.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="omsguru-table">
            <thead>
              <tr>
                <th>Date (IST)</th>
                <th>Request ID (Audit Tracker)</th>
                <th style={{ textAlign: "right" }}>Unique SKUs</th>
                <th style={{ textAlign: "right" }}>Good Units</th>
                <th>Dropship ID</th>
                <th>Email Dispatch</th>
                <th>Firebase Storage Archive</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {updates.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong style={{ color: "var(--ink)" }}>{item.updateDate}</strong>
                  </td>
                  <td>
                    <code className="omsguru-req-badge">{item.requestId}</code>
                  </td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>
                    {item.totalSkus.toLocaleString("en-IN")}
                  </td>
                  <td style={{ textAlign: "right", fontWeight: 700, color: "#136c57" }}>
                    +{item.totalQty.toLocaleString("en-IN")}
                  </td>
                  <td>
                    <span className="badge badge-neutral">{item.dropshipWarehouseId}</span>
                  </td>
                  <td>
                    {item.emailSent ? (
                      <span className="badge badge-success" title={`Sent at ${item.emailSentAt || ""}`}>
                        ✓ Sent {item.emailCc.length > 0 ? `(+${item.emailCc.length} CC)` : ""}
                      </span>
                    ) : (
                      <span className="badge badge-warning">Pending Send</span>
                    )}
                  </td>
                  <td>
                    {item.storageUrl ? (
                      <a
                        href={item.storageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="omsguru-link"
                        title={item.storagePath}
                      >
                        ☁️ {item.fileName}
                      </a>
                    ) : (
                      <span style={{ fontSize: "12px", color: "var(--muted)" }}>{item.fileName}</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <div className="omsguru-action-group">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleViewDetail(item.id)}
                        title="View SKU breakdown and quantity distribution"
                      >
                        Inspect
                      </button>

                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => handleDownload(item.id)}
                        title="Download UpdateInStockQtyAnd_orLastPurchasePrice.csv"
                      >
                        <Icon name="upload" size={13} />
                        CSV
                      </button>

                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleSendEmail(item.id)}
                        disabled={sendingId === item.id}
                        title={item.emailSent ? "Resend update email with CSV attachment" : "Send update email with CSV attachment"}
                      >
                        {sendingId === item.id ? "Sending..." : item.emailSent ? "Resend" : "Email"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="omsguru-pagination">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span>
            Page {page} of {totalPages} ({totalCount} updates)
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
          </button>
        </div>
      )}

      {/* SKU Breakdown Detail Modal */}
      {selectedUpdate && (
        <Modal onClose={() => setSelectedUpdate(null)} wide>
          <div className="omsguru-modal-content">
            <div className="omsguru-modal-header">
              <div>
                <span className="omsguru-badge-primary">OMSGuru Inventory Update Details</span>
                <h3 style={{ margin: "6px 0 2px 0", fontSize: "20px" }}>
                  {selectedUpdate.update.requestId}
                </h3>
                <small style={{ color: "var(--muted)" }}>
                  Date: {selectedUpdate.update.updateDate} · Dropship Warehouse: {selectedUpdate.update.dropshipWarehouseId} ·
                  Total Good Units: <strong>{selectedUpdate.update.totalQty}</strong> across{" "}
                  <strong>{selectedUpdate.update.totalSkus}</strong> SKUs
                </small>
              </div>

              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleDownload(selectedUpdate.update.id)}
                >
                  <Icon name="upload" size={14} />
                  Download OMSGuru CSV
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSelectedUpdate(null)}
                >
                  ✕ Close
                </button>
              </div>
            </div>

            <div style={{ margin: "16px 0", display: "flex", gap: "12px", alignItems: "center" }}>
              <div className="omsguru-search-box" style={{ flex: 1 }}>
                <Icon name="search" size={15} />
                <input
                  type="text"
                  placeholder="Filter SKUs in this update..."
                  value={detailSkuSearch}
                  onChange={(e) => setDetailSkuSearch(e.target.value)}
                />
                {detailSkuSearch && (
                  <button type="button" className="omsguru-clear-btn" onClick={() => setDetailSkuSearch("")}>
                    ✕
                  </button>
                )}
              </div>
              <span style={{ fontSize: "12px", color: "var(--muted)" }}>
                Showing {filteredDetailSkus.length} of {selectedUpdate.update.skuBreakdown.length} SKUs
              </span>
            </div>

            <div className="table-wrap" style={{ maxHeight: "400px", overflowY: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Item SkuCode (Master SKU)</th>
                    <th style={{ textAlign: "right" }}>Good Qty (ADD)</th>
                    <th>Marketplace Breakdown (Summed)</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDetailSkus.map((item) => (
                    <tr key={item.sku}>
                      <td>
                        <strong style={{ fontFamily: "monospace", fontSize: "13px" }}>{item.sku}</strong>
                      </td>
                      <td style={{ textAlign: "right", fontWeight: 700, color: "#136c57" }}>
                        +{item.qty}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                          {Object.entries(item.marketplaces).map(([mp, q]) => (
                            <span key={mp} className="badge badge-neutral" style={{ fontSize: "11px" }}>
                              {mp}: <strong>{q}</strong>
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: "16px", padding: "12px", background: "#f8fafc", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "#475569" }}>OMSGuru Upload Parameters:</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "8px", marginTop: "8px", fontSize: "12px" }}>
                <div>DropshipWarehouseId: <strong>{selectedUpdate.update.dropshipWarehouseId}</strong></div>
                <div>InventoryAction: <strong>ADD</strong></div>
                <div>QtyIncludesBlocked: <em>(blank)</em></div>
                <div>RackSpace: <em>(DEFAULT)</em></div>
                <div>Notes: <code>{selectedUpdate.update.requestId}</code></div>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Live Preview Modal */}
      {showPreviewModal && (
        <Modal onClose={() => setShowPreviewModal(false)} wide>
          <div className="omsguru-modal-content">
            <div className="omsguru-modal-header">
              <div>
                <span className="omsguru-badge-primary">Live Scan Reconciliation Preview</span>
                <h3 style={{ margin: "6px 0 2px 0", fontSize: "20px" }}>
                  Today's Good Returns ({previewData?.date || "Today"})
                </h3>
                <small style={{ color: "var(--muted)" }}>
                  Aggregating all verified scans completed today. Only good physical units are summed.
                  Damaged/issue items are excluded.
                </small>
              </div>

              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowPreviewModal(false)}
              >
                ✕ Close
              </button>
            </div>

            {loadingPreview ? (
              <Loading label="Aggregating today's good return scans..." />
            ) : previewData ? (
              <>
                <div className="omsguru-kpi-grid" style={{ marginTop: "16px", marginBottom: "16px" }}>
                  <div className="omsguru-kpi-card">
                    <div className="omsguru-kpi-header"><span>Good Return Units</span></div>
                    <div className="omsguru-kpi-value">{previewData.totalQty.toLocaleString("en-IN")}</div>
                  </div>
                  <div className="omsguru-kpi-card">
                    <div className="omsguru-kpi-header"><span>Unique Master SKUs</span></div>
                    <div className="omsguru-kpi-value">{previewData.totalSkus.toLocaleString("en-IN")}</div>
                  </div>
                </div>

                <div style={{ margin: "12px 0", display: "flex", gap: "12px", alignItems: "center" }}>
                  <div className="omsguru-search-box" style={{ flex: 1 }}>
                    <Icon name="search" size={15} />
                    <input
                      type="text"
                      placeholder="Filter SKUs in preview..."
                      value={previewSkuSearch}
                      onChange={(e) => setPreviewSkuSearch(e.target.value)}
                    />
                    {previewSkuSearch && (
                      <button type="button" className="omsguru-clear-btn" onClick={() => setPreviewSkuSearch("")}>
                        ✕
                      </button>
                    )}
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--muted)" }}>
                    {filteredPreviewSkus.length} of {previewData.skus.length} SKUs
                  </span>
                </div>

                <div className="table-wrap" style={{ maxHeight: "350px", overflowY: "auto" }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Master Product SKU</th>
                        <th style={{ textAlign: "right" }}>Good Qty (Ready to ADD)</th>
                        <th>Marketplaces Summed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPreviewSkus.length === 0 ? (
                        <tr>
                          <td colSpan={3} style={{ textAlign: "center", padding: "20px", color: "var(--muted)" }}>
                            No good returns scanned today yet.
                          </td>
                        </tr>
                      ) : (
                        filteredPreviewSkus.map((item) => (
                          <tr key={item.sku}>
                            <td>
                              <strong style={{ fontFamily: "monospace", fontSize: "13px" }}>{item.sku}</strong>
                            </td>
                            <td style={{ textAlign: "right", fontWeight: 700, color: "#136c57" }}>
                              +{item.qty}
                            </td>
                            <td>
                              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                                {Object.entries(item.marketplaces).map(([mp, q]) => (
                                  <span key={mp} className="badge badge-neutral" style={{ fontSize: "11px" }}>
                                    {mp}: <strong>{q}</strong>
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setShowPreviewModal(false)
                      handleGenerateNow(false)
                    }}
                  >
                    Generate Update File Now
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </Modal>
      )}

      {/* Settings Modal (Admin) */}
      {showSettingsModal && config && (
        <Modal onClose={() => setShowSettingsModal(false)}>
          <div className="omsguru-modal-content">
            <div className="omsguru-modal-header">
              <div>
                <h3 style={{ margin: 0, fontSize: "18px" }}>OMSGuru Automation Settings</h3>
                <small style={{ color: "var(--muted)" }}>Configure warehouse ID, daily run time, and audit CC emails</small>
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => setShowSettingsModal(false)}>✕</button>
            </div>

            <form onSubmit={handleSaveConfig} style={{ marginTop: "16px" }}>
              <div className="form-group" style={{ marginBottom: "14px" }}>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
                  Dropship Warehouse ID
                </label>
                <input
                  type="text"
                  className="input"
                  value={config.dropshipWarehouseId}
                  onChange={(e) => setConfig({ ...config, dropshipWarehouseId: e.target.value.trim() })}
                  required
                />
                <small style={{ color: "var(--muted)", fontSize: "11px" }}>
                  Default is 6688. Used as DropshipWarehouseId in the OMSGuru CSV.
                </small>
              </div>

              <div className="form-group" style={{ marginBottom: "14px" }}>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
                  Daily Scheduled Time (IST)
                </label>
                <input
                  type="time"
                  className="input"
                  value={config.dailyTime}
                  onChange={(e) => setConfig({ ...config, dailyTime: e.target.value })}
                  required
                />
                <small style={{ color: "var(--muted)", fontSize: "11px" }}>
                  23:00 is 11:00 PM IST. Supervisors receive the email. Admins are copied. You can change this time here or in Admin → System.
                </small>
              </div>

              <div className="form-group" style={{ marginBottom: "14px" }}>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
                  CC Recipients for Audit (comma separated)
                </label>
                <input
                  type="text"
                  className="input"
                  value={ccInput}
                  onChange={(e) => setCcInput(e.target.value)}
                  placeholder="manager@example.com, audit@example.com"
                />
                <small style={{ color: "var(--muted)", fontSize: "11px" }}>
                  Responsible persons and audit personnel added to CC for daily OMSGuru update emails.
                </small>
              </div>

              <div className="form-group" style={{ marginBottom: "14px" }}>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
                  Storage Retention (Days)
                </label>
                <input
                  type="number"
                  className="input"
                  value={config.retentionDays}
                  onChange={(e) => setConfig({ ...config, retentionDays: Number(e.target.value) || 180 })}
                  min={30}
                  max={365}
                />
                <small style={{ color: "var(--muted)", fontSize: "11px" }}>
                  Default is 180 days. Files older than this are automatically deleted from Firebase Storage.
                </small>
              </div>

              <div className="form-group" style={{ marginBottom: "18px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={config.dailyEnabled}
                    onChange={(e) => setConfig({ ...config, dailyEnabled: e.target.checked })}
                  />
                  <span>Enable automated daily generation & email dispatch</span>
                </label>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowSettingsModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingConfig}>
                  {savingConfig ? "Saving..." : "Save Settings"}
                </button>
              </div>
            </form>
          </div>
        </Modal>
      )}

      {/* Unmapped Scanned Returns Modal */}
      {showUnmappedModal && unmappedData && (
        <Modal onClose={() => setShowUnmappedModal(false)} wide>
          <div className="omsguru-modal-content">
            <div className="omsguru-modal-header">
              <div>
                <span
                  style={{
                    background: "#fef3c7",
                    color: "#92400e",
                    padding: "3px 8px",
                    borderRadius: 4,
                    fontWeight: 700,
                    fontSize: 11,
                    textTransform: "uppercase",
                  }}
                >
                  Unlinked Items in Scanned Returns
                </span>
                <h3 style={{ margin: "6px 0 2px 0", fontSize: "20px" }}>
                  Unmapped Returns Missing Product SKU ({unmappedData.unmappedCount})
                </h3>
                <p style={{ margin: 0, color: "var(--muted)", fontSize: "13px" }}>
                  The items below were scanned physically in warehouse returns, but their marketplace listing SKUs are not yet linked to any internal VB Export Product SKU.
                </p>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() =>
                    downloadFile("/api/admin/product-master/unmapped/download", "unmapped-listing-skus.csv").catch((err: Error) =>
                      setError(err.message),
                    )
                  }
                  style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
                >
                  <Icon name="file" size={13} /> Download Missing SKUs CSV
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowUnmappedModal(false)}
                >
                  ✕ Close
                </button>
              </div>
            </div>

            <div style={{ margin: "14px 0", display: "flex", gap: "12px", alignItems: "center" }}>
              <div className="omsguru-search-box" style={{ flex: 1 }}>
                <Icon name="search" size={15} />
                <input
                  type="text"
                  placeholder="Filter by listing SKU, order ID, or tracking ID..."
                  value={unmappedSearch}
                  onChange={(e) => setUnmappedSearch(e.target.value)}
                />
                {unmappedSearch && (
                  <button type="button" className="omsguru-clear-btn" onClick={() => setUnmappedSearch("")}>
                    ✕
                  </button>
                )}
              </div>
            </div>

            <div className="table-wrap" style={{ maxHeight: "380px", overflowY: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Marketplace</th>
                    <th>Order Number</th>
                    <th>Tracking ID</th>
                    <th>Marketplace Listing SKU</th>
                    <th style={{ textAlign: "right" }}>Scanned Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {unmappedData.unmappedItems
                    .filter((item) => {
                      if (!unmappedSearch.trim()) return true
                      const q = unmappedSearch.toLowerCase().trim()
                      return (
                        item.listingSku.toLowerCase().includes(q) ||
                        item.orderNumber.toLowerCase().includes(q) ||
                        item.tracking.toLowerCase().includes(q) ||
                        item.account.toLowerCase().includes(q)
                      )
                    })
                    .map((item) => (
                      <tr key={item.scanId}>
                        <td>
                          <span className="badge badge-neutral" style={{ fontSize: "11px", fontWeight: 600 }}>
                            {item.account}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontFamily: "monospace", fontSize: "12px" }}>
                            {item.orderNumber || "—"}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontFamily: "monospace", fontSize: "12px" }}>
                            {item.tracking}
                          </span>
                        </td>
                        <td>
                          <strong style={{ fontFamily: "monospace", fontSize: "13px", color: "#b45309" }}>
                            {item.listingSku || "(Missing on scan)"}
                          </strong>
                        </td>
                        <td style={{ textAlign: "right", fontWeight: 700 }}>
                          {item.qty}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 14, padding: "10px 14px", background: "#f8fafc", borderRadius: 8, fontSize: 12, color: "#475569" }}>
              💡 <strong>Action Required:</strong> Download the pre-filled CSV template above, enter the corresponding <strong>Product SkuCode</strong> (VB Exports internal parent SKU) and <strong>Product Category</strong>, then upload it under <strong>Admin → Product SKU master</strong> tab. Once mapped, these items will automatically be included in future OMSGuru inventory updates.
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
