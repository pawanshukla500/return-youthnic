import type { ReactNode } from 'react'
import { Modal } from '../../components/ui/Modal'

/** Shared control classes so every AI Center panel renders identical buttons/inputs. */
export const BTN_PRIMARY =
  'rounded-lg bg-green px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-dark disabled:opacity-50'
export const BTN_SECONDARY =
  'rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-ink'
export const BTN_DANGER =
  'rounded-lg border border-red/30 bg-red-soft px-3 py-1.5 text-xs font-medium text-red hover:bg-red/10 disabled:opacity-50'
export const INPUT_CLS =
  'rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink outline-none focus:border-blue'

export type InlineMessageKind = 'ok' | 'error' | 'info'

/** Small status line under a form (save/test results, filter problems). */
export function InlineMessage({ kind, text }: { kind: InlineMessageKind; text: string }) {
  const cls = kind === 'ok' ? 'text-green-dark' : kind === 'error' ? 'text-red' : 'text-muted'
  return (
    <p role={kind === 'error' ? 'alert' : 'status'} className={`text-xs ${cls}`}>
      {text}
    </p>
  )
}

/** Inline alert banner for a failed mutation at the top of a panel. */
export function ActionAlert({ message }: { message: string }) {
  return (
    <p role="alert" className="mb-3 rounded-lg bg-red-soft px-3 py-2 text-sm text-red">
      {message}
    </p>
  )
}

/** Accessible confirm dialog (replaces window.confirm) built on the shared Modal. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Confirm',
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string
  children: ReactNode
  confirmLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal title={title} onClose={onCancel} width="max-w-md">
      <div className="text-sm text-ink">{children}</div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={BTN_SECONDARY} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={BTN_DANGER} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

/** Renders the bold-able segments built by the pure summary formatters. */
export function Segments({ parts }: { parts: Array<{ t: string; strong?: boolean }> }) {
  return (
    <>
      {parts.map((part, index) =>
        part.strong ? (
          <strong key={index} className="font-semibold text-ink">
            {part.t}
          </strong>
        ) : (
          <span key={index}>{part.t}</span>
        ),
      )}
    </>
  )
}
