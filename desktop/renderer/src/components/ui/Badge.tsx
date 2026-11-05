import type { ReactNode } from 'react'

export type BadgeVariant = 'neutral' | 'green' | 'orange' | 'purple' | 'blue' | 'red'

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-2 text-muted border-line',
  green: 'bg-green-soft text-green-dark border-green/25',
  orange: 'bg-orange-soft text-orange border-orange/25',
  purple: 'bg-purple-soft text-purple border-purple/25',
  blue: 'bg-blue-soft text-blue border-blue/25',
  red: 'bg-red-soft text-red border-red/25',
}

export function Badge({ variant = 'neutral', children, title }: { variant?: BadgeVariant; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${VARIANT_CLASSES[variant]}`}
    >
      {children}
    </span>
  )
}
