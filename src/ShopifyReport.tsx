import { useEffect, useState } from "react"
import { api, downloadFile } from "./api"
import { DateField } from "./date-field"
import { Loading } from "./shell"
import { Badge, Icon, Modal } from "./ui"

export type ShopifyStatus = {
  configured: boolean
  connected: boolean
  message: string
  orderCount?: number
  lastSyncedLabel: string
  totalActiveScannable: number
}

export type ShopifyMetricsData = {
  formula: {
    created: number
    received: number
    pending: number
  }
  breakdown: {
    returns: {
      created: number
      received: number
      pending: number
    }
    rtos: {
      created: number
      received: number
      pending: number
    }
  }
  receiptRate: string
  totalActiveScannable: number
  lastSyncedLabel: string
  dailyStats: {
    date: string
    dayLabel: string
    createdReturns: number
    createdRtos: number
    totalCreated: number
    receivedReturns: number
    receivedRtos: number
    totalReceived: number
    pending: number
  }[]
}

export type ShopifyRecordItem = {
  sku: string
  title: string
  qty: number
  imageUrl: string
}

export type ShopifyRecordData = {
  id: number
  trackingId: string
  altTrackingId: string
  orderNumber: string
  returnType: "Customer Return" | "RTO"
  status: "Pending" | "Received"
  createdAt: string
  receivedAt: string | null
  scannedBy: string | null
  customerName: string
  customerCity: string
  customerPhone: string
  returnReason: string
  productTitle: string
  itemCount: number
  items: ShopifyRecordItem[]
  scanIssue: string | null
  scanTicket: string | null
}

