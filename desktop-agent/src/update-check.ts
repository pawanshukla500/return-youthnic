import { logger } from "./logger.js"

/**
 * Application update check for the packaged desktop app.
 *
 * Compares the running app version against the newest `desktop-v*` GitHub
 * release (the same family the release workflow publishes). This is a
 * check-and-notify mechanism: the dashboard shows a banner with the
 * download link and the operator installs the new setup. Silent
 * auto-install is deliberately not implemented — without OS code signing
 * it would train operators to accept unsigned binaries.
 */

export const UPDATE_OWNER = "pawanshukla500"
export const UPDATE_REPO = "return-youthnic"

export function updateFeedUrl(): string {
  const override = process.env.DESKTOP_UPDATE_FEED_URL?.trim()
  if (override) return override
  // 100 is GitHub's maximum page size, so the newest desktop release is found even if Android releases pile up.
  return `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases?per_page=100`
}

/** "1.2.0" vs tag "desktop-v1.2.0.16" — true when the release is newer. */
export function isNewerRelease(currentVersion: string, tagName: string): boolean {
  const cur = parseVersion(currentVersion)
  const rel = parseVersion(tagName.replace(/^desktop-v/, ""))
  // A release tag carries the package version plus the CI run number
  // (desktop-v1.2.0.16). Compare the first three parts only.
  for (let i = 0; i < 3; i++) {
    if ((rel[i] || 0) > (cur[i] || 0)) return true
    if ((rel[i] || 0) < (cur[i] || 0)) return false
  }
  return false
}

function parseVersion(value: string): number[] {
  return String(value || "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((n) => (Number.isFinite(n) ? n : 0))
}

export type UpdateAsset = { name: string; url: string }

/**
 * Windows-only desktop: the setup asset is always the NSIS `.exe`.
 * GitHub release assets are filtered by name so a stale or foreign
 * installer can never become the offered download.
 */
export function selectWindowsSetupAsset(downloads: UpdateAsset[]): UpdateAsset | null {
  const exe = downloads.find((asset) => asset.url && asset.name.toLowerCase().endsWith(".exe"))
  if (exe) return exe
  return downloads.find((asset) => Boolean(asset.url)) || null
}

type FeedRelease = {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
  assets?: Array<{ name?: string; browser_download_url?: string }>
}

/** Numeric, part by part (1.3.100 > 1.3.99); the run number breaks a tie. Never string order. */
function compareDesktopTags(a: string, b: string): number {
  const x = parseVersion(a.replace(/^desktop-v/, ""))
  const y = parseVersion(b.replace(/^desktop-v/, ""))
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] || 0) - (y[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * The GitHub release list is not newest-first: on 2026-11-20 it listed
 * desktop-v1.3.9.154 before desktop-v1.3.10.157, so the first desktop-v tag
 * is not the newest. Pick the highest published desktop release that ships
 * the Windows setup .exe; drafts and prereleases never count.
 */
export function pickNewestDesktopRelease(releases: FeedRelease[]): (FeedRelease & { tag_name: string }) | null {
  let best: (FeedRelease & { tag_name: string }) | null = null
  for (const release of releases) {
    const tag = release.tag_name
    if (typeof tag !== "string" || !tag.startsWith("desktop-v")) continue
    if (release.draft || release.prerelease) continue
    const hasExe = (release.assets || []).some(
      (a) => a.browser_download_url && (a.name || "").toLowerCase().endsWith(".exe"),
    )
    if (!hasExe) continue
    if (!best || compareDesktopTags(tag, best.tag_name) > 0) best = { ...release, tag_name: tag }
  }
  return best
}

export type UpdateCheckResult = {
  ok: boolean
  currentVersion: string
  latestTag: string | null
  downloadUrl: string | null
  downloads: UpdateAsset[]
  updateAvailable: boolean
  error?: string
}

export function currentAppVersion(): string {
  return (
    process.env.RETURN_APP_VERSION?.trim() ||
    (process.env.npm_package_version || "").trim() ||
    "0.0.0"
  )
}

export async function checkForUpdates(fetchImpl: typeof fetch = fetch): Promise<UpdateCheckResult> {
  const currentVersion = currentAppVersion()
  try {
    const res = await fetchImpl(updateFeedUrl(), {
      headers: { Accept: "application/vnd.github+json" },
    })
    if (!res.ok) {
      return { ok: false, currentVersion, latestTag: null, downloadUrl: null, downloads: [], updateAvailable: false, error: `Release feed answered HTTP ${res.status}.` }
    }
    const desktop = pickNewestDesktopRelease((await res.json()) as FeedRelease[])
    if (!desktop) {
      return { ok: true, currentVersion, latestTag: null, downloadUrl: null, downloads: [], updateAvailable: false }
    }
    const downloads = (desktop.assets || [])
      .filter((a) => a.browser_download_url)
      .map((a) => ({ name: a.name || "setup", url: a.browser_download_url as string }))
    const asset = selectWindowsSetupAsset(downloads)?.url || null
    return {
      ok: true,
      currentVersion,
      latestTag: desktop.tag_name,
      downloadUrl: asset,
      downloads,
      updateAvailable: isNewerRelease(currentVersion, desktop.tag_name),
    }
  } catch (err) {
    logger.warn("Update check failed.", err)
    return {
      ok: false,
      currentVersion,
      latestTag: null,
      downloadUrl: null,
      downloads: [],
      updateAvailable: false,
      error: err instanceof Error ? err.message : "Update check failed.",
    }
  }
}
