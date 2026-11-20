import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Request, Response } from "express"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const RELEASE_FILE = path.join(root, "data", "return-scan-release.json")

export type MobileReleaseInfo = {
  versionCode: number
  versionName: string
  minRequiredVersionCode: number
  sha256: string
  sizeBytes: number
  notes: string
  publishedAt: string
  downloadUrl?: string
  pageUrl?: string
}

// Must stay identical to data/return-scan-release.json (a test checks it). Update both
// when a newer Android release is published so the offline fallback never goes stale.
export const DEFAULT_RELEASE: MobileReleaseInfo = {
  versionCode: 10080,
  versionName: "1.0.80",
  minRequiredVersionCode: 10001,
  sha256: "e1dd6b6bdbccc44264ba7ccaa058201f802d54501434429a2442d1170591e566",
  sizeBytes: 3865402,
  notes: "Official Android Release APK for Return Scanning App (v1.0.80).",
  publishedAt: "2026-11-20T08:24:07Z",
  downloadUrl: "https://github.com/pawanshukla500/return-youthnic/releases/download/v1.0.80/ReturnScan-v1.0.80.apk",
  pageUrl: "https://github.com/pawanshukla500/return-youthnic/releases",
}

let cachedRelease: MobileReleaseInfo | null = null
let nextFetchAt = 0
const GITHUB_CACHE_TTL_MS = 10 * 60 * 1000 // a good answer is reused for 10 minutes
const GITHUB_FAILURE_TTL_MS = 5 * 60 * 1000 // an outage is retried at most every 5 minutes
const GITHUB_TIMEOUT_MS = 8000

async function fetchLatestFromGitHub(): Promise<MobileReleaseInfo | null> {
  try {
    // The repo publishes two release families: Android APKs (v1.0.N) and Windows desktop
    // installers (desktop-v*). /releases/latest can point at either one, so list recent
    // releases and pick the newest Android tag ourselves.
    const res = await fetch("https://api.github.com/repos/pawanshukla500/return-youthnic/releases?per_page=30", {
      headers: {
        "User-Agent": "Return-App-Server",
        "Accept": "application/vnd.github.v3+json",
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const list = (await res.json()) as any[]
    let best: { data: any; runNum: number } | null = null
    for (const data of Array.isArray(list) ? list : []) {
      if (data?.draft || data?.prerelease) continue
      const match = String(data?.tag_name || "").match(/^v1\.0\.(\d+)$/)
      if (match && (!best || parseInt(match[1], 10) > best.runNum)) {
        best = { data, runNum: parseInt(match[1], 10) }
      }
    }
    if (!best) return null
    const data = best.data
    const tagName = String(data.tag_name || "")
    const runNum = best.runNum
    const vCode = 10000 + runNum
    const vName = `1.0.${runNum}`
    
    // Find release apk asset
    const apkAsset = data.assets?.find((a: any) => a.name?.endsWith(".apk") && !a.name.includes("latest")) ||
                     data.assets?.find((a: any) => a.name?.endsWith(".apk"))

    const downloadUrl = apkAsset?.browser_download_url || 
      `https://github.com/pawanshukla500/return-youthnic/releases/download/${tagName}/ReturnScan-${tagName}.apk`

    // The phone refuses an APK whose hash does not match, so a release without its own
    // digest is not offered at all: the caller keeps serving the last good release.
    const sha256 = typeof apkAsset?.digest === "string" ? apkAsset.digest.replace(/^sha256:/i, "") : ""
    if (!/^[a-f0-9]{64}$/i.test(sha256)) return null

    return {
      versionCode: vCode,
      versionName: vName,
      minRequiredVersionCode: 10001,
      sha256,
      sizeBytes: Number(apkAsset.size) || 0,
      // Never show another release's notes or date for this one.
      notes: data.body || "",
      publishedAt: data.published_at || "",
      downloadUrl,
      pageUrl: data.html_url || DEFAULT_RELEASE.pageUrl,
    }
  } catch {
    return null
  }
}

export function getMobileReleaseInfo(): MobileReleaseInfo {
  if (cachedRelease && cachedRelease.versionCode >= DEFAULT_RELEASE.versionCode) {
    return cachedRelease
  }

  let release = { ...DEFAULT_RELEASE }
  try {
    if (fs.existsSync(RELEASE_FILE)) {
      const raw = fs.readFileSync(RELEASE_FILE, "utf-8")
      const parsed = JSON.parse(raw) as Partial<MobileReleaseInfo>
      if (!parsed.versionCode || parsed.versionCode >= DEFAULT_RELEASE.versionCode) {
        release = {
          ...release,
          ...parsed,
        }
      }
    }
  } catch {
    // Fall back to default release
  }
  return release
}

// One resolver for the manifest and the download link, so both always name the same
// release: the live GitHub one when reachable and complete, else the last good one.
export async function resolveMobileRelease(now = Date.now()): Promise<MobileReleaseInfo> {
  if (now >= nextFetchAt) {
    const gh = await fetchLatestFromGitHub()
    if (gh && gh.versionCode >= DEFAULT_RELEASE.versionCode) {
      cachedRelease = gh
      nextFetchAt = now + GITHUB_CACHE_TTL_MS
    } else {
      nextFetchAt = now + GITHUB_FAILURE_TTL_MS
    }
  }
  return cachedRelease || getMobileReleaseInfo()
}

export async function handleLatestRelease(req: Request, res: Response) {
  const info = await resolveMobileRelease()
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http"
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3001"
  const baseUrl = `${protocol}://${host}`

  res.json({
    available: true,
    ...info,
    downloadUrl: info.downloadUrl || `${baseUrl}/download/return-scan.apk`,
    pageUrl: info.pageUrl || `${baseUrl}/download`,
  })
}

export async function handleApkDownload(req: Request, res: Response) {
  const info = await resolveMobileRelease()

  // Look for APK in android release directory or dist directory
  const candidates = [
    path.join(root, "android", "app", "build", "outputs", "apk", "release", "app-release.apk"),
    path.join(root, "android", "release", "return-scan.apk"),
    path.join(root, "dist", "return-scan.apk"),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      res.setHeader("Content-Type", "application/vnd.android.package-archive")
      res.setHeader("Content-Disposition", `attachment; filename="ReturnScan-v${info.versionName}.apk"`)
      res.setHeader("Cache-Control", "no-cache")
      return res.sendFile(candidate)
    }
  }

  // If local APK file not compiled on this server, redirect to GitHub release download.
  // Build the URL from the resolved version: /releases/latest can be a desktop installer.
  const tag = `v${info.versionName}`
  const tagUrl = `https://github.com/pawanshukla500/return-youthnic/releases/download/${tag}/ReturnScan-${tag}.apk`
  const redirectUrl = info.downloadUrl && info.downloadUrl.endsWith(".apk") ? info.downloadUrl : tagUrl
  res.redirect(redirectUrl)
}
