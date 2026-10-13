import { useEffect, useState } from "react"
import { api } from "../api"
import { saveCsv, toCsv } from "../csv"
import { Loading, PageError } from "../shell"
import type { Stat } from "../types"
import { DataTable, Icon, MarketplaceBadge, StatCard } from "../ui"

type ClaimsData = {
  stats: Stat[]
  total: string
  slices: { name: string; count: string; pct: string; tone: string }[]
  rows: { market: string; raised: string; approved: string; review: string; rejected: string; value: string; rate: number }[]
}

export function Claims() {
  const [data, setData] = useState<ClaimsData | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    api<ClaimsData>("/api/claims").then(setData).catch((err: Error) => setError(err.message))
  }, [])
  if (error) return <PageError message={error} />
  if (!data) return <Loading label="Loading claims…" />

  // Exports the marketplace table shown on this page. It is not the returns report.
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
    <div className="page-content">
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
            {/* Every claim ticket is counted, so this is a label, not a filter. */}
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
    </div>
  )
}
