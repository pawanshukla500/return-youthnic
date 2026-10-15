import { useEffect, useState } from "react"
import { ApiError, api } from "../api"
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
  "failed",
  "manual_action_required",
]

const NEXT_STATUSES: Record<ClaimStatus, ClaimStatus[]> = {
  pending_evidence: [],
  ready_for_claim: ["waiting_for_approval"],
  waiting_for_approval: ["ready_for_claim", "processing", "manual_action_required"],
  processing: ["submitted", "failed", "manual_action_required"],
  submitted: [],
  failed: ["processing", "manual_action_required"],
  manual_action_required: ["processing", "failed"],
}

export function Claims() {
  const [tab, setTab] = useState<"overview" | "queue" | "automation">("queue")

  // Overview data
  const [data, setData] = useState<ClaimsData | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    api<ClaimsData>("/api/claims").then(setData).catch((err: Error) => setError(err.message))
  }, [])

  if (error && tab === "overview") return <PageError message={error} />

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
      {tab === "overview" && <Overview data={data} />}
    </div>
  )
}

function Overview({ data }: { data: ClaimsData | null }) {
  if (!data) return <Loading label="Loading claims…" />

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
              <p>All claim tickets</p>
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
            <p>Claim outcomes by channel</p>
          </div>
          <button className="btn secondary" onClick={exportClaims} disabled={!data.rows.length}>
            <Icon name="upload" /> Export CSV
          </button>
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
    params.set("page", String(page))
    params.set("pageSize", "25")
    api<ClaimListResult>(`/api/claims/queue?${params.toString()}`)
      .then((d) => setClaims(d))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadClaims()
  }, [statusFilter, marketplaceFilter, search, page])

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
  const [uploadingField, setUploadingField] = useState("")
  const [refImage, setRefImage] = useState<string | null>(null)
  const [automationJob, setAutomationJob] = useState<AutomationJob | null>(null)
  const [manualModalOpen, setManualModalOpen] = useState(false)
  const [manualClaimRef, setManualClaimRef] = useState("")
  const [approving, setApproving] = useState(false)

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
    setStatusUpdating(true)
    try {
      await api(`/api/claims/${claimId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus, reason: statusReason }),
      })
      setNewStatus("")
      setStatusReason("")
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

  return (
    <Modal onClose={onClose} wide>
      <div className="modal-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Claim #{claim.id} · {claim.marketplace}</h2>
        <button className="btn-icon" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="modal-body" style={{ display: "grid", gap: 20 }}>
        {error && <div className="form-error">{error}</div>}

        {/* Top Details Grid */}
        <div className="detail-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <div className="detail-section" style={{ background: "#f8fafc", padding: 16, borderRadius: 8 }}>
            <div className="detail-row"><span className="label">Status</span><Badge tone={CLAIM_STATUS_TONES[claim.status as ClaimStatus] || "neutral"}>{CLAIM_STATUS_LABELS[claim.status as ClaimStatus] || claim.status}</Badge></div>
            <div className="detail-row"><span className="label">Marketplace</span><MarketplaceBadge name={claim.marketplace} /></div>
            <div className="detail-row"><span className="label">Tracking ID / AWB</span><strong>{claim.trackingId}</strong></div>
            <div className="detail-row"><span className="label">Order ID</span><span>{claim.orderId}</span></div>
            {claim.subOrderId && <div className="detail-row"><span className="label">Sub Order ID</span><span>{claim.subOrderId}</span></div>}
            {claim.packetId && <div className="detail-row"><span className="label">Packet ID</span><span>{claim.packetId}</span></div>}
            {claim.dueDate && (
              <div className="detail-row">
                <span className="label">Claim Due Date</span>
                <Badge tone={claim.overdue ? "danger" : "success"}>
                  {claim.dueDate} {claim.daysRemaining !== null ? `(${claim.overdue ? `${Math.abs(claim.daysRemaining)}d overdue` : `${claim.daysRemaining}d left`})` : ""}
                </Badge>
              </div>
            )}
          </div>

          <div className="detail-section" style={{ background: "#f8fafc", padding: 16, borderRadius: 8 }}>
            <div className="detail-row"><span className="label">Claim Reason</span><strong>{claim.claimReason}</strong></div>
            <div className="detail-row"><span className="label">Claim Title</span><span>{claim.claimTitle}</span></div>
            <div className="detail-row"><span className="label">Description</span><span style={{ fontSize: 13 }}>{claim.claimDescription || "—"}</span></div>
            {claim.remarks && <div className="detail-row"><span className="label">Remarks</span><span style={{ fontSize: 12, color: "var(--muted)" }}>{claim.remarks}</span></div>}
            <div className="detail-row"><span className="label">Created By</span><span>{claim.createdBy} · {new Date(claim.createdAt).toLocaleDateString("en-IN")}</span></div>
          </div>
        </div>

        {/* Desktop Automation Status Card */}
        {automationJob && (
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", padding: 16, borderRadius: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 18 }}>🤖</span>
                <div>
                  <h4 style={{ margin: 0 }}>Windows Desktop EXE Claim Automation</h4>
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
              </div>
            </div>

            {automationJob.manualActionReason && (
              <div style={{ background: "#fef3c7", padding: "8px 12px", borderRadius: 6, fontSize: 13, color: "#92400e", marginBottom: 10 }}>
                ⚠️ <strong>Manual Action Required:</strong> {automationJob.manualActionReason}
              </div>
            )}

            {automationJob.marketplaceClaimId && (
              <div style={{ background: "#ecfdf5", padding: "8px 12px", borderRadius: 6, fontSize: 13, color: "#065f46" }}>
                ✅ <strong>Marketplace Claim Reference:</strong> {automationJob.marketplaceClaimId}
              </div>
            )}
          </div>
        )}

        {/* Product Reference vs Evidence Section */}
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}>
          <h3 style={{ margin: "0 0 14px", display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="box" size={18} /> Product Reference & Captured Evidence
          </h3>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
            {/* Original reference image */}
            <div style={{ width: 140, textAlign: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", display: "block", marginBottom: 6 }}>
                Catalog Reference
              </span>
              {refImage ? (
                <img
                  src={refImage}
                  alt="Original Product"
                  style={{ width: 130, height: 130, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }}
                />
              ) : (
                <div style={{ width: 130, height: 130, background: "#f1f5f9", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--muted)" }}>
                  No Catalog Photo
                </div>
              )}
            </div>

            {/* Evidence fields grid */}
            <div style={{ flex: 1 }}>
              <div className="account-grid-v2" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
                {(templates.find((t) => t.id === claim.claimTemplateId)?.fields || [])
                  .filter((f) => f.active)
                  .map((field) => {
                    const count = claim.media.filter((m) => m.active && m.fieldKey === field.fieldKey).length
                    const accept =
                      field.fieldType === "image"
                        ? "image/*"
                        : field.fieldType === "video"
                          ? "video/*"
                          : "application/pdf,image/*"
                    return (
                      <div className="account-card-v2" key={field.id} style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 8, background: count >= field.minCount ? "#f0fdf4" : "#fff" }}>
                        <strong style={{ fontSize: 13 }}>{field.fieldLabel}{field.required ? " *" : ""}</strong>
                        <p style={{ margin: "4px 0 8px", fontSize: 12, color: "var(--muted)" }}>
                          {count} / {field.maxCount} uploaded (min {field.minCount})
                        </p>
                        <label className="btn secondary small" style={{ display: "inline-block", cursor: "pointer" }}>
                          {uploadingField === field.fieldKey ? "Uploading…" : `+ Add ${field.fieldType}`}
                          <input
                            type="file"
                            accept={accept}
                            hidden
                            disabled={Boolean(uploadingField) || count >= field.maxCount}
                            onChange={(e) => void uploadEvidence(field.fieldKey, e.target.files?.[0] || null)}
                          />
                        </label>
                      </div>
                    )
                  })}
              </div>
            </div>
          </div>
        </div>

        {/* Media List Table */}
        <div className="panel-sub">
          <h3>Uploaded Evidence Media ({claim.media.length})</h3>
          {claim.media.length === 0 ? (
            <p className="muted">No evidence media uploaded yet.</p>
          ) : (
            <table className="media-table" style={{ width: "100%", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th>Field Slot</th>
                  <th>Original Filename</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>Uploaded By</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {claim.media.map((m) => (
                  <tr key={m.id}>
                    <td><strong>{m.fieldKey}</strong></td>
                    <td>{m.originalFilename || "—"}</td>
                    <td>{m.mimeType}</td>
                    <td>{m.sizeBytes > 0 ? `${(m.sizeBytes / (1024 * 1024)).toFixed(2)} MB` : "—"}</td>
                    <td>{m.uploadedBy}</td>
                    <td>
                      <a
                        href={`/api/claims/${claim.id}/media/${m.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn secondary small"
                      >
                        Preview / Download
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Supervisor Status Transition */}
        {canApprove && (
          <div className="panel-sub" style={{ background: "#f8fafc", padding: 14, borderRadius: 8 }}>
            <h4 style={{ margin: "0 0 10px" }}>Change Claim Lifecycle Status</h4>
            <div style={{ display: "flex", gap: 10 }}>
              <select value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
                <option value="">Select status…</option>
                {(NEXT_STATUSES[claim.status as ClaimStatus] || []).map((s) => (
                  <option key={s} value={s}>{CLAIM_STATUS_LABELS[s]}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Reason for status change (optional)"
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
                style={{ flex: 1 }}
              />
              <button className="btn primary" disabled={!newStatus || statusUpdating} onClick={updateStatus}>
                {statusUpdating ? "Updating…" : "Update"}
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
  const [query, setQuery] = useState("")
  const [loadingLookup, setLoadingLookup] = useState(false)
  const [lookupResult, setLookupResult] = useState<ClaimReturnLookup | null>(null)
  const [selectedTemplateId, setSelectedTemplateId] = useState("")
  const [selectedReason, setSelectedReason] = useState("wrong_product")
  const [claimTitle, setClaimTitle] = useState("")
  const [claimContent, setClaimContent] = useState("")
  const [remarks, setRemarks] = useState("")
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState("")

  const handleSearch = async () => {
    if (query.trim().length < 3) {
      setFormError("Enter at least 3 characters of AWB or Order ID.")
      return
    }
    setLoadingLookup(true)
    setFormError("")
    try {
      const data = await api<ClaimReturnLookup>(`/api/claims/return-lookup?query=${encodeURIComponent(query.trim())}`)
      setLookupResult(data)
      if (data.templates[0]) setSelectedTemplateId(String(data.templates[0].id))
      if (data.standardReasons[0]) {
        setSelectedReason(data.standardReasons[0].code)
        setClaimTitle(data.standardReasons[0].suggestedTitle)
        setClaimContent(data.standardReasons[0].suggestedContent)
      }
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
      setClaimContent(match.suggestedContent)
    }
  }

  const handleCreate = async () => {
    if (!lookupResult) return
    setCreating(true)
    setFormError("")
    try {
      const res = await api<{ claim: ClaimDetail; jobId: number }>("/api/claims/unified-create", {
        method: "POST",
        body: JSON.stringify({
          receiptScanId: lookupResult.scanId || undefined,
          expectedReturnId: lookupResult.expectedReturnId,
          awb: lookupResult.trackingNumber,
          orderId: lookupResult.orderId,
          packetId: lookupResult.packetId,
          customerName: lookupResult.customerName,
          totalPrice: lookupResult.totalPrice,
          shippedDate: lookupResult.shippedDate,
          sku: lookupResult.items[0]?.masterSku || lookupResult.items[0]?.sku || "",
          claimReason: lookupResult.standardReasons.find((r) => r.code === selectedReason)?.label || "Wrong Product",
          claimTitle,
          claimContent,
          claimDescription: claimContent,
          remarks,
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
        <h2>Capture Claim Evidence & Queue Automation</h2>
        <button className="btn-icon" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="modal-body" style={{ display: "grid", gap: 16 }}>
        {formError && <div className="form-error">{formError}</div>}

        {/* Search return box */}
        <div style={{ display: "flex", gap: 10 }}>
          <input
            type="search"
            placeholder="Scan or enter AWB Number, Order ID, or Packet ID…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            style={{ flex: 1 }}
          />
          <button className="btn primary" onClick={handleSearch} disabled={loadingLookup}>
            {loadingLookup ? "Searching…" : "Find Return"}
          </button>
        </div>

        {/* Return Details Card */}
        {lookupResult && (
          <div style={{ background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: 8, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <MarketplaceBadge name={lookupResult.marketplace} />
                <h3 style={{ margin: "6px 0 2px" }}>Order: {lookupResult.orderId}</h3>
                <span style={{ fontSize: 13, color: "var(--muted)" }}>AWB: {lookupResult.trackingNumber} · Customer: {lookupResult.customerName}</span>
              </div>
              <div style={{ textAlign: "right" }}>
                <span className="badge green" style={{ fontSize: 12 }}>₹{lookupResult.totalPrice}</span>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                  {lookupResult.daysSinceShipped > 0 ? `${lookupResult.daysSinceShipped} days since shipped` : lookupResult.returnStatus}
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
                </div>
              </div>
            )}

            {/* Form Inputs */}
            <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Claim Reason</label>
                <select
                  value={selectedReason}
                  onChange={(e) => handleReasonChange(e.target.value)}
                  style={{ width: "100%", marginTop: 4 }}
                >
                  {lookupResult.standardReasons.map((r) => (
                    <option key={r.code} value={r.code}>{r.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Claim Template</label>
                <select
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                  style={{ width: "100%", marginTop: 4 }}
                >
                  {lookupResult.templates.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Claim Title</label>
                <input
                  type="text"
                  value={claimTitle}
                  onChange={(e) => setClaimTitle(e.target.value)}
                  style={{ width: "100%", marginTop: 4 }}
                />
              </div>

              <div>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Claim Content / Description</label>
                <textarea
                  rows={3}
                  value={claimContent}
                  onChange={(e) => setClaimContent(e.target.value)}
                  style={{ width: "100%", marginTop: 4 }}
                />
              </div>

              <div>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Internal Remarks (Optional)</label>
                <input
                  type="text"
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Notes for warehouse or supervisor…"
                  style={{ width: "100%", marginTop: 4 }}
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
              <button className="btn secondary" onClick={onClose} disabled={creating}>Cancel</button>
              <button className="btn primary" onClick={handleCreate} disabled={creating}>
                {creating ? "Creating Claim & Queueing…" : "Create Claim & Proceed to Evidence"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

function DesktopAutomationTab() {
  const [agents, setAgents] = useState<AutomationAgent[]>([])
  const [jobs, setJobs] = useState<AutomationJob[]>([])
  const [credentials, setCredentials] = useState<MarketplaceCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedJob, setSelectedJob] = useState<AutomationJob | null>(null)

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
            <h2>Connected Windows Desktop Claim Agents</h2>
            <p>Background EXE daemons performing browser automation across warehouse terminals</p>
          </div>
          <button className="btn secondary small" onClick={loadData}>↻ Refresh</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, margin: "16px 0" }}>
          {agents.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", background: "#f8fafc", borderRadius: 8, gridColumn: "1 / -1" }}>
              <p style={{ margin: 0, color: "var(--muted)" }}>
                No desktop agents currently connected. Run <code>TaskFlowClaimAgent.exe</code> on a warehouse Windows PC.
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
            <p>Live marketplace submission tasks and execution status</p>
          </div>
        </div>

        <DataTable
          columns={[
            {
              key: "stage",
              header: "Stage",
              render: (row) => (
                <Badge tone={row.stage === "completed" ? "success" : row.stage === "failed" ? "danger" : row.stage === "prepared" ? "purple" : "blue"}>
                  {row.stage}
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
          rows={jobs}
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
