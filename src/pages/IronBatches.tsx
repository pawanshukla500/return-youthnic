import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react"
import { ApiError, api, downloadFile } from "../api"
import { DateField } from "../date-field"
import { useLiveChanges } from "../live"
import type { IronBatch, IronBatchState, IronHandoverStatus, IronRecord } from "../types"
import { Icon, Modal } from "../ui"
import { ReceiveDialog, imageSrc, istDateTime, newKey } from "./IronTracking"

// Iron Send batches. Ironing takes 2-3 days, sometimes 4-5. The Return Team groups the pending lines into a numbered
// daily batch (IRN-YYMMDD-NNN), downloads the Excel file and Batch Slip, and hands the batch over to the next team.
// Once a batch is created, Return Team processing responsibility for those tracking records is marked Completed, and
// those records move out of Pending Iron Send into this Batched section. Receiving ironed units back into inventory is
// always a manual Inward Team step and never syncs to OMSGuru (server/iron.ts).

type BatchFilter = "all" | "open" | "overdue" | "partial" | "received"
type HandoverFilter = "all" | IronHandoverStatus

const BATCH_TABS: { id: BatchFilter; label: string }[] = [
  { id: "all", label: "All batches" },
  { id: "open", label: "Out for ironing" },
  { id: "overdue", label: "Overdue" },
  { id: "partial", label: "Part received" },
  { id: "received", label: "Received back" },
]

const HANDOVER_TABS: { id: HandoverFilter; label: string }[] = [
  { id: "all", label: "All handover stages" },
  { id: "batch_created", label: "Batch Created" },
  { id: "ready_for_handover", label: "Ready for Handover" },
  { id: "handed_over", label: "Handed Over" },
]

const BATCH_STATE_LABEL: Record<IronBatchState, string> = {
  open: "Out with khaata",
  partial: "Part received",
  overdue: "Overdue",
  received: "Received",
}

// The batch state uses the same colours as the line states.
const BATCH_STATE_CLASS: Record<IronBatchState, string> = {
  open: "state-pending",
  partial: "state-partial",
  overdue: "state-overdue",
  received: "state-received",
}

export const HANDOVER_STATUS_LABEL: Record<IronHandoverStatus, string> = {
  batch_created: "Batch Created",
  ready_for_handover: "Ready for Handover",
  handed_over: "Handed Over",
}

export const HANDOVER_STATUS_CLASS: Record<IronHandoverStatus, string> = {
  batch_created: "handover-created",
  ready_for_handover: "handover-ready",
  handed_over: "handover-done",
}

function batchStateLabel(batch: IronBatch): string {
  if (batch.state === "open" && batch.location === "in_house") return "Ironing at return desk"
  return BATCH_STATE_LABEL[batch.state]
}

const DAY_CHOICES = [2, 3, 4, 5, 6, 7]
// High-running pieces ironed at the return desk come back the same or the next days.
const IN_HOUSE_DAY_CHOICES = [1, 2, 3]

/**
 * Downloads an Iron Send batch file (`xlsx`, `csv`, or `slip` HTML).
 */
export function downloadBatch(batch: IronBatch, format: "xlsx" | "csv" | "slip"): Promise<void> {
  const filename = format === "slip" ? `${batch.batchNo}-slip.html` : `${batch.batchNo}.${format}`
  return downloadFile(`/api/iron/batches/${batch.id}/download?format=${format}`, filename)
}

/**
 * Fetches the printable HTML Batch Slip for `batch` and opens it in a new browser tab, falling back to a file download if pop-ups are blocked.
 */
