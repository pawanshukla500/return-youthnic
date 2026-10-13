import { useEffect, useState } from "react"
import { api } from "../api"
import { Loading, PageError } from "../shell"
import { ReturnsTable } from "../returns-table"
import type { ReturnRow, Stat, WarehouseOperations } from "../types"
import { Badge, Icon, StatCard } from "../ui"
import { useWorkspace } from "../workspace"

type MarketSlice = { name: string; count: string; pct: string; share: number }

type DashboardData = {
  stats: Stat[]
  dailyAvg: string
  chartBars: { weekday: string; d: string; received: number; issues: number; v: number; i: number }[]
  reasons: { name: string; count: string; width: number }[]
  marketIssues: { total: string; subtitle: string; slices: MarketSlice[] }
  skus: { sku: string; name: string; issues: string; rate: string }[]
  recent: ReturnRow[]
  operations?: WarehouseOperations
}

const SLICE_COLORS = ["#136c57", "#487cb3", "#d88354", "#815ea8", "#9ba8a4", "#c34e4e"]

function donutBackground(slices: MarketSlice[]) {
  if (slices.length === 0) return "#e7eeeb"
  let cursor = 0
  const stops = slices.map((slice, index) => {
    const start = cursor
    cursor += slice.share
    return `${SLICE_COLORS[index % SLICE_COLORS.length]} ${start}% ${cursor}%`
  })
  return `conic-gradient(${stops.join(", ")})`
}

