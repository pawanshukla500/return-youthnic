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
  versionCode: 10001,
  versionName: "1.0.1",
  minRequiredVersionCode: 10001,
  sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  sizeBytes: 4194304,
  notes: "Youthnic Native Android Return Scanner · Initial production release with continuous CameraX scanning, return verification bottom sheet, and low-latency audio/haptics.",
  publishedAt: "2026-10-12T12:00:00Z",
  pageUrl: "https://github.com/youthnic/return-scan/releases",
}

export function getMobileReleaseInfo(): MobileReleaseInfo {
  try {
    if (fs.existsSync(RELEASE_FILE)) {
      const raw = fs.readFileSync(RELEASE_FILE, "utf-8")
      const parsed = JSON.parse(raw) as Partial<MobileReleaseInfo>
      return {
        ...DEFAULT_RELEASE,
        ...parsed,
      }
    }
  } catch {
    // Fall back to default release
  }
  return DEFAULT_RELEASE
}

export function handleLatestRelease(req: Request, res: Response) {
  const info = getMobileReleaseInfo()
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
  // Look for APK in android release directory or dist directory
  const candidates = [
    path.join(root, "android", "app", "build", "outputs", "apk", "release", "app-release.apk"),
    path.join(root, "android", "release", "return-scan.apk"),
    path.join(root, "dist", "return-scan.apk"),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      res.setHeader("Content-Type", "application/vnd.android.package-archive")
      res.setHeader("Content-Disposition", 'attachment; filename="return-scan-1.0.1.apk"')
      res.setHeader("Cache-Control", "no-cache")
      return res.sendFile(candidate)
    }
  }

  // If local APK file not compiled yet, redirect to GitHub release page
  res.redirect("https://github.com/youthnic/return-scan/releases")
}
