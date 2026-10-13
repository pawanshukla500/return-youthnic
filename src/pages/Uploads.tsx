import { useEffect, useRef, useState } from "react"
import { ApiError, api, downloadFile } from "../api"
import type {
  AccountOption,
  ScannerListPreview,
  UploadException,
  UploadHistoryRow,
  UploadImportResult,
  UploadPreview,
} from "../types"
import { Badge, DataTable, Icon, MarketplaceBadge, Modal } from "../ui"

const NO_MARKETPLACE = "Select marketplace"

// A file that was replaced by a later activation keeps a neutral badge. Anything that is not Imported is shown as a problem.
function uploadTone(status: string) {
  if (status === "Imported" || status === "Imported with exceptions") return "success"
  if (status === "Replaced") return "neutral"
  return "danger"
}

const count = (value: number) => value.toLocaleString("en-US")

function csvCell(value: unknown) {
  const text = String(value ?? "")
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function downloadExceptions(exceptions: UploadException[], filename: string) {
  const header = ["Source line", "Status", "Reason", "Source tracking", "Parsed tracking", "Order ID", "Shipment ID", "Quantity", "Return type", "Carrier", "Listing SKU"]
  const rows = exceptions.map((item) => [
    item.line ?? "",
    item.status,
    item.reasons.join(" | "),
    item.sourceTrackingId,
    item.trackingId,
    item.orderId,
    item.shipmentId,
    item.quantity,
    item.returnType,
    item.carrier,
    item.listingSku,
  ])
  const blob = new Blob([[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")], {
    type: "text/csv;charset=utf-8",
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function downloadScannerResults(preview: ScannerListPreview) {
  const header = ["Sheet", "Source row", "Source column", "Source value", "Normalized value", "Validation", "Duplicate", "Mapped account", "Candidates"]
  const rows = preview.entries.map((item) => [
    item.sheet,
    item.sourceRow,
    item.sourceColumn,
    item.sourceValue,
    item.normalizedValue,
    item.matchStatus,
    item.duplicate ? "yes" : "no",
    item.mappedAccount,
    item.candidates.map((candidate) => `${candidate.accountName} lookup #${candidate.expectedReturnId}`).join(" | "),
  ])
  const blob = new Blob([[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")], {
    type: "text/csv;charset=utf-8",
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `${preview.filename}.scanner-validation.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function ScannerPreviewDetails({
  preview,
  mappings,
  onMapping,
  onRevalidate,
  onExport,
  busy,
}: {
  preview: ScannerListPreview
  mappings: Record<string, string>
  onMapping: (sheet: string, account: string) => void
  onRevalidate: () => void
  onExport: () => void
  busy: boolean
}) {
  const statusLabels: [keyof ScannerListPreview["counts"], string][] = [
    ["matched", "Matched"],
    ["unmatched", "Unmatched"],
    ["ambiguous", "Ambiguous"],
    ["previouslyScanned", "Previously scanned"],
    ["unassigned", "Unassigned"],
    ["malformed", "Malformed"],
    ["duplicateEntries", "Duplicates"],
  ]
  return (
    <div className="upload-preview" style={{ margin: "12px 20px 0" }}>
      <div className="demo-note" style={{ marginBottom: 12 }}>
        <Icon name="alert" />
        <span>
          Validation only. This is a scanner list, not a return master. It cannot replace lookup data or create physical
          scans.
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginBottom: 12 }}>
        {statusLabels.map(([key, label]) => (
          <div key={key} style={{ padding: "10px 11px", border: "1px solid var(--line)", borderRadius: 8 }}>
            <div style={{ color: "#7d8784", fontSize: 10 }}>{label}</div>
            <strong style={{ display: "block", marginTop: 3, fontSize: 18 }}>{count(preview.counts[key])}</strong>
          </div>
        ))}
      </div>
      <div style={{ border: "1px solid var(--line)", borderRadius: 9, overflow: "hidden" }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)" }}>
          <strong>Worksheet account mapping</strong>
          <p style={{ margin: "4px 0 0", color: "#7d8784", fontSize: 10 }}>
            A sheet name is not trusted as a marketplace account. Select the verified account before matching.
          </p>
        </div>
        {preview.sheets.map((sheet) => (
          <div key={sheet.name} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "center", padding: "9px 12px", borderTop: "1px solid #f0f2f1" }}>
            <span>
              <strong>{sheet.name}</strong>
              <small style={{ display: "block", color: "#89928f" }}>{sheet.nonEmptyCells} values · columns {sheet.columns.join(", ") || "none"}</small>
            </span>
            <select value={mappings[sheet.name] ?? ""} onChange={(event) => onMapping(sheet.name, event.target.value)}>
              <option value="">Select verified account</option>
              {preview.accounts.map((account) => (
                <option key={account.id} value={account.name}>{account.name}</option>
              ))}
            </select>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 12px", borderTop: "1px solid var(--line)" }}>
          <button className="btn secondary" style={{ height: 34 }} onClick={onExport}>Export CSV</button>
          <button className="btn primary" style={{ height: 34 }} onClick={onRevalidate} disabled={busy}>Validate against active lookups</button>
        </div>
      </div>
    </div>
  )
}

// Batch Progress State
type BatchProgressState = {
  active: boolean
  phase: "uploading" | "validating" | "staging" | "batch_pause" | "finalizing" | "complete" | "error"
  batchIndex: number
  totalBatches: number
  processedRows: number
  totalRows: number
  percent: number
  message: string
}

function UploadProgressBar({ progress }: { progress: BatchProgressState }) {
  if (!progress.active) return null
  const isPause = progress.phase === "batch_pause"
  const isComplete = progress.phase === "complete"
  const isError = progress.phase === "error"

  return (
    <div className="batch-progress-card">
      <div className="batch-progress-header">
        <div className="batch-progress-title">
          <Icon name={isComplete ? "check" : isError ? "alert" : "upload"} size={16} />
          <span>
            {isComplete
              ? "Dataset Activation Complete"
              : isError
              ? "Processing Interrupted"
              : isPause
              ? "Pausing 1s for Database Integrity"
              : progress.phase === "uploading"
              ? "Analyzing Spreadsheet File"
              : "Processing & Activating Dataset (500 rows / batch)"}
          </span>
        </div>
        <span className="batch-progress-badge">{progress.percent}%</span>
      </div>

      <div className="batch-progress-track">
        <div
          className={`batch-progress-fill ${!isComplete && !isError ? "animated" : ""}`}
          style={{
            width: `${Math.max(4, Math.min(100, progress.percent))}%`,
            background: isError
              ? "var(--red)"
              : isPause
              ? "linear-gradient(90deg, #d97706 0%, #f59e0b 100%)"
              : "linear-gradient(90deg, #136c57 0%, #10b981 100%)",
          }}
        />
      </div>

      <div className="batch-progress-status">
        <strong>{progress.message}</strong>
        {progress.totalRows > 0 && (
          <span>
            {count(progress.processedRows)} / {count(progress.totalRows)} rows
          </span>
        )}
      </div>

      {progress.totalBatches > 1 && (
        <div className="batch-progress-pills">
          {Array.from({ length: progress.totalBatches }, (_, i) => {
            const batchNo = i + 1
            const isDone = batchNo < progress.batchIndex || isComplete
            const isCurrent = batchNo === progress.batchIndex && !isComplete
            const statusClass = isDone ? "completed" : isCurrent ? (isPause ? "paused" : "active") : ""
            const startRow = i * 500 + 1
            const endRow = Math.min((i + 1) * 500, progress.totalRows)
            const countInBatch = endRow - startRow + 1

            return (
              <div key={batchNo} className={`batch-step-pill ${statusClass}`}>
                <span>{isDone ? "✓" : isCurrent ? (isPause ? "⏸" : "⟳") : "○"}</span>
                <span>
                  Batch {batchNo} ({countInBatch} rows: {startRow}–{endRow})
                  {isCurrent && isPause ? " · 1s pause" : ""}
                </span>
              </div>
            )
          })}
        </div>
      )}

      <div className="batch-progress-sub">
        {progress.totalBatches > 1
          ? "Large dataset: processing in batches of 500 rows with a 1-second pause to prevent database lock contention and ensure zero disruption to live warehouse scanning."
          : "Processing return records atomically into PostgreSQL."}
      </div>
    </div>
  )
}

function UnmappedSkusModal({
  skus,
  marketplace,
  onClose,
}: {
  skus: string[]
  marketplace: string
  onClose: () => void
}) {
  const [filter, setFilter] = useState("")
  const [copiedAll, setCopiedAll] = useState(false)
  const [copiedSingle, setCopiedSingle] = useState<string | null>(null)

  const filtered = skus.filter((sku) => sku.toLowerCase().includes(filter.trim().toLowerCase()))

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(filtered.join("\n"))
      setCopiedAll(true)
      setTimeout(() => setCopiedAll(false), 2000)
    } catch {
      // clipboard fallback
    }
  }

  const copySingle = async (sku: string) => {
    try {
      await navigator.clipboard.writeText(sku)
      setCopiedSingle(sku)
      setTimeout(() => setCopiedSingle(null), 1500)
    } catch {
      // clipboard fallback
    }
  }

  const exportCsv = () => {
    const csvContent = "Listing SKU,Marketplace\n" + filtered.map((s) => `"${s.replace(/"/g, '""')}","${marketplace}"`).join("\n")
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `unmapped-skus-${marketplace.toLowerCase().replace(/\s+/g, "-")}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Modal onClose={onClose} wide>
      <div className="unmapped-modal-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 18, color: "var(--ink)" }}>Pending Listing SKUs</h3>
            <span className="badge danger" style={{ fontSize: 12 }}>{count(skus.length)} unmapped</span>
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.45 }}>
            These {count(skus.length)} listing SKU(s) in this <strong>{marketplace}</strong> report are not found in the Product Master or OMS catalog mappings. Physical returns will scan and record without blockers, but won't show catalog photos until mapped.
          </p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} title="Close modal" style={{ border: 0 }}>
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="unmapped-modal-toolbar">
        <input
          type="search"
          placeholder="Filter SKUs by code..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="unmapped-search-input"
          autoFocus
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" className="btn secondary" style={{ height: 36, fontSize: 12 }} onClick={copyAll}>
            {copiedAll ? "✓ Copied to clipboard" : `Copy ${count(filtered.length)} SKUs`}
          </button>
          <button type="button" className="btn secondary" style={{ height: 36, fontSize: 12 }} onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>

      <div className="unmapped-skus-list">
        {filtered.length === 0 ? (
          <div className="unmapped-empty" style={{ padding: "32px 16px", textAlign: "center", color: "var(--muted)" }}>
            No SKU matches "{filter}"
          </div>
        ) : (
          filtered.map((sku, index) => (
            <div key={`${sku}-${index}`} className="unmapped-sku-row">
              <span className="unmapped-idx">#{index + 1}</span>
              <strong className="unmapped-code">{sku}</strong>
              <button
                type="button"
                className="btn-tiny-copy"
                onClick={() => copySingle(sku)}
                title="Copy SKU code"
              >
                {copiedSingle === sku ? "Copied" : "Copy"}
              </button>
            </div>
          ))
        )}
      </div>

      <div className="unmapped-modal-footer">
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          Showing {count(filtered.length)} of {count(skus.length)} pending SKUs
        </span>
        <button type="button" className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}

// Everything the server checked about the file, grouped cleanly into executive cards and quality metrics.
function PreviewDetails({
  preview,
  confirmed,
  onConfirm,
}: {
  preview: UploadPreview
  confirmed: boolean
  onConfirm: (value: boolean) => void
}) {
  const c = preview.counts
  const [query, setQuery] = useState("")
  const [showUnmappedModal, setShowUnmappedModal] = useState(false)
  const unmappedHint = preview.productMapping?.unmappedSample.length
    ? `, for example ${preview.productMapping.unmappedSample.slice(0, 3).join(", ")}`
    : ""
  const filteredExceptions = preview.exceptions.filter((item) => {
    const text = [
      item.line,
      item.status,
      item.reasons.join(" "),
      item.sourceTrackingId,
      item.trackingId,
      item.orderId,
      item.shipmentId,
      item.returnType,
      item.carrier,
      item.listingSku,
    ]
      .join(" ")
      .toLowerCase()
    return !query.trim() || text.includes(query.trim().toLowerCase())
  })
  const exceptionGroups = [
    ["pending", "Pending review", c.pendingRows],
    ["rejected", "Invalid rows", c.errorRows],
    ["duplicate", "Duplicate rows", c.duplicateRows],
    ["cancelled", "Cancelled rows", c.cancelledRows],
  ] as const

  return (
    <div className="upload-preview">
      {/* 4 Summary Status Cards */}
      <div className="preview-status-cards">
        {[
          ["Ready to scan", c.scannableRows, "var(--green-soft)", "var(--green)"],
          ["Pending review", c.pendingRows, "#fff6df", "#9a6b00"],
          ["Invalid", c.errorRows, "var(--red-soft)", "var(--red)"],
          ["Duplicates", c.duplicateRows, "#f1f3f2", "#68736f"],
        ].map(([label, value, background, color]) => (
          <div key={String(label)} className="preview-status-card" style={{ background: String(background), color: String(color) }}>
            <div className="preview-status-label">{label}</div>
            <strong className="preview-status-val">{count(Number(value))}</strong>
          </div>
        ))}
      </div>

      {/* Overview Specification & Dataset Impact Card */}
      <div className="preview-overview-card">
        <div className="preview-overview-col">
          <span className="preview-overview-label">File & Format Specification</span>
          <div className="preview-overview-main">
            <Icon name="file" size={16} />
            <span>{preview.filename}</span>
            <MarketplaceBadge name={preview.marketplace} />
          </div>
          <div className="preview-overview-meta">
            {preview.profile === "generic" ? "Generic layout" : preview.profile} ({preview.profileVersion ?? "v1.0"}) · Header row {preview.headerRow ?? 1}
          </div>
        </div>
        <div className="preview-overview-col">
          <span className="preview-overview-label">Dataset Replacement Impact</span>
          <div className="preview-transition-box">
            <div className="preview-transition-stat">
              <span>Current in DB</span>
              <strong>{count(preview.currentActiveRows ?? 0)} rows</strong>
            </div>
            <div className="preview-transition-arrow">→</div>
            <div className="preview-transition-stat">
              <span>New Replacement</span>
              <strong style={{ color: "var(--green)" }}>{count(c.scannableRows)} ready rows</strong>
            </div>
          </div>
        </div>
      </div>

      {/* Quality & Verification Metrics Grid */}
      <div className="preview-metrics-grid">
        <div className="preview-metric-card">
          <span className="preview-metric-label">Rows in File</span>
          <strong className="preview-metric-value">{count(c.rows)}</strong>
          <span className="preview-metric-sub">Total records parsed</span>
        </div>
        <div className="preview-metric-card">
          <span className="preview-metric-label">Readable Rows</span>
          <strong className="preview-metric-value" style={{ color: "var(--green)" }}>{count(c.validRows)}</strong>
          <span className="preview-metric-sub">Valid structured rows</span>
        </div>
        <div className="preview-metric-card">
          <span className="preview-metric-label">Unverified Tracking</span>
          <strong className="preview-metric-value">{count(c.unverifiedTrackingRows)}</strong>
          <span className="preview-metric-sub">Pending courier check</span>
        </div>
        <div className="preview-metric-card">
          <span className="preview-metric-label">Blank Return AWB</span>
          <strong className="preview-metric-value">{count(c.blankTrackingRows)}</strong>
          <span className="preview-metric-sub">Missing tracking number</span>
        </div>
        <div className="preview-metric-card">
          <span className="preview-metric-label">Tracking Links Unchecked</span>
          <strong className="preview-metric-value">{count(c.trackingUncheckedRows)}</strong>
          <span className="preview-metric-sub">Tracking link not checked</span>
        </div>
        <div className="preview-metric-card">
          <span className="preview-metric-label">Exact Duplicates</span>
          <strong className="preview-metric-value">{count(c.exactDuplicateRows)}</strong>
          <span className="preview-metric-sub">Kept, not counted</span>
        </div>
        <div className="preview-metric-card">
          <span className="preview-metric-label">Repeated Lines</span>
          <strong className="preview-metric-value">{count(c.repeatedRows)}</strong>
          <span className="preview-metric-sub">Kept as separate lines</span>
        </div>
        <div className="preview-metric-card">
          <span className="preview-metric-label">Sanitized Identifiers</span>
          <strong className="preview-metric-value">{count(c.untrustedIdentifierRows)}</strong>
          <span className="preview-metric-sub">Excel number IDs blanked</span>
        </div>
        {c.trackingCorrectedRows > 0 && (
          <div className="preview-metric-card">
            <span className="preview-metric-label">Tracking Corrected</span>
            <strong className="preview-metric-value" style={{ color: "var(--green)" }}>{count(c.trackingCorrectedRows)}</strong>
            <span className="preview-metric-sub">Corrected from verified link</span>
          </div>
        )}
        {c.trackingKeptRows > 0 && (
          <div className="preview-metric-card">
            <span className="preview-metric-label">Tracking Kept</span>
            <strong className="preview-metric-value">{count(c.trackingKeptRows)}</strong>
            <span className="preview-metric-sub">Link disagrees with file</span>
          </div>
        )}
      </div>

      {preview.headers.missing.length > 0 && (
        <div className="form-error">
          <strong>Missing required columns</strong>
          <p>{preview.headers.missing.join(", ")}</p>
        </div>
      )}

      {/* Logistics Partner Breakdown Section */}
      {preview.partners.length > 0 && (
        <div className="preview-section-card">
          <div className="preview-section-title">
            <Icon name="box" size={14} />
            <span>Logistics Partners Detected ({preview.partners.length} carriers)</span>
          </div>
          <div className="partner-badges-wrap">
            {preview.partners.map((partner) => (
              <div key={partner.name} className="partner-badge-pill">
                <span>{partner.name}</span>
                <span className="pill-count">{count(partner.rows)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Product Master Mapping Callout */}
      {preview.productMapping && (
        <div className={`preview-product-banner ${preview.productMapping.unmappedCount > 0 ? "warning" : "success"}`}>
          <Icon name={preview.productMapping.unmappedCount > 0 ? "alert" : "check"} size={16} />
          <div style={{ flex: 1, display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span>
              <strong>Product mapping:</strong> {count(preview.productMapping.mappedRows)} of {count(preview.productMapping.checked)} rows mapped ({Math.round((preview.productMapping.mappedRows / Math.max(1, preview.productMapping.checked)) * 100)}%).{" "}
              {preview.productMapping.unmappedCount > 0
                ? `${count(preview.productMapping.unmappedCount)} listing SKU(s) pending mapping${unmappedHint}. Valid returns are not blocked.`
                : "All listing SKUs have an active mapping to the product master."}
            </span>
            {preview.productMapping.unmappedCount > 0 && (
              <button
                type="button"
                className="btn secondary"
                style={{ height: 32, fontSize: 12, padding: "0 12px", background: "white", borderColor: "#fcd34d", color: "#92400e" }}
                onClick={() => setShowUnmappedModal(true)}
              >
                <Icon name="search" size={13} />
                <span>View all {count(preview.productMapping.unmappedCount)} pending listing SKUs</span>
              </button>
            )}
          </div>
        </div>
      )}
      {showUnmappedModal && preview.productMapping && (
        <UnmappedSkusModal
          skus={preview.productMapping.unmappedSkus && preview.productMapping.unmappedSkus.length > 0 ? preview.productMapping.unmappedSkus : preview.productMapping.unmappedSample}
          marketplace={preview.marketplace}
          onClose={() => setShowUnmappedModal(false)}
        />
      )}

      {/* Validation Exceptions Accordion / Search (Existing feature preserved) */}
      {preview.exceptions.length > 0 && (
        <section style={{ border: "1px solid var(--line)", borderRadius: 9, marginBottom: 4, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", borderBottom: "1px solid var(--line)" }}>
            <strong style={{ flex: 1, fontSize: 13 }}>Validation exceptions ({count(preview.exceptions.length)})</strong>
            <button className="btn secondary" style={{ height: 32, padding: "0 10px" }} onClick={() => downloadExceptions(preview.exceptions, `${preview.filename}.validation.csv`)}>
              Export CSV
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "10px 12px", background: "#fafbfb" }}>
            {exceptionGroups.map(([status, label, value]) => (
              <span key={status} className="badge" style={{ padding: "5px 8px" }}>
                {label}: {count(value)}
              </span>
            ))}
          </div>
          <div style={{ padding: "10px 12px" }}>
            <input
              aria-label="Search validation exceptions"
              placeholder="Search line, AWB, order, SKU, or reason"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              style={{ width: "100%", height: 36, border: "1px solid var(--line)", borderRadius: 7, padding: "0 10px" }}
            />
          </div>
          <div style={{ maxHeight: 260, overflow: "auto", padding: "0 12px 10px" }}>
            {filteredExceptions.slice(0, 200).map((item, index) => (
              <details key={`${item.line}-${index}`} style={{ padding: "8px 0", borderTop: "1px solid #f0f2f1" }}>
                <summary style={{ cursor: "pointer", fontSize: 11 }}>
                  Line {item.line ?? "?"} · {item.status} · {item.sourceTrackingId || "no source AWB"} · {item.listingSku || "no listing SKU"}
                </summary>
                <div style={{ padding: "7px 0 0 18px", color: "#68736f", fontSize: 10, lineHeight: 1.6 }}>
                  <div>{item.reasons.join(" ") || "No additional reason"}</div>
                  {item.orderId && <div>Order: {item.orderId}</div>}
                  {item.shipmentId && <div>Shipment: {item.shipmentId}</div>}
                  <div>Quantity: {item.quantity} · Type: {item.returnType || "—"} · Carrier: {item.carrier || "—"}</div>
                </div>
              </details>
            ))}
            {filteredExceptions.length > 200 && <p style={{ fontSize: 11, color: "var(--muted)", margin: "8px 0 0" }}>Showing first 200 matches. Export CSV for the complete report.</p>}
            {filteredExceptions.length === 0 && <p style={{ fontSize: 11, color: "var(--muted)", margin: "8px 0 0" }}>No exception matches this search.</p>}
          </div>
        </section>
      )}

      {/* Data Precision Warnings Card (Fixes Screenshot 2 defect) */}
      {preview.warnings.length > 0 && (
        <div className="preview-warnings-card">
          <div className="preview-warnings-header">
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <Icon name="alert" size={14} />
              <span>Data Precision Warnings & Excel Formatting Notices</span>
            </div>
            <span className="preview-warnings-badge">{preview.warnings.length} notices</span>
          </div>
          <ul className="preview-warnings-list">
            {preview.warnings.map((warning) => (
              <li key={warning}>
                <span className="preview-warnings-bullet">•</span>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Blockers Alert */}
      {preview.blockers.length > 0 && (
        <div className="form-error">
          <strong>This file cannot be activated</strong>
          <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
            {preview.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Active Lookup Replacement Confirmation Card */}
      {preview.canActivate && preview.counts.scannableRows > 0 && (
        <div className="preview-confirm-card">
          <div className="preview-confirm-header">
            <Icon name="check" size={16} />
            <span>Active Lookup Replacement Confirmation</span>
          </div>
          <p className="preview-confirm-text">
            Activating this report will replace the current active lookup data for <strong>{preview.marketplace}</strong>.
            Previously completed return scans and audit records will remain permanently saved in PostgreSQL.
          </p>
          {preview.confirmations.length > 0 && (
            <ul style={{ margin: "0 0 4px 16px", fontSize: 11, color: "#14532d" }}>
              {preview.confirmations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          <label className="preview-confirm-label">
            <input type="checkbox" checked={confirmed} onChange={(event) => onConfirm(event.target.checked)} />
            <span>Confirm dataset replacement for {preview.marketplace} ({count(preview.counts.scannableRows)} records)</span>
          </label>
        </div>
      )}

      {preview.counts.scannableRows === 0 && (
        <div className="form-error">
          <strong>No scannable rows found</strong>
          <p>Activation is disabled because this report contains 0 scannable rows.</p>
        </div>
      )}
    </div>
  )
}

export function Uploads() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [mode, setMode] = useState<"returns" | "scanner">("returns")
  const [marketplace, setMarketplace] = useState(NO_MARKETPLACE)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<UploadPreview | null>(null)
  const [scannerPreview, setScannerPreview] = useState<ScannerListPreview | null>(null)
  const [scannerMappings, setScannerMappings] = useState<Record<string, string>>({})
  const [confirmed, setConfirmed] = useState(false)
  const [history, setHistory] = useState<UploadHistoryRow[]>([])
  const [batchProgress, setBatchProgress] = useState<BatchProgressState>({
    active: false,
    phase: "uploading",
    batchIndex: 1,
    totalBatches: 1,
    processedRows: 0,
    totalRows: 0,
    percent: 0,
    message: "",
  })
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const hasMarketplace = marketplace !== NO_MARKETPLACE

  const loadHistory = () =>
    api<{ rows: UploadHistoryRow[] }>("/api/uploads")
      .then((data) => setHistory(data.rows))
      .catch((err: Error) => setError(err.message))

  useEffect(() => {
    api<{ accounts: AccountOption[] }>("/api/accounts")
      .then((data) => setAccounts(data.accounts))
      .catch((err: Error) => setError(err.message))
    void loadHistory()
  }, [])

  const isShopifySelected = mode === "returns" && marketplace === "Shopify"
  const canChooseFile = (mode === "scanner" || hasMarketplace) && !isShopifySelected

  const previewFile = async (file: File, mappings: Record<string, string> = {}) => {
    if (!canChooseFile) return
    setSelectedFile(file)
    setError("")
    setNotice("")
    setConfirmed(false)
    setBusy(true)
    setBatchProgress({
      active: true,
      phase: "uploading",
      batchIndex: 1,
      totalBatches: 1,
      processedRows: 0,
      totalRows: 0,
      percent: 30,
      message: `Analyzing ${file.name} structure & resolving columns...`,
    })
    try {
      const body = new FormData()
      body.append("file", file)
      if (mode === "scanner") {
        body.append("sheetAccounts", JSON.stringify(mappings))
        setScannerPreview(await api<ScannerListPreview>("/api/uploads/scanner-list/preview", { method: "POST", body }))
        setPreview(null)
      } else {
        body.append("marketplace", marketplace)
        setPreview(await api<UploadPreview>("/api/uploads/preview", { method: "POST", body }))
        setScannerPreview(null)
      }
    } catch (err) {
      setPreview(null)
      setScannerPreview(null)
      setError(err instanceof Error ? err.message : "Could not read that file")
    } finally {
      setBusy(false)
      setBatchProgress((prev) => ({ ...prev, active: false }))
    }
  }

  const changeMode = (next: "returns" | "scanner") => {
    setMode(next)
    setSelectedFile(null)
    setPreview(null)
    setScannerPreview(null)
    setScannerMappings({})
    setConfirmed(false)
    setError("")
    setNotice("")
  }

  const revalidateScanner = () => {
    if (selectedFile) void previewFile(selectedFile, scannerMappings)
  }

  // The server checks every rule again on activation. Batched in 500-row chunks with 1s pause when streaming.
  const importFile = async () => {
    if (!preview?.uploadId) return
    const totalRows = preview.counts.scannableRows
    const batchSize = 500
    const totalBatches = Math.max(1, Math.ceil(totalRows / batchSize))

    setBusy(true)
    setError("")
    setNotice("")
    setBatchProgress({
      active: true,
      phase: "staging",
      batchIndex: 1,
      totalBatches,
      processedRows: 0,
      totalRows,
      percent: 5,
      message: `Initializing batch activation for ${preview.marketplace} (${count(totalRows)} ready rows)...`,
    })

    try {
      const response = await fetch("/api/uploads/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        credentials: "include",
        body: JSON.stringify({
          uploadId: preview.uploadId,
          confirm: confirmed,
          stream: true,
          batchSize: 500,
          pauseMs: 1000,
        }),
      })

      if (!response.ok) {
        const errJson = await response.json().catch(() => null)
        throw new Error(errJson?.error || `Import failed (${response.status})`)
      }

      const contentType = response.headers.get("content-type") || ""
      if (contentType.includes("text/event-stream") && response.body) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        let finalResult: UploadImportResult | null = null

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const events = buffer.split("\n\n")
          buffer = events.pop() ?? ""
          for (const evt of events) {
            const trimmed = evt.trim()
            if (!trimmed.startsWith("data: ")) continue
            try {
              const data = JSON.parse(trimmed.slice(6))
              if (data.phase === "error") {
                throw new Error(data.error || "Import failed")
              }
              if (data.phase === "complete" && data.result) {
                finalResult = data.result
                setBatchProgress((prev) => ({
                  ...prev,
                  phase: "complete",
                  percent: 100,
                  processedRows: totalRows,
                  message: `Successfully activated all ${count(totalRows)} rows!`,
                }))
              } else if (data.phase) {
                setBatchProgress({
                  active: true,
                  phase: data.phase,
                  batchIndex: data.batchIndex ?? 1,
                  totalBatches: data.totalBatches ?? totalBatches,
                  processedRows: data.processedRows ?? 0,
                  totalRows: data.totalRows ?? totalRows,
                  percent: data.percent ?? 50,
                  message: data.message ?? "Processing batch...",
                })
              }
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message !== "Unexpected end of JSON input") {
                console.warn("SSE parse error", parseErr)
              }
            }
          }
        }

        if (finalResult) {
          setNotice(
            `Activated ${count(finalResult.activatedRows)} lookup rows for ${preview.marketplace}. ${count(finalResult.supersededRows)} earlier rows were kept as superseded, and ${count(finalResult.cancelledRows)} cancelled rows were replaced. Scanned returns stay in the register.`,
          )
          setPreview(null)
          setConfirmed(false)
          await loadHistory()
        }
      } else {
        const result = (await response.json()) as UploadImportResult
        setBatchProgress((prev) => ({
          ...prev,
          phase: "complete",
          percent: 100,
          processedRows: totalRows,
          message: `Successfully activated ${count(result.activatedRows)} rows!`,
        }))
        setNotice(
          `Activated ${count(result.activatedRows)} lookup rows for ${preview.marketplace}. ${count(result.supersededRows)} earlier rows were kept as superseded, and ${count(result.cancelledRows)} cancelled rows were replaced. Scanned returns stay in the register.`,
        )
        setPreview(null)
        setConfirmed(false)
        await loadHistory()
      }
    } catch (err) {
      setBatchProgress((prev) => ({
        ...prev,
        phase: "error",
        message: err instanceof Error ? err.message : "Import failed",
      }))
      setError(err instanceof Error ? err.message : "Import failed")
      if (err instanceof ApiError && err.status === 400) setPreview(null)
    } finally {
      setBusy(false)
      setTimeout(() => {
        setBatchProgress((prev) => (prev.phase === "complete" ? { ...prev, active: false } : prev))
      }, 2500)
    }
  }

  const openPicker = () => {
    if (canChooseFile) fileRef.current?.click()
  }

  const canActivate = Boolean(preview?.uploadId) &&
    Boolean(preview?.canActivate) &&
    (preview?.counts?.scannableRows ?? 0) > 0 &&
    confirmed

  return (
    <div className="page-content">
      <section className="upload-layout">
        <article className="panel upload-main">
          <div className="panel-head">
            <div>
              <h2>Upload return data</h2>
              <p>Check the file, then activate it to replace this account's active lookup data</p>
            </div>
          </div>
          <div className="upload-selectors-row">
            <div className="upload-field-group">
              <label htmlFor="upload-file-type">FILE TYPE</label>
              <select
                id="upload-file-type"
                value={mode}
                onChange={(event) => changeMode(event.target.value as "returns" | "scanner")}
              >
                <option value="returns">Marketplace Return Master Import</option>
                <option value="scanner">Bulk Scanned AWB List / Lookup Validation</option>
              </select>
            </div>
            {mode === "returns" && accounts.length > 0 && (
              <div className="upload-field-group">
                <label htmlFor="upload-marketplace">MARKETPLACE</label>
                <select
                  id="upload-marketplace"
                  value={marketplace}
                  onChange={(event) => {
                    // A preview belongs to the account it was read for. Changing the choice discards it.
                    setMarketplace(event.target.value)
                    setPreview(null)
                    setConfirmed(false)
                    setError("")
                    setNotice("")
                  }}
                >
                  <option>{NO_MARKETPLACE}</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.name}>
                      {account.name} {account.name === "Shopify" ? "(⚡ Real-time automated sync)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          {mode === "returns" && accounts.length === 0 && (
            <div className="form-error" style={{ margin: "12px 20px 0" }}>
              No marketplace account is assigned to you. Ask an administrator to assign one.
            </div>
          )}

          {isShopifySelected && (
            <div className="shopify-upload-notice-card">
              <div className="shopify-upload-notice-header">
                <img src="/logos/shopify.svg" alt="Shopify" width={24} height={24} />
                <div>
                  <strong>Shopify Real-Time Inbuilt Sync</strong>
                  <p>
                    Customer return requests and RTO shipments are synchronized directly from the Shopify database in real-time.
                    Physical parcels are scannable immediately without manual file uploads.
                  </p>
                </div>
              </div>
              <div className="shopify-upload-notice-actions">
                <a
                  href="/register?tab=shopify"
                  className="btn secondary"
                  style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}
                >
                  <span>View Shopify Returns & RTO Report (Created − Received = Pending)</span>
                  <span>→</span>
                </a>
              </div>
            </div>
          )}

          <div
            className={`drop-zone ${preview || scannerPreview ? "done" : ""} ${canChooseFile ? "" : "locked"}`}
            role="button"
            tabIndex={canChooseFile ? 0 : -1}
            aria-disabled={!canChooseFile}
            onClick={openPicker}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") openPicker()
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              const file = event.dataTransfer.files?.[0]
              if (file && canChooseFile) void previewFile(file)
            }}
          >
            <span>
              <Icon name={preview || scannerPreview ? "check" : isShopifySelected ? "alert" : "upload"} size={26} />
            </span>
            <h3>
              {isShopifySelected
                ? "Shopify uses automated real-time sync"
                : preview || scannerPreview
                  ? preview?.filename || scannerPreview?.filename
                  : canChooseFile
                    ? "Drop your file here, or click to browse"
                    : "Choose a marketplace first"}
            </h3>
            <p>
              {isShopifySelected
                ? "No manual file upload is required for Shopify. Returns sync automatically."
                : preview?.message || scannerPreview?.message || "Supports .CSV and .XLSX files up to 25 MB"}
            </p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            hidden
            disabled={!canChooseFile}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void previewFile(file)
              event.target.value = ""
            }}
          />
          {batchProgress.active && <UploadProgressBar progress={batchProgress} />}
          {error && (
            <div className="form-error" style={{ margin: "12px 20px 0" }}>
              {error}
            </div>
          )}
          {notice && (
            <div className="form-success" style={{ margin: "12px 20px 0" }}>
              {notice}
            </div>
          )}
          {preview && <PreviewDetails preview={preview} confirmed={confirmed} onConfirm={setConfirmed} />}
          {scannerPreview && (
            <ScannerPreviewDetails
              preview={scannerPreview}
              mappings={scannerMappings}
              onMapping={(sheet, account) => setScannerMappings((current) => ({ ...current, [sheet]: account }))}
              onRevalidate={revalidateScanner}
              onExport={() => downloadScannerResults(scannerPreview)}
              busy={busy}
            />
          )}
          {mode === "returns" && <div className="upload-footer">
            <div>
              <Icon name="check" />
              <span>
                Only ready-to-scan rows become active. Pending and invalid source rows stay in upload history, and earlier
                lookup data is kept as superseded.
              </span>
            </div>
            <button className="btn primary" disabled={!canActivate || busy} onClick={importFile}>
              {busy ? (
                <>
                  <Icon name="upload" /> {batchProgress.active && batchProgress.totalBatches > 1 ? `Batch ${batchProgress.batchIndex}/${batchProgress.totalBatches}...` : "Activating..."}
                </>
              ) : (
                <>
                  Activate {preview ? `${count(preview.counts.scannableRows)} ready rows` : "file"} <Icon name="arrow" />
                </>
              )}
            </button>
          </div>}
        </article>
        <aside className="panel template-card">
          <div className="modal-icon blue">
            <Icon name="file" />
          </div>
          <h3>Need a template?</h3>
          <p>
            Return reports upload in their original export format. A bulk scanned AWB workbook uses the separate validation
            mode and never activates or creates scans.
          </p>
          <button
            className="btn secondary wide"
            onClick={() =>
              downloadFile("/api/uploads/template", "return-upload-template.csv").catch((err: Error) => setError(err.message))
            }
          >
            Download generic template <Icon name="arrow" />
          </button>
          <hr />
          <strong>Required data</strong>
          <ul>
            <li>Trustworthy return tracking ID (Myntra can use forward AWB when return AWB is blank)</li>
            <li>Order ID and order item ID</li>
            <li>Channel listing SKU (Myntra: seller_sku_code)</li>
            <li>Quantity and return reason</li>
          </ul>
          <p>
            The Myntra seller IDs are not yet confirmed: 10708 is set as Myntra VB and 45833 as Myntra EJ. Confirm this in the
            Myntra seller portal before importing a Myntra file.
          </p>
        </aside>
      </section>
      <section className="panel upload-history">
        <div className="panel-head">
          <div>
            <h2>Upload history</h2>
            <p>Files for the accounts you can see</p>
          </div>
        </div>
        <DataTable
          columns={[
            {
              key: "file",
              header: "File",
              render: (row) => (
                <>
                  <strong>{row.filename}</strong>
                  <small>{row.uploadedAt}</small>
                </>
              ),
            },
            { key: "market", header: "Account", render: (row) => <MarketplaceBadge name={row.marketplace} /> },
            {
              key: "rows",
              header: "Rows",
              render: (row) => (
                <>
                  <strong>{row.rowCount}</strong>
                  <small style={{ display: "block", color: "#89928f" }}>
                    {count(row.scannableRows)} ready · {count(row.pendingRows)} pending · {count(row.rejectedRows)} invalid
                  </small>
                </>
              ),
            },
            { key: "format", header: "Format", render: (row) => row.format || "—" },
            {
              key: "status",
              header: "Status",
              render: (row) => <Badge tone={uploadTone(row.status)}>{row.status}</Badge>,
            },
          ]}
          rows={history}
          rowKey={(row) => String(row.id)}
          empty="No uploads yet"
        />
      </section>
    </div>
  )
}
