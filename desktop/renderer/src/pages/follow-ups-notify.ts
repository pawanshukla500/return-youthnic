import type { FollowUpRow } from '../types/engine'

/**
 * Pure diff for follow-up ticket notifications (no DOM, no timers — node:test
 * covers it). The renderer polls /api/follow-ups once a minute and runs this
 * over consecutive snapshots; App.tsx owns the fired-key Set and the actual
 * sendNotification call.
 *
 * Triggers:
 *  - prev empty/null + a row with a marketplaceClaimId → "Ticket tracking
 *    started" (a freshly filed ticket's first follow-up row appeared).
 *  - a row's claimStatus/statusAtLastCheck/lastError changed vs prev:
 *      - claimStatus becomes approved or paid (case-insensitive) → "Claim approved"
 *      - claimStatus becomes rejected → "Claim rejected"
 *      - statusAtLastCheck asks for a response — the same trigger words the
 *        engine classifier uses (provide / upload / reply / action) →
 *        "Meesho needs a response"
 *
 * Every notification carries a stable key — the identity the App.tsx Set
 * dedupes on — so one state is reported once even across 60s polls.
 */

export type FollowUpNotification = {
  key: string
  title: string
  body: string
}

/** Same response/action wording the engine ticket-page classifier keys on. */
const RESPONSE_TRIGGER_WORDS = ['provide', 'upload', 'reply', 'action'] as const

/** Match a row across polls: backend id, else the marketplace ticket id, else a composite. */
function rowIdentity(row: FollowUpRow): string {
  const id = (row as Record<string, unknown>).id
  if (typeof id === 'number' && Number.isFinite(id)) return `id:${id}`
  if (row.marketplaceClaimId) return `claim:${row.marketplaceClaimId}`
  return [row.marketplace, row.accountName, row.orderNumber].join('|')
}

/** Operator-facing ticket label: the marketplace's own ticket id when known. */
function ticketLabel(row: FollowUpRow): string {
  if (row.marketplaceClaimId) return row.marketplaceClaimId
  const id = (row as Record<string, unknown>).id
  if (typeof id === 'number' && Number.isFinite(id)) return `ticket ${id}`
  return `ticket ${row.orderNumber || '(unknown)'}`
}

/** Stable per-state key: identity + the two status fields that define the state. */
function notificationKey(row: FollowUpRow): string {
  const id = (row as Record<string, unknown>).id
  return `${row.marketplaceClaimId || id}:${row.claimStatus}:${row.statusAtLastCheck}`
}

export function detectFollowUpNotifications(prev: FollowUpRow[] | null, next: FollowUpRow[]): FollowUpNotification[] {
  const notifications: FollowUpNotification[] = []
  const firstBatch = !prev || prev.length === 0
  const prevByIdentity = new Map<string, FollowUpRow>()
  if (prev) {
    for (const row of prev) prevByIdentity.set(rowIdentity(row), row)
  }

  for (const row of next) {
    if (firstBatch) {
      if (row.marketplaceClaimId) {
        notifications.push({
          key: notificationKey(row),
          title: 'Ticket tracking started',
          body: `${ticketLabel(row)} is now being tracked by the bot.`,
        })
      }
      continue
    }

    const before = prevByIdentity.get(rowIdentity(row))
    // A row that appeared after the first batch has no baseline to diff against.
    if (!before) continue
    const statusChanged = before.claimStatus !== row.claimStatus
    const noteChanged = before.statusAtLastCheck !== row.statusAtLastCheck
    if (!statusChanged && !noteChanged && before.lastError === row.lastError) continue

    const status = (row.claimStatus || '').toLowerCase()
    if (statusChanged && (status === 'approved' || status === 'paid')) {
      notifications.push({
        key: notificationKey(row),
        title: 'Claim approved',
        body: `${ticketLabel(row)} — ${row.claimStatus}.`,
      })
    } else if (statusChanged && status === 'rejected') {
      notifications.push({
        key: notificationKey(row),
        title: 'Claim rejected',
        body: `${ticketLabel(row)} — ${row.claimStatus}.`,
      })
    } else if (noteChanged && RESPONSE_TRIGGER_WORDS.some((word) => (row.statusAtLastCheck || '').toLowerCase().includes(word))) {
      notifications.push({
        key: notificationKey(row),
        title: 'Meesho needs a response',
        body: `${ticketLabel(row)}: ${row.statusAtLastCheck}`,
      })
    }
  }

  return notifications
}
