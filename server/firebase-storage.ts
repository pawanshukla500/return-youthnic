// Pure Node.js Firebase / Google Cloud Storage Client (No external SDK dependency).
// Uses official Google OAuth2 Service Account JWT authorization and Google Cloud Storage REST API v1.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

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

  // 4. Fallback: Parse unquoted multiline JSON from .env if present
  if (!raw || raw === "{" || raw.length < 10) {
    const envPath = path.join(root, ".env")
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, "utf8")
        const idx = content.indexOf("FIREBASE_SERVICE_ACCOUNT_JSON")
        if (idx !== -1) {
          const sub = content.slice(idx)
          const start = sub.indexOf("{")
          const end = sub.indexOf("}")
          if (start !== -1 && end !== -1) {
            raw = sub.slice(start, end + 1).trim()
          }
        }
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
