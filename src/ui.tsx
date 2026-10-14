import { ReactNode, useState } from "react"
import { MARKETPLACE_CLASS, MARKETPLACE_LOGO } from "./marketplaces"
import { PARTNER_LOGO } from "./partners"
import type { IconName } from "./types"

const iconPaths: Partial<Record<IconName, ReactNode>> = {
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

// Icons added with Iron Send tracking and live sync. Kept apart from the original set above.
const extraIconPaths: Partial<Record<IconName, ReactNode>> = {
  iron: (
    <>
      <path d="M3 17h15a3 3 0 0 0 3-3V9a2 2 0 0 0-2-2h-5a5 5 0 0 0-5 5v1H6a3 3 0 0 0-3 3z" />
      <path d="M12 7V5h4" />
    </>
  ),
  wifi: (
    <>
      <path d="M5 12.5a10 10 0 0 1 14 0" />
      <path d="M8.5 16a5 5 0 0 1 7 0" />
      <path d="M12 19.5h.01" />
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
      {extraIconPaths[name] ?? iconPaths[name]}
    </svg>
  )
}

export function YouthnicMark({
  className = "return-vector-mark",
  size,
}: {
  className?: string
  size?: number
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Youthnic"
    >
      <defs>
        <linearGradient id="yn-bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0f6b56" />
          <stop offset="45%" stopColor="#0d5948" />
          <stop offset="100%" stopColor="#063b2f" />
        </linearGradient>
        <linearGradient id="yn-mark-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#e6f7f2" />
        </linearGradient>
      </defs>

      <rect
        x="2"
        y="2"
        width="60"
        height="60"
        rx="16"
        fill="url(#yn-bg-grad)"
        stroke="rgba(255,255,255,0.22)"
        strokeWidth="1.2"
      />

      <g transform="translate(17, 12) scale(1.05)" fill="url(#yn-mark-grad)">
        <path d="M9.69125 0.832277C8.02023 0.79121 6.38103 1.59301 5.2107 3.02623C4.73351 3.60774 4.28207 4.31546 3.93753 5.02239C3.68174 5.54801 3.60475 5.78633 3.53444 6.28661L3.47666 6.69769L3.84928 6.15685C4.25721 5.56166 4.62462 5.17037 5.14819 4.76543C5.91006 4.18438 6.60499 3.88263 7.09854 3.9164C7.57658 3.94799 7.87223 4.15168 8.09035 4.59758C8.39974 5.23822 8.34425 6.16769 7.91655 7.32563C7.39143 8.75462 6.11715 11.237 4.40196 14.1835C2.48319 17.481 1.60527 19.3942 1.065 21.4657C0.412724 23.9683 0.888997 26.151 2.4306 27.7321C3.83397 29.1711 5.6407 29.7097 7.80923 29.3343C8.065 29.2872 8.39105 29.2183 8.52721 29.1781C8.91076 29.0659 9.49772 28.7727 9.82449 28.53C10.0982 28.3272 10.3081 28.0997 10.2715 28.051C10.2315 27.9979 9.77749 28.0765 9.55839 28.1722C9.13678 28.3582 8.79364 28.4642 8.66955 28.4468C8.36372 28.3998 8.07999 28.0831 7.93325 27.6077C7.67778 26.8085 7.8062 25.5571 8.29568 24.044C8.68453 22.853 9.50351 21.0777 10.6545 18.9378C12.4811 15.5364 13.6462 13.0426 14.415 10.8649C15.3544 8.20485 15.544 6.12365 14.9911 4.54314C14.7402 3.82372 14.105 2.88419 13.539 2.38149C12.4912 1.4512 11.0355 0.863009 9.69125 0.832277Z" />
        <path d="M26.1037 3.27717C24.2622 3.2675 23.0046 3.60488 21.8999 4.4027C20.6812 5.27942 19.8532 6.47205 18.8195 8.84593C18.6454 9.24066 18.2175 10.3155 17.8674 11.2313C17.1781 13.0406 16.8466 13.8798 16.5749 14.4902C16.3617 14.9664 15.9212 15.8774 15.8291 16.0266C15.7927 16.0887 15.7729 16.1729 15.7819 16.2216C15.821 16.3932 16.7095 16.4588 17.9621 16.3817C20.7459 16.2154 22.608 15.5161 24.0204 14.105C24.8482 13.2801 25.5426 12.0252 26.364 9.86669C27.1007 7.94542 27.3342 7.35339 27.586 6.77184C27.9573 5.93027 28.466 4.81535 28.7036 4.33463C28.8084 4.12394 28.8866 3.93324 28.8777 3.91221C28.8688 3.89119 28.8743 3.8801 28.8931 3.8867C28.9691 3.90923 29.0261 3.89747 29.0077 3.8593C28.9955 3.83385 28.9733 3.82283 28.9567 3.8284C28.9395 3.83786 28.8414 3.8043 28.7411 3.75855C28.2066 3.50943 26.9611 3.28297 26.1037 3.27717Z" />
        <path d="M13.3535 21.4289C13.2246 21.7271 12.9018 22.5044 12.6369 23.1513C10.5368 28.3018 9.21654 31.28 8.19682 33.1892C6.7392 35.9068 5.74267 36.8069 4.32457 36.6827C3.40613 36.605 2.53437 36.1108 1.93999 35.3312C1.61893 34.9143 1.43414 34.5127 1.29327 33.9392C1.08033 33.0907 1.07281 32.9472 1.18454 32.1522C1.23904 31.7644 1.27319 31.437 1.26374 31.4199C1.24986 31.4061 1.16395 31.6234 1.0649 31.9061C0.790355 32.7059 0.707343 33.4654 0.825677 34.1147C1.02088 35.202 1.49525 36.3009 2.14186 37.159C2.62183 37.7959 3.02257 38.1805 3.60443 38.5707C4.59842 39.2364 5.66589 39.5762 7.19367 39.7079C7.98692 39.7759 8.51803 39.7675 9.12319 39.6825C10.9957 39.4157 12.3435 38.6046 13.7132 36.9067C14.4787 35.9624 15.0785 34.9868 15.836 33.4521C17.4121 30.2567 18.2364 27.9088 18.2467 26.5696C18.2571 25.3134 17.8158 24.1204 17.0062 23.2117C16.3027 22.4208 14.861 21.3956 13.9324 21.0238L13.5876 20.8884L13.3535 21.4289Z" />
      </g>
    </svg>
  )
}

export function ReturnLogo({ light = false }: { light?: boolean }) {
  return (
    <div className={`return-brand ${light ? "inverse" : ""}`}>
      <YouthnicMark />
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
