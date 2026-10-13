import { ReactNode, useState } from "react"
import { MARKETPLACE_CLASS, MARKETPLACE_LOGO } from "./marketplaces"
import { PARTNER_LOGO } from "./partners"
import type { IconName } from "./types"

const iconPaths: Record<IconName, ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  scan: (
    <>
      <path d="M4 7V5a2 2 0 0 1 2-2h2M16 3h2a2 2 0 0 1 2 2v2M20 17v2a2 2 0 0 1-2 2h-2M8 21H6a2 2 0 0 1-2-2v-2M7 12h10" />
      <path d="M8 9v6M11 9v6M15 9v6M17 9v6" />
    </>
  ),
  report: (
    <>
      <path d="M4 19V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
      <path d="M14 3v6h6M8 13h8M8 17h6" />
    </>
  ),
  claim: (
    <>
      <path d="M12 3 4 7v5c0 4.7 3.3 7.8 8 9 4.7-1.2 8-4.3 8-9V7l-8-4Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
    </>
  ),
  chevron: <path d="m9 18 6-6-6-6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18" />
    </>
  ),
  arrow: (
    <>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </>
  ),
  box: (
    <>
      <path d="m21 8-9 5-9-5M3 8l9-5 9 5v9l-9 5-9-5V8Z" />
      <path d="M12 13v9" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 3.7 2.5 18a2 2 0 0 0 1.8 3h15.4a2 2 0 0 0 1.8-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M8 13h8M8 17h5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  logout: (
    <>
      <path d="M10 17l5-5-5-5M15 12H3" />
      <path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" />
    </>
  ),
  video: (
    <>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </>
  ),
}

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconPaths[name]}
    </svg>
  )
}

export function ReturnLogo({ light = false }: { light?: boolean }) {
  return (
    <div className={`return-brand ${light ? "inverse" : ""}`}>
      <img
        src="/logos/youthnic-mark.jpg"
        alt="Youthnic"
        className="return-vector-mark"
      />
      <span className="return-wordmark">
        <strong>Youthnic</strong>
        <small>RETURNS</small>
      </span>
    </div>
  )
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>
}

export function MarketplaceBadge({ name }: { name: string }) {
  const src = MARKETPLACE_LOGO[name]
  const [logo, setLogo] = useState(Boolean(src))
  return (
    <span className={`marketplace ${MARKETPLACE_CLASS[name] || "neutral"}`}>
      {logo && src ? (
        <img src={src} alt="" onError={() => setLogo(false)} />
      ) : (
        <span>{name.slice(0, 1)}</span>
      )}
      {name}
    </span>
  )
}

export function PartnerBadge({ name }: { name: string }) {
  const src = PARTNER_LOGO[name]
  const [logo, setLogo] = useState(Boolean(src))
  return (
    <span className="partner-mark">
      {logo && src ? (
        <img src={src} alt="" width={28} height={28} decoding="async" onError={() => setLogo(false)} />
      ) : (
        <span>{name.slice(0, 1)}</span>
      )}
      {name}
    </span>
  )
}

export function Modal({
  children,
  onClose,
  wide,
}: {
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={wide ? "modal modal-wide" : "modal"} onMouseDown={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

export function StatCard({
  label,
  value,
  delta,
  icon,
  tone,
}: {
  label: string
  value: string
  delta: string
  icon: IconName
  tone: string
}) {
  return (
    <article className="stat-card">
      <div className={`stat-icon ${tone}`}>
        <Icon name={icon} />
      </div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small className={delta.startsWith("+") ? "up" : delta === "Needs attention" ? "down" : ""}>
        {delta.startsWith("+") ? "↗ " : ""}
        {delta}
      </small>
    </article>
  )
}

// One table component for every list in the app. Columns define the header and the cell.
// Used by overview, reports, claims, admin users, and upload history, so they share markup and styling.
export type Column<T> = {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  cellClassName?: string
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  empty?: string
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && empty ? (
            <tr>
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : null}
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={column.cellClassName}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