export function Dashboard() {
  const { openPage } = useWorkspace()
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    api<DashboardData>("/api/dashboard").then(setData).catch((err: Error) => setError(err.message))
  }, [])

  if (error) return <PageError message={error} />
  if (!data) return <Loading label="Loading overview…" />

  const ops = data.operations
  const maxHourly = Math.max(
    1,
    ...(ops?.hourlyThroughput.map((h) => Math.max(h.shipments, h.items_qty)) || [1]),
  )

  return (
    <div className="page-content">
      {/* Top Headline Stats */}
      <section className="stats-grid">
        {data.stats.map((stat) => (
          <StatCard key={stat.label} {...stat} />
        ))}
      </section>

      {/* Warehouse Operational Real-Time Counters */}
      {ops && (
        <section className="ops-banner">
          <div className="ops-pill">
            <span>Items Scanned Today</span>
            <strong>{ops.scanned_qty_today.toLocaleString()}</strong>
            <small>{ops.scanned_shipments_today.toLocaleString()} shipments today</small>
          </div>
          <div className="ops-pill">
            <span>Clear Returns</span>
            <strong>{ops.clear_today.toLocaleString()}</strong>
            <small>{ops.clear_total.toLocaleString()} all-time clear</small>
          </div>
          <div className="ops-pill">
            <span>Returns With Issues</span>
            <strong>{ops.issues_today.toLocaleString()}</strong>
            <small>{ops.issues_total.toLocaleString()} all-time issues</small>
          </div>
          <div className="ops-pill">
            <span>Duplicate Scan Attempts</span>
            <strong>{ops.duplicate_attempts_today.toLocaleString()}</strong>
            <small>Identified & prevented</small>
          </div>
          <div className="ops-pill">
            <span>Unmatched AWBs</span>
            <strong>{ops.unmatched_awbs_today.toLocaleString()}</strong>
            <small>Audited lookup misses</small>
          </div>
          <div className="ops-pill">
            <span>Pending Validation</span>
            <strong>{ops.pending_validation_rows.toLocaleString()}</strong>
            <small>Upload rows awaiting review</small>
          </div>
        </section>
      )}

      {/* Hourly Scanning Throughput Today */}
      {ops && (
        <section className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head">
            <div>
              <h2>Hourly Scanning Throughput (Today, IST)</h2>
              <p>Real-time physical scan throughput across 24-hour Asia/Kolkata day boundaries</p>
            </div>
            <span className="filter-button">Asia/Kolkata</span>
          </div>
          <div className="hourly-chart">
            {ops.hourlyThroughput.map((h) => {
              const heightPct = Math.round((Math.max(h.shipments, h.items_qty) / maxHourly) * 100)
              const hasActivity = h.shipments > 0 || h.items_qty > 0
              return (
                <div className="hourly-group" key={h.hour}>
                  <div className="hourly-bars">
                    <i
                      className={hasActivity ? "hourly-bar" : "hourly-bar empty"}
                      style={{ height: hasActivity ? `${Math.max(6, heightPct)}%` : "0%" }}
                      title={`${h.label}: ${h.items_qty} items (${h.shipments} shipments)`}
                    />
                  </div>
                  <strong>{hasActivity ? h.items_qty : "—"}</strong>
                  <span>{h.label}</span>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Operator & Marketplace Performance Breakdown */}
      {ops && (
        <section className="dashboard-grid lower" style={{ marginTop: 14 }}>
          <article className="panel ops-table-card">
            <div className="panel-head">
              <div>
                <h2>Operator Performance (Today)</h2>
                <p>Physical parcel and SKU processing breakdown by warehouse operator</p>
              </div>
            </div>
            {ops.operators.length === 0 ? (
              <p className="dash-empty">No operator scans recorded today yet.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Operator</th>
                      <th>Shipments</th>
                      <th>Items Qty</th>
                      <th>Clear</th>
                      <th>Issues</th>
                      <th>Clear Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ops.operators.map((op) => (
                      <tr key={op.operator_id}>
                        <td>
                          <strong>{op.operator_name}</strong>
                        </td>
                        <td>{op.shipments_count.toLocaleString()}</td>
                        <td>
                          <strong>{op.items_qty.toLocaleString()}</strong>
                        </td>
                        <td style={{ color: "var(--green)" }}>{op.clear_count}</td>
                        <td style={{ color: "var(--red)" }}>{op.issue_count}</td>
                        <td>
                          <Badge tone={Number(op.clear_rate.replace("%", "")) >= 80 ? "success" : "warning"}>
                            {op.clear_rate}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>

          <article className="panel ops-table-card">
            <div className="panel-head">
              <div>
                <h2>Marketplace Processing (Today)</h2>
                <p>Today's returns processed by marketplace account</p>
              </div>
            </div>
            {ops.marketplaces.length === 0 ? (
              <p className="dash-empty">No marketplace returns processed today yet.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Marketplace</th>
                      <th>Shipments</th>
                      <th>Items Qty</th>
                      <th>Clear</th>
                      <th>Issues</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ops.marketplaces.map((m) => (
                      <tr key={m.marketplace_id}>
                        <td>
                          <strong>{m.marketplace_name}</strong>
                        </td>
                        <td>{m.shipments_count.toLocaleString()}</td>
                        <td>
                          <strong>{m.items_qty.toLocaleString()}</strong>
                        </td>
                        <td style={{ color: "var(--green)" }}>{m.clear_count}</td>
                        <td style={{ color: "var(--red)" }}>{m.issue_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        </section>
      )}

      {/* 7-Day Volume and Reasons */}
      <section className="dashboard-grid">
        <article className="panel volume-panel">
          <div className="panel-head">
            <div>
              <h2>Return volume</h2>
              <p>Received vs issue returns over the last 7 days</p>
            </div>
            <span className="filter-button">Last 7 days</span>
          </div>
          <div className="legend">
            <span>
              <i className="dot received" />
              Received
            </span>
            <span>
              <i className="dot issues" />
              Issues
            </span>
            <strong>
              Daily avg. <b>{data.dailyAvg}</b>
            </strong>
          </div>
          <div className="bar-chart">
            {data.chartBars.map((bar) => (
              <div className="bar-group" key={`${bar.weekday}-${bar.d}`}>
                <div className="bars">
                  <i
                    className={bar.received ? "bar received" : "bar received empty"}
                    style={{ height: bar.received ? `${bar.v}%` : "0" }}
                    title={`${bar.received} received`}
                  />
                  <i
                    className={bar.issues ? "bar issues" : "bar issues empty"}
                    style={{ height: bar.issues ? `${bar.i}%` : "0" }}
                    title={`${bar.issues} issues`}
                  />
                </div>
                <strong>{bar.received}</strong>
                <span>
                  {bar.weekday} {bar.d}
                </span>
              </div>
            ))}
          </div>
        </article>

        <article className="panel reason-panel">
          <div className="panel-head">
            <div>
              <h2>Top return reasons</h2>
              <p>All scanned issue returns</p>
            </div>
            <button className="text-button" onClick={() => openPage("reports")}>
              View report <Icon name="arrow" size={15} />
            </button>
          </div>
          {data.reasons.length === 0 && <p className="dash-empty">No issue returns scanned yet.</p>}
          {data.reasons.map((reason, index) => (
            <div className="reason-row" key={reason.name}>
              <span className="rank">{index + 1}</span>
              <div>
                <p>
                  <span>{reason.name}</span>
                  <strong>{reason.count}</strong>
                </p>
                <i>
                  <b style={{ width: `${reason.width}%` }} />
                </i>
              </div>
            </div>
          ))}
        </article>
      </section>

      {/* Issues by Marketplace and High-Risk SKUs */}
      <section className="dashboard-grid lower">
        <article className="panel">
          <div className="panel-head">
            <div>
              <h2>Issues by marketplace</h2>
              <p>{data.marketIssues.subtitle}</p>
            </div>
          </div>
          {data.marketIssues.slices.length === 0 ? (
            <p className="dash-empty">No issue returns in the accounts you can see.</p>
          ) : (
            <div className="market-chart">
              <div className="donut" style={{ background: donutBackground(data.marketIssues.slices) }}>
                <div>
                  <strong>{data.marketIssues.total}</strong>
                  <span>Total issues</span>
                </div>
              </div>
              <div className="market-legend">
                {data.marketIssues.slices.map((slice, index) => (
                  <div key={slice.name}>
                    <i className="market-dot" style={{ background: SLICE_COLORS[index % SLICE_COLORS.length] }} />
                    <span>{slice.name}</span>
                    <strong>{slice.count}</strong>
                    <small>{slice.pct}</small>
                  </div>
                ))}
              </div>
            </div>
          )}
        </article>

        <article className="panel sku-panel">
          <div className="panel-head">
            <div>
              <h2>High-risk SKUs</h2>
              <p>Most issue returns across all scans</p>
            </div>
            <button className="text-button" onClick={() => openPage("reports")} title="Open the return register">
              View register <Icon name="arrow" size={15} />
            </button>
          </div>
          {data.skus.length === 0 && <p className="dash-empty">No SKU has an issue return yet.</p>}
          {data.skus.map((row) => (
            <div className="sku-row" key={row.sku}>
              <div className="product-thumb">
                <Icon name="box" />
              </div>
              <div>
                <strong>{row.sku}</strong>
                <span>{row.name}</span>
              </div>
              <div>
                <strong>{row.issues}</strong>
                <span>issues</span>
              </div>
              <Badge tone="danger">{row.rate}</Badge>
            </div>
          ))}
        </article>
      </section>

      {/* Recent Scans */}
      <section className="panel recent-panel">
        <div className="panel-head">
          <div>
            <h2>Recent scans</h2>
            <p>Latest returns received by your team</p>
          </div>
          <button className="text-button" onClick={() => openPage("reports")}>
            View all returns <Icon name="arrow" size={15} />
          </button>
        </div>
        <ReturnsTable rows={data.recent} compact />
      </section>
    </div>
  )
}
