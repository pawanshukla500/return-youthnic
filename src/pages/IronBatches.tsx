import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react"
import { api, downloadFile } from "../api"
import { useLiveChanges } from "../live"
import type { IronBatch, IronBatchState, IronRecord } from "../types"
import { Icon, Modal } from "../ui"
import { ReceiveDialog, imageSrc, istDateTime, newKey } from "./IronTracking"

// Iron Send batches. Ironing takes 2-3 days, sometimes 4-5. The Return Team groups the pending lines into a numbered
// batch (IRN-YYMMDD-NNN), downloads the sheet, and writes the batch number on the khaata challan that goes with the goods.
// The outward and inward teams then track the batch until every unit is back. Receiving is always a manual Inward Team
// step (server/iron.ts).

type BatchFilter = "open" | "overdue" | "partial" | "received" | "all"

const BATCH_TABS: { id: BatchFilter; label: string }[] = [
  { id: "open", label: "Out with khaata" },
  { id: "overdue", label: "Overdue" },
  { id: "partial", label: "Part received" },
  { id: "received", label: "Received" },
  { id: "all", label: "All" },
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

const DAY_CHOICES = [2, 3, 4, 5, 6, 7]

function downloadBatch(batch: IronBatch, format: "xlsx" | "csv"): Promise<void> {
  return downloadFile(`/api/iron/batches/${batch.id}/download?format=${format}`, `${batch.batchNo}.${format}`)
}

export function IronBatches({
  mayReceive,
  mayDispatch,
  onChanged,
}: {
  mayReceive: boolean
  mayDispatch: boolean
  onChanged: () => void
}) {
  const [state, setState] = useState<BatchFilter>("open")
  const [search, setSearch] = useState("")
  const [batches, setBatches] = useState<IronBatch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [openId, setOpenId] = useState<number | null>(null)

  const query = useMemo(() => {
    const params = new URLSearchParams({ state })
    if (search.trim()) params.set("search", search.trim())
    return params.toString()
  }, [state, search])

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

  return (
    <div className="card iron-panel">
      <div className="iron-toolbar">
        <div className="iron-tabs" role="tablist">
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
          <label className="iron-search">
            <Icon name="search" size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Batch, khaata or challan"
              aria-label="Search by batch number, khaata or challan number"
            />
          </label>
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
      {loading && batches.length === 0 ? (
        <p className="iron-empty">Loading batches…</p>
      ) : batches.length === 0 ? (
        <div className="iron-empty">
          <Icon name="iron" size={28} />
          <strong>No batches here</strong>
          <span>Make a batch from the pending Iron Send lines with “Create batch”.</span>
        </div>
      ) : (
        <div className="iron-list">
          {batches.map((batch) => (
            <article key={batch.id} className={`iron-batch-row state-${batch.state}`}>
              <div className="iron-batch-id">
                <strong>{batch.batchNo}</strong>
                <span className={`iron-state ${BATCH_STATE_CLASS[batch.state]}`}>{BATCH_STATE_LABEL[batch.state]}</span>
              </div>
              <div className="iron-main">
                <div className="iron-meta">
                  <span>
                    Khaata <b>{batch.khaataName}</b>
                  </span>
                  <span>
                    Challan <b>{batch.challanNo || "not entered"}</b>
                  </span>
                  <span>{batch.lines} line{batch.lines === 1 ? "" : "s"}</span>
                </div>
                <div className="iron-meta subtle">
                  <span>
                    Sent {istDateTime(batch.createdAt)} by {batch.createdBy || "—"}
                  </span>
                  <span className={batch.state === "overdue" ? "iron-due-late" : ""}>
                    Due back {istDateTime(batch.expectedReturnAt)} ({batch.expectedDays} days)
                  </span>
                  {batch.lastReceivedAt && <span>Last received {istDateTime(batch.lastReceivedAt)}</span>}
                </div>
              </div>
              <div className="iron-qty">
                <div>
                  <small>Sent</small>
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
                <button type="button" className="btn primary" onClick={() => setOpenId(batch.id)}>
                  Open
                </button>
                <button
                  type="button"
                  className="btn"
                  title="Download the batch sheet (Excel) for the khaata challan"
                  onClick={() => void downloadBatch(batch, "xlsx").catch((err: Error) => setError(err.message))}
                >
                  <Icon name="file" size={16} /> Excel
                </button>
              </div>
            </article>
          ))}
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
  )
}

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
  const [busy, setBusy] = useState(false)
  const [receiving, setReceiving] = useState<IronRecord | null>(null)
  const [receiveKey] = useState(newKey)

  const load = useCallback(() => {
    return api<{ batch: IronBatch; rows: IronRecord[] }>(`/api/iron/batches/${id}`)
      .then((data) => {
        setBatch(data.batch)
        setRows(data.rows)
        setChallan(data.batch.challanNo)
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

  const receiveAll = async () => {
    if (!batch) return
    if (!window.confirm(`Record every pending unit of ${batch.batchNo} (${batch.qtyPending}) as received back from ${batch.khaataName}?`)) return
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

  return (
    <Modal wide onClose={onClose}>
      <div className="iron-dialog iron-batch-dialog">
        <div className="iron-dialog-head">
          <div>
            <small>Iron Send batch</small>
            <h2>{batch?.batchNo ?? "…"}</h2>
            {batch && (
              <p>
                Khaata <b>{batch.khaataName}</b> · sent {istDateTime(batch.createdAt)} by {batch.createdBy || "—"} · due back{" "}
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
                <small>Sent</small>
                <strong>{batch.qtySent}</strong>
              </div>
              <div>
                <small>Received</small>
                <strong>{batch.qtyReceived}</strong>
              </div>
              <div>
                <small>Pending</small>
                <strong>{batch.qtyPending}</strong>
              </div>
            </div>
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
              <button type="button" className="btn" onClick={() => void downloadBatch(batch, "xlsx").catch((err: Error) => setError(err.message))}>
                <Icon name="file" size={16} /> Download Excel
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

  const toggle = (id: number) =>
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!khaata.trim()) {
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
          khaataName: khaata.trim(),
          challanNo: challan.trim(),
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
          <small>Batch made · write this number on the khaata challan</small>
          <strong className="iron-batch-big">{made.batchNo}</strong>
          <p>
            {made.lines} line{made.lines === 1 ? "" : "s"} · {made.qtySent} unit{made.qtySent === 1 ? "" : "s"} to <b>{made.khaataName}</b>
            {made.challanNo ? ` · challan ${made.challanNo}` : ""} · due back {istDateTime(made.expectedReturnAt)}
          </p>
          {error && <div className="form-error">{error}</div>}
          <div className="iron-dialog-actions">
            <button type="button" className="btn" onClick={() => void downloadBatch(made, "csv").catch((err: Error) => setError(err.message))}>
              CSV
            </button>
            <button type="button" className="btn primary" onClick={() => void downloadBatch(made, "xlsx").catch((err: Error) => setError(err.message))}>
              <Icon name="file" size={16} /> Download Excel
            </button>
            <button type="button" className="btn" onClick={onOpenBatches}>
              Go to batches
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
            <small>Create Iron Send batch</small>
            <h2 className="plain">Send pending lines to the khaata</h2>
            <p>Every line not yet in a batch is ticked. Untick what is not going out now. The batch number goes on the khaata challan.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="iron-batch-form">
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
          <label className="iron-field">
            Expected back in
            <select value={days} onChange={(event) => setDays(event.target.value)}>
              {DAY_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {choice} days
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
          <span>
            <button type="button" className="link-button" onClick={() => setChosen(new Set(lines.map((line) => line.id)))}>
              Tick all
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
          ) : (
            lines.map((line) => (
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
            {saving ? "Making batch…" : `Create batch (${units} units)`}
          </button>
        </div>
      </form>
    </Modal>
  )
}
