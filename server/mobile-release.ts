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
  versionCode: 10035,
  versionName: "1.0.35",
  minRequiredVersionCode: 10001,
  sha256: "28ddb67a6ecc0cbe591522c179349c472b0a411b168af8e93b08bb029c54b048",
  sizeBytes: 3325570,
  notes: "Youthnic Native Android Return Scanner · Meesho flyer capture & continuous scanning\n- Meesho issue returns capture the flyer ID for future claims (scan the flyer or mark it unavailable; Iron Send never takes a flyer)\n- Same backend, database and validation as desktop; flyer stored permanently against the return tracking ID\n- Continuous scanning: compact success toast, scanner stays focused, buffered parcels continue automatically\n- Signed with the same warehouse key as v1.0.30: phones on v1.0.30 or later update in place",
  publishedAt: "2026-10-14T15:44:06Z",
  downloadUrl: "https://github.com/pawanshukla500/return-youthnic/releases/download/v1.0.35/ReturnScan-v1.0.35.apk",
  pageUrl: "https://github.com/pawanshukla500/return-youthnic/releases/tag/v1.0.35",
}

let cachedRelease: MobileReleaseInfo | null = null
let lastFetchTime = 0
const GITHUB_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes cache

async function fetchLatestFromGitHub(): Promise<MobileReleaseInfo | null> {
  try {
    const res = await fetch("https://api.github.com/repos/pawanshukla500/return-youthnic/releases/latest", {
      headers: {
        "User-Agent": "Return-App-Server",
        "Accept": "application/vnd.github.v3+json",
      },
    })
    if (!res.ok) return null
    const data = await res.json() as any
    const tagName = String(data.tag_name || "")
    const match = tagName.match(/^v?1\.0\.(\d+)$/)
    const runNum = match ? parseInt(match[1], 10) : 0
    const vCode = 10000 + runNum
    const vName = match ? `1.0.${runNum}` : tagName.replace(/^v/, "")
    
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

  // If local APK file not compiled on this server, redirect to GitHub release download
  const redirectUrl = info.downloadUrl || "https://github.com/pawanshukla500/return-youthnic/releases/latest/download/ReturnScan-latest.apk"
  res.redirect(redirectUrl)
}
