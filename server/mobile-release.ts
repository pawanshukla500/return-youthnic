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

const DEFAULT_RELEASE: MobileReleaseInfo = {
  versionCode: 10058,
  versionName: "1.0.58",
  minRequiredVersionCode: 10001,
  sha256: "c4c522dd83e2c8be711006f9d8914dbfc10e29c7afa750e7f5d39a002d0e69eb",
  sizeBytes: 3847664,
  notes: "Youthnic Native Android Return Scanner · Mobile Upload Progress & Zero-Reset\n- Live visual evidence upload progress dialog with percentage indicator\n- One-tap start-again reset to zero for scanning subsequent orders\n- Automatic local file cleanup after successful cloud upload\n- Fault-tolerant background retry via WorkManager",
  publishedAt: "2026-10-17T09:57:55Z",
  downloadUrl: "https://github.com/pawanshukla500/return-youthnic/releases/download/v1.0.58/ReturnScan-v1.0.58.apk",
  pageUrl: "https://github.com/pawanshukla500/return-youthnic/releases",
}

let cachedRelease: MobileReleaseInfo | null = null
let lastFetchTime = 0
const GITHUB_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes cache

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

    let sha256 = ""
    if (apkAsset?.digest && typeof apkAsset.digest === "string") {
      sha256 = apkAsset.digest.replace(/^sha256:/i, "")
    }

    return {
      versionCode: vCode,
      versionName: vName,
      minRequiredVersionCode: 10001,
      sha256: sha256 || DEFAULT_RELEASE.sha256,
      sizeBytes: Number(apkAsset?.size || DEFAULT_RELEASE.sizeBytes),
      notes: data.body || DEFAULT_RELEASE.notes,
      publishedAt: data.published_at || DEFAULT_RELEASE.publishedAt,
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

export async function handleLatestRelease(req: Request, res: Response) {
  const now = Date.now()
  if (!cachedRelease || now - lastFetchTime > GITHUB_CACHE_TTL_MS) {
    const gh = await fetchLatestFromGitHub()
    if (gh && gh.versionCode >= DEFAULT_RELEASE.versionCode) {
      cachedRelease = gh
      lastFetchTime = now
    }
  }

  const info = cachedRelease || getMobileReleaseInfo()
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

export function handleApkDownload(req: Request, res: Response) {
  const info = cachedRelease || getMobileReleaseInfo()

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