export function ShopifyReport() {
  const [status, setStatus] = useState<ShopifyStatus | null>(null)
  const [metrics, setMetrics] = useState<ShopifyMetricsData | null>(null)
  const [records, setRecords] = useState<ShopifyRecordData[]>([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [tab, setTab] = useState<"all" | "pending" | "received" | "returns" | "rtos">("all")
  const [search, setSearch] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [page, setPage] = useState(1)
  const pageSize = 50

  // Details Modal
  const [selectedRecord, setSelectedRecord] = useState<ShopifyRecordData | null>(null)
  const [showDailyTable, setShowDailyTable] = useState(false)

  // Load Status and Metrics
  const loadData = async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [statusRes, metricsRes] = await Promise.all([
        api<ShopifyStatus>("/api/shopify/status"),
        api<ShopifyMetricsData>("/api/shopify/metrics"),
      ])
      setStatus(statusRes)
      setMetrics(metricsRes)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Shopify data")
    } finally {
      if (!silent) setLoading(false)
    }
  }

  // Load Records
  const loadRecords = async () => {
    try {
      const params = new URLSearchParams()
      params.set("tab", tab)
      if (search.trim()) params.set("q", search.trim())
      if (dateFrom.trim()) params.set("from", dateFrom.trim())
      if (dateTo.trim()) params.set("to", dateTo.trim())
      params.set("limit", String(pageSize))
      params.set("offset", String((page - 1) * pageSize))

      const data = await api<{ rows: ShopifyRecordData[]; total: number }>(
        `/api/shopify/records?${params.toString()}`,
      )
      setRecords(data.rows)
      setTotalRecords(data.total)
    } catch (err) {
      console.error("Failed to load Shopify records", err)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    loadRecords()
  }, [tab, search, dateFrom, dateTo, page])

  const handleSyncNow = async () => {
    setSyncing(true)
    setSyncMessage(null)
    try {
      const res = await api<{
        ok: boolean
        returnsSynced: number
        rtosSynced: number
        totalActive: number
        error?: string
      }>("/api/shopify/sync", {
        method: "POST",
      })
      if (res.ok) {
        setSyncMessage(`✓ Synced ${res.returnsSynced} returns and ${res.rtosSynced} RTOs (${res.totalActive} scannable)`)
        await loadData(true)
        await loadRecords()
      } else {
        setSyncMessage(`⚠️ Sync warning: ${res.error || "No new records"}`)
      }
    } catch (err) {
      setSyncMessage(`❌ Sync failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMessage(null), 6000)
    }
  }

  const handleExportCsv = () => {
    const params = new URLSearchParams()
    params.set("tab", tab)
    if (search.trim()) params.set("q", search.trim())
    if (dateFrom.trim()) params.set("from", dateFrom.trim())
    if (dateTo.trim()) params.set("to", dateTo.trim())
    const filename = `shopify-returns-rto-${tab}-${new Date().toISOString().slice(0, 10)}.csv`
    downloadFile(`/api/shopify/export?${params.toString()}`, filename).catch((err) => {
      alert("Failed to export: " + err.message)
    })
  }

  if (loading && !metrics) {
    return <Loading label="Loading Shopify returns and RTO records…" />
  }

  const pageCount = Math.max(1, Math.ceil(totalRecords / pageSize))

  return (
    <div className="shopify-dashboard-wrapper">
      {/* Top Banner / Actions Bar */}
      <header className="shopify-header-card">
        <div className="shopify-title-area">
          <div className="shopify-logo-badge">
            <img src="/logos/shopify.svg" alt="Shopify" width={28} height={28} />
          </div>
          <div>
            <div className="shopify-headline-row">
              <h2>Shopify Returns & RTO Channel</h2>
              <span className="shopify-tag-badge">Real-Time Sync</span>
              <span className="shopify-readonly-badge" title="Guaranteed: Never modifies, inserts, or deletes external Shopify data">
                🔒 Strictly Read-Only
              </span>
            </div>
            <p className="shopify-subtitle">
              Automated continuous synchronization from Shopify database. Physical parcels are scannable on the bench.
            </p>
          </div>
        </div>

        <div className="shopify-actions-area">
          <div className="shopify-sync-status">
            <span className="shopify-pulse-dot" />
            <span>
              {status?.connected ? "Connected" : "Disconnected"} · Last synced:{" "}
              <strong>{status?.lastSyncedLabel || metrics?.lastSyncedLabel || "Just now"}</strong>
            </span>
          </div>

          <div className="shopify-btn-group">
            <button
              className="btn btn-secondary"
              onClick={handleExportCsv}
              title="Download CSV report matching current filters"
            >
              <Icon name="file" size={15} />
              <span>Export CSV</span>
            </button>

            <button
              className={`btn btn-primary shopify-sync-btn ${syncing ? "loading" : ""}`}
              onClick={handleSyncNow}
              disabled={syncing}
              title="Pull latest return requests and RTO shipments from Shopify database"
            >
              <span className={`sync-icon ${syncing ? "spin" : ""}`}>⚡</span>
              <span>{syncing ? "Syncing..." : "Sync Now"}</span>
            </button>
          </div>
        </div>
      </header>

      {syncMessage && (
        <div className="shopify-alert-banner">
          <span>{syncMessage}</span>
          <button className="close-btn" onClick={() => setSyncMessage(null)}>×</button>
        </div>
      )}

      {error && (
        <div className="form-error shopify-error-banner">
          <strong>Connection notice:</strong> {error}
        </div>
      )}

      {/* Hero Mathematical Formula Ribbon */}
      <section className="shopify-formula-banner">
        <div className="formula-tag">BUSINESS FORMULA</div>
        <div className="formula-equation">
          <span className="term created">Created (Returns + RTOs)</span>
          <span className="operator">−</span>
          <span className="term received">Received (Scanned in Warehouse)</span>
          <span className="operator">=</span>
          <span className="term pending">Pending Arrival</span>
        </div>
      </section>

      {/* KPI Stat Cards Grid */}
      {metrics && (
        <section className="shopify-stats-grid">
          {/* 1. Created */}
          <div className="shopify-stat-card created-card">
            <div className="stat-head">
              <span className="stat-label">TOTAL CREATED</span>
              <span className="stat-badge blue">Shopify Manifest</span>
            </div>
            <div className="stat-number">{metrics.formula.created.toLocaleString()}</div>
            <div className="stat-meta">
              <span>{metrics.breakdown.returns.created} Customer Returns</span>
              <span className="dot">•</span>
              <span>{metrics.breakdown.rtos.created} Courier RTOs</span>
            </div>
          </div>

          {/* 2. Received */}
          <div className="shopify-stat-card received-card">
            <div className="stat-head">
              <span className="stat-label">TOTAL RECEIVED</span>
              <span className="stat-badge green">Verified Scanned</span>
            </div>
            <div className="stat-number">{metrics.formula.received.toLocaleString()}</div>
            <div className="stat-meta">
              <span>{metrics.breakdown.returns.received} Returns scanned</span>
              <span className="dot">•</span>
              <span>{metrics.breakdown.rtos.received} RTOs scanned</span>
            </div>
          </div>

          {/* 3. Pending = Created - Received */}
          <div className="shopify-stat-card pending-card">
            <div className="stat-head">
              <span className="stat-label">PENDING ARRIVAL</span>
              <span className="stat-badge orange">Created − Received</span>
            </div>
            <div className="stat-number highlight-pending">{metrics.formula.pending.toLocaleString()}</div>
            <div className="stat-meta">
              <span>{metrics.breakdown.returns.pending} Returns pending</span>
              <span className="dot">•</span>
              <span>{metrics.breakdown.rtos.pending} RTOs in transit</span>
            </div>
          </div>

          {/* 4. Receipt Rate */}
          <div className="shopify-stat-card rate-card">
            <div className="stat-head">
              <span className="stat-label">RECEIPT RECOVERY RATE</span>
              <span className="stat-badge purple">Efficiency</span>
            </div>
            <div className="stat-number">{metrics.receiptRate}</div>
            <div className="stat-meta">
              <span>{metrics.totalActiveScannable} currently active scannable barcodes</span>
            </div>
          </div>
        </section>
      )}

      {/* Channel Breakdown Row (Returns vs RTO) */}
      {metrics && (
        <section className="shopify-breakdown-row">
          <div className="channel-box return-box">
            <div className="channel-box-header">
              <div className="channel-icon">📦</div>
              <div>
                <strong>Customer Returns (Reverse Pickups)</strong>
                <p>Initiated by customers with Delhivery reverse pickup AWB</p>
              </div>
            </div>
            <div className="channel-equation">
              <div className="eq-item">
                <small>Created</small>
                <strong>{metrics.breakdown.returns.created}</strong>
              </div>
              <div className="eq-op">−</div>
              <div className="eq-item">
                <small>Received</small>
                <strong style={{ color: "var(--green)" }}>{metrics.breakdown.returns.received}</strong>
              </div>
              <div className="eq-op">=</div>
              <div className="eq-item">
                <small>Pending</small>
                <strong style={{ color: "var(--orange)" }}>{metrics.breakdown.returns.pending}</strong>
              </div>
            </div>
          </div>

          <div className="channel-box rto-box">
            <div className="channel-box-header">
              <div className="channel-icon">🚚</div>
              <div>
                <strong>RTO Shipments (Return to Origin)</strong>
                <p>Customer refused, address undeliverable, or NDR escalation</p>
              </div>
            </div>
            <div className="channel-equation">
              <div className="eq-item">
                <small>Created</small>
                <strong>{metrics.breakdown.rtos.created}</strong>
              </div>
              <div className="eq-op">−</div>
              <div className="eq-item">
                <small>Received</small>
                <strong style={{ color: "var(--green)" }}>{metrics.breakdown.rtos.received}</strong>
              </div>
              <div className="eq-op">=</div>
              <div className="eq-item">
                <small>Pending</small>
                <strong style={{ color: "var(--orange)" }}>{metrics.breakdown.rtos.pending}</strong>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Daily Stats Accordion / Toggle */}
      {metrics?.dailyStats && metrics.dailyStats.length > 0 && (
        <section className="shopify-daily-section">
          <button
            className="shopify-daily-toggle"
            onClick={() => setShowDailyTable(!showDailyTable)}
          >
            <div className="daily-toggle-left">
              <Icon name="calendar" size={16} />
              <span>Daily Created vs Received vs Pending History ({metrics.dailyStats.length} Days)</span>
            </div>
            <span className="daily-toggle-indicator">{showDailyTable ? "Hide ▲" : "Show ▼"}</span>
          </button>

          {showDailyTable && (
            <div className="shopify-daily-table-wrap">
              <table className="shopify-table">
                <thead>
                  <tr>
                    <th>Date (IST)</th>
                    <th>Created Returns</th>
                    <th>Created RTOs</th>
                    <th>Total Created</th>
                    <th>Received Returns</th>
                    <th>Received RTOs</th>
                    <th>Total Received</th>
                    <th>Pending</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.dailyStats.map((day) => (
                    <tr key={day.date}>
                      <td><strong>{day.date}</strong></td>
                      <td>{day.createdReturns}</td>
                      <td>{day.createdRtos}</td>
                      <td><span className="badge neutral">{day.totalCreated}</span></td>
                      <td style={{ color: "var(--green)" }}>{day.receivedReturns}</td>
                      <td style={{ color: "var(--green)" }}>{day.receivedRtos}</td>
                      <td><span className="badge success">{day.totalReceived}</span></td>
                      <td>
                        <span className={`badge ${day.pending > 0 ? "warning" : "success"}`}>
                          {day.pending}
                        </span>
                      </td>
                      <td>
                        <button
                          className="btn-tiny"
                          onClick={() => {
                            setDateFrom(day.date)
                            setDateTo(day.date)
                            setPage(1)
                          }}
                          title={`Filter records created on ${day.date}`}
                        >
                          View Records
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Main Records Section */}
      <section className="panel shopify-records-panel">
        {/* Navigation Tabs */}
        <div className="shopify-tab-bar">
          <button
            className={`shopify-tab-btn ${tab === "all" ? "active" : ""}`}
            onClick={() => { setTab("all"); setPage(1); }}
          >
            All Records ({metrics?.formula.created ?? 0})
          </button>
          <button
            className={`shopify-tab-btn ${tab === "pending" ? "active" : ""}`}
            onClick={() => { setTab("pending"); setPage(1); }}
          >
            Pending Arrival ({metrics?.formula.pending ?? 0})
          </button>
          <button
            className={`shopify-tab-btn ${tab === "received" ? "active" : ""}`}
            onClick={() => { setTab("received"); setPage(1); }}
          >
            Received ({metrics?.formula.received ?? 0})
          </button>
          <button
            className={`shopify-tab-btn ${tab === "returns" ? "active" : ""}`}
            onClick={() => { setTab("returns"); setPage(1); }}
          >
            Customer Returns ({metrics?.breakdown.returns.created ?? 0})
          </button>
          <button
            className={`shopify-tab-btn ${tab === "rtos" ? "active" : ""}`}
            onClick={() => { setTab("rtos"); setPage(1); }}
          >
            RTO Shipments ({metrics?.breakdown.rtos.created ?? 0})
          </button>
        </div>

        {/* Filter Controls */}
        <div className="shopify-filter-row">
          <div className="search-box">
            <Icon name="search" size={16} />
            <input
              type="text"
              placeholder="Search Delhivery AWB, Order #, Customer, Product, SKU…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
            {search && (
              <button className="clear-search-btn" onClick={() => { setSearch(""); setPage(1); }}>×</button>
            )}
          </div>

          <div className="date-filter-group">
            <label>
              <span>From:</span>
              <DateField
                label="From date"
                value={dateFrom}
                onChange={(value) => { setDateFrom(value); setPage(1); }}
              />
            </label>
            <label>
              <span>To:</span>
              <DateField
                label="To date"
                value={dateTo}
                onChange={(value) => { setDateTo(value); setPage(1); }}
              />
            </label>
            {(dateFrom || dateTo) && (
              <button
                className="btn-text"
                onClick={() => { setDateFrom(""); setDateTo(""); setPage(1); }}
              >
                Clear Dates
              </button>
            )}
          </div>
        </div>

        {/* Record Table */}
        <div className="shopify-table-container">
          <table className="shopify-table data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Type</th>
                <th>Order #</th>
                <th>Tracking ID (AWB)</th>
                <th>Customer</th>
                <th>Product & SKU</th>
                <th>Created Date</th>
                <th>Reason / Issue</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr>
                  <td colSpan={9} className="empty-table-cell">
                    No Shopify records match the selected filters.
                  </td>
                </tr>
              ) : (
                records.map((r) => (
                  <tr key={r.id} className={r.status === "Received" ? "row-received" : "row-pending"}>
                    <td>
                      {r.status === "Received" ? (
                        <span className="shopify-badge received">
                          ✓ Received
                        </span>
                      ) : (
                        <span className="shopify-badge pending">
                          ⏱ Pending
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`shopify-type-badge ${r.returnType === "Customer Return" ? "ret" : "rto"}`}>
                        {r.returnType === "Customer Return" ? "Return" : "RTO"}
                      </span>
                    </td>
                    <td>
                      <strong>{r.orderNumber}</strong>
                    </td>
                    <td>
                      <div className="tracking-cell">
                        <span className="mono-awb">{r.trackingId}</span>
                        {r.altTrackingId && (
                          <small className="alt-awb" title="Forward AWB">Fwd: {r.altTrackingId}</small>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="customer-cell">
                        <span>{r.customerName}</span>
                        <small>{r.customerCity} {r.customerPhone ? `· ${r.customerPhone}` : ""}</small>
                      </div>
                    </td>
                    <td>
                      <div className="product-summary-cell">
                        <span className="prod-title" title={r.productTitle}>{r.productTitle}</span>
                        {r.items[0]?.sku && <small className="mono-sku">{r.items[0].sku}</small>}
                        {r.itemCount > 1 && (
                          <span className="item-count-badge">+{r.itemCount - 1} more items</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="date-cell">{r.createdAt}</span>
                    </td>
                    <td>
                      <div className="reason-cell">
                        <span>{r.returnReason}</span>
                        {r.scanIssue && <span className="issue-tag">{r.scanIssue}</span>}
                      </div>
                    </td>
                    <td>
                      <button
                        className="btn-tiny view-btn"
                        onClick={() => setSelectedRecord(r)}
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="shopify-pagination-bar">
          <div className="pagination-info">
            Showing {records.length} of {totalRecords.toLocaleString()} Shopify records
          </div>
          <div className="pagination-controls">
            <button
              className="btn-page"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span className="page-current">Page {page} of {pageCount}</span>
            <button
              className="btn-page"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              Next
            </button>
          </div>
        </div>
      </section>

      {/* Record Details Modal */}
      {selectedRecord && (
        <Modal wide onClose={() => setSelectedRecord(null)}>
          <div className="shopify-detail-modal">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>
                Shopify Order {selectedRecord.orderNumber}
              </h3>
              <button
                className="btn-tiny"
                style={{ fontSize: 16, lineHeight: 1, padding: "4px 8px" }}
                onClick={() => setSelectedRecord(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="detail-hero-banner">
              <div className="detail-status-pill">
                <span className={`status-dot ${selectedRecord.status.toLowerCase()}`} />
                <strong>{selectedRecord.status.toUpperCase()}</strong>
              </div>
              <div className="detail-type-pill">
                <span>{selectedRecord.returnType}</span>
              </div>
              <div className="detail-created-date">
                Created: {selectedRecord.createdAt}
              </div>
            </div>

            <div className="detail-grid">
              <div className="detail-card">
                <h4>Tracking & Barcode Identifiers</h4>
                <div className="detail-row">
                  <span className="label">Return Waybill (Delhivery AWB):</span>
                  <strong className="mono">{selectedRecord.trackingId}</strong>
                </div>
                {selectedRecord.altTrackingId && (
                  <div className="detail-row">
                    <span className="label">Forward Waybill:</span>
                    <strong className="mono">{selectedRecord.altTrackingId}</strong>
                  </div>
                )}
                <div className="detail-row">
                  <span className="label">Return Reason / Risk:</span>
                  <span>{selectedRecord.returnReason}</span>
                </div>
              </div>

              <div className="detail-card">
                <h4>Customer Information</h4>
                <div className="detail-row">
                  <span className="label">Customer Name:</span>
                  <strong>{selectedRecord.customerName}</strong>
                </div>
                <div className="detail-row">
                  <span className="label">City / State:</span>
                  <span>{selectedRecord.customerCity || "N/A"}</span>
                </div>
                <div className="detail-row">
                  <span className="label">Phone:</span>
                  <span>{selectedRecord.customerPhone || "N/A"}</span>
                </div>
              </div>
            </div>

            <div className="detail-items-card">
              <h4>Order Line Items ({selectedRecord.itemCount} items)</h4>
              <div className="detail-items-list">
                {selectedRecord.items.map((item, idx) => (
                  <div key={idx} className="detail-item-row">
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt={item.title} className="item-thumb" />
                    ) : (
                      <div className="item-thumb-placeholder">📷</div>
                    )}
                    <div className="item-info">
                      <strong className="item-title">{item.title}</strong>
                      <span className="mono-sku">SKU: {item.sku || "N/A"}</span>
                    </div>
                    <div className="item-qty">
                      <span>Qty: <strong>{item.qty}</strong></span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {selectedRecord.status === "Received" && (
              <div className="detail-verification-box">
                <span className="verify-check">✓</span>
                <div>
                  <strong>Physically Verified in Warehouse</strong>
                  <p>
                    Scanned at bench on {selectedRecord.receivedAt || "N/A"}{" "}
                    {selectedRecord.scannedBy ? `by ${selectedRecord.scannedBy}` : ""}
                  </p>
                  {selectedRecord.scanIssue && (
                    <div className="detail-issue-alert">
                      Issue Recorded: {selectedRecord.scanIssue}{" "}
                      {selectedRecord.scanTicket ? `(Ticket ${selectedRecord.scanTicket})` : ""}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
