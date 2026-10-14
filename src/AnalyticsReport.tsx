import { useCallback, useEffect, useMemo, useState } from "react"
import { api, downloadFile } from "./api"
import { useLiveChanges } from "./live"
import type { AccountOption, AnalyticsReport as Report, IssueCategory } from "./types"
import { Icon } from "./ui"

// Return analytics from the stored scans (server/analytics.ts): date, marketplace, size, SKU, reason and received-issue
// figures, with filters and the weekly trend. Iron Send is shown on its own and is never counted as an issue.
//
// Colours follow the data-viz palette: slot 1 blue (units), slot 2 orange (issue units), slot 3 aqua (Iron Send). Single-
// series bars use slot 1 only. Text never takes a series colour.

const SERIES = { units: "#2a78d6", issues: "#eb6834", iron: "#1baf7a" }

function istToday(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
}

function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const PRESETS: { id: string; label: string; days: number }[] = [
  { id: "7", label: "7 days", days: 7 },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
]

const n = (value: number) => value.toLocaleString("en-IN")
const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })

function delta(current: number, previous: number): string {
  if (!previous) return current ? "new" : "—"
  const change = Math.round(((current - previous) / previous) * 1000) / 10
  return `${change >= 0 ? "▲" : "▼"} ${Math.abs(change)}%`
}

