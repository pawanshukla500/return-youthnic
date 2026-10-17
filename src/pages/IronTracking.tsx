import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react"
import { canDispatchIron, canReceiveIron, isAdminUser } from "../access"
import { ApiError, api } from "../api"
import { DateField } from "../date-field"
import { useLiveChanges } from "../live"
import type { AccountOption, IronRecord, IronState, IronSummary } from "../types"
import { IronBatches, CreateBatchDialog } from "./IronBatches"
import { Icon, MarketplaceBadge, Modal } from "../ui"
import { useWorkspace } from "../workspace"

// Iron Send tracking. The Return Team taps "Iron Send" at the scan bench; each scanned line sent for ironing appears
// here. The Inward Team records what came back, by hand, when the ironed units return (about 2-3 days). Nothing on this
// page or on the server marks a unit received on its own. Iron Send is never a return issue and is never sent to OMSGuru.
// The Return Team groups pending lines into numbered batches for the khaata challan (src/pages/IronBatches.tsx).

type StateFilter = "open" | "unbatched" | "pending" | "overdue" | "partial" | "received" | "cancelled" | "all"

const STATE_TABS: { id: StateFilter; label: string }[] = [
  { id: "open", label: "All open" },
  { id: "unbatched", label: "Not in a batch" },
  { id: "pending", label: "Pending" },
  { id: "overdue", label: "Overdue" },
  { id: "partial", label: "Part received" },
  { id: "received", label: "Received" },
  { id: "cancelled", label: "Cancelled" },
]

const STATE_LABEL: Record<IronState, string> = {
  pending: "Pending",
  partial: "Part received",
  overdue: "Overdue",
  received: "Received",
  cancelled: "Cancelled",
}

const IST_DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
})

export function istDateTime(iso: string | null): string {
  if (!iso) return "—"
  return IST_DATE_TIME.format(new Date(iso))
}

export function imageSrc(url: string): string {
  return /^https?:\/\//i.test(url) ? `/api/catalog-image?url=${encodeURIComponent(url)}` : ""
}

export function newKey(): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `iron-${Date.now().toString(36)}-${random}`
}

