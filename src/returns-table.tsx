import { useEffect, useState, type KeyboardEvent } from "react"
import type { ReturnRow } from "./types"
import { Badge, type Column, DataTable, Icon, MarketplaceBadge } from "./ui"

// Editable ticket cell. Saves on blur or Enter, only when the value changed.
// If the save fails, the cell goes back to the last saved value.
function TicketCell({
  id,
  ticket,
  onTicket,
}: {
  id: string
  ticket: string
  onTicket: (id: string, ticket: string) => Promise<void>
}) {
  const [value, setValue] = useState(ticket)
  useEffect(() => setValue(ticket), [ticket])

  const save = async () => {
    if (value === ticket) return
    try {
      await onTicket(id, value)
    } catch {
      setValue(ticket)
    }
  }

  return (
    <input
      className="ticket-input"
      value={value}
      placeholder="Add manually"
      aria-label={`Ticket ID for ${id}`}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") event.currentTarget.blur()
      }}
    />
  )
}

const noTicketSave = async () => undefined

// Overview (compact) and Reports (full) use the same column definitions.
export function ReturnsTable({
  rows,
  compact = false,
  onTicket,
}: {
  rows: ReturnRow[]
  compact?: boolean
  onTicket?: (id: string, ticket: string) => Promise<void>
}) {
  const columns: Column<ReturnRow>[] = [
    {
      key: "id",
      header: "Tracking ID",
      render: (row) => (
        <>
          <strong>{row.id}</strong>
          <small>{row.order}</small>
        </>
      ),
    },
    {
      key: "market",
      header: "Marketplace",
      render: (row) => <MarketplaceBadge name={row.market} />,
    },
    { key: "sku", header: "Product SKU", render: (row) => row.sku },
    { key: "type", header: "Return type", render: (row) => row.type },
    {
      key: "issue",
      header: "Received issue",
      render: (row) => (
        <span className={row.issue === "No issue" ? "clean" : "issue-text"}>
          {row.issue === "No issue" && <Icon name="check" size={15} />} {row.issue}
        </span>
      ),
    },
  ]
  if (!compact) {
    columns.push({
      key: "ticket",
      header: "Ticket ID",
      render: (row) => <TicketCell id={row.id} ticket={row.ticket} onTicket={onTicket || noTicketSave} />,
    })
  }
  columns.push({
    key: "status",
    header: "Ticket status",
    render: (row) => (
      <Badge
        tone={
          row.status === "Approved" || row.status === "Clear"
            ? "success"
            : row.status === "Draft"
              ? "neutral"
              : "warning"
        }
      >
        {row.status}
      </Badge>
    ),
  })
  if (!compact) {
    columns.push({ key: "time", header: "Scanned at", render: (row) => row.time })
  }
  return <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} empty="No returns to show" />
}
