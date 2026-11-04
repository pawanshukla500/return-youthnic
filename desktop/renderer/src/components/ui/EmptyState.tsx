import type { ReactNode } from 'react'

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string
  message?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-surface px-6 py-12 text-center">
      <div aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-lg text-muted">
        ◌
      </div>
      <p className="font-display text-sm font-semibold text-ink">{title}</p>
      {message ? <p className="max-w-sm text-sm text-muted">{message}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
