// Pure Node.js Firebase / Google Cloud Storage Client (No external SDK dependency).
// Uses official Google OAuth2 Service Account JWT authorization and Google Cloud Storage REST API v1.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Readable, Transform, pipeline } from "node:stream"
import type { ReadableStream as WebReadableStream } from "node:stream/web"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// Every storage call gets a deadline so a hung Google endpoint cannot hold a request open forever.
const STORAGE_TIMEOUT_MS = 60_000
// Resumable uploads send the file in chunks of this size; GCS needs each chunk but the last to be a
// multiple of 256 KiB. Memory per upload stays at one chunk whatever the file size.
const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024
const RESUMABLE_RETRIES = 4

export type FirebaseConfig = {
  projectId: string
  clientEmail: string
  privateKey: string
  bucket: string
}

let cachedToken: { token: string; expiresAt: number } | null = null

// Resolves service account credentials from env, certs directory, or file path.
export function loadFirebaseConfig(): FirebaseConfig | null {
  const bucket =
    process.env.FIREBASE_STORAGE_BUCKET?.trim() || "return-scan-app.firebasestorage.app"

  // 1. Direct env variable
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()

  // 2. certs/firebase-service-account.json
  if (!raw || raw === "{" || raw.length < 10) {
    const certPath = path.join(root, "certs", "firebase-service-account.json")
    if (fs.existsSync(certPath)) {
      try {
        raw = fs.readFileSync(certPath, "utf8").trim()
      } catch {
        // ignore
      }
    }
  }

  // 3. certs/db-ca.pem-adjacent or custom path
  if (!raw || raw.length < 10) {
    const customPath = process.env.FIREBASE_SERVICE_ACCOUNT_FILE?.trim()
    if (customPath && fs.existsSync(customPath)) {
      try {
        raw = fs.readFileSync(customPath, "utf8").trim()
      } catch {
        // ignore
      }
    }
  }

  if (!raw || raw.length < 10) return null

  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    if (!parsed.client_email || !parsed.private_key) return null
    return {
      projectId: parsed.project_id || "return-scan-app",
      clientEmail: String(parsed.client_email).trim(),
      privateKey: String(parsed.private_key).trim(),
      bucket,
    }
  } catch {
    return null
  }
}

export function isFirebaseConfigured(): {
  configured: boolean
  projectId: string
  bucket: string
  clientEmail?: string
} {
  const config = loadFirebaseConfig()
  if (!config) {
    return {
      configured: false,
      projectId: "return-scan-app",
      bucket: process.env.FIREBASE_STORAGE_BUCKET?.trim() || "return-scan-app.firebasestorage.app",
    }
  }
  return {
    configured: true,
    projectId: config.projectId,
    bucket: config.bucket,
    clientEmail: config.clientEmail,
  }
}

// Generates and exchanges Google Service Account JWT for Google OAuth2 Bearer Access Token
export async function getGoogleAccessToken(config: FirebaseConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedToken.expiresAt > now + 300) {
    return cachedToken.token
  }

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const claimSet = Buffer.from(
    JSON.stringify({
      iss: config.clientEmail,
      scope: "https://www.googleapis.com/auth/devstorage.read_write",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    }),
  ).toString("base64url")

  const sign = crypto.createSign("RSA-SHA256")
  sign.update(`${header}.${claimSet}`)
  sign.end()
  const signature = sign.sign(config.privateKey, "base64url")
  const assertion = `${header}.${claimSet}.${signature}`

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Google Cloud OAuth2 token exchange failed (${response.status}): ${errorBody}`)
  }

  const data = (await response.json()) as { access_token: string; expires_in: number }
  cachedToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 3600),
  }
  return data.access_token
}

// Uploads a file directly to Firebase Storage bucket using GCS REST API v1
export async function uploadToFirebaseStorage(
  objectPath: string,
  content: string | Buffer,
  contentType = "text/csv; charset=utf-8",
): Promise<{ url: string; directUrl: string; size: number }> {
  const config = loadFirebaseConfig()
  if (!config) {
    console.warn("[Firebase Storage] Credentials not configured. Skipped remote upload.")
    return {
      url: `local://${objectPath}`,
      directUrl: "",
      size: typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.length,
    }
  }

  const token = await getGoogleAccessToken(config)
  const encodedName = encodeURIComponent(objectPath)
  const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(config.bucket)}/o?uploadType=media&name=${encodedName}`

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
    },
    body: typeof content === "string" ? content : new Uint8Array(content),
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Firebase Storage upload failed (${response.status}): ${errorBody}`)
  }

  const data = (await response.json()) as { name: string; size: string; mediaLink?: string }
  const directUrl = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(config.bucket)}/o/${encodeURIComponent(objectPath)}?alt=media`

  return {
    url: `gs://${config.bucket}/${objectPath}`,
    directUrl,
    size: Number(data.size || 0),
  }
}

export type FileUploadOptions = { timeoutMs?: number; retries?: number; retryDelayMs?: number }

// A 308 "Resume Incomplete" answer carries `Range: bytes=0-N` for what GCS already holds; no header means nothing.
function committedBytes(response: Response): number {
  const match = /^bytes=0-(\d+)$/.exec(response.headers.get("range") ?? "")
  return match ? Number(match[1]) + 1 : 0
}

