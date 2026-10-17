import { useEffect, useState } from "react"
import { ApiError, api, downloadFile } from "../api"
import { Loading, PageError } from "../shell"
import { saveCsv, toCsv } from "../csv"
import {
  CLAIM_STATUS_LABELS,
  CLAIM_STATUS_TONES,
  type AccountOption,
  type AutomationAgent,
  type AutomationJob,
  type ClaimDetail,
  type ClaimListResult,
  type ClaimReturnLookup,
  type ClaimScanSearchRow,
  type ClaimStatus,
  type ClaimTemplate,
  type MarketplaceCredential,
  type MeeshoClaimDraft,
  type Stat,
} from "../types"
import { DataTable, Icon, MarketplaceBadge, Modal, StatCard, Badge } from "../ui"
import { isSupervisorOrAdminUser } from "../access"
import { useWorkspace } from "../workspace"
import { useLiveChanges } from "../live"

type ClaimsData = {
  stats: Stat[]
  total: string
  slices: { name: string; count: string; pct: string; tone: string }[]
  rows: { market: string; raised: string; approved: string; review: string; rejected: string; value: string; rate: number }[]
}

const STATUS_VALUES: ClaimStatus[] = [
  "pending_evidence",
  "ready_for_claim",
  "waiting_for_approval",
  "processing",
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "reconciled",
  "paid",
  "reclaim",
  "escalated",
  "failed",
  "manual_action_required",
]

const NEXT_STATUSES: Record<ClaimStatus, ClaimStatus[]> = {
  pending_evidence: [],
  ready_for_claim: ["waiting_for_approval"],
  waiting_for_approval: ["ready_for_claim", "processing", "manual_action_required"],
  processing: ["submitted", "failed", "manual_action_required"],
  submitted: ["under_review", "approved", "rejected", "escalated"],
  under_review: ["approved", "rejected", "escalated"],
  approved: ["reconciled"],
  rejected: ["reclaim", "escalated"],
  reconciled: ["paid", "escalated"],
  paid: [],
  reclaim: ["processing", "submitted", "under_review", "rejected", "escalated"],
  escalated: ["under_review", "approved", "rejected", "reclaim"],
  failed: ["processing", "manual_action_required", "reclaim", "escalated"],
  manual_action_required: ["processing", "failed", "reclaim", "escalated"],
}

export function Claims() {
  const [tab, setTab] = useState<"overview" | "queue" | "automation">("queue")

  // Overview data
  const [data, setData] = useState<ClaimsData | null>(null)
  const [loadingOverview, setLoadingOverview] = useState(false)
  const [error, setError] = useState("")

  const loadOverview = () => {
    setLoadingOverview(true)
    api<ClaimsData>("/api/claims")
      .then((d) => {
        setData(d)
        setError("")
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoadingOverview(false))
  }

  useEffect(() => {
    loadOverview()
  }, [tab])
  useLiveChanges((change) => {
    if (change.kind === "claim.updated" && tab === "overview") loadOverview()
  }, 800)

  if (error && tab === "overview" && !data) return <PageError message={error} />

  return (
    <div className="page-content">
      <div className="claims-tabs" style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        <button
          className={tab === "queue" ? "active btn primary" : "btn secondary"}
          onClick={() => setTab("queue")}
        >
          <Icon name="box" size={16} /> Claim Queue
        </button>
        <button
          className={tab === "automation" ? "active btn primary" : "btn secondary"}
          onClick={() => setTab("automation")}
        >
          <Icon name="check" size={16} /> Desktop EXE Automation
        </button>
        <button
          className={tab === "overview" ? "active btn primary" : "btn secondary"}
          onClick={() => setTab("overview")}
        >
          <Icon name="claim" size={16} /> Overview & Analytics
        </button>
      </div>

      {tab === "queue" && <ClaimQueue />}
      {tab === "automation" && <DesktopAutomationTab />}
      {tab === "overview" && <Overview data={data} loading={loadingOverview} onRefresh={loadOverview} />}
    </div>
  )
}

function Overview({
  data,
  loading,
  onRefresh,
}: {
  data: ClaimsData | null
  loading: boolean
  onRefresh: () => void
}) {
  if (!data) return <Loading label="Loading claims overview & analytics…" />

  const exportClaims = () => {
    saveCsv(
      "claims-by-marketplace.csv",
      toCsv(
        ["marketplace", "claims_raised", "approved", "under_review", "rejected", "claim_value", "approval_rate_pct"],
        data.rows.map((row) => [row.market, row.raised, row.approved, row.review, row.rejected, row.value, row.rate]),
      ),
    )
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>Claim Overview & Metrics</h2>
          <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 13 }}>
            Real-time aggregate claim values and settlement metrics across all marketplaces
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn secondary" onClick={onRefresh} disabled={loading}>
            {loading ? "Refreshing…" : "↻ Refresh"}
          </button>
          <button className="btn secondary" onClick={exportClaims} disabled={!data.rows.length}>
            <Icon name="upload" /> Export CSV
          </button>
        </div>
      </div>

      <section className="stats-grid claims-stats">
        {data.stats.map((stat) => (
          <StatCard key={stat.label} {...stat} />
        ))}
      </section>
      <section className="dashboard-grid claims-grid">
        <article className="panel">
          <div className="panel-head">
            <div>
              <h2>Claim status</h2>
              <p>All active & completed claims</p>
            </div>
            <span className="filter-button">All time</span>
          </div>
          <div className="claim-chart">
            <div className="claim-donut">
              <div>
                <strong>{data.total}</strong>
                <span>Total claims</span>
              </div>
            </div>
            <div className="claim-legend">
              {data.slices.map((slice) => (
                <div key={slice.name}>
                  <i className={slice.tone} />
                  <span>{slice.name}</span>
                  <strong>{slice.count}</strong>
                  <small>{slice.pct}</small>
                </div>
              ))}
            </div>
          </div>
        </article>
      </section>
      <section className="panel claim-table">
        <div className="panel-head">
          <div>
            <h2>Marketplace performance</h2>
            <p>Claim outcomes & financial recovery by channel</p>
          </div>
        </div>
        <DataTable
          columns={[
            {
              key: "market",
              header: "Marketplace",
              render: (row) => <MarketplaceBadge name={row.market} />,
            },
            { key: "raised", header: "Claims raised", render: (row) => <strong>{row.raised}</strong> },
            { key: "approved", header: "Approved", render: (row) => row.approved, cellClassName: "green-text" },
            { key: "review", header: "Under review", render: (row) => row.review },
            { key: "rejected", header: "Rejected", render: (row) => row.rejected, cellClassName: "red-text" },
            { key: "value", header: "Claim value", render: (row) => <strong>{row.value}</strong> },
            {
              key: "rate",
              header: "Approval rate",
              render: (row) => (
                <div className="rate-cell">
                  <i>
                    <b style={{ width: `${row.rate}%` }} />
                  </i>
                  <span>{row.rate}%</span>
                </div>
              ),
            },
          ]}
          rows={data.rows}
          rowKey={(row) => row.market}
        />
      </section>
    </>
  )
}

