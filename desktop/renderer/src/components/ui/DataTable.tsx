import type { ReactNode } from 'react'
import { EmptyState } from './EmptyState'

export type DataTableColumn<T> = {
  key: string
  header: ReactNode
  render?: (row: T) => ReactNode
  className?: string
  ariaLabel?: (row: T) => string
}

/**
 * Generic accessible data table. Columns are declarative; the row key keeps
 * React reconciliation stable across polls. Renders an EmptyState when there
 * is nothing to show.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyTitle = 'Nothing here yet',
  emptyMessage,
  ariaLabel = 'Data table',
}: {
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string | number
  emptyTitle?: string
  emptyMessage?: string
  ariaLabel?: string
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} message={emptyMessage} />
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-card">
      <table className="w-full border-collapse text-sm" aria-label={ariaLabel}>
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left">
            {columns.map((column) => (
              <th key={column.key} scope="col" className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted ${column.className ?? ''}`}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row)
            return (
              <tr key={key} className="border-b border-line last:border-b-0 hover:bg-surface-2">
                {columns.map((column) => (
                  <td key={column.key} className={`px-3 py-2 text-ink ${column.className ?? ''}`}>
                    {column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? '')}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
