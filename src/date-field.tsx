// Shared date input for the console. A native <input type="date"> renders the
// operating-system locale (mm/dd/yyyy on US-locale Windows), which warehouse staff
// misread as day/month. This field always displays DD/MM/YYYY while the value
// handed to onChange stays the ISO yyyy-mm-dd string every API route expects.
import { Icon } from "./ui"

// "2026-10-17" -> "17/10/2026". Anything that is not an ISO date passes through unchanged.
export function toDayMonthYear(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value
}

export function DateField({
  value,
  onChange,
  label,
  title,
  min,
  max,
  placeholder = "dd/mm/yyyy",
  bare = false,
  showIcon = true,
}: {
  value: string
  onChange: (value: string) => void
  // Accessible name for the hidden native picker (screen readers, focus).
  label: string
  title?: string
  min?: string
  max?: string
  placeholder?: string
  // Bare drops the bordered box, for containers that already draw their own (Omsguru toolbar).
  bare?: boolean
  showIcon?: boolean
}) {
  return (
    <span className={`date-field${bare ? " bare" : ""}`} title={title ?? label}>
      <span className={`date-field-text${value ? "" : " is-placeholder"}`} aria-hidden="true">
        {value ? toDayMonthYear(value) : placeholder}
      </span>
      {showIcon && <Icon name="calendar" size={15} />}
      <input
        type="date"
        className="date-field-picker"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value)}
        onClick={(event) => {
          // Chrome opens the picker only from its calendar indicator; ask for it on any click.
          try {
            event.currentTarget.showPicker()
          } catch {
            // The picker was already opening from the indicator; nothing more to do.
          }
        }}
      />
    </span>
  )
}