export async function printBatchSlip(batch: IronBatch): Promise<void> {
  const response = await fetch(`/api/iron/batches/${batch.id}/download?format=slip`, {
    credentials: "include",
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new ApiError(data?.error || "Could not load batch slip", response.status)
  }
  const html = await response.text()
  const blob = new Blob([html], { type: "text/html;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const win = window.open("about:blank", "_blank")
  if (win) {
    win.opener = null
    win.location.replace(url)
  }
  if (!win) {
    const link = document.createElement("a")
    link.href = url
    link.download = `${batch.batchNo}-slip.html`
    link.click()
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Displays the Batched section of Iron Send, including handover status KPI filters, date range filters,
 * Excel & Batch Slip downloads, and the Return Team Handover Workflow modal.
 */
export function IronBatches({
  mayReceive,
  mayDispatch,
  onChanged,
}: {
  mayReceive: boolean
  mayDispatch: boolean
  onChanged: () => void
}) {
  const [state, setState] = useState<BatchFilter>("all")
  const [handoverStatus, setHandoverStatus] = useState<HandoverFilter>("all")
  const [search, setSearch] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [batches, setBatches] = useState<IronBatch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [flash, setFlash] = useState("")
  const [openId, setOpenId] = useState<number | null>(null)

  const query = useMemo(() => {
    const params = new URLSearchParams({ state })
    if (handoverStatus !== "all") params.set("handoverStatus", handoverStatus)
    if (search.trim()) params.set("search", search.trim())
    if (dateFrom) params.set("dateFrom", dateFrom)
    if (dateTo) params.set("dateTo", dateTo)
    return params.toString()
  }, [state, handoverStatus, search, dateFrom, dateTo])

  const load = useCallback(
    (quiet = false) => {
      if (!quiet) setLoading(true)
      return api<{ batches: IronBatch[] }>(`/api/iron/batches?${query}`)
        .then((data) => {
          setBatches(data.batches)
          setError("")
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoading(false))
    },
    [query],
  )

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200)
    return () => window.clearTimeout(timer)
  }, [load])
  useLiveChanges(() => void load(true))

  const counts = useMemo(() => {
    let batchCreated = 0
    let readyForHandover = 0
    let handedOver = 0
    let totalUnits = 0
    for (const batch of batches) {
      totalUnits += batch.qtySent
      if (batch.handoverStatus === "handed_over") handedOver += 1
      else if (batch.handoverStatus === "ready_for_handover") readyForHandover += 1
      else batchCreated += 1
    }
    return { total: batches.length, batchCreated, readyForHandover, handedOver, totalUnits }
  }, [batches])

  const quickMarkReady = async (batch: IronBatch) => {
    setError("")
    try {
      await api<{ batch: IronBatch }>(`/api/iron/batches/${batch.id}/handover`, {
        method: "POST",
        body: JSON.stringify({
          handoverStatus: "ready_for_handover",
          handoverTo: batch.handoverTo || batch.khaataName || "",
          handoverNotes: batch.handoverNotes || "",
          clientKey: newKey(),
        }),
      })
      setFlash(`Batch ${batch.batchNo} marked Ready for Handover.`)
      window.setTimeout(() => setFlash(""), 4500)
      void load(true)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update handover status")
    }
  }

  return (
    <div className="iron-batches-wrap">
      <div className="iron-stats">
        <button
          type="button"
          className={`iron-stat tone-sent ${handoverStatus === "all" ? "active" : ""}`}
          onClick={() => setHandoverStatus("all")}
        >
          <span>All Created Batches</span>
          <strong>{counts.total.toLocaleString("en-IN")}</strong>
          <small>{counts.totalUnits.toLocaleString("en-IN")} total units · Return Team completed</small>
        </button>
        <button
          type="button"
          className={`iron-stat tone-pending ${handoverStatus === "batch_created" ? "active" : ""}`}
          onClick={() => setHandoverStatus("batch_created")}
        >
          <span>Batch Created</span>
          <strong>{counts.batchCreated.toLocaleString("en-IN")}</strong>
          <small>Batched &amp; removed from pending list</small>
        </button>
        <button
          type="button"
          className={`iron-stat tone-ready ${handoverStatus === "ready_for_handover" ? "active" : ""}`}
          onClick={() => setHandoverStatus("ready_for_handover")}
        >
          <span>Ready for Handover</span>
          <strong>{counts.readyForHandover.toLocaleString("en-IN")}</strong>
          <small>Slip &amp; goods staged for next team</small>
        </button>
        <button
          type="button"
          className={`iron-stat tone-received ${handoverStatus === "handed_over" ? "active" : ""}`}
          onClick={() => setHandoverStatus("handed_over")}
        >
          <span>Handed Over</span>
          <strong>{counts.handedOver.toLocaleString("en-IN")}</strong>
          <small>Transferred to next responsible team</small>
        </button>
      </div>

      <div className="card iron-panel">
        <div className="iron-toolbar">
          <div className="iron-tabs" role="tablist" aria-label="Batch inward state">
            {BATCH_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={state === tab.id}
                className={state === tab.id ? "active" : ""}
                onClick={() => setState(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="iron-filters">
            <select
              value={handoverStatus}
              onChange={(event) => setHandoverStatus(event.target.value as HandoverFilter)}
              aria-label="Handover status"
            >
              {HANDOVER_TABS.map((tab) => (
                <option key={tab.id} value={tab.id}>
                  {tab.label}
                </option>
              ))}
            </select>
            <label className="iron-search">
              <Icon name="search" size={16} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Batch ID, AWB, SKU or khaata"
                aria-label="Search by batch ID, tracking ID, SKU, khaata or challan"
              />
            </label>
            <DateField value={dateFrom} onChange={setDateFrom} label="Batch from" title="Batch creation date from (IST)" />
            <DateField value={dateTo} onChange={setDateTo} label="Batch to" title="Batch creation date to (IST)" />
          </div>
        </div>
        {flash && (
          <div className="iron-flash" role="status">
            <Icon name="check" size={16} /> {flash}
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        {loading && batches.length === 0 ? (
          <p className="iron-empty">Loading batches…</p>
        ) : batches.length === 0 ? (
          <div className="iron-empty">
            <Icon name="iron" size={28} />
            <strong>No batches match these filters</strong>
            <span>Create a daily batch from Pending Iron Send lines using “Create Daily Batch”.</span>
          </div>
        ) : (
          <div className="iron-list">
            {batches.map((batch) => {
              const trackingList = Array.isArray(batch.trackingIds) ? batch.trackingIds : []
              const shownTracking = trackingList.slice(0, 5)
              const extraTracking = Math.max(0, trackingList.length - shownTracking.length)
              return (
                <article key={batch.id} className={`iron-batch-row state-${batch.state}`}>
                  <div className="iron-batch-id">
                    <strong>{batch.batchNo}</strong>
                    <div className="iron-badge-stack">
                      <span className={`iron-handover-badge ${HANDOVER_STATUS_CLASS[batch.handoverStatus || "batch_created"]}`}>
                        {HANDOVER_STATUS_LABEL[batch.handoverStatus || "batch_created"]}
                      </span>
                      <span className="iron-return-team-badge" title="Return Team processing responsibility is completed for this batch">
                        Return Team: Completed
                      </span>
                      <span className={`iron-state ${BATCH_STATE_CLASS[batch.state]}`}>{batchStateLabel(batch)}</span>
                    </div>
                  </div>
                  <div className="iron-main">
                    <div className="iron-meta">
                      <span>
                        Date <b>{batch.batchDate || istDateTime(batch.createdAt)}</b>
                      </span>
                      {batch.location === "in_house" ? (
                        <span>
                          Ironed at <b>return desk (in-house)</b>
                        </span>
                      ) : (
                        <>
                          <span>
                            Khaata <b>{batch.khaataName}</b>
                          </span>
                          <span>
                            Challan <b>{batch.challanNo || "not entered"}</b>
                          </span>
                        </>
                      )}
                      <span>
                        <b>{batch.lines}</b> line{batch.lines === 1 ? "" : "s"} · <b>{batch.qtySent}</b> unit{batch.qtySent === 1 ? "" : "s"}
                      </span>
                    </div>

                    <div className="iron-tracking-pills" aria-label="Batch tracking IDs">
                      <span className="iron-tracking-label">
                        Tracking IDs ({trackingList.length}):
                      </span>
                      {shownTracking.length > 0 ? (
                        <>
                          {shownTracking.map((awb) => (
                            <span key={awb} className="iron-awb-pill">
                              {awb}
                            </span>
                          ))}
                          {extraTracking > 0 && (
                            <button type="button" className="iron-awb-more" onClick={() => setOpenId(batch.id)}>
                              +{extraTracking} more
                            </button>
                          )}
                        </>
                      ) : (
                        <span className="iron-awb-empty">View in batch details</span>
                      )}
                    </div>

                    <div className="iron-meta subtle">
                      <span>
                        Created {istDateTime(batch.createdAt)} by {batch.createdBy || "—"}
                      </span>
                      <span className={batch.state === "overdue" ? "iron-due-late" : ""}>
                        Due back {istDateTime(batch.expectedReturnAt)} ({batch.expectedDays}d)
                      </span>
                      {batch.readyForHandoverAt && (
                        <span>
                          Ready for handover {istDateTime(batch.readyForHandoverAt)}
                          {batch.readyForHandoverBy ? ` by ${batch.readyForHandoverBy}` : ""}
                        </span>
                      )}
                      {batch.handedOverAt && (
                        <span className="iron-handover-meta">
                          Handed over {istDateTime(batch.handedOverAt)}
                          {batch.handedOverBy ? ` by ${batch.handedOverBy}` : ""}
                          {batch.handoverTo ? ` → ${batch.handoverTo}` : ""}
                        </span>
                      )}
                      {batch.lastReceivedAt && <span>Last received {istDateTime(batch.lastReceivedAt)}</span>}
                    </div>
                  </div>
                  <div className="iron-qty">
                    <div>
                      <small>Total Qty</small>
                      <strong>{batch.qtySent}</strong>
                    </div>
                    <div>
                      <small>Received</small>
                      <strong className="ok">{batch.qtyReceived}</strong>
                    </div>
                    <div>
                      <small>Pending</small>
                      <strong className={batch.qtyPending ? (batch.state === "overdue" ? "bad" : "warn") : ""}>{batch.qtyPending}</strong>
                    </div>
                  </div>
                  <div className="iron-action iron-batch-actions">
                    <button
                      type="button"
                      className="btn"
                      title="Download Excel file (.xlsx) for this batch"
                      onClick={() => void downloadBatch(batch, "xlsx").catch((err: Error) => setError(err.message))}
                    >
                      <Icon name="file" size={16} /> Download Excel
                    </button>
                    <button
                      type="button"
                      className="btn"
                      title="Download printable Batch Slip for handover and verification"
                      onClick={() => void downloadBatch(batch, "slip").catch((err: Error) => setError(err.message))}
                    >
                      <Icon name="report" size={16} /> Batch Slip
                    </button>
                    {mayDispatch && batch.handoverStatus === "batch_created" && (
                      <button
                        type="button"
                        className="btn"
                        title="Mark this batch as Ready for Handover to the next team"
                        onClick={() => void quickMarkReady(batch)}
                      >
                        Ready for Handover
                      </button>
                    )}
                    <button type="button" className="btn primary" onClick={() => setOpenId(batch.id)}>
                      {batch.handoverStatus === "ready_for_handover" && mayDispatch ? "Hand Over / Open" : "Details & Handover"}
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
        {openId !== null && (
          <BatchDialog
            id={openId}
            mayReceive={mayReceive}
            mayDispatch={mayDispatch}
            onClose={() => setOpenId(null)}
            onChanged={() => {
              void load(true)
              onChanged()
            }}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Modal displaying full batch details, Return Team Handover Workflow controls, tracking IDs, and download actions.
 */
function BatchDialog({
  id,
  mayReceive,
  mayDispatch,
  onClose,
  onChanged,
}: {
  id: number
  mayReceive: boolean
  mayDispatch: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const [batch, setBatch] = useState<IronBatch | null>(null)
  const [rows, setRows] = useState<IronRecord[]>([])
  const [error, setError] = useState("")
  const [flash, setFlash] = useState("")
  const [challan, setChallan] = useState("")
  const [editingChallan, setEditingChallan] = useState(false)
  const [handoverTo, setHandoverTo] = useState("")
  const [handoverNotes, setHandoverNotes] = useState("")
  const [busy, setBusy] = useState(false)
  const [receiving, setReceiving] = useState<IronRecord | null>(null)
  const [receiveKey] = useState(newKey)

  const load = useCallback(() => {
    return api<{ batch: IronBatch; rows: IronRecord[] }>(`/api/iron/batches/${id}`)
      .then((data) => {
        setBatch(data.batch)
        setRows(data.rows)
        setChallan(data.batch.challanNo)
        setHandoverTo((prev) => prev || data.batch.handoverTo || data.batch.khaataName || "")
        setHandoverNotes((prev) => prev || data.batch.handoverNotes || "")
        setError("")
      })
      .catch((err: Error) => setError(err.message))
  }, [id])

  useEffect(() => {
    void load()
  }, [load])
  useLiveChanges(() => void load(), 600)

  const saveChallan = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      const result = await api<{ batch: IronBatch }>(`/api/iron/batches/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ challanNo: challan.trim() }),
      })
      setBatch(result.batch)
      setEditingChallan(false)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save")
    } finally {
      setBusy(false)
    }
  }

  const updateHandover = async (nextStatus: IronHandoverStatus) => {
    if (!batch) return
    if (nextStatus === "handed_over" && !handoverTo.trim()) {
      setError("Enter the team, person, or khaata receiving this batch before marking it Handed Over.")
      return
    }
    setBusy(true)
    setError("")
    try {
      const result = await api<{ batch: IronBatch }>(`/api/iron/batches/${id}/handover`, {
        method: "POST",
        body: JSON.stringify({
          handoverStatus: nextStatus,
          handoverTo: handoverTo.trim(),
          handoverNotes: handoverNotes.trim(),
          clientKey: newKey(),
        }),
      })
      setBatch(result.batch)
      setFlash(`Batch ${result.batch.batchNo} updated to ${HANDOVER_STATUS_LABEL[nextStatus]}.`)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update handover status")
    } finally {
      setBusy(false)
    }
  }

  const receiveAll = async () => {
    if (!batch) return
    const from = batch.location === "in_house" ? "the return desk" : batch.khaataName
    if (!window.confirm(`Record every pending unit of ${batch.batchNo} (${batch.qtyPending}) as ironed and received back from ${from}?`)) return
    setBusy(true)
    try {
      const result = await api<{ batch: IronBatch; unitsReceived: number }>(`/api/iron/batches/${id}/receive`, {
        method: "POST",
        body: JSON.stringify({ clientKey: receiveKey }),
      })
      setFlash(`${result.unitsReceived} unit${result.unitsReceived === 1 ? "" : "s"} of ${batch.batchNo} received back.`)
      await load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not receive the batch")
    } finally {
      setBusy(false)
    }
  }

  const trackingList = useMemo(() => {
    if (batch?.trackingIds?.length) return batch.trackingIds
    return [...new Set(rows.map((r) => r.trackingId).filter(Boolean))]
  }, [batch, rows])

  return (
    <Modal wide onClose={onClose}>
      <div className="iron-dialog iron-batch-dialog">
        <div className="iron-dialog-head">
          <div>
            <small>Iron Send Batch · Return Team Status: Completed</small>
            <h2>{batch?.batchNo ?? "…"}</h2>
            {batch && (
              <p>
                Batch Date <b>{batch.batchDate || istDateTime(batch.createdAt)}</b> ·{" "}
                {batch.location === "in_house" ? (
                  <>
                    Ironed at <b>return desk (in-house)</b>
                  </>
                ) : (
                  <>
                    Khaata <b>{batch.khaataName}</b>
                  </>
                )}{" "}
                · created {istDateTime(batch.createdAt)} by {batch.createdBy || "—"} · due back{" "}
                <span className={batch.state === "overdue" ? "iron-due-late" : ""}>{istDateTime(batch.expectedReturnAt)}</span>
              </p>
            )}
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        {batch && (
          <>
            <div className="iron-dialog-qty">
              <div>
                <small>Total Quantity</small>
                <strong>{batch.qtySent}</strong>
              </div>
              <div>
                <small>Received Back</small>
                <strong>{batch.qtyReceived}</strong>
              </div>
              <div>
                <small>Pending Return</small>
                <strong>{batch.qtyPending}</strong>
              </div>
            </div>

            <div className="iron-handover-panel">
              <div className="iron-handover-header">
                <div>
                  <strong>Return Team Handover Workflow</strong>
                  <span>
                    Return Team responsibility is <b>Completed</b> once batched. Track transfer of physical items to the next team.
                  </span>
                </div>
                <span className={`iron-handover-badge ${HANDOVER_STATUS_CLASS[batch.handoverStatus]}`}>
                  {HANDOVER_STATUS_LABEL[batch.handoverStatus]}
                </span>
              </div>

              <div className="iron-handover-steps">
                <div className="iron-step active">
                  <span className="iron-step-dot">1</span>
                  <div>
                    <strong>Batch Created</strong>
                    <small>
                      {istDateTime(batch.createdAt)} · {batch.createdBy || "—"}
                    </small>
                    <small className="iron-step-tag">Return Team: Completed</small>
                  </div>
                </div>
                <div
                  className={`iron-step ${
                    batch.handoverStatus === "ready_for_handover" || batch.handoverStatus === "handed_over" ? "active" : ""
                  }`}
                >
                  <span className="iron-step-dot">2</span>
                  <div>
                    <strong>Ready for Handover</strong>
                    <small>
                      {batch.readyForHandoverAt
                        ? `${istDateTime(batch.readyForHandoverAt)} · ${batch.readyForHandoverBy || "—"}`
                        : "Awaiting staging"}
                    </small>
                  </div>
                </div>
                <div className={`iron-step ${batch.handoverStatus === "handed_over" ? "active" : ""}`}>
                  <span className="iron-step-dot">3</span>
                  <div>
                    <strong>Handed Over</strong>
                    <small>
                      {batch.handedOverAt
                        ? `${istDateTime(batch.handedOverAt)} · ${batch.handedOverBy || "—"}${
                            batch.handoverTo ? ` → ${batch.handoverTo}` : ""
                          }`
                        : "Not handed over yet"}
                    </small>
                  </div>
                </div>
              </div>

              <div className="iron-handover-controls">
                <label className="iron-field">
                  Handed over to (Next Team / Person / Khaata)
                  <input
                    value={handoverTo}
                    maxLength={120}
                    disabled={!mayDispatch || busy}
                    title={!mayDispatch ? "Only the Return Team, a Supervisor, or an Admin can update handover details." : undefined}
                    placeholder="e.g. Ironing Team - Raju / Khaata Dispatch"
                    onChange={(event) => setHandoverTo(event.target.value)}
                  />
                </label>
                <label className="iron-field">
                  Handover notes (optional)
                  <input
                    value={handoverNotes}
                    maxLength={500}
                    disabled={!mayDispatch || busy}
                    title={!mayDispatch ? "Only the Return Team, a Supervisor, or an Admin can update handover details." : undefined}
                    placeholder="e.g. Verified 12 pieces with printed batch slip"
                    onChange={(event) => setHandoverNotes(event.target.value)}
                  />
                </label>
                <div className="iron-handover-buttons">
                  {batch.handoverStatus === "batch_created" && (
                    <button
                      type="button"
                      className="btn"
                      disabled={!mayDispatch || busy}
                      title={!mayDispatch ? "Only the Return Team, a Supervisor, or an Admin can update handover details." : undefined}
                      onClick={() => void updateHandover("ready_for_handover")}
                    >
                      Mark Ready for Handover
                    </button>
                  )}
                  {batch.handoverStatus !== "handed_over" ? (
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!mayDispatch || busy}
                      title={!mayDispatch ? "Only the Return Team, a Supervisor, or an Admin can update handover details." : undefined}
                      onClick={() => void updateHandover("handed_over")}
                    >
                      <Icon name="check" size={16} /> Confirm Handed Over
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={!mayDispatch || busy}
                      title={!mayDispatch ? "Only the Return Team, a Supervisor, or an Admin can update handover details." : undefined}
                      onClick={() => void updateHandover("handed_over")}
                    >
                      Update Handover Details
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="iron-tracking-summary">
              <strong>Tracking IDs in Batch ({trackingList.length})</strong>
              <div className="iron-tracking-pills">
                {trackingList.length > 0 ? (
                  trackingList.map((awb) => (
                    <span key={awb} className="iron-awb-pill">
                      {awb}
                    </span>
                  ))
                ) : (
                  <span className="iron-awb-empty">No tracking IDs recorded</span>
                )}
              </div>
            </div>

            {batch.location === "khaata" && (
              <form className="iron-challan" onSubmit={saveChallan}>
                <span>Khaata challan no.</span>
                {editingChallan ? (
                  <>
                    <input value={challan} maxLength={120} onChange={(event) => setChallan(event.target.value)} autoFocus />
                    <button type="submit" className="btn primary" disabled={busy}>
                      Save
                    </button>
                  </>
                ) : (
                  <>
                    <b>{batch.challanNo || "not entered"}</b>
                    <button
                      type="button"
                      className="btn"
                      disabled={!mayDispatch}
                      title={mayDispatch ? "Enter or correct the khaata challan number" : "The Return Team enters the challan number."}
                      onClick={() => setEditingChallan(true)}
                    >
                      {batch.challanNo ? "Change" : "Add"}
                    </button>
                  </>
                )}
              </form>
            )}
          </>
        )}
        {flash && (
          <div className="iron-flash" role="status">
            <Icon name="check" size={16} /> {flash}
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="iron-batch-lines">
          {rows.map((row, index) => (
            <div key={row.id} className={`iron-batch-line state-${row.state}`}>
              <span className="iron-batch-line-no">{index + 1}</span>
              <div className="iron-thumb small">
                {imageSrc(row.imageUrl) ? <img src={imageSrc(row.imageUrl)} alt="" loading="lazy" /> : <Icon name="box" size={18} />}
              </div>
              <div className="iron-main">
                <div className="iron-sku-line">
                  <strong className="iron-sku">{row.productSku || row.marketplaceSku || "SKU not resolved"}</strong>
                  {row.size && <span className="iron-size">{row.size}</span>}
                </div>
                <div className="iron-meta subtle">
                  <span>{row.marketplace}</span>
                  <span>AWB {row.trackingId}</span>
                  {row.orderId && <span>Order {row.orderId}</span>}
                </div>
              </div>
              <span className="iron-batch-line-qty">
                {row.qtyReceived}/{row.qtySent}
              </span>
              {row.qtyPending > 0 ? (
                <button
                  type="button"
                  className="btn"
                  disabled={!mayReceive}
                  title={mayReceive ? "Record part of this line as received back" : "Only the Inward Team records ironed units as received."}
                  onClick={() => setReceiving(row)}
                >
                  Receive
                </button>
              ) : (
                <span className="iron-state state-received">Received</span>
              )}
            </div>
          ))}
        </div>
        <div className="iron-dialog-actions">
          {batch && (
            <>
              <button type="button" className="btn" onClick={() => void downloadBatch(batch, "csv").catch((err: Error) => setError(err.message))}>
                CSV
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void downloadBatch(batch, "slip").catch((err: Error) => setError(err.message))}
              >
                <Icon name="report" size={16} /> Download Batch Slip
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void printBatchSlip(batch).catch((err: Error) => setError(err.message))}
              >
                Print Slip
              </button>
              <button type="button" className="btn" onClick={() => void downloadBatch(batch, "xlsx").catch((err: Error) => setError(err.message))}>
                <Icon name="file" size={16} /> Download Excel File
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!mayReceive || busy || batch.qtyPending === 0}
                title={
                  !mayReceive
                    ? "Only the Inward Team records ironed units as received."
                    : batch.qtyPending === 0
                      ? "Every unit of this batch is already received."
                      : "Record every pending unit of this batch as received back"
                }
                onClick={() => void receiveAll()}
              >
                <Icon name="check" size={16} /> Receive whole batch
              </button>
            </>
          )}
        </div>
      </div>
      {receiving && (
        <ReceiveDialog
          record={receiving}
          mayReceive={mayReceive}
          onClose={() => setReceiving(null)}
          onSaved={(record, qty) => {
            setReceiving(null)
            setFlash(`${qty} unit${qty === 1 ? "" : "s"} of ${record.productSku || record.marketplaceSku} received back.`)
            void load()
            onChanged()
          }}
        />
      )}
    </Modal>
  )
}

/**
 * Modal for selecting pending unbatched Iron Send tracking records and creating a daily batch.
 */
export function CreateBatchDialog({
  onClose,
  onCreated,
  onOpenBatches,
}: {
  onClose: () => void
  onCreated: (batch: IronBatch) => void
  onOpenBatches: () => void
}) {
  const [lines, setLines] = useState<IronRecord[]>([])
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [location, setLocation] = useState<IronBatch["location"]>("khaata")
  const [pickSearch, setPickSearch] = useState("")
  const [khaatas, setKhaatas] = useState<string[]>([])
  const [khaata, setKhaata] = useState("")
  const [challan, setChallan] = useState("")
  const [days, setDays] = useState("3")
  const [notes, setNotes] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [made, setMade] = useState<IronBatch | null>(null)
  const [clientKey] = useState(newKey)

  useEffect(() => {
    api<{ rows: IronRecord[] }>("/api/iron?state=unbatched")
      .then((data) => {
        setLines(data.rows)
        setChosen(new Set(data.rows.map((row) => row.id)))
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
    // Earlier khaata names, so the same unit is typed the same way every time.
    api<{ batches: IronBatch[] }>("/api/iron/batches?state=all")
      .then((data) => setKhaatas([...new Set(data.batches.map((batch) => batch.khaataName).filter(Boolean))]))
      .catch(() => {})
  }, [])

  const chosenLines = lines.filter((line) => chosen.has(line.id))
  const units = chosenLines.reduce((sum, line) => sum + line.qtySent, 0)
  const inHouse = location === "in_house"
  const pickTerm = pickSearch.trim().toUpperCase()
  const shownLines = pickTerm
    ? lines.filter((line) =>
        [line.productSku, line.marketplaceSku, line.productName, line.trackingId].some((value) => (value || "").toUpperCase().includes(pickTerm)),
      )
    : lines

  const chooseLocation = (next: IronBatch["location"]) => {
    setLocation(next)
    setError("")
    if (next === "in_house") {
      // High-running pieces are picked one by one, so start with nothing ticked.
      setChosen(new Set())
      setDays("1")
    } else {
      setChosen(new Set(lines.map((line) => line.id)))
      setDays("3")
    }
  }

  const toggle = (id: number) =>
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!inHouse && !khaata.trim()) {
      setError("Enter the khaata (ironing unit) the batch goes to.")
      return
    }
    if (!chosenLines.length) {
      setError("Choose at least one line.")
      return
    }
    setSaving(true)
    setError("")
    try {
      const result = await api<{ batch: IronBatch }>("/api/iron/batches", {
        method: "POST",
        body: JSON.stringify({
          recordIds: chosenLines.map((line) => line.id),
          location,
          khaataName: inHouse ? "" : khaata.trim(),
          challanNo: inHouse ? "" : challan.trim(),
          expectedDays: Number(days),
          notes: notes.trim(),
          clientKey,
        }),
      })
      setMade(result.batch)
      onCreated(result.batch)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not make the batch")
    } finally {
      setSaving(false)
    }
  }

  if (made) {
    return (
      <Modal onClose={onClose}>
        <div className="iron-dialog iron-batch-made">
          <small>
            {made.location === "in_house"
              ? "Daily batch created · Return Team status: Completed"
              : "Daily batch created · Return Team status: Completed"}
          </small>
          <strong className="iron-batch-big">{made.batchNo}</strong>
          <p>
            {made.lines} line{made.lines === 1 ? "" : "s"} · {made.qtySent} unit{made.qtySent === 1 ? "" : "s"} removed from Pending and moved to{" "}
            <b>Batched</b> · {made.location === "in_house" ? "at" : "to"}{" "}
            <b>{made.location === "in_house" ? "the return desk" : made.khaataName}</b>
            {made.challanNo ? ` · challan ${made.challanNo}` : ""} · due back {istDateTime(made.expectedReturnAt)}
          </p>
          {error && <div className="form-error">{error}</div>}
          <div className="iron-dialog-actions">
            <button type="button" className="btn" onClick={() => void downloadBatch(made, "slip").catch((err: Error) => setError(err.message))}>
              <Icon name="report" size={16} /> Download Batch Slip
            </button>
            <button type="button" className="btn" onClick={() => void printBatchSlip(made).catch((err: Error) => setError(err.message))}>
              Print Slip
            </button>
            <button type="button" className="btn primary" onClick={() => void downloadBatch(made, "xlsx").catch((err: Error) => setError(err.message))}>
              <Icon name="file" size={16} /> Download Excel File
            </button>
            <button type="button" className="btn" onClick={onOpenBatches}>
              Open Batched section
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal wide onClose={onClose}>
      <form className="iron-dialog iron-batch-dialog" onSubmit={submit}>
        <div className="iron-dialog-head">
          <div>
            <small>Create Daily Iron Send Batch</small>
            <h2 className="plain">{inHouse ? "Iron high-running pieces at the return desk" : "Send pending lines to the khaata"}</h2>
            <p>
              {inHouse
                ? "Tick the pieces you will iron here. Once batched, they leave Pending Iron Send, move to Batched, and Return Team responsibility is marked Completed."
                : "Only unbatched pending tracking records appear below. Once batched, they automatically move to the Batched section for slip download and team handover."}
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="iron-tabs" role="tablist" aria-label="Where will it be ironed?">
          <button type="button" role="tab" aria-selected={!inHouse} className={!inHouse ? "active" : ""} onClick={() => chooseLocation("khaata")}>
            Send to khaata
          </button>
          <button type="button" role="tab" aria-selected={inHouse} className={inHouse ? "active" : ""} onClick={() => chooseLocation("in_house")}>
            Iron at return desk (high-running)
          </button>
        </div>
        <div className="iron-batch-form">
          {!inHouse && (
            <>
              <label className="iron-field">
                Khaata (ironing unit)
                <input value={khaata} maxLength={120} list="iron-khaatas" onChange={(event) => setKhaata(event.target.value)} autoFocus required />
                <datalist id="iron-khaatas">
                  {khaatas.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </label>
              <label className="iron-field">
                Khaata challan no. (optional, can be added later)
                <input value={challan} maxLength={120} onChange={(event) => setChallan(event.target.value)} />
              </label>
            </>
          )}
          <label className="iron-field">
            {inHouse ? "Ironing done in" : "Expected back in"}
            <select value={days} onChange={(event) => setDays(event.target.value)}>
              {(inHouse ? IN_HOUSE_DAY_CHOICES : DAY_CHOICES).map((choice) => (
                <option key={choice} value={choice}>
                  {choice} day{choice === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </label>
          <label className="iron-field">
            Note (optional)
            <input value={notes} maxLength={500} onChange={(event) => setNotes(event.target.value)} />
          </label>
        </div>
        <div className="iron-batch-pick-head">
          <strong>
            {chosenLines.length} of {lines.length} lines · {units} units
          </strong>
          <label className="iron-search">
            <Icon name="search" size={16} />
            <input
              value={pickSearch}
              onChange={(event) => setPickSearch(event.target.value)}
              placeholder="Find SKU or AWB"
              aria-label="Find pending lines by SKU, product or AWB"
            />
          </label>
          <span>
            <button
              type="button"
              className="link-button"
              onClick={() => setChosen((current) => new Set([...current, ...shownLines.map((line) => line.id)]))}
            >
              {pickTerm ? "Tick shown" : "Tick all"}
            </button>{" "}
            ·{" "}
            <button type="button" className="link-button" onClick={() => setChosen(new Set())}>
              Untick all
            </button>
          </span>
        </div>
        <div className="iron-batch-lines">
          {loading ? (
            <p className="iron-empty">Loading pending lines…</p>
          ) : lines.length === 0 ? (
            <p className="iron-empty">Every pending Iron Send line is already in a batch.</p>
          ) : shownLines.length === 0 ? (
            <p className="iron-empty">No pending line matches “{pickSearch.trim()}”.</p>
          ) : (
            shownLines.map((line) => (
              <label key={line.id} className="iron-batch-line pick">
                <input type="checkbox" checked={chosen.has(line.id)} onChange={() => toggle(line.id)} />
                <div className="iron-thumb small">
                  {imageSrc(line.imageUrl) ? <img src={imageSrc(line.imageUrl)} alt="" loading="lazy" /> : <Icon name="box" size={18} />}
                </div>
                <div className="iron-main">
                  <div className="iron-sku-line">
                    <strong className="iron-sku">{line.productSku || line.marketplaceSku || "SKU not resolved"}</strong>
                    {line.size && <span className="iron-size">{line.size}</span>}
                  </div>
                  <div className="iron-meta subtle">
                    <span>{line.marketplace}</span>
                    <span>AWB {line.trackingId}</span>
                    <span>Sent {istDateTime(line.sentAt)}</span>
                  </div>
                </div>
                <span className="iron-batch-line-qty">{line.qtySent}</span>
              </label>
            ))
          )}
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="iron-dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving || !chosenLines.length}>
            {saving ? "Making batch…" : inHouse ? `Iron at return desk (${units} units)` : `Create batch (${units} units)`}
          </button>
        </div>
      </form>
    </Modal>
  )
}

