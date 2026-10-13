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
  versionCode: 10012,
  versionName: "1.0.12",
  minRequiredVersionCode: 10001,
  sha256: "3d5089ec1b5c490a618c5e632cb717ba68e27c768997a06a2374e2d3bbef04ee",
  sizeBytes: 3243809,
  notes: "Youthnic Native Android Return Scanner · Production Release v1.0.12. Features continuous CameraX scanning, physical return verification bottom sheet, low-latency audio/haptics, and offline image caching.",
  publishedAt: "2026-10-13T08:20:00Z",
  downloadUrl: "https://github.com/pawanshukla500/return-youthnic/releases/download/v1.0.12/ReturnScan-v1.0.12.apk",
  pageUrl: "https://github.com/pawanshukla500/return-youthnic/releases",
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
      res.setHeader("Content-Disposition", 'attachment; filename="ReturnScan-v1.0.12.apk"')
      res.setHeader("Cache-Control", "no-cache")
      return res.sendFile(candidate)
    }
  }

  // If local APK file not compiled on this server, redirect to GitHub release download
  res.redirect("https://github.com/pawanshukla500/return-youthnic/releases/download/v1.0.12/ReturnScan-v1.0.12.apk")
}