function ClaimQueue() {
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [claims, setClaims] = useState<ClaimListResult | null>(null)
  const [templates, setTemplates] = useState<ClaimTemplate[]>([])
  const [statusFilter, setStatusFilter] = useState("")
  const [marketplaceFilter, setMarketplaceFilter] = useState("")
  const [search, setSearch] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [detailId, setDetailId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  useEffect(() => {
    api<{ accounts: AccountOption[] }>("/api/accounts")
      .then((d) => setAccounts(d.accounts))
      .catch(() => {})
  }, [])

  useEffect(() => {
    api<{ templates: ClaimTemplate[] }>("/api/claims/templates")
      .then((d) => setTemplates(d.templates))
      .catch(() => {})
  }, [])

  const loadClaims = () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (statusFilter) params.set("status", statusFilter)
    if (marketplaceFilter) params.set("marketplaceId", marketplaceFilter)
    if (search) params.set("search", search)
    if (dateFrom) params.set("dateFrom", dateFrom)
    if (dateTo) params.set("dateTo", dateTo)
    params.set("page", String(page))
    params.set("pageSize", "25")
    api<ClaimListResult>(`/api/claims/queue?${params.toString()}`)
      .then((d) => setClaims(d))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadClaims()
  }, [statusFilter, marketplaceFilter, search, dateFrom, dateTo, page])
  useLiveChanges((change) => {
    if (change.kind === "claim.updated") loadClaims()
  }, 800)

  const exportQueue = async (format: "csv" | "xlsx") => {
    try {
      const params = new URLSearchParams({ format })
      if (statusFilter) params.set("status", statusFilter)
      if (marketplaceFilter) params.set("marketplaceId", marketplaceFilter)
      if (search) params.set("search", search)
      if (dateFrom) params.set("dateFrom", dateFrom)
      if (dateTo) params.set("dateTo", dateTo)
      await downloadFile(`/api/claims/export?${params.toString()}`, `claim-reconciliation.${format}`)
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim export failed.")
    }
  }

  if (loading && !claims) return <Loading label="Loading claim queue…" />
  if (error && !claims) return <PageError message={error} />

  return (
    <>
      <section className="panel">
        <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h2>Claim queue</h2>
            <p>Lifecycle claims with evidence capture and desktop automation tracking</p>
          </div>
          <button className="btn primary" onClick={() => setShowCreate(true)}>
            <Icon name="file" /> Capture Claim Evidence
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}

        {/* Filter row */}
        <div className="filter-row" style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "16px 0" }}>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}>
            <option value="">All statuses ({STATUS_VALUES.length})</option>
            {STATUS_VALUES.map((s) => (
              <option key={s} value={s}>{CLAIM_STATUS_LABELS[s]}</option>
            ))}
          </select>
          <select value={marketplaceFilter} onChange={(e) => { setMarketplaceFilter(e.target.value); setPage(1) }}>
            <option value="">All marketplaces</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <input
            type="search"
            placeholder="Search AWB, order ID, packet ID, reason…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            style={{ flex: 1, minWidth: 200 }}
          />
          <input type="date" aria-label="Claims from date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1) }} />
          <input type="date" aria-label="Claims to date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1) }} />
          <button className="btn secondary small" onClick={() => void exportQueue("csv")}>Export CSV</button>
          <button className="btn secondary small" onClick={() => void exportQueue("xlsx")}>Export Excel</button>
        </div>

        {/* Claims Table */}
        <DataTable
          columns={[
            {
              key: "status",
              header: "Status",
              render: (row) => (
                <Badge tone={CLAIM_STATUS_TONES[row.status as ClaimStatus] || "neutral"}>
                  {CLAIM_STATUS_LABELS[row.status as ClaimStatus] || row.status}
                </Badge>
              ),
            },
            {
              key: "marketplace",
              header: "Marketplace",
              render: (row) => <MarketplaceBadge name={row.marketplace} />,
            },
            {
              key: "trackingId",
              header: "AWB / Packet ID",
              render: (row) => (
                <div>
                  <strong style={{ display: "block" }}>{row.trackingId}</strong>
                  {row.packetId && row.packetId !== row.trackingId && (
                    <small style={{ color: "var(--muted)" }}>Packet: {row.packetId}</small>
                  )}
                </div>
              ),
            },
            { key: "orderId", header: "Order ID", render: (row) => row.orderId || "—" },
            {
              key: "claimReason",
              header: "Claim Reason & Title",
              render: (row) => (
                <div>
                  <strong>{row.claimReason}</strong>
                  {row.claimTitle && <div style={{ fontSize: 12, color: "var(--muted)" }}>{row.claimTitle}</div>}
                </div>
              ),
            },
            {
              key: "mediaCount",
              header: "Evidence",
              render: (row) => (
                <span className="badge neutral">
                  📎 {row.mediaCount} file{row.mediaCount === 1 ? "" : "s"}
                </span>
              ),
            },
            {
              key: "createdAt",
              header: "Created",
              render: (row) => new Date(row.createdAt).toLocaleDateString("en-IN"),
            },
            {
              key: "actions",
              header: "",
              render: (row) => (
                <button className="btn secondary small" onClick={() => setDetailId(row.id)}>
                  View Details
                </button>
              ),
            },
          ]}
          rows={claims?.rows || []}
          rowKey={(row) => String(row.id)}
        />

        {/* Pagination */}
        {claims && claims.total > claims.pageSize && (
          <div className="pagination" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
            <span>Total: {claims.total} claims</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn secondary small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span style={{ alignSelf: "center", fontSize: 13 }}>Page {page} of {Math.ceil(claims.total / claims.pageSize)}</span>
              <button
                className="btn secondary small"
                disabled={page >= Math.ceil(claims.total / claims.pageSize)}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Detail Modal */}
      {detailId !== null && (
        <ClaimDetailModal
          claimId={detailId}
          templates={templates}
          onClose={() => { setDetailId(null); loadClaims() }}
        />
      )}

      {/* Create Claim Modal */}
      {showCreate && (
        <CreateClaimModal
          accounts={accounts}
          templates={templates}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false)
            setDetailId(id)
            loadClaims()
          }}
        />
      )}
    </>
  )
}

