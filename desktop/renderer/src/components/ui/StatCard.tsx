import type { ReactNode } from 'react'

export function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string
  value: ReactNode
  hint?: string
  icon?: ReactNode
}) {
  return (
    <div
      role="group"
      aria-label={`${label}: ${typeof value === 'string' || typeof value === 'number' ? value : ''}`}
      className="rounded-xl border border-line bg-surface p-4 shadow-card"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
        {icon ? <span aria-hidden="true" className="text-muted">{icon}</span> : null}
      </div>
      <div className="mt-1 font-display text-2xl font-bold text-ink">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  )
}
