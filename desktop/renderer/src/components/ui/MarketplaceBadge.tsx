import { useState } from 'react'
import { Badge } from './Badge'

/**
 * Marketplace identity badge. Uses the bundled logo from /logos/* (copied from
 * the repo's public/logos convention); when the image fails to load it falls
 * back to a letter avatar so the identity is still readable offline.
 */
const LOGO_BY_KEY: Record<string, string> = {
  meesho: '/logos/meesho.png',
  flipkart: '/logos/flipkart.jpg',
  amazon: '/logos/amazon.jpg',
  myntra: '/logos/myntra.png',
  myntra_vb: '/logos/myntra.png',
  'myntra vb': '/logos/myntra.png',
  myntra_ej: '/logos/myntra.png',
  'myntra ej': '/logos/myntra.png',
  ajio: '/logos/ajio.jpg',
}

const LETTER_BG: Record<string, string> = {
  meesho: 'bg-purple-soft text-purple',
  flipkart: 'bg-blue-soft text-blue',
  amazon: 'bg-orange-soft text-orange',
  myntra: 'bg-red-soft text-red',
  myntra_vb: 'bg-red-soft text-red',
  'myntra vb': 'bg-red-soft text-red',
  myntra_ej: 'bg-red-soft text-red',
  'myntra ej': 'bg-red-soft text-red',
  ajio: 'bg-green-soft text-green-dark',
}

function normalizeKey(marketplace: string): string {
  return marketplace.trim().toLowerCase()
}

export function MarketplaceBadge({ marketplace, size = 24 }: { marketplace: string; size?: number }) {
  const key = normalizeKey(marketplace)
  const logo = LOGO_BY_KEY[key]
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const imgFailed = failedKey === key
  const letter = (marketplace.trim().charAt(0) || '?').toUpperCase()

  if (!logo || imgFailed) {
    return (
      <Badge>
        <span
          aria-hidden="true"
          className={`inline-flex items-center justify-center rounded-full font-display font-bold ${LETTER_BG[key] ?? 'bg-surface-2 text-muted'}`}
          style={{ width: size * 0.83, height: size * 0.83, fontSize: size * 0.45 }}
        >
          {letter}
        </span>
        <span>{marketplace}</span>
      </Badge>
    )
  }

  return (
    <Badge>
      <img
        src={logo}
        alt=""
        width={size}
        height={size}
        className="rounded object-contain"
        style={{ width: size, height: size }}
        onError={() => setFailedKey(key)}
      />
      <span>{marketplace}</span>
    </Badge>
  )
}
