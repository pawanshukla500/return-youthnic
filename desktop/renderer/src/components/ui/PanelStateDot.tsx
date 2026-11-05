import type { PanelRuntimeState } from '../../types/engine'

/** Human labels for the engine's per-panel runtime states. */
export const PANEL_STATE_LABELS: Record<PanelRuntimeState, string> = {
  idle: 'Idle',
  preparing: 'Preparing',
  submitting: 'Submitting',
  prepared: 'Prepared (Waiting approval)',
  manual_action: 'Manual action',
  cooldown: 'Cooling down',
  disabled: 'Disabled',
}

const DOT_CLASSES: Record<PanelRuntimeState, string> = {
  idle: 'bg-green',
  preparing: 'bg-blue',
  submitting: 'bg-blue animate-pulse',
  prepared: 'bg-orange animate-pulse',
  manual_action: 'bg-orange',
  cooldown: 'bg-red',
  disabled: 'bg-muted',
}

export function PanelStateDot({ state, withLabel = true }: { state: PanelRuntimeState; withLabel?: boolean }) {
  const label = PANEL_STATE_LABELS[state] ?? state
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${DOT_CLASSES[state] ?? 'bg-muted'}`} />
      {withLabel ? <span className="text-xs text-muted">{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  )
}