export function AnalyticsReport() {
  const today = istToday()
  const [dateFrom, setDateFrom] = useState(shiftDay(today, -29))
  const [dateTo, setDateTo] = useState(today)
  const [accountId, setAccountId] = useState("")
  const [category, setCategory] = useState("")
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [categories, setCategories] = useState<IssueCategory[]>([])
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<"charts" | "table">("charts")

  useEffect(() => {
    api<{ accounts: AccountOption[] }>("/api/accounts").then((d) => setAccounts(d.accounts)).catch(() => {})
    api<{ issueCategories: IssueCategory[] }>("/api/scan/session")
      .then((d) => setCategories(d.issueCategories.filter((c) => !c.isClear)))
      .catch(() => {})
  }, [])

  const query = useMemo(() => {
    const p = new URLSearchParams({ dateFrom, dateTo })
    if (accountId) p.set("marketplaceId", accountId)
    if (category) p.set("category", category)
    return p.toString()
  }, [dateFrom, dateTo, accountId, category])

  const load = useCallback(
    (quiet = false) => {
      if (!quiet) setLoading(true)
      return api<Report>(`/api/reports/analytics?${query}`)
        .then((data) => {
          setReport(data)
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
  useLiveChanges(() => void load(true), 1500)

  const preset = (days: number) => {
    setDateTo(today)
    setDateFrom(shiftDay(today, -(days - 1)))
  }

  const t = report?.totals
  const p = report?.previous
  return (
    <div className="analytics">
      <div className="analytics-filters card">
        <div className="analytics-presets" role="group" aria-label="Period">
          {PRESETS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={dateTo === today && dateFrom === shiftDay(today, -(item.days - 1)) ? "active" : ""}
              onClick={() => preset(item.days)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <input type="date" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} aria-label="From (IST)" />
        <span className="analytics-to">to</span>
        <input type="date" value={dateTo} min={dateFrom} max={today} onChange={(e) => setDateTo(e.target.value)} aria-label="To (IST)" />
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Marketplace">
          <option value="">All marketplaces</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Received issue">
          <option value="">Any received issue</option>
          {categories.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
              {c.isOperational ? " (operational)" : ""}
            </option>
          ))}
        </select>
        <div className="analytics-actions">
          <button type="button" className="btn" onClick={() => setView(view === "charts" ? "table" : "charts")}>
            {view === "charts" ? "Table view" : "Chart view"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              downloadFile(`/api/reports/analytics?${query}&format=csv`, `return-analytics-${dateFrom}-to-${dateTo}.csv`).catch(
                (err: Error) => setError(err.message),
              )
            }
          >
            <Icon name="file" size={16} /> Download CSV
          </button>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}
      {loading && !report && <p className="boot-copy">Loading analytics…</p>}

      {report && t && p && (
        <>
          <div className="analytics-kpis">
            <Kpi label="Returns received" value={n(t.scans)} sub={`${delta(t.scans, p.scans)} vs previous ${n(p.scans)}`} />
            <Kpi label="Units received" value={n(t.units)} sub={`${delta(t.units, p.units)} vs previous ${n(p.units)}`} />
            <Kpi
              label="Issue rate"
              value={`${t.issueRatePct}%`}
              sub={`${n(t.issueScans)} issue returns · ${n(t.issueUnits)} units`}
            />
            <Kpi label="Iron Send" value={n(t.ironUnits)} sub={`units · not an issue · ${n(report.iron.units.overdue)} overdue now`} />
            <Kpi label="SKUs returned" value={n(t.skus)} sub={`${n(t.missingUnits)} units not received`} />
          </div>

          {report.insights.length > 0 && (
            <div className="card analytics-insights">
              <strong>Insights</strong>
              <ul>
                {report.insights.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          {view === "charts" ? (
            <div className="analytics-grid">
              <section className="card analytics-card span-2">
                <header>
                  <h3>Date-wise returns</h3>
                  <Legend
                    items={[
                      { label: "Units received", color: SERIES.units },
                      { label: "Issue units", color: SERIES.issues },
                      { label: "Iron Send units", color: SERIES.iron },
                    ]}
                  />
                </header>
                <TrendChart rows={report.byDay} />
                {report.byWeek.length > 1 && (
                  <div className="analytics-weeks">
                    {report.byWeek.map((w) => (
                      <div key={w.weekStart}>
                        <small>Week of {shortDay(w.weekStart)}</small>
                        <strong>{n(w.units)} units</strong>
                        <span>
                          {w.scans ? Math.round((w.issueScans / w.scans) * 1000) / 10 : 0}% issue rate · {n(w.ironUnits)} iron
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="card analytics-card">
                <header>
                  <h3>Marketplace-wise</h3>
                  <small>units · issue rate</small>
                </header>
                <BarList
                  rows={report.byMarketplace.map((m) => ({
                    key: String(m.marketplaceId),
                    label: m.marketplace,
                    value: m.units,
                    note: `${m.issueRatePct}% issues · ${n(m.ironUnits)} iron`,
                    title: `${m.marketplace}: ${n(m.scans)} returns, ${n(m.units)} units, ${n(m.issueScans)} issue returns (${m.issueRatePct}%), ${n(m.ironUnits)} Iron Send units`,
                  }))}
                />
              </section>

              <section className="card analytics-card">
                <header>
                  <h3>Size-wise</h3>
                  <small>units received</small>
                </header>
                <SizeColumns rows={report.bySize} />
              </section>

              <section className="card analytics-card">
                <header>
                  <h3>Return reason-wise</h3>
                  <small>units</small>
                </header>
                <BarList
                  rows={report.byReason.slice(0, 10).map((r) => ({
                    key: r.reason,
                    label: r.reason,
                    value: r.units,
                    note: r.canonical || "",
                    title: `${r.reason}: ${n(r.units)} units in ${n(r.scans)} returns, ${n(r.issueUnits)} with received issues`,
                  }))}
                />
              </section>

              <section className="card analytics-card">
                <header>
                  <h3>Received issues</h3>
                  <small>units · Iron Send is shown apart</small>
                </header>
                <BarList
                  rows={report.byIssueCategory.map((c) => ({
                    key: c.code,
                    label: c.operational ? `${c.label} (operational, not an issue)` : c.label,
                    value: c.units,
                    note: `${n(c.lines)} lines`,
                    muted: c.operational,
                    title: `${c.label}: ${n(c.units)} units on ${n(c.lines)} lines${c.operational ? ". Not counted as an issue." : ""}`,
                  }))}
                  empty="No received issues in this period."
                />
              </section>

              <section className="card analytics-card span-2">
                <header>
                  <h3>SKU-wise (most returned)</h3>
                  <small>top {Math.min(25, report.bySku.length)} of {n(t.skus)}</small>
                </header>
                <SkuTable rows={report.bySku.slice(0, 25)} />
              </section>
            </div>
          ) : (
            <TableView report={report} />
          )}
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card analytics-kpi">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{sub}</small>
    </div>
  )
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="analytics-legend">
      {items.map((item) => (
        <span key={item.label}>
          <i style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  )
}

type BarRow = { key: string; label: string; value: number; note?: string; title: string; muted?: boolean }

function BarList({ rows, empty = "No returns in this period." }: { rows: BarRow[]; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  if (!rows.length) return <p className="analytics-empty">{empty}</p>
  return (
    <div className="bar-list">
      {rows.map((row) => (
        <div key={row.key} className="bar-row" title={row.title}>
          <div className="bar-label">
            <span>{row.label}</span>
            <strong>{n(row.value)}</strong>
          </div>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ width: `${Math.max(2, (row.value / max) * 100)}%`, background: row.muted ? SERIES.iron : SERIES.units }}
            />
          </div>
          {row.note && <small className="bar-note">{row.note}</small>}
        </div>
      ))}
    </div>
  )
}

function SizeColumns({ rows }: { rows: Report["bySize"] }) {
  const [hover, setHover] = useState<string | null>(null)
  const max = Math.max(1, ...rows.map((r) => r.units))
  if (!rows.length) return <p className="analytics-empty">No returns in this period.</p>
  const active = rows.find((r) => r.size === hover)
  return (
    <div className="size-columns-wrap">
      <div className="size-columns" onMouseLeave={() => setHover(null)}>
        {rows.map((row) => (
          <button
            key={row.size}
            type="button"
            className={`size-col ${hover === row.size ? "hover" : ""}`}
            onMouseEnter={() => setHover(row.size)}
            onFocus={() => setHover(row.size)}
            aria-label={`${row.size}: ${row.units} units, ${row.sharePct}%`}
          >
            <small>{row.sharePct}%</small>
            <span className="size-col-bar" style={{ height: `${Math.max(3, (row.units / max) * 100)}%`, background: SERIES.units }} />
            <strong>{row.size}</strong>
          </button>
        ))}
      </div>
      <p className="size-hover">
        {active
          ? `${active.size}: ${n(active.units)} units (${active.sharePct}%) · ${n(active.issueUnits)} issue units · ${n(active.ironUnits)} Iron Send`
          : "Hover a size for its figures."}
      </p>
    </div>
  )
}

function TrendChart({ rows }: { rows: Report["byDay"] }) {
  const [hover, setHover] = useState<number | null>(null)
  if (!rows.length) return <p className="analytics-empty">No returns in this period.</p>
  const width = 760
  const height = 220
  const pad = { l: 40, r: 12, t: 12, b: 26 }
  const max = Math.max(1, ...rows.map((r) => r.units))
  const x = (i: number) => pad.l + (rows.length === 1 ? (width - pad.l - pad.r) / 2 : (i / (rows.length - 1)) * (width - pad.l - pad.r))
  const y = (v: number) => pad.t + (1 - v / max) * (height - pad.t - pad.b)
  const line = (key: "units" | "issueUnits" | "ironUnits") => rows.map((r, i) => `${i ? "L" : "M"}${x(i)},${y(r[key])}`).join(" ")
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f))
  const labelEvery = Math.max(1, Math.ceil(rows.length / 8))
  const h = hover === null ? null : rows[hover]
  return (
    <div className="trend-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="trend-chart"
        role="img"
        aria-label="Units received, issue units and Iron Send units per day"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect()
          const px = ((event.clientX - rect.left) / rect.width) * width
          const i = Math.round(((px - pad.l) / (width - pad.l - pad.r)) * (rows.length - 1))
          setHover(Math.min(rows.length - 1, Math.max(0, i)))
        }}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.l} x2={width - pad.r} y1={y(tick)} y2={y(tick)} className="trend-grid" />
            <text x={pad.l - 6} y={y(tick) + 4} className="trend-axis" textAnchor="end">
              {n(tick)}
            </text>
          </g>
        ))}
        {rows.map((r, i) =>
          i % labelEvery === 0 || i === rows.length - 1 ? (
            <text key={r.day} x={x(i)} y={height - 6} className="trend-axis" textAnchor="middle">
              {shortDay(r.day)}
            </text>
          ) : null,
        )}
        <path d={line("units")} fill="none" stroke={SERIES.units} strokeWidth={2} strokeLinejoin="round" />
        <path d={line("issueUnits")} fill="none" stroke={SERIES.issues} strokeWidth={2} strokeLinejoin="round" />
        <path d={line("ironUnits")} fill="none" stroke={SERIES.iron} strokeWidth={2} strokeLinejoin="round" strokeDasharray="5 3" />
        {/* Point markers for short ranges, so a single day (no line to draw) is still visible. */}
        {rows.length <= 45 &&
          rows.flatMap((r, i) =>
            (["units", "issueUnits", "ironUnits"] as const).map((key) => (
              <circle
                key={`${r.day}-${key}`}
                cx={x(i)}
                cy={y(r[key])}
                r={4}
                fill={key === "units" ? SERIES.units : key === "issueUnits" ? SERIES.issues : SERIES.iron}
                stroke="#fff"
                strokeWidth={2}
              />
            )),
          )}
        {hover !== null && h && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} className="trend-cross" />
            {(["units", "issueUnits", "ironUnits"] as const).map((key) => (
              <circle
                key={key}
                cx={x(hover)}
                cy={y(h[key])}
                r={4}
                fill={key === "units" ? SERIES.units : key === "issueUnits" ? SERIES.issues : SERIES.iron}
                stroke="#fff"
                strokeWidth={2}
              />
            ))}
          </g>
        )}
      </svg>
      <p className="trend-tip" aria-live="polite">
        {h
          ? `${shortDay(h.day)}: ${n(h.scans)} returns · ${n(h.units)} units · ${n(h.issueUnits)} issue units · ${n(h.ironUnits)} Iron Send`
          : "Move over the chart to read a day."}
      </p>
    </div>
  )
}

function SkuTable({ rows }: { rows: Report["bySku"] }) {
  const max = Math.max(1, ...rows.map((r) => r.units))
  if (!rows.length) return <p className="analytics-empty">No returns in this period.</p>
  return (
    <div className="analytics-table-wrap">
      <table className="analytics-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>Size</th>
            <th className="num">Units</th>
            <th className="num">Returns</th>
            <th className="num">Issue units</th>
            <th className="num">Iron Send</th>
            <th>Top reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sku}>
              <td>
                <strong className="mono">{row.sku}</strong>
                {row.productName && <small>{row.productName}</small>}
              </td>
              <td>{row.size}</td>
              <td className="num">
                <span className="inline-bar" style={{ width: `${(row.units / max) * 60}px`, background: SERIES.units }} />
                {n(row.units)}
              </td>
              <td className="num">{n(row.scans)}</td>
              <td className="num">{n(row.issueUnits)}</td>
              <td className="num">{n(row.ironUnits)}</td>
              <td>{row.topReason || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TableView({ report }: { report: Report }) {
  return (
    <div className="analytics-grid">
      <section className="card analytics-card span-2">
        <header>
          <h3>Date-wise</h3>
        </header>
        <div className="analytics-table-wrap">
          <table className="analytics-table">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Returns</th>
                <th className="num">Units</th>
                <th className="num">Issue returns</th>
                <th className="num">Issue units</th>
                <th className="num">Iron Send</th>
              </tr>
            </thead>
            <tbody>
              {report.byDay.map((d) => (
                <tr key={d.day}>
                  <td>{shortDay(d.day)}</td>
                  <td className="num">{n(d.scans)}</td>
                  <td className="num">{n(d.units)}</td>
                  <td className="num">{n(d.issueScans)}</td>
                  <td className="num">{n(d.issueUnits)}</td>
                  <td className="num">{n(d.ironUnits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card analytics-card">
        <header>
          <h3>Marketplace-wise</h3>
        </header>
        <div className="analytics-table-wrap">
          <table className="analytics-table">
            <thead>
              <tr>
                <th>Marketplace</th>
                <th className="num">Returns</th>
                <th className="num">Units</th>
                <th className="num">Issue rate</th>
                <th className="num">Iron Send</th>
              </tr>
            </thead>
            <tbody>
              {report.byMarketplace.map((m) => (
                <tr key={m.marketplaceId}>
                  <td>{m.marketplace}</td>
                  <td className="num">{n(m.scans)}</td>
                  <td className="num">{n(m.units)}</td>
                  <td className="num">{m.issueRatePct}%</td>
                  <td className="num">{n(m.ironUnits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card analytics-card">
        <header>
          <h3>Size-wise</h3>
        </header>
        <div className="analytics-table-wrap">
          <table className="analytics-table">
            <thead>
              <tr>
                <th>Size</th>
                <th className="num">Units</th>
                <th className="num">Share</th>
                <th className="num">Issue units</th>
                <th className="num">Iron Send</th>
              </tr>
            </thead>
            <tbody>
              {report.bySize.map((s) => (
                <tr key={s.size}>
                  <td>{s.size}</td>
                  <td className="num">{n(s.units)}</td>
                  <td className="num">{s.sharePct}%</td>
                  <td className="num">{n(s.issueUnits)}</td>
                  <td className="num">{n(s.ironUnits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card analytics-card span-2">
        <header>
          <h3>Return reason-wise</h3>
        </header>
        <div className="analytics-table-wrap">
          <table className="analytics-table">
            <thead>
              <tr>
                <th>Reason</th>
                <th>Canonical</th>
                <th className="num">Units</th>
                <th className="num">Returns</th>
                <th className="num">Issue units</th>
              </tr>
            </thead>
            <tbody>
              {report.byReason.map((r) => (
                <tr key={r.reason}>
                  <td>{r.reason}</td>
                  <td>{r.canonical || "—"}</td>
                  <td className="num">{n(r.units)}</td>
                  <td className="num">{n(r.scans)}</td>
                  <td className="num">{n(r.issueUnits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card analytics-card span-2">
        <header>
          <h3>SKU-wise</h3>
        </header>
        <SkuTable rows={report.bySku} />
      </section>
    </div>
  )
}