export function IronTracking() {
  const { user } = useWorkspace()
  const mayReceive = canReceiveIron(user)
  const mayDispatch = canDispatchIron(user)
  const [view, setView] = useState<"lines" | "batches">(() =>
    new URLSearchParams(window.location.search).get("view") === "batches" ? "batches" : "lines",
  )
  const [creating, setCreating] = useState(false)
  const [state, setState] = useState<StateFilter>("open")
  const [accountId, setAccountId] = useState("")
  const [search, setSearch] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [rows, setRows] = useState<IronRecord[]>([])
  const [summary, setSummary] = useState<IronSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [receiving, setReceiving] = useState<IronRecord | null>(null)
  const [flash, setFlash] = useState("")
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    api<{ accounts: AccountOption[] }>("/api/accounts")
      .then((data) => setAccounts(data.accounts))
      .catch(() => setAccounts([]))
  }, [])

  const query = useMemo(() => {
    const params = new URLSearchParams({ state })
    if (accountId) params.set("marketplaceId", accountId)
    if (search.trim()) params.set("search", search.trim())
    if (dateFrom) params.set("dateFrom", dateFrom)
    if (dateTo) params.set("dateTo", dateTo)
    return params.toString()
  }, [state, accountId, search, dateFrom, dateTo])

  const load = useCallback(
    (quiet = false) => {
      if (!quiet) setLoading(true)
      return api<{ rows: IronRecord[]; summary: IronSummary }>(`/api/iron?${query}`)
        .then((data) => {
          setRows(data.rows)
          setSummary(data.summary)
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

  // Another screen or phone saved a scan or received units: reload quietly, keeping the filters.
  useLiveChanges(() => void load(true))

  const changeView = (next: "lines" | "batches") => {
    setView(next)
    const url = new URL(window.location.href)
    if (next === "batches") url.searchParams.set("view", "batches")
    else url.searchParams.delete("view")
    window.history.replaceState(null, "", url.toString())
  }

  const units = summary?.units
  const unbatched = summary?.unbatched
  return (
    <div className="page-content iron-page">
      <div className="iron-explainer">
        <Icon name="iron" size={20} />
        <div>
          <strong>Iron Send is an operational step, not a return issue.</strong>
          <span>
            It is never counted in issue reports and never sent to OMSGuru. The Return Team records it at the scan bench; the
            Inward Team records the units that come back. Nothing is marked received automatically.
          </span>
        </div>
      </div>

      <div className="iron-batch-bar">
        <div className="iron-view-switch" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={view === "lines"} className={view === "lines" ? "active" : ""} onClick={() => changeView("lines")}>
            Lines
          </button>
          <button type="button" role="tab" aria-selected={view === "batches"} className={view === "batches" ? "active" : ""} onClick={() => changeView("batches")}>
            Batches
          </button>
        </div>
        <div className="iron-batch-callout">
          <span>
            <strong>{unbatched ? unbatched.lines : "—"}</strong> line{unbatched?.lines === 1 ? "" : "s"} ·{" "}
            <strong>{unbatched ? unbatched.units : "—"}</strong> unit{unbatched?.units === 1 ? "" : "s"} not in a batch yet
          </span>
          <button
            type="button"
            className="btn primary"
            disabled={!mayDispatch || !unbatched?.lines}
            title={
              !mayDispatch
                ? "The Return Team makes batches. The Inward Team records what comes back."
                : !unbatched?.lines
                  ? "Every pending Iron Send line is already in a batch."
                  : "Group the pending lines into a numbered batch for the khaata challan"
            }
            onClick={() => setCreating(true)}
          >
            <Icon name="iron" size={16} /> Create batch
          </button>
        </div>
      </div>

      {view === "batches" ? (
        <IronBatches mayReceive={mayReceive} mayDispatch={mayDispatch} onChanged={() => void load(true)} />
      ) : (
      <>

      <div className="iron-stats">
        <button type="button" className={`iron-stat tone-pending ${state === "pending" ? "active" : ""}`} onClick={() => setState("pending")}>
          <span>Pending with ironing</span>
          <strong>{units ? units.pending.toLocaleString("en-IN") : "—"}</strong>
          <small>units · {summary ? summary.records.pending + summary.records.partial : 0} lines within {summary?.overdueAfterDays ?? 3} days</small>
        </button>
        <button type="button" className={`iron-stat tone-overdue ${state === "overdue" ? "active" : ""}`} onClick={() => setState("overdue")}>
          <span>Overdue</span>
          <strong>{units ? units.overdue.toLocaleString("en-IN") : "—"}</strong>
          <small>units · {summary?.records.overdue ?? 0} lines past their batch date (or {summary?.overdueAfterDays ?? 3} days if not batched)</small>
        </button>
        <button type="button" className={`iron-stat tone-received ${state === "received" ? "active" : ""}`} onClick={() => setState("received")}>
          <span>Received back</span>
          <strong>{units ? units.received.toLocaleString("en-IN") : "—"}</strong>
          <small>units · {summary?.receivedToday ?? 0} received today</small>
        </button>
        <div className="iron-stat tone-sent">
          <span>Sent for ironing</span>
          <strong>{units ? units.sent.toLocaleString("en-IN") : "—"}</strong>
          <small>
            units in all ·{" "}
            {isAdminUser(user) ? (
              <button type="button" className="link-button" onClick={() => setSettingsOpen(true)}>
                overdue after {summary?.overdueAfterDays ?? 3} days
              </button>
            ) : (
              <>overdue after {summary?.overdueAfterDays ?? 3} days</>
            )}
          </small>
        </div>
      </div>

      <div className="card iron-panel">
        <div className="iron-toolbar">
          <div className="iron-tabs" role="tablist">
            {STATE_TABS.map((tab) => (
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
                placeholder="AWB, order or SKU"
                aria-label="Search by AWB, order or SKU"
              />
            </label>
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)} aria-label="Account">
              <option value="">All accounts</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
            <DateField value={dateFrom} onChange={setDateFrom} label="Sent from" title="Sent from (IST)" />
            <DateField value={dateTo} onChange={setDateTo} label="Sent to" title="Sent to (IST)" />
          </div>
        </div>

        {flash && (
          <div className="iron-flash" role="status">
            <Icon name="check" size={16} /> {flash}
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        {!mayReceive && (
          <p className="iron-role-note">
            You can see Iron Send here. Only the Inward Team records ironed units as received back.
          </p>
        )}

        {loading && rows.length === 0 ? (
          <p className="iron-empty">Loading Iron Send…</p>
        ) : rows.length === 0 ? (
          <div className="iron-empty">
            <Icon name="iron" size={28} />
            <strong>Nothing here</strong>
            <span>No Iron Send matches these filters.</span>
          </div>
        ) : (
          <div className="iron-list">
            {rows.map((row) => (
              <article key={row.id} className={`iron-row state-${row.state}`}>
                <div className="iron-thumb">
                  {imageSrc(row.imageUrl) ? <img src={imageSrc(row.imageUrl)} alt="" loading="lazy" /> : <Icon name="box" size={24} />}
                </div>
                <div className="iron-main">
                  <div className="iron-sku-line">
                    <strong className="iron-sku">{row.productSku || row.marketplaceSku || "SKU not resolved"}</strong>
                    {row.size && <span className="iron-size">{row.size}</span>}
                    <span className={`iron-state state-${row.state}`}>{STATE_LABEL[row.state]}</span>
                  </div>
                  <div className="iron-meta">
                    {row.marketplace && <MarketplaceBadge name={row.marketplace} />}
                    <span>AWB {row.trackingId || "—"}</span>
                    <span>Order {row.orderId || "—"}</span>
                    {row.productSku && row.marketplaceSku && row.productSku !== row.marketplaceSku && <span>Listing {row.marketplaceSku}</span>}
                    {row.batchNo ? (
                      <span className="iron-batch-chip" title="Batch number on the khaata challan">
                        {row.batchNo}
                      </span>
                    ) : (
                      row.state !== "received" && row.state !== "cancelled" && <span className="iron-batch-chip none">Not in a batch</span>
                    )}
                    {row.dueAt && row.state !== "received" && row.state !== "cancelled" && <span>Due back {istDateTime(row.dueAt)}</span>}
                  </div>
                  <div className="iron-meta subtle">
                    <span>
                      Sent {istDateTime(row.sentAt)} by {row.sentBy || "—"} · {row.ageDays === 0 ? "today" : `${row.ageDays} day${row.ageDays === 1 ? "" : "s"} ago`}
                    </span>
                    {row.lastReceivedAt && <span>Last received {istDateTime(row.lastReceivedAt)}</span>}
                    {row.notes && <span>Note: {row.notes}</span>}
                  </div>
                </div>
                <div className="iron-qty">
                  <div>
                    <small>Sent</small>
                    <strong>{row.qtySent}</strong>
                  </div>
                  <div>
                    <small>Received</small>
                    <strong className="ok">{row.qtyReceived}</strong>
                  </div>
                  <div>
                    <small>Pending</small>
                    <strong className={row.qtyPending ? (row.state === "overdue" ? "bad" : "warn") : ""}>{row.qtyPending}</strong>
                  </div>
                </div>
                <div className="iron-action">
                  {row.state !== "received" && row.state !== "cancelled" ? (
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!mayReceive}
                      title={mayReceive ? "Record ironed units that came back" : "Only the Inward Team records ironed units as received."}
                      onClick={() => setReceiving(row)}
                    >
                      <Icon name="check" size={16} /> Receive
                    </button>
                  ) : (
                    <button type="button" className="btn" onClick={() => setReceiving(row)}>
                      History
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      </>
      )}

      {creating && (
        <CreateBatchDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            void load(true)
          }}
          onOpenBatches={() => {
            setCreating(false)
            changeView("batches")
          }}
        />
      )}
      {receiving && (
        <ReceiveDialog
          record={receiving}
          mayReceive={mayReceive}
          onClose={() => setReceiving(null)}
          onSaved={(record, qty) => {
            setReceiving(null)
            setFlash(`${qty} unit${qty === 1 ? "" : "s"} of ${record.productSku || record.marketplaceSku} received back.`)
            window.setTimeout(() => setFlash(""), 5000)
            void load(true)
          }}
        />
      )}
      {settingsOpen && summary && (
        <OverdueSettings
          current={summary.overdueAfterDays}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false)
            void load(true)
          }}
        />
      )}
    </div>
  )
}

export function ReceiveDialog({
  record,
  mayReceive,
  onClose,
  onSaved,
}: {
  record: IronRecord
  mayReceive: boolean
  onClose: () => void
  onSaved: (record: IronRecord, qty: number) => void
}) {
  const [detail, setDetail] = useState<IronRecord>(record)
  const [qty, setQty] = useState(String(record.qtyPending || ""))
  const [notes, setNotes] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  // One key per dialog: a double click or a retry after a lost reply records the entry once.
  const [clientKey] = useState(newKey)

  useEffect(() => {
    api<{ record: IronRecord }>(`/api/iron/${record.id}`)
      .then((data) => {
        setDetail(data.record)
        setQty((current) => (current === String(record.qtyPending) ? String(data.record.qtyPending || "") : current))
      })
      .catch(() => {})
  }, [record.id, record.qtyPending])

  const open = detail.state !== "received" && detail.state !== "cancelled"

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const amount = Number(qty)
    if (!Number.isInteger(amount) || amount < 1 || amount > detail.qtyPending) {
      setError(`Enter a whole number from 1 to ${detail.qtyPending}.`)
      return
    }
    setSaving(true)
    setError("")
    try {
      const result = await api<{ record: IronRecord }>(`/api/iron/${record.id}/receive`, {
        method: "POST",
        body: JSON.stringify({ qty: amount, notes: notes.trim(), clientKey }),
      })
      onSaved(result.record, amount)
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose}>
      <form className="iron-dialog" onSubmit={submit}>
        <div className="iron-dialog-head">
          <div>
            <small>{open ? "Record ironed units received back" : "Iron Send history"}</small>
            <h2>{detail.productSku || detail.marketplaceSku}</h2>
            <p>
              {detail.marketplace} · AWB {detail.trackingId} · {detail.size || "Size not known"}
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="iron-dialog-qty">
          <div>
            <small>Sent</small>
            <strong>{detail.qtySent}</strong>
          </div>
          <div>
            <small>Received</small>
            <strong>{detail.qtyReceived}</strong>
          </div>
          <div>
            <small>Pending</small>
            <strong>{detail.qtyPending}</strong>
          </div>
        </div>
        {open && (
          <>
            <label className="iron-field">
              Units received back now
              <input
                type="number"
                min={1}
                max={detail.qtyPending}
                step={1}
                value={qty}
                onChange={(event) => setQty(event.target.value)}
                disabled={!mayReceive || saving}
                autoFocus
              />
            </label>
            <label className="iron-field">
              Note (optional)
              <input
                value={notes}
                maxLength={500}
                onChange={(event) => setNotes(event.target.value)}
                disabled={!mayReceive || saving}
                placeholder="e.g. 1 unit still at the ironing unit"
              />
            </label>
          </>
        )}
        {detail.receipts.length > 0 && (
          <div className="iron-history">
            <strong>Received so far</strong>
            {detail.receipts.map((entry) => (
              <div key={entry.id}>
                <span>
                  {entry.qty} unit{entry.qty === 1 ? "" : "s"} · {istDateTime(entry.receivedAt)}
                </span>
                <span>
                  {entry.receivedBy}
                  {entry.notes ? ` · ${entry.notes}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="iron-dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          {open && (
            <button
              type="submit"
              className="btn primary"
              disabled={!mayReceive || saving}
              title={mayReceive ? "Save the received quantity" : "Only the Inward Team records ironed units as received."}
            >
              {saving ? "Saving…" : "Save received"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  )
}

function OverdueSettings({ current, onClose, onSaved }: { current: number; onClose: () => void; onSaved: () => void }) {
  const [days, setDays] = useState(String(current))
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError("")
    try {
      await api("/api/admin/iron/settings", { method: "PATCH", body: JSON.stringify({ overdueAfterDays: Number(days) }) })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save")
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal onClose={onClose}>
      <form className="iron-dialog" onSubmit={submit}>
        <div className="iron-dialog-head">
          <div>
            <small>Admin setting</small>
            <h2 className="plain">When is Iron Send overdue?</h2>
            <p>Ironed units usually come back in 2-3 days. Lines still pending after this many days are shown as overdue.</p>
          </div>
        </div>
        <label className="iron-field">
          Overdue after (days)
          <input type="number" min={1} max={30} step={1} value={days} onChange={(event) => setDays(event.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="iron-dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  )
}
