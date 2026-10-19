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
  return `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases?per_page=20`
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
    const releases = (await res.json()) as Array<{ tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> }>
    const desktop = releases.find((r) => typeof r.tag_name === "string" && r.tag_name.startsWith("desktop-v"))
    if (!desktop?.tag_name) {
      return { ok: true, currentVersion, latestTag: null, downloadUrl: null, downloads: [], updateAvailable: false }
    }
    const downloads = (desktop.assets || [])
      .filter((a) => a.browser_download_url)
      .map((a) => ({ name: a.name || "setup", url: a.browser_download_url as string }))
    const asset = downloads[0]?.url || null
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