function ClaimDetailModal({
  claimId,
  templates,
  onClose,
}: {
  claimId: number
  templates: ClaimTemplate[]
  onClose: () => void
}) {
  const { user } = useWorkspace()
  const canApprove = isSupervisorOrAdminUser(user)
  const [claim, setClaim] = useState<ClaimDetail | null>(null)
  const [error, setError] = useState("")
  const [statusUpdating, setStatusUpdating] = useState(false)
  const [newStatus, setNewStatus] = useState("")
  const [statusReason, setStatusReason] = useState("")
  const [approvedAmount, setApprovedAmount] = useState("")
  const [paidAmount, setPaidAmount] = useState("")
  const [payoutReference, setPayoutReference] = useState("")
  const [payoutDate, setPayoutDate] = useState("")
  const [uploadingField, setUploadingField] = useState("")
  const [refImage, setRefImage] = useState<string | null>(null)
  const [automationJob, setAutomationJob] = useState<AutomationJob | null>(null)
  const [manualModalOpen, setManualModalOpen] = useState(false)
  const [manualClaimRef, setManualClaimRef] = useState("")
  const [approving, setApproving] = useState(false)
  const [previewMediaUrl, setPreviewMediaUrl] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState("")

  const copyText = (val: string, key: string) => {
    if (!val) return
    navigator.clipboard.writeText(val).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(""), 2000)
    }).catch(() => {})
  }

  const load = () => {
    api<{ claim: ClaimDetail }>(`/api/claims/${claimId}`)
      .then((d) => {
        setClaim(d.claim)
        setError("")

        // Fetch reference catalog image if available
        if (d.claim.trackingId) {
          api<ClaimReturnLookup>(`/api/claims/return-lookup?query=${encodeURIComponent(d.claim.trackingId)}`)
            .then((l) => {
              if (l.items?.[0]?.imageUrl) setRefImage(l.items[0].imageUrl)
            })
            .catch(() => {})
        }
      })
      .catch((err: Error) => setError(err.message))

    // Fetch matching automation job
    api<{ rows: AutomationJob[] }>(`/api/automation/jobs?search=${claimId}`)
      .then((d) => {
        const matching = d.rows.find((j) => j.claimId === claimId)
        if (matching) setAutomationJob(matching)
      })
      .catch(() => {})
  }

  useEffect(() => {
    load()
  }, [claimId])

  const updateStatus = async () => {
    if (!newStatus) return
    if ((approvedAmount !== "" && Number(approvedAmount) < 0) || (paidAmount !== "" && Number(paidAmount) < 0)) {
      setError("Claim amounts cannot be negative.")
      return
    }
    setStatusUpdating(true)
    try {
      await api(`/api/claims/${claimId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: newStatus,
          reason: statusReason,
          approvedAmount: approvedAmount === "" ? undefined : Number(approvedAmount),
          paidAmount: paidAmount === "" ? undefined : Number(paidAmount),
          payoutReference,
          payoutDate,
        }),
      })
      setNewStatus("")
      setStatusReason("")
      setApprovedAmount("")
      setPaidAmount("")
      setPayoutReference("")
      setPayoutDate("")
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status")
    } finally {
      setStatusUpdating(false)
    }
  }

  const uploadEvidence = async (fieldKey: string, file: File | null) => {
    if (!file) return
    setUploadingField(fieldKey)
    setError("")
    try {
      const form = new FormData()
      form.set("fieldKey", fieldKey)
      form.set("file", file)
      await api(`/api/claims/${claimId}/media/upload`, { method: "POST", body: form })
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Evidence upload failed")
    } finally {
      setUploadingField("")
    }
  }

  const handleApproveAutomation = async () => {
    if (!automationJob) return
    setApproving(true)
    try {
      await api(`/api/automation/jobs/${automationJob.id}/approve`, { method: "POST" })
      load()
    } catch (err: any) {
      setError(err.message || "Failed to approve automation submission.")
    } finally {
      setApproving(false)
    }
  }

  const handleRetryAutomation = async () => {
    if (!automationJob) return
    try {
      await api(`/api/automation/jobs/${automationJob.id}/retry`, { method: "POST" })
      load()
    } catch (err: any) {
      setError(err.message || "Failed to retry automation.")
    }
  }

  const handleManualResolve = async () => {
    if (!automationJob || !manualClaimRef.trim()) return
    try {
      await api(`/api/automation/jobs/${automationJob.id}/manual-resolve`, {
        method: "POST",
        body: JSON.stringify({ marketplaceClaimId: manualClaimRef.trim() }),
      })
      setManualModalOpen(false)
      load()
    } catch (err: any) {
      setError(err.message || "Failed to resolve claim manually.")
    }
  }

  if (error && !claim) return <Modal onClose={onClose}><PageError message={error} /></Modal>
  if (!claim) return <Modal onClose={onClose}><Loading label="Loading claim…" /></Modal>

  const templateFields = (templates.find((t) => t.id === claim.claimTemplateId)?.fields || []).filter((f) => f.active)

  return (
    <>
      <Modal onClose={onClose} wide>
        {/* Header */}
        <div className="modal-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0 }}>Claim #{claim.id}</h2>
              <MarketplaceBadge name={claim.marketplace} />
              <Badge tone={CLAIM_STATUS_TONES[claim.status as ClaimStatus] || "neutral"}>
                {CLAIM_STATUS_LABELS[claim.status as ClaimStatus] || claim.status}
              </Badge>
              {claim.totalPrice > 0 && (
                <span className="claim-amount-pill">₹{claim.totalPrice.toFixed(2)}</span>
              )}
            </div>

            {/* Quick Copy & Meta Bar */}
            <div className="claim-meta-bar">
              <button
                type="button"
                className="claim-copy-pill"
                onClick={() => copyText(claim.trackingId, "awb")}
                title="Click to copy Tracking ID / AWB"
              >
                📋 AWB: <strong>{claim.trackingId}</strong> {copiedKey === "awb" && <span style={{ color: "var(--green)" }}>✓ Copied</span>}
              </button>
              {(claim.subOrderId || claim.orderId) && (
                <button
                  type="button"
                  className="claim-copy-pill"
                  onClick={() => copyText(claim.subOrderId || claim.orderId, "order")}
                  title="Click to copy Order ID"
                >
                  📋 SubOrder: <strong>{claim.subOrderId || claim.orderId}</strong> {copiedKey === "order" && <span style={{ color: "var(--green)" }}>✓ Copied</span>}
                </button>
              )}
              {claim.packetId && claim.packetId !== claim.trackingId && (
                <span className="claim-copy-pill" style={{ cursor: "default" }}>
                  📦 Packet: {claim.packetId}
                </span>
              )}
              {claim.dueDate && (
                <Badge tone={claim.overdue ? "danger" : "success"}>
                  Due: {claim.dueDate} {claim.daysRemaining !== null ? `(${claim.overdue ? `${Math.abs(claim.daysRemaining)}d overdue` : `${claim.daysRemaining}d left`})` : ""}
                </Badge>
              )}
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} title="Close"><Icon name="close" /></button>
        </div>

        <div className="modal-body" style={{ display: "grid", gap: 18 }}>
          {error && <div className="form-error">{error}</div>}

          {/* Details 2-Column Responsive Grid */}
          <div className="claim-detail-grid">
            {/* Left Card: Shipment & Order */}
            <div className="claim-detail-card">
              <h4>📦 Shipment & Order Details</h4>
              <div className="claim-detail-row">
                <span className="label">AWB / Tracking ID</span>
                <span className="val" style={{ fontFamily: "monospace", fontSize: 14 }}>{claim.trackingId}</span>
              </div>
              <div className="claim-detail-row">
                <span className="label">Order ID</span>
                <span className="val">{claim.orderId || "—"}</span>
              </div>
              {claim.subOrderId && (
                <div className="claim-detail-row">
                  <span className="label">Sub Order ID</span>
                  <span className="val">{claim.subOrderId}</span>
                </div>
              )}
              {claim.packetId && (
                <div className="claim-detail-row">
                  <span className="label">Packet ID</span>
                  <span className="val">{claim.packetId}</span>
                </div>
              )}
              <div className="claim-detail-row">
                <span className="label">Packet State</span>
                <span className="val"><Badge tone="warning">Tampered</Badge></span>
              </div>
              {claim.totalPrice > 0 && (
                <div className="claim-detail-row">
                  <span className="label">Merchandise Value</span>
                  <span className="val" style={{ color: "#059669", fontWeight: 700 }}>₹{claim.totalPrice.toFixed(2)}</span>
                </div>
              )}
              <div className="claim-detail-row">
                <span className="label">Filed On</span>
                <span className="val">{new Date(claim.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <div className="claim-detail-row">
                <span className="label">Created By</span>
                <span className="val">{claim.createdBy}</span>
              </div>
            </div>

            {/* Right Card: Claim Case & Description */}
            <div className="claim-detail-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <h4 style={{ margin: 0 }}>📝 Claim Issue & Statement</h4>
                {claim.claimDescription && (
                  <button
                    type="button"
                    className="claim-copy-pill"
                    onClick={() => copyText(claim.claimDescription, "desc")}
                    title="Copy full description for seller portal"
                  >
                    📋 {copiedKey === "desc" ? "Copied!" : "Copy Description"}
                  </button>
                )}
              </div>
              <div className="claim-detail-row">
                <span className="label">Claim Reason</span>
                <span className="val"><strong>{claim.claimReason}</strong></span>
              </div>
              {claim.claimTitle && (
                <div className="claim-detail-row">
                  <span className="label">Claim Title</span>
                  <span className="val">{claim.claimTitle}</span>
                </div>
              )}
              <div style={{ marginTop: 10 }}>
                <span className="label" style={{ display: "block", marginBottom: 4 }}>Full Description:</span>
                <div className="claim-desc-block">
                  {claim.claimDescription || "No detailed description entered."}
                </div>
              </div>
              {claim.remarks && (
                <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
                  <strong>Remarks:</strong> {claim.remarks}
                </div>
              )}
            </div>
          </div>

          {/* Desktop Automation Status Card */}
          {automationJob && (
            <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", padding: 16, borderRadius: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 22 }}>🤖</span>
                  <div>
                    <h4 style={{ margin: 0, fontSize: 14 }}>Windows Desktop EXE Claim Automation</h4>
                    <small style={{ color: "#1e40af" }}>
                      Stage: <strong>{automationJob.stage}</strong> · Mode: {automationJob.browserMode} · Attempts: {automationJob.attempts}/{automationJob.maxAttempts}
                    </small>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {(automationJob.stage === "prepared" || automationJob.stage === "waiting_approval") && canApprove && (
                    <button className="btn primary" onClick={handleApproveAutomation} disabled={approving}>
                      {approving ? "Approving…" : "✓ Approve for Submission"}
                    </button>
                  )}
                  {(automationJob.stage === "failed" || automationJob.stage === "manual_intervention_required") && (
                    <>
                      <button className="btn secondary small" onClick={handleRetryAutomation}>Retry Automation</button>
                      <button className="btn secondary small" onClick={() => setManualModalOpen(true)}>Record Manual Claim</button>
                    </>
                  )}
                  {automationJob.stage === "not_eligible" && (
                    <button className="btn secondary small" onClick={() => setManualModalOpen(true)}>Record Manual Claim</button>
                  )}
                </div>
              </div>

              {automationJob.manualActionReason && (
                <div style={{ background: "#fef3c7", padding: "10px 14px", borderRadius: 6, fontSize: 13, color: "#92400e", marginBottom: 8 }}>
                  ⚠️ <strong>{automationJob.stage === "not_eligible" ? "Not eligible, the bot did not claim it:" : "Manual Action Required:"}</strong>{" "}
                  {automationJob.manualActionReason}
                </div>
              )}

              {automationJob.marketplaceClaimId && automationJob.stage === "completed" && (
                <div style={{ background: "#ecfdf5", padding: "10px 14px", borderRadius: 6, fontSize: 13, color: "#065f46", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>✅ <strong>Marketplace Claim Reference:</strong> <code>{automationJob.marketplaceClaimId}</code></span>
                  <button
                    type="button"
                    className="claim-copy-pill"
                    onClick={() => copyText(automationJob.marketplaceClaimId, "ticket")}
                  >
                    📋 {copiedKey === "ticket" ? "Copied!" : "Copy"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Product Reference & Captured Evidence Visual Gallery */}
          <div className="claim-gallery-section">
            <h3 style={{ margin: "0 0 16px", display: "flex", alignItems: "center", gap: 8, fontSize: 15 }}>
              <Icon name="box" size={18} /> Product Reference & Captured Evidence Gallery ({claim.media.length} files)
            </h3>
            
            <div className="claim-gallery-layout">
              {/* Left Catalog Photo Box */}
              <div className="claim-catalog-box">
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", display: "block", marginBottom: 8, textTransform: "uppercase" }}>
                  Catalog Photo
                </span>
                {refImage ? (
                  <div title="Click to view full catalog image">
                    <img
                      src={refImage}
                      alt="Catalog Reference"
                      onClick={() => setPreviewMediaUrl(refImage)}
                    />
                    <small style={{ display: "block", marginTop: 6, color: "var(--muted)", fontSize: 11 }}>
                      🔍 Click to enlarge
                    </small>
                  </div>
                ) : (
                  <div style={{ width: "100%", aspectRatio: "1", background: "#f1f5f9", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--muted)" }}>
                    No Catalog Photo
                  </div>
                )}
              </div>

              {/* Right: Slot-by-Slot Evidence Grid */}
              <div className="claim-evidence-grid">
                {templateFields.map((field) => {
                  const slotMedia = claim.media.filter((m) => m.active && m.fieldKey === field.fieldKey)
                  const count = slotMedia.length
                  const isFulfilled = count >= field.minCount
                  const accept =
                    field.fieldType === "image"
                      ? "image/*"
                      : field.fieldType === "video"
                        ? "video/*"
                        : "application/pdf,image/*"

                  return (
                    <div className={`claim-slot-card ${isFulfilled ? "fulfilled" : ""}`} key={field.id}>
                      <div className="claim-slot-header">
                        <strong>{field.fieldLabel}{field.required ? " *" : ""}</strong>
                        <span className="slot-badge">
                          {count} / {field.maxCount}
                        </span>
                      </div>

                      {/* Render uploaded items for this slot */}
                      {slotMedia.map((m) => {
                        const isImage = m.mimeType.startsWith("image/")
                        const isVideo = m.mimeType.startsWith("video/")
                        const mediaUrl = `/api/claims/${claim.id}/media/${m.id}`
                        const sizeMb = m.sizeBytes > 0 ? (m.sizeBytes / (1024 * 1024)).toFixed(2) : null

                        return (
                          <div key={m.id} className="claim-media-item">
                            <div className="claim-media-preview-box">
                              {isImage ? (
                                <div onClick={() => setPreviewMediaUrl(mediaUrl)} style={{ cursor: "pointer" }}>
                                  <img
                                    src={mediaUrl}
                                    alt={m.originalFilename || field.fieldLabel}
                                    loading="lazy"
                                  />
                                  <div className="zoom-hint">🔍 Enlarge Photo</div>
                                </div>
                              ) : isVideo ? (
                                <video
                                  src={mediaUrl}
                                  controls
                                  preload="metadata"
                                  className="claim-video-player"
                                />
                              ) : (
                                <div style={{ padding: 24, textAlign: "center", background: "#f8fafc", color: "#334155" }}>
                                  📄 Document File
                                </div>
                              )}
                            </div>
                            <div className="claim-media-meta">
                              <span title={m.originalFilename} style={{ maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {m.originalFilename || `${field.fieldKey}.${m.mimeType.split("/")[1] || "dat"}`}
                              </span>
                              <div>
                                {sizeMb && <span style={{ marginRight: 6 }}>{sizeMb} MB</span>}
                                <a href={mediaUrl} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 600 }}>
                                  Open ↗
                                </a>
                              </div>
                            </div>
                          </div>
                        )
                      })}

                      {/* If more uploads allowed for this slot */}
                      {count < field.maxCount && (
                        <div style={{ marginTop: "auto", paddingTop: 8 }}>
                          <label className="btn secondary small" style={{ display: "block", textAlign: "center", cursor: "pointer" }}>
                            {uploadingField === field.fieldKey ? "Uploading…" : `+ Add ${field.fieldType}`}
                            <input
                              type="file"
                              accept={accept}
                              hidden
                              disabled={Boolean(uploadingField)}
                              onChange={(e) => void uploadEvidence(field.fieldKey, e.target.files?.[0] || null)}
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Supervisor Status Transition Footer */}
          {canApprove && (
            <div className="panel-sub" style={{ background: "#f8fafc", padding: 14, borderRadius: 8 }}>
              <h4 style={{ margin: "0 0 10px", fontSize: 13, textTransform: "uppercase", color: "#64748b" }}>
                Update Lifecycle Status
              </h4>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <select value={newStatus} onChange={(e) => setNewStatus(e.target.value)} style={{ minWidth: 180 }}>
                  <option value="">Select new status…</option>
                  {(NEXT_STATUSES[claim.status as ClaimStatus] || []).map((s) => (
                    <option key={s} value={s}>{CLAIM_STATUS_LABELS[s]}</option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Reason for status change (optional)"
                  value={statusReason}
                  onChange={(e) => setStatusReason(e.target.value)}
                  style={{ flex: 1, minWidth: 200 }}
                />
                {newStatus === "approved" && (
                  <input type="number" min="0" step="0.01" placeholder="Approved amount" value={approvedAmount} onChange={(e) => setApprovedAmount(e.target.value)} />
                )}
                {(newStatus === "reconciled" || newStatus === "paid") && (
                  <input type="text" placeholder="Payout / reconciliation reference" value={payoutReference} onChange={(e) => setPayoutReference(e.target.value)} />
                )}
                {newStatus === "paid" && (
                  <>
                    <input type="number" min="0" step="0.01" placeholder="Paid amount" value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)} required />
                    <input type="date" aria-label="Payout date" value={payoutDate} onChange={(e) => setPayoutDate(e.target.value)} />
                  </>
                )}
                <button className="btn primary" disabled={!newStatus || statusUpdating} onClick={updateStatus}>
                  {statusUpdating ? "Updating…" : "Update Status"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Manual Claim Submission Dialog */}
        {manualModalOpen && (
          <Modal onClose={() => setManualModalOpen(false)}>
            <div style={{ padding: 10 }}>
              <h3>Record Marketplace Claim Submission</h3>
              <p style={{ fontSize: 13, color: "var(--muted)" }}>
                If you submitted this claim manually through the seller portal, enter the marketplace confirmation number below.
              </p>
              <div style={{ margin: "16px 0" }}>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Marketplace Claim Reference / Ticket ID</label>
                <input
                  type="text"
                  placeholder="e.g. MCL-8492049, SPF-92049"
                  value={manualClaimRef}
                  onChange={(e) => setManualClaimRef(e.target.value)}
                  style={{ width: "100%", marginTop: 6 }}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button className="btn secondary" onClick={() => setManualModalOpen(false)}>Cancel</button>
                <button className="btn primary" disabled={!manualClaimRef.trim()} onClick={handleManualResolve}>
                  Save & Mark Submitted
                </button>
              </div>
            </div>
          </Modal>
        )}
      </Modal>

      {/* Lightbox Modal */}
      {previewMediaUrl && (
        <div className="claim-lightbox-backdrop" onClick={() => setPreviewMediaUrl(null)}>
          <div className="claim-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <button className="claim-lightbox-close" onClick={() => setPreviewMediaUrl(null)}>×</button>
            <img src={previewMediaUrl} alt="Evidence Full Resolution" />
          </div>
        </div>
      )}
    </>
  )
}

function CreateClaimModal({
  accounts,
  templates,
  onClose,
  onCreated,
}: {
  accounts: AccountOption[]
  templates: ClaimTemplate[]
  onClose: () => void
  onCreated: (claimId: number) => void
}) {
  const [selectedMarketplace, setSelectedMarketplace] = useState("meesho")
  const [query, setQuery] = useState("")
  const [loadingLookup, setLoadingLookup] = useState(false)
  const [lookupResult, setLookupResult] = useState<ClaimReturnLookup | null>(null)
  const [selectedTemplateId, setSelectedTemplateId] = useState("")
  const [selectedReason, setSelectedReason] = useState("wrong_return")
  const [subOrderNumber, setSubOrderNumber] = useState("")
  const [awbNumber, setAwbNumber] = useState("")
  const [packetId, setPacketId] = useState("")
  const [claimTitle, setClaimTitle] = useState("")
  const [claimContent, setClaimContent] = useState("")
  const [remarks, setRemarks] = useState("")
  const [copiedSubOrder, setCopiedSubOrder] = useState(false)
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState("")

  const generateDescription = (
    reasonCode: string,
    res: ClaimReturnLookup,
    subOrderVal: string,
    awbVal: string,
    pktVal: string,
  ) => {
    const subId = subOrderVal || res.subOrderId || res.orderId
    const awbNo = awbVal || res.awb || res.trackingNumber
    const pId = pktVal || res.packetId || "NA"
    const masterSku = res.items[0]?.masterSku || res.items[0]?.sku || "item"
    const packetState = "Tampered"

    if (reasonCode === "missing_items") {
      let missingDesc = "one or more item/s"
      if (res.missingItems && res.missingItems.length > 0) {
        missingDesc = res.missingItems
          .map((m) => `${m.label} (Qty: ${m.quantity}, Rate: ₹${m.amountEach || 100})`)
          .join(", ")
      }
      const amtStr = res.missingAmount > 0 ? `Total claim amount: ₹${res.missingAmount}.\n` : ""
      return `Team,\n\nPlease Note This Sub Order ID ${subId} has item/s missing in the return package: ${missingDesc}.\n${amtStr}Please check attached all proof and video and make sure our claim will be approved.\n\nSub Order ID: ${subId}\nAWB Number: ${awbNo}\nState of the packet: ${packetState}\nPacket ID: ${pId}\n\nRegards,\nReturn Team Tullipprints`
    }

    if (reasonCode === "wrong_barcode_rto") {
      return `Team,\n\nPlease Note This Sub Order ID ${subId} has received a wrong barcoded package in RTO instead of ordered item (${masterSku}). Outer package barcode label does not match our return manifest. Please check attached proof and video and make sure our claim will be approved.\n\nSub Order ID: ${subId}\nAWB Number: ${awbNo}\nState of the packet: ${packetState}\nPacket ID: ${pId}\n\nRegards,\nReturn Team Tullipprints`
    }

    if (reasonCode === "damaged_return") {
      return `Team,\n\nPlease Note This Sub Order ID ${subId} has received damaged return product (${masterSku}). Product arrived physically damaged/torn. Please check attached proof and video and make sure our claim will be approved.\n\nSub Order ID: ${subId}\nAWB Number: ${awbNo}\nState of the packet: ${packetState}\nPacket ID: ${pId}\n\nRegards,\nReturn Team Tullipprints`
    }

    if (reasonCode === "used_product") {
      return `Team,\n\nPlease Note This Sub Order ID ${subId} has received used/soiled product as return instead of fresh ${masterSku}. Returned product shows evident signs of wear/use. Please check attached proof and video and make sure our claim will be approved.\n\nSub Order ID: ${subId}\nAWB Number: ${awbNo}\nState of the packet: ${packetState}\nPacket ID: ${pId}\n\nRegards,\nReturn Team Tullipprints`
    }

    // Default: wrong_return
    return `Team,\n\nPlease Note This Sub Order ID ${subId} Has received Us the wrong please check attached all the prrof and video and and make sure we claim will be approved )\n\nSub Order ID: ${subId}\nAWB Number: ${awbNo}\nState of the packet: ${packetState}\nPacket ID: ${pId}\n\nRegards,\nReturn Team Tullipprints`
  }

  const handleSearch = async () => {
    if (query.trim().length < 3) {
      setFormError("Enter at least 3 characters of AWB, Sub Order ID, or Packet ID.")
      return
    }
    setLoadingLookup(true)
    setFormError("")
    try {
      const data = await api<ClaimReturnLookup>(`/api/claims/return-lookup?query=${encodeURIComponent(query.trim())}`)
      setLookupResult(data)
      const initialSubOrder = data.subOrderId || data.items[0]?.subOrderId || data.orderId
      const initialAwb = data.awb || data.trackingNumber
      const initialPacket = data.packetId || "NA"
      setSubOrderNumber(initialSubOrder)
      setAwbNumber(initialAwb)
      setPacketId(initialPacket)

      if (data.templates[0]) setSelectedTemplateId(String(data.templates[0].id))
      const initialReason = data.standardReasons[0]?.code || "wrong_return"
      setSelectedReason(initialReason)
      setClaimTitle(data.standardReasons[0]?.suggestedTitle || "I have received wrong return")
      setClaimContent(generateDescription(initialReason, data, initialSubOrder, initialAwb, initialPacket))
    } catch (err: any) {
      setFormError(err.message || "No matching return found.")
      setLookupResult(null)
    } finally {
      setLoadingLookup(false)
    }
  }

  const handleReasonChange = (code: string) => {
    setSelectedReason(code)
    if (!lookupResult) return
    const match = lookupResult.standardReasons.find((r) => r.code === code)
    if (match) {
      setClaimTitle(match.suggestedTitle)
    }
    setClaimContent(generateDescription(code, lookupResult, subOrderNumber, awbNumber, packetId))
  }

  const copySubOrder = () => {
    if (!subOrderNumber) return
    navigator.clipboard.writeText(subOrderNumber).then(() => {
      setCopiedSubOrder(true)
      setTimeout(() => setCopiedSubOrder(false), 2000)
    })
  }

  const handleCreate = async () => {
    if (!lookupResult) return
    setCreating(true)
    setFormError("")
    try {
      const selectedReasonObj = lookupResult.standardReasons.find((r) => r.code === selectedReason)
      const res = await api<{ claim: ClaimDetail; jobId: number | null }>("/api/claims/unified-create", {
        method: "POST",
        body: JSON.stringify({
          receiptScanId: lookupResult.scanId || undefined,
          expectedReturnId: lookupResult.expectedReturnId,
          subOrderId: subOrderNumber.trim() || lookupResult.subOrderId || lookupResult.orderId,
          awb: awbNumber.trim() || lookupResult.awb || lookupResult.trackingNumber,
          orderId: lookupResult.orderId,
          packetState: "Tampered",
          packetId: packetId.trim() || lookupResult.packetId || "NA",
          customerName: lookupResult.customerName,
          totalPrice: lookupResult.totalPrice,
          missingAmount: lookupResult.missingAmount || 0,
          shippedDate: lookupResult.shippedDate,
          sku: lookupResult.items[0]?.masterSku || lookupResult.items[0]?.sku || "",
          claimReason: selectedReasonObj?.label || "I have received wrong return",
          claimTitle: claimTitle.trim(),
          claimContent: claimContent.trim(),
          claimDescription: claimContent.trim(),
          remarks: remarks.trim(),
          claimTemplateId: selectedTemplateId ? Number(selectedTemplateId) : undefined,
          marketplaceIssueCode: selectedReason,
        }),
      })

      onCreated(res.claim.id)
    } catch (err: any) {
      setFormError(err.message || "Failed to create claim.")
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal onClose={onClose} wide>
      <div className="modal-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Meesho Support Portal · Raise a Return Claim Ticket</h2>
        <button className="btn-icon" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="modal-body" style={{ display: "grid", gap: 16 }}>
        {formError && <div className="form-error">{formError}</div>}

        {/* Marketplace Selection Header */}
        <div style={{ background: "#f8fafc", padding: "12px 16px", borderRadius: 8, border: "1px solid #e2e8f0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <label style={{ fontSize: 13, fontWeight: 700, color: "var(--foreground)", display: "block" }}>
                Select Marketplace
              </label>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                Meesho is active & configured. Other channels will be enabled sequentially.
              </span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className={`btn ${selectedMarketplace === "meesho" ? "primary" : "secondary"} small`}
                onClick={() => setSelectedMarketplace("meesho")}
              >
                Meesho (Active)
              </button>
              <button
                type="button"
                className="btn secondary small"
                disabled
                title="Flipkart claim flow is upcoming"
                style={{ opacity: 0.5 }}
              >
                Flipkart (Upcoming)
              </button>
              <button
                type="button"
                className="btn secondary small"
                disabled
                title="Amazon claim flow is upcoming"
                style={{ opacity: 0.5 }}
              >
                Amazon (Upcoming)
              </button>
              <button
                type="button"
                className="btn secondary small"
                disabled
                title="Myntra claim flow is upcoming"
                style={{ opacity: 0.5 }}
              >
                Myntra (Upcoming)
              </button>
            </div>
          </div>
        </div>

        {/* Search return box */}
        <div style={{ display: "flex", gap: 10 }}>
          <input
            type="search"
            placeholder="Scan or enter AWB Number, Sub Order ID, Order ID, or Packet ID…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            style={{ flex: 1 }}
          />
          <button className="btn primary" onClick={handleSearch} disabled={loadingLookup}>
            {loadingLookup ? "Searching…" : "Find Return"}
          </button>
        </div>

        {/* Return Details Card & Meesho Ticket Form */}
        {lookupResult && (
          <div style={{ background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: 8, padding: 16 }}>
            {/* 7-Day TAT Banner */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: lookupResult.overdue ? "#fef2f2" : "#f0fdf4",
                border: `1px solid ${lookupResult.overdue ? "#fca5a5" : "#86efac"}`,
                borderRadius: 8,
                padding: "10px 14px",
                marginBottom: 14,
              }}
            >
              <div>
                <strong style={{ color: lookupResult.overdue ? "#991b1b" : "#166534", fontSize: 13 }}>
                  ⏱️ Meesho Claim TAT (Turnaround Time): 7 Days
                </strong>
                <div style={{ fontSize: 12, color: lookupResult.overdue ? "#b91c1c" : "#15803d", marginTop: 2 }}>
                  Received: <strong>{lookupResult.receivedDate || "Today"}</strong> · File Claim Till:{" "}
                  <strong>{lookupResult.dueDate || "Within 7 days"}</strong>
                </div>
              </div>
              <div>
                <Badge tone={lookupResult.overdue ? "danger" : "success"}>
                  {lookupResult.overdue
                    ? `⚠️ Overdue by ${Math.abs(lookupResult.daysRemaining || 0)}d`
                    : `✓ ${lookupResult.daysRemaining !== null ? lookupResult.daysRemaining : 7}d remaining`}
                </Badge>
              </div>
            </div>

            {/* Order & Product Summary Card */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <MarketplaceBadge name={lookupResult.marketplace} />
                <h3 style={{ margin: "6px 0 2px" }}>Order: {lookupResult.orderId}</h3>
                <span style={{ fontSize: 13, color: "var(--muted)" }}>
                  AWB: {lookupResult.trackingNumber} · Customer: {lookupResult.customerName}
                </span>
              </div>
              <div style={{ textAlign: "right" }}>
                <span className="badge green" style={{ fontSize: 12 }}>₹{lookupResult.totalPrice}</span>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                  {lookupResult.returnStatus}
                </div>
              </div>
            </div>

            {/* Product Item with Image */}
            {lookupResult.items[0] && (
              <div style={{ display: "flex", gap: 14, background: "#fff", padding: 10, borderRadius: 6, border: "1px solid #e2e8f0" }}>
                {lookupResult.items[0].imageUrl ? (
                  <img
                    src={lookupResult.items[0].imageUrl}
                    alt="SKU"
                    style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6 }}
                  />
                ) : (
                  <div style={{ width: 64, height: 64, background: "#f1f5f9", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    📷
                  </div>
                )}
                <div>
                  <strong>{lookupResult.items[0].title}</strong>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    Master SKU: {lookupResult.items[0].masterSku} · Qty: {lookupResult.items[0].quantity}
                  </div>
                  {lookupResult.items[0].subOrderId && (
                    <div style={{ fontSize: 12, color: "#1e40af", marginTop: 2 }}>
                      Item Sub Order: {lookupResult.items[0].subOrderId}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Meesho Portal Form Inputs */}
            <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
              {/* Issue Selection */}
              <div>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Issue *</label>
                <select
                  value={selectedReason}
                  onChange={(e) => handleReasonChange(e.target.value)}
                  style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #cbd5e1" }}
                >
                  {lookupResult.standardReasons.map((r) => (
                    <option key={r.code} value={r.code}>{r.label}</option>
                  ))}
                </select>
              </div>

              {/* Sub Order Number + Copy Button */}
              <div>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Sub Order Number *</label>
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <input
                    type="text"
                    value={subOrderNumber}
                    onChange={(e) => {
                      setSubOrderNumber(e.target.value)
                      setClaimContent(generateDescription(selectedReason, lookupResult, e.target.value, awbNumber, packetId))
                    }}
                    placeholder="Enter Sub Order Number"
                    style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: "1px solid #cbd5e1" }}
                  />
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={copySubOrder}
                    title="Copy Sub Order Number"
                    style={{ whiteSpace: "nowrap" }}
                  >
                    {copiedSubOrder ? "✓ Copied" : "Copy"}
                  </button>
                </div>
              </div>

              {/* AWB Number */}
              <div>
                <label style={{ fontSize: 13, fontWeight: 600 }}>AWB Number *</label>
                <input
                  type="text"
                  value={awbNumber}
                  onChange={(e) => {
                    setAwbNumber(e.target.value)
                    setClaimContent(generateDescription(selectedReason, lookupResult, subOrderNumber, e.target.value, packetId))
                  }}
                  placeholder="Enter AWB Number"
                  style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #cbd5e1" }}
                />
              </div>

              {/* State of the packet (ALWAYS Tampered) */}
              <div>
                <label style={{ fontSize: 13, fontWeight: 600 }}>State of the packet *</label>
                <select
                  disabled
                  value="Tampered"
                  style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #cbd5e1", background: "#f1f5f9", cursor: "not-allowed" }}
                >
                  <option value="Tampered">Tampered (Auto-fixed for claims)</option>
                </select>
                <small style={{ color: "var(--muted)", fontSize: 11, display: "block", marginTop: 2 }}>
                  Per Meesho Claim Policy, return claims must always have packet state selected as Tampered.
                </small>
              </div>

              {/* Packet ID */}
              <div>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Packet ID *</label>
                <input
                  type="text"
                  value={packetId}
                  onChange={(e) => {
                    setPacketId(e.target.value)
                    setClaimContent(generateDescription(selectedReason, lookupResult, subOrderNumber, awbNumber, e.target.value))
                  }}
                  placeholder="Flyer barcode ID or NA"
                  style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #cbd5e1" }}
                />
                <small style={{ color: "var(--muted)", fontSize: 11, display: "block", marginTop: 2 }}>
                  Correct Packet ID entry is mandatory for accurate claims resolution. If you don't have Packet ID then enter NA in the above field.
                </small>
              </div>

              {/* Claim Title */}
              <div>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Claim Title *</label>
                <input
                  type="text"
                  value={claimTitle}
                  onChange={(e) => setClaimTitle(e.target.value)}
                  style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #cbd5e1" }}
                />
              </div>

              {/* Description */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label style={{ fontSize: 13, fontWeight: 600 }}>Description *</label>
                  <span style={{ fontSize: 11, color: claimContent.length > 1000 ? "#b91c1c" : "var(--muted)" }}>
                    {claimContent.length}/1000
                  </span>
                </div>
                <textarea
                  rows={4}
                  maxLength={1000}
                  value={claimContent}
                  onChange={(e) => setClaimContent(e.target.value)}
                  style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #cbd5e1", fontSize: 13 }}
                />
              </div>

              {/* Internal Remarks */}
              <div>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Internal Remarks (Optional)</label>
                <input
                  type="text"
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Notes for warehouse or supervisor…"
                  style={{ width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6, border: "1px solid #cbd5e1" }}
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
              <button className="btn secondary" onClick={onClose} disabled={creating}>Cancel</button>
              <button className="btn primary" onClick={handleCreate} disabled={creating || !subOrderNumber.trim() || !awbNumber.trim()}>
                {creating ? "Creating Claim & Queueing…" : "Create Claim & Upload Evidence"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

type JobFilter = "all" | "active" | "manual" | "not_eligible" | "completed"

const JOB_FILTERS: { id: JobFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "In progress" },
  { id: "manual", label: "Needs manual action" },
  { id: "not_eligible", label: "Not eligible (manual)" },
  { id: "completed", label: "Filed" },
]

function jobMatchesFilter(job: AutomationJob, filter: JobFilter): boolean {
  if (filter === "all") return true
  if (filter === "not_eligible") return job.stage === "not_eligible"
  if (filter === "manual") return job.stage === "manual_intervention_required" || job.stage === "failed"
  if (filter === "completed") return job.stage === "completed"
  return !["not_eligible", "manual_intervention_required", "failed", "completed"].includes(job.stage)
}

function jobStageLabel(stage: string): string {
  if (stage === "not_eligible") return "not eligible · manual"
  return stage
}

function DesktopAutomationTab() {
  const [agents, setAgents] = useState<AutomationAgent[]>([])
  const [jobs, setJobs] = useState<AutomationJob[]>([])
  const [credentials, setCredentials] = useState<MarketplaceCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedJob, setSelectedJob] = useState<AutomationJob | null>(null)
  const [jobFilter, setJobFilter] = useState<JobFilter>("all")
  const shownJobs = jobs.filter((job) => jobMatchesFilter(job, jobFilter))

  const loadData = () => {
    setLoading(true)
    Promise.all([
      api<{ agents: AutomationAgent[] }>("/api/automation/agents"),
      api<{ rows: AutomationJob[] }>("/api/automation/jobs"),
      api<{ credentials: MarketplaceCredential[] }>("/api/automation/credentials"),
    ])
      .then(([a, j, c]) => {
        setAgents(a.agents)
        setJobs(j.rows)
        setCredentials(c.credentials)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadData()
    const timer = setInterval(loadData, 8000)
    return () => clearInterval(timer)
  }, [])

  if (loading && !agents.length) return <Loading label="Loading desktop automation dashboard…" />

  return (
    <div style={{ display: "grid", gap: 24 }}>
      {/* Agents Overview Card */}
      <section className="panel">
        <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h2>Connected 24/7 Desktop Claim Processing Bots</h2>
            <p>Always-on background automation bot running on the server PC processing marketplace claims</p>
          </div>
          <button className="btn secondary small" onClick={loadData}>↻ Refresh</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, margin: "16px 0" }}>
          {agents.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", background: "#f8fafc", borderRadius: 8, gridColumn: "1 / -1" }}>
              <p style={{ margin: 0, color: "var(--muted)" }}>
                No desktop bots currently connected. Run the 24/7 claim bot on the server PC (<code>npm run bot</code> or double-click <code>START-BOT.bat</code>).
              </p>
            </div>
          ) : (
            agents.map((ag) => (
              <div key={ag.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14, background: ag.status === "online" ? "#f0fdf4" : "#fff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>{ag.agentName}</strong>
                  <Badge tone={ag.status === "online" ? "success" : ag.status === "busy" ? "warning" : "neutral"}>
                    {ag.status}
                  </Badge>
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
                  Host: {ag.hostname} · OS: {ag.platform} · v{ag.version}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                  Last Heartbeat: {new Date(ag.lastHeartbeatAt).toLocaleTimeString("en-IN")}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Marketplace Credentials & Settings */}
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Marketplace Portals & Automation Configuration</h2>
            <p>Seller portal login endpoints, automation modes, and submission approval rules</p>
          </div>
        </div>

        <DataTable
          columns={[
            {
              key: "marketplaceName",
              header: "Marketplace",
              render: (row) => <MarketplaceBadge name={row.marketplaceName} />,
            },
            { key: "accountName", header: "Account Name", render: (row) => <strong>{row.accountName}</strong> },
            {
              key: "portalUrl",
              header: "Portal Endpoint",
              render: (row) => <span style={{ fontSize: 12, fontFamily: "monospace" }}>{row.portalUrl}</span>,
            },
            { key: "usernameMasked", header: "Portal Username", render: (row) => row.usernameMasked || "—" },
            {
              key: "automationMode",
              header: "Browser Mode",
              render: (row) => (
                <span className="badge neutral">{row.automationMode}</span>
              ),
            },
            {
              key: "requireApprovalBeforeSubmit",
              header: "Approval Required",
              render: (row) => (
                <Badge tone={row.requireApprovalBeforeSubmit ? "warning" : "neutral"}>
                  {row.requireApprovalBeforeSubmit ? "Yes (Pre-Approval)" : "Direct Submit"}
                </Badge>
              ),
            },
          ]}
          rows={credentials}
          rowKey={(row) => String(row.id)}
        />
      </section>

      {/* Automation Jobs Queue */}
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Automated Claims Processing Queue</h2>
            <p>Live marketplace submission tasks and execution status. Orders the marketplace refuses are never claimed; they wait under “Not eligible” for a manual check.</p>
          </div>
        </div>

        <div role="tablist" aria-label="Filter claim bot jobs" style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "4px 0 12px" }}>
          {JOB_FILTERS.map((filter) => {
            const count = jobs.filter((job) => jobMatchesFilter(job, filter.id)).length
            return (
              <button
                key={filter.id}
                type="button"
                role="tab"
                aria-selected={jobFilter === filter.id}
                className={jobFilter === filter.id ? "btn primary small" : "btn secondary small"}
                onClick={() => setJobFilter(filter.id)}
              >
                {filter.label} ({count})
              </button>
            )
          })}
        </div>

        <DataTable
          columns={[
            {
              key: "stage",
              header: "Stage",
              render: (row) => (
                <Badge
                  tone={
                    row.stage === "completed"
                      ? "success"
                      : row.stage === "failed"
                        ? "danger"
                        : row.stage === "not_eligible" || row.stage === "manual_intervention_required"
                          ? "warning"
                          : row.stage === "prepared"
                            ? "purple"
                            : "blue"
                  }
                >
                  {jobStageLabel(row.stage)}
                </Badge>
              ),
            },
            { key: "marketplace", header: "Marketplace", render: (row) => <MarketplaceBadge name={row.marketplace} /> },
            { key: "trackingId", header: "AWB / Order", render: (row) => <div><strong>{row.trackingId}</strong><small style={{ display: "block", color: "var(--muted)" }}>{row.orderNumber}</small></div> },
            { key: "claimReason", header: "Reason", render: (row) => row.claimReason },
            {
              key: "marketplaceClaimId",
              header: "Marketplace Ref ID",
              render: (row) => (row.marketplaceClaimId ? <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#065f46" }}>{row.marketplaceClaimId}</span> : "—"),
            },
            { key: "attempts", header: "Attempts", render: (row) => `${row.attempts}/${row.maxAttempts}` },
            {
              key: "actions",
              header: "",
              render: (row) => (
                <button className="btn secondary small" onClick={() => setSelectedJob(row)}>
                  Inspect Job
                </button>
              ),
            },
          ]}
          rows={shownJobs}
          rowKey={(row) => String(row.id)}
        />
      </section>

      {/* Job Details Modal */}
      {selectedJob && (
        <Modal onClose={() => setSelectedJob(null)} wide>
          <div className="modal-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2>Automation Job #{selectedJob.id} · {selectedJob.marketplace}</h2>
            <button className="btn-icon" onClick={() => setSelectedJob(null)}><Icon name="close" /></button>
          </div>
          <div className="modal-body" style={{ display: "grid", gap: 16 }}>
            <div style={{ background: "#f8fafc", padding: 14, borderRadius: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div><strong>Stage:</strong> {selectedJob.stage}</div>
              <div><strong>Order:</strong> {selectedJob.orderNumber}</div>
              <div><strong>AWB:</strong> {selectedJob.trackingId}</div>
              <div><strong>Marketplace Claim ID:</strong> {selectedJob.marketplaceClaimId || "Pending"}</div>
            </div>

            {selectedJob.manualActionReason && (
              <div style={{ background: "#fef3c7", padding: 12, borderRadius: 6, color: "#92400e" }}>
                ⚠️ <strong>Intervention reason:</strong> {selectedJob.manualActionReason}
              </div>
            )}

            <div>
              <h4>Execution Timeline & Agent Logs</h4>
              <div style={{ background: "#0f172a", color: "#e2e8f0", padding: 12, borderRadius: 6, maxHeight: 200, overflowY: "auto", fontFamily: "monospace", fontSize: 12 }}>
                {selectedJob.logs.map((l, i) => (
                  <div key={i} style={{ marginBottom: 4 }}>
                    <span style={{ color: "#94a3b8" }}>[{l.timestamp.split("T")[1]?.slice(0, 8)}]</span>{" "}
                    <span style={{ color: l.level === "error" ? "#f87171" : "#34d399" }}>[{l.level.toUpperCase()}]</span>{" "}
                    {l.message}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
