// Claim evidence moves through the server as streams, never as whole files in memory.
//
// Upload: multer writes the file to a private temp folder while hashing it, so memory stays at one
// chunk whatever the file size. A request that declares more than the limit is refused before its
// body is read. The route then sends the temp file to Firebase with a resumable upload and removes it.
//
// Download: the browser's Range header goes to storage and the 200/206 answer is piped straight back,
// so the console's <video> player can seek without the server holding the file.

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Transform, pipeline } from "node:stream"
import type { Request, RequestHandler, Response } from "express"
import multer from "multer"
import { openFirebaseStorageDownload } from "./firebase-storage.js"
import { ServiceError } from "./register-service.js"

const EVIDENCE_MAX_BYTES = 100 * 1024 * 1024
const MULTIPART_SLACK_BYTES = 64 * 1024 // boundaries and the small text fields sent with the file
const HEAD_BYTES = 16 // covers every file signature evidenceContentError checks
const STALE_TEMP_MS = 24 * 60 * 60 * 1000

export type EvidenceTempFile = Express.Multer.File & { contentHash: string; head: Buffer }

function hashingDiskStorage(dir: string): multer.StorageEngine {
  return {
    _handleFile(req, file, cb) {
      // A phone that drops off mid-upload never ends the multipart stream; without this the temp file and
      // its open handle would wait for the next restart.
      req.once("close", () => {
        if (!req.complete) file.stream.destroy(new Error("The upload was interrupted."))
      })
      const filePath = path.join(dir, crypto.randomUUID())
      const hash = crypto.createHash("sha256")
      const head: Buffer[] = []
      let size = 0
      const tap = new Transform({
        transform(chunk: Buffer, _encoding, next) {
          if (size < HEAD_BYTES) head.push(Buffer.from(chunk.subarray(0, HEAD_BYTES - size)))
          size += chunk.length
          hash.update(chunk)
          next(null, chunk)
        },
      })
      pipeline(file.stream, tap, fs.createWriteStream(filePath, { mode: 0o600 }), (error) => {
        if (error) {
          fs.rm(filePath, { force: true }, () => cb(error))
          return
        }
        const info = { path: filePath, size, contentHash: hash.digest("hex"), head: Buffer.concat(head) }
        cb(null, info as Partial<Express.Multer.File>)
      })
    },
    _removeFile(_req, file, cb) {
      fs.rm(file.path, { force: true }, cb)
    },
  }
}

// A crash mid-request can leave a temp file behind; nothing still in flight is a day old.
function sweepStaleTempFiles(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name)
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > STALE_TEMP_MS) fs.rmSync(file, { force: true })
    } catch {
      // already gone
    }
  }
}

// Accepts one multipart `file` field into a temp file. Too large answers 413 with the real limit.
export function evidenceUpload(options: { dir?: string; maxBytes?: number } = {}): RequestHandler {
  const dir = options.dir ?? path.join(os.tmpdir(), "return-app-evidence-uploads")
  const maxBytes = options.maxBytes ?? EVIDENCE_MAX_BYTES
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  sweepStaleTempFiles(dir)
  const single = multer({ storage: hashingDiskStorage(dir), limits: { fileSize: maxBytes, files: 1 } }).single("file")
  const tooLarge = `Evidence files can be up to ${Math.round(maxBytes / (1024 * 1024))} MB.`

  return (req, res, next) => {
    if (Number(req.headers["content-length"]) > maxBytes + MULTIPART_SLACK_BYTES) {
      // Refuse before reading the body, and close the connection so the rest is not drained.
      res.setHeader("Connection", "close")
      res.status(413).json({ error: tooLarge })
      return
    }
    single(req, res, (error?: unknown) => {
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: tooLarge })
        return
      }
      next(error)
    })
  }
}

export function removeEvidenceTempFile(file: Express.Multer.File | undefined): void {
  if (file?.path) fs.rm(file.path, { force: true }, () => undefined)
}

// Only one plain byte range is passed to storage. Anything else is ignored and the whole file is sent,
// which HTTP allows.
export function singleByteRange(header: string | undefined): string | undefined {
  const value = header?.trim()
  return value && /^bytes=(\d+-\d*|-\d+)$/.test(value) ? value : undefined
}

type StoredEvidence = { storageObjectPath: string; mimeType: string; sizeBytes: number; originalFilename: string }

export async function sendStoredEvidence(req: Request, res: Response, meta: StoredEvidence): Promise<void> {
  const download = await openFirebaseStorageDownload(meta.storageObjectPath, { range: singleByteRange(req.headers.range) })
  if (!download) throw new ServiceError(404, "The file could not be retrieved from storage.")

  res.setHeader("Accept-Ranges", "bytes")
  if (download.status === 416) {
    res.setHeader("Content-Range", download.contentRange || `bytes */${meta.sizeBytes}`)
    res.status(416).end()
    return
  }
  res.status(download.status)
  res.setHeader("Content-Type", meta.mimeType)
  if (download.contentLength) res.setHeader("Content-Length", download.contentLength)
  if (download.contentRange) res.setHeader("Content-Range", download.contentRange)
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(meta.originalFilename)}`)
  res.setHeader("Cache-Control", "private, max-age=3600")
  await new Promise<void>((resolve) => {
    pipeline(download.body, res, (error) => {
      // A viewer seeking or closing the page cuts streams short all the time; only storage failures are news.
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") {
        console.warn("[claims] evidence stream ended early:", error.message)
      }
      resolve()
    })
  })
}