// Uploads a file from disk with a GCS resumable upload: one chunk in memory at a time and every request on a
// deadline. After a dropped, failed or timed-out chunk it asks the session how much arrived and resumes there.
export async function uploadFileToFirebaseStorage(
  objectPath: string,
  filePath: string,
  contentType: string,
  options: FileUploadOptions = {},
): Promise<{ url: string; size: number }> {
  const config = loadFirebaseConfig()
  if (!config) throw new Error("Firebase Storage is not configured.")
  const { timeoutMs = STORAGE_TIMEOUT_MS, retries = RESUMABLE_RETRIES, retryDelayMs = 1000 } = options
  const handle = await fs.promises.open(filePath, "r")
  try {
    const size = (await handle.stat()).size
    const token = await getGoogleAccessToken(config)
    const start = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(config.bucket)}/o?uploadType=resumable&name=${encodeURIComponent(objectPath)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Upload-Content-Type": contentType,
          "X-Upload-Content-Length": String(size),
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    )
    const sessionUrl = start.headers.get("location")
    if (!start.ok || !sessionUrl) throw new Error(`Firebase Storage upload could not start (${start.status}).`)
    const finish = async (response: Response) => {
      await response.body?.cancel() // the object resource is not needed; release the connection
      return { url: `gs://${config.bucket}/${objectPath}`, size }
    }

    let offset = 0
    let failures = 0
    for (;;) {
      const length = Math.min(RESUMABLE_CHUNK_BYTES, size - offset)
      const chunk = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(chunk, 0, length, offset)
      if (bytesRead !== length) throw new Error("The file changed while it was being uploaded.")
      const response = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "Content-Range": length > 0 ? `bytes ${offset}-${offset + length - 1}/${size}` : `bytes */${size}` },
        body: chunk,
        signal: AbortSignal.timeout(timeoutMs),
      }).catch(() => null) // a dropped connection or a timeout is resumed below
      if (response?.ok) return finish(response)
      if (response?.status === 308 && committedBytes(response) > offset) {
        offset = committedBytes(response)
        continue
      }
      const retryable =
        !response || [308, 408, 429].includes(response.status) || response.status >= 500
      if (!retryable) throw new Error(`Firebase Storage upload failed (${response.status}).`)
      failures += 1
      if (failures > retries) throw new Error("Firebase Storage upload kept failing. Try again.")
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * failures))
      // Ask the session how many bytes it holds, then resume from there instead of starting over.
      const status = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes */${size}` },
        signal: AbortSignal.timeout(timeoutMs),
      }).catch(() => null)
      if (status?.ok) return finish(status)
      if (status?.status === 308) offset = committedBytes(status)
    }
  } finally {
    await handle.close()
  }
}

export type StorageDownload = {
  status: number // 200 the whole file, 206 one byte range, 416 a range past the end
  contentLength: string | null
  contentRange: string | null
  body: Readable
}

// Opens a file in Firebase Storage as a stream and passes one Range header through. Nothing is buffered: the
// caller pipes `body` to its client. One timer covers the wait for headers and every gap between chunks, so a
// read that stalls halfway also ends (as does a client that stops reading for that long; a video player that
// resumes simply asks for a new range). Returns null when storage is not configured or the file is not there.
export async function openFirebaseStorageDownload(
  objectPath: string,
  options: { range?: string; timeoutMs?: number } = {},
): Promise<StorageDownload | null> {
  const config = loadFirebaseConfig()
  if (!config) return null

  const token = await getGoogleAccessToken(config)
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.bucket)}/o/${encodeURIComponent(objectPath)}?alt=media`
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error("Firebase Storage did not answer in time.")),
    options.timeoutMs ?? STORAGE_TIMEOUT_MS,
  )
  let response: Response
  try {
    response = await fetch(url, {
      // identity keeps the bytes and Content-Length exactly as stored, so a 206 can be passed straight through
      headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "identity", ...(options.range ? { Range: options.range } : {}) },
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    throw error
  }
  const contentLength = response.headers.get("content-length")
  const contentRange = response.headers.get("content-range")
  if (response.status !== 200 && response.status !== 206) {
    clearTimeout(timer)
    controller.abort() // drop the error body without reading it
    if (response.status === 404) return null
    if (response.status === 416) return { status: 416, contentLength: null, contentRange, body: Readable.from([]) }
    throw new Error(`Firebase Storage download failed (${response.status}).`)
  }
  const refresh = new Transform({
    transform(chunk, _encoding, next) {
      timer.refresh()
      next(null, chunk)
    },
  })
  const source = response.body ? Readable.fromWeb(response.body as unknown as WebReadableStream) : Readable.from([])
  pipeline(source, refresh, () => clearTimeout(timer))
  return { status: response.status, contentLength, contentRange, body: refresh }
}

// Deletes a file from Firebase Storage
export async function deleteFromFirebaseStorage(objectPath: string): Promise<boolean> {
  const config = loadFirebaseConfig()
  if (!config) return false

  try {
    const token = await getGoogleAccessToken(config)
    const encodedName = encodeURIComponent(objectPath)
    const deleteUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.bucket)}/o/${encodedName}`
    const response = await fetch(deleteUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    })
    return response.ok || response.status === 404
  } catch (err) {
    console.error("[Firebase Storage] Delete failed for:", objectPath, err)
    return false
  }
}

// Lists files in Firebase Storage under a prefix
export async function listFirebaseStorageFiles(prefix = "inventory-update-file/"): Promise<
  { name: string; size: number; updated: string; downloadUrl: string }[]
> {
  const config = loadFirebaseConfig()
  if (!config) return []

  try {
    const token = await getGoogleAccessToken(config)
    const listUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.bucket)}/o?prefix=${encodeURIComponent(prefix)}`
    const response = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    })
    if (!response.ok) return []
    const data = (await response.json()) as { items?: { name: string; size: string; updated: string }[] }
    if (!Array.isArray(data.items)) return []

    return data.items.map((item) => ({
      name: item.name,
      size: Number(item.size || 0),
      updated: item.updated,
      downloadUrl: `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(config.bucket)}/o/${encodeURIComponent(item.name)}?alt=media`,
    }))
  } catch (err) {
    console.error("[Firebase Storage] List files failed:", err)
    return []
  }
}
