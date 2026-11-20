// Phase 2 item 2.8: claim evidence is streamed, never held whole in memory.
// - Uploads go to a temp file while hashing; memory stays bounded and oversize requests get 413 early.
// - The storage upload is resumable, sent in bounded chunks, and every storage call has a deadline.
// - Downloads pass a Range header through and answer 206, so the console's video player can seek.
// Google endpoints are faked through globalThis.fetch; no network, no real credentials, SYN- data only.
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import v8 from "node:v8"
import vm from "node:vm"
import express from "express"
import { openFirebaseStorageDownload, uploadFileToFirebaseStorage } from "../firebase-storage.js"
import {
  evidenceUpload,
  removeEvidenceTempFile,
  sendStoredEvidence,
  singleByteRange,
  type EvidenceTempFile,
} from "../evidence-stream.js"

const MiB = 1024 * 1024
const realFetch = globalThis.fetch
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-evidence-"))
const SESSION_URL = "https://storage.googleapis.com/upload/SYN-session"

type FakeHandler = (url: string, init: RequestInit) => Promise<Response> | Response
let storageHandler: FakeHandler = () => new Response("not faked", { status: 500 })

function abortable(init: RequestInit): Promise<never> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
  })
}

before(() => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  })
  process.env.FIREBASE_STORAGE_BUCKET = "SYN-bucket"
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    project_id: "SYN-project",
    client_email: "SYN-uploader@example.test",
    private_key: privateKey,
  })
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init)
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "SYN-token", expires_in: 3600 })
    }
    return storageHandler(url, init)
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function writeSynFile(name: string, size: number): { filePath: string; sha: string } {
  const content = Buffer.alloc(size)
  for (let i = 0; i < size; i += 1) content[i] = (i * 31 + 7) & 0xff
  content.write("SYN-", 0)
  const filePath = path.join(tempRoot, name)
  fs.writeFileSync(filePath, content)
  return { filePath, sha: crypto.createHash("sha256").update(content).digest("hex") }
}

// A fake GCS resumable session: stores chunks by Content-Range and answers like the real API.
function fakeSession(options: { dropChunkAt?: number } = {}) {
  const received: Buffer[] = []
  let committed = 0
  let dropped = false
  const puts: { range: string; bytes: number }[] = []
  let started = false
  const handler: FakeHandler = async (url, init) => {
    const headers = new Headers(init.headers)
    if (url.includes("uploadType=resumable")) {
      assert.equal(headers.get("authorization"), "Bearer SYN-token")
      assert.equal(headers.get("x-upload-content-type"), "video/mp4")
      started = true
      return new Response(null, { status: 200, headers: { Location: SESSION_URL } })
    }
    assert.equal(url, SESSION_URL)
    const range = headers.get("content-range") ?? ""
    const body = init.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0)
    puts.push({ range, bytes: body.length })
    const status = /^bytes \*\/(\d+)$/.exec(range)
    if (status) {
      return new Response(null, { status: 308, headers: committed ? { Range: `bytes=0-${committed - 1}` } : {} })
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)
    assert.ok(match, `unexpected Content-Range ${range}`)
    const [start, end, total] = match.slice(1).map(Number)
    if (options.dropChunkAt === start && !dropped) {
      dropped = true
      throw new TypeError("fetch failed") // the connection dropped mid-chunk; nothing was kept
    }
    assert.equal(start, committed, "a resumed upload continues from what storage already holds")
    assert.equal(body.length, end - start + 1)
    received.push(body)
    committed = end + 1
    if (committed === total) return Response.json({ name: "SYN-object", size: String(total) })
    return new Response(null, { status: 308, headers: { Range: `bytes=0-${committed - 1}` } })
  }
  return { handler, puts, received: () => Buffer.concat(received), started: () => started }
}

test("resumable upload: bounded 8 MiB chunks, and a dropped chunk resumes from storage's offset", async () => {
  const { filePath, sha } = writeSynFile("SYN-unboxing.mp4", 20 * MiB + 123)
  const session = fakeSession({ dropChunkAt: 8 * MiB })
  storageHandler = session.handler

  const result = await uploadFileToFirebaseStorage("claim-evidence/SYN-order/video.mp4", filePath, "video/mp4", {
    retryDelayMs: 0,
  })

  assert.equal(result.size, 20 * MiB + 123)
  assert.equal(result.url, "gs://SYN-bucket/claim-evidence/SYN-order/video.mp4")
  assert.equal(crypto.createHash("sha256").update(session.received()).digest("hex"), sha)
  assert.ok(session.puts.every((put) => put.bytes <= 8 * MiB), "no request carries more than one chunk")
  assert.deepEqual(
    session.puts.map((put) => put.range),
    [
      `bytes 0-${8 * MiB - 1}/${20 * MiB + 123}`,
      `bytes ${8 * MiB}-${16 * MiB - 1}/${20 * MiB + 123}`, // dropped
      `bytes */${20 * MiB + 123}`, // asks how much arrived
      `bytes ${8 * MiB}-${16 * MiB - 1}/${20 * MiB + 123}`, // resumes, does not restart at 0
      `bytes ${16 * MiB}-${20 * MiB + 122}/${20 * MiB + 123}`,
    ],
  )
})

test("resumable upload: a hung storage call times out and the upload fails instead of hanging", async () => {
  const { filePath } = writeSynFile("SYN-hung.jpg", 1000)
  storageHandler = (url, init) =>
    url.includes("uploadType=resumable")
      ? new Response(null, { status: 200, headers: { Location: SESSION_URL } })
      : abortable(init)
  const startedAt = Date.now()
  await assert.rejects(
    uploadFileToFirebaseStorage("claim-evidence/SYN-hung.jpg", filePath, "image/jpeg", {
      timeoutMs: 50,
      retries: 1,
      retryDelayMs: 0,
    }),
    /kept failing/,
  )
  assert.ok(Date.now() - startedAt < 5000)
})

test("resumable upload: a refused chunk (4xx) stops at once without retrying", async () => {
  const { filePath } = writeSynFile("SYN-refused.jpg", 1000)
  const calls: string[] = []
  storageHandler = (url) => {
    calls.push(url)
    return url.includes("uploadType=resumable")
      ? new Response(null, { status: 200, headers: { Location: SESSION_URL } })
      : new Response("SYN-forbidden", { status: 403 })
  }
  await assert.rejects(
    uploadFileToFirebaseStorage("claim-evidence/SYN-refused.jpg", filePath, "image/jpeg", { retryDelayMs: 0 }),
    /upload failed \(403\)/,
  )
  assert.equal(calls.length, 2)
})

// ---- multipart upload into a temp file ----

const BOUNDARY = "SYN-boundary-7f3a"

function startServer(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

function uploadApp(dir: string, maxBytes?: number): express.Express {
  const app = express()
  app.post("/upload", evidenceUpload({ dir, maxBytes }), (req, res) => {
    const file = req.file as EvidenceTempFile
    const onDisk = fs.statSync(file.path).size
    res.json({
      size: file.size,
      onDisk,
      contentHash: file.contentHash,
      head: file.head.toString("latin1"),
      hasBuffer: file.buffer !== undefined,
      fieldKey: req.body.fieldKey,
    })
    removeEvidenceTempFile(file)
  })
  return app
}

// Streams a multipart body of `fileBytes` bytes without ever building it in memory. `declaredLength` sends
// only headers claiming that size; `midway` pauses the body halfway so the test can look at the server.
function sendMultipart(
  port: number,
  fileBytes: number,
  options: { declaredLength?: number; midway?: () => Promise<void> } = {},
): Promise<{ status: number; json: Record<string, unknown>; sha: string }> {
  const { declaredLength, midway } = options
  const chunk = Buffer.alloc(64 * 1024, "SYN-")
  const hash = crypto.createHash("sha256")
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="fieldKey"\r\n\r\nSYN-unboxing_video\r\n` +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="SYN-unboxing.mp4"\r\n` +
      "Content-Type: video/mp4\r\n\r\n",
  )
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`)
  return new Promise((resolve, reject) => {
    let settled = false
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/upload",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
          ...(declaredLength ? { "Content-Length": String(declaredLength) } : {}),
        },
      },
      (res) => {
        const parts: Buffer[] = []
        res.on("data", (part: Buffer) => parts.push(part))
        res.on("end", () => {
          settled = true
          req.destroy()
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(parts).toString()), sha: hash.digest("hex") })
        })
      },
    )
    req.on("error", (error) => {
      if (!settled) reject(error)
    })
    if (declaredLength) {
      req.flushHeaders() // headers only: the body never comes
      return
    }
    req.write(head)
    let sent = 0
    let paused = false
    const pump = () => {
      while (sent < fileBytes) {
        if (midway && !paused && sent >= fileBytes / 2) {
          paused = true
          midway().then(pump, reject)
          return
        }
        const piece = fileBytes - sent >= chunk.length ? chunk : chunk.subarray(0, fileBytes - sent)
        sent += piece.length
        hash.update(piece)
        if (!req.write(piece)) {
          req.once("drain", pump)
          return
        }
      }
      req.end(tail)
    }
    pump()
  })
}

// Memory still held after garbage collection, so garbage awaiting collection does not count. V8 frees
// Buffer memory after a collection in the background, hence the pause and the second collection.
async function retainedMemory(): Promise<number> {
  v8.setFlagsFromString("--expose-gc")
  const gc = vm.runInNewContext("gc") as () => void
  gc()
  await new Promise((resolve) => setTimeout(resolve, 50))
  gc()
  const usage = process.memoryUsage()
  return usage.heapUsed + usage.arrayBuffers
}

test("multipart upload: a 96 MiB file lands on disk with its hash while memory stays bounded", async () => {
  const dir = fs.mkdtempSync(path.join(tempRoot, "SYN-upload-"))
  const server = await startServer(uploadApp(dir))
  const baseline = await retainedMemory()
  let heldMidway = Number.POSITIVE_INFINITY
  try {
    const fileBytes = 96 * MiB
    const result = await sendMultipart(server.port, fileBytes, {
      midway: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200)) // let the server take in the first 48 MiB
        heldMidway = (await retainedMemory()) - baseline
      },
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.size, fileBytes)
    assert.equal(result.json.onDisk, fileBytes)
    assert.equal(result.json.contentHash, result.sha, "the hash is computed while the file streams to disk")
    assert.equal(result.json.head, "SYN-SYN-SYN-SYN-", "the first bytes are kept for the file-signature check")
    assert.equal(result.json.hasBuffer, false, "the file is never buffered in memory")
    assert.equal(result.json.fieldKey, "SYN-unboxing_video")
    // Memory storage would hold the 48 MiB received so far; streaming holds a few buffers.
    assert.ok(heldMidway < 8 * MiB, `the server held ${Math.round(heldMidway / MiB)} MiB halfway through a 96 MiB upload`)
  } finally {
    await server.close()
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(fs.readdirSync(dir), [], "the temp file is removed after the request")
})

test("multipart upload: a declared size over the limit gets 413 before any body is sent", async () => {
  const dir = fs.mkdtempSync(path.join(tempRoot, "SYN-early-"))
  const server = await startServer(uploadApp(dir, 1 * MiB))
  try {
    const result = await sendMultipart(server.port, 0, { declaredLength: 200 * MiB })
    assert.equal(result.status, 413)
    assert.equal(result.json.error, "Evidence files can be up to 1 MB.")
  } finally {
    await server.close()
  }
})

test("multipart upload: a streamed file over the limit gets 413 and leaves no temp file", async () => {
  const dir = fs.mkdtempSync(path.join(tempRoot, "SYN-over-"))
  const server = await startServer(uploadApp(dir, 1 * MiB))
  try {
    const result = await sendMultipart(server.port, 2 * MiB)
    assert.equal(result.status, 413)
    assert.equal(result.json.error, "Evidence files can be up to 1 MB.")
  } finally {
    await server.close()
  }
  assert.deepEqual(fs.readdirSync(dir), [])
})

test("multipart upload: a client that drops off halfway leaves no temp file behind", async () => {
  const dir = fs.mkdtempSync(path.join(tempRoot, "SYN-dropped-"))
  const app = uploadApp(dir)
  const reachedErrorHandler: unknown[] = []
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    reachedErrorHandler.push(error)
    res.status(500).end()
  })
  const server = await startServer(app)
  try {
    const req = http.request({
      host: "127.0.0.1",
      port: server.port,
      method: "POST",
      path: "/upload",
      headers: { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`, "Content-Length": String(8 * MiB) },
    })
    req.on("error", () => undefined) // the connection is cut on purpose
    req.write(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="SYN-dropped.mp4"\r\n` +
        "Content-Type: video/mp4\r\n\r\n",
    )
    req.write(Buffer.alloc(1 * MiB, "SYN-"))
    const waitUntil = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await waitUntil(() => fs.readdirSync(dir).length === 1)
    assert.equal(fs.readdirSync(dir).length, 1, "the upload started writing its temp file")
    req.destroy()
    await waitUntil(() => fs.readdirSync(dir).length === 0)
    assert.deepEqual(fs.readdirSync(dir), [], "the partial temp file is removed when the client goes away")
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(reachedErrorHandler, [], "a dropped upload never reaches the 500 handler (no log, no Sentry event)")
  } finally {
    await server.close()
  }
})

// ---- streamed download with Range ----

test("singleByteRange passes one plain byte range and ignores anything else", () => {
  assert.equal(singleByteRange("bytes=0-99"), "bytes=0-99")
  assert.equal(singleByteRange("bytes=1000-"), "bytes=1000-")
  assert.equal(singleByteRange("bytes=-500"), "bytes=-500")
  assert.equal(singleByteRange("bytes=0-1,5-6"), undefined)
  assert.equal(singleByteRange("items=0-1"), undefined)
  assert.equal(singleByteRange(undefined), undefined)
})

const STORED = Buffer.from(`SYN-${"video-bytes-".repeat(20)}`)
const META = {
  storageObjectPath: "claim-evidence/SYN-order/claim-1/video.mp4",
  mimeType: "video/mp4",
  sizeBytes: STORED.length,
  originalFilename: "SYN-unboxing.mp4",
}

function fakeMediaStorage(seen: (string | null)[]): FakeHandler {
  return (url, init) => {
    assert.ok(url.endsWith(`/o/${encodeURIComponent(META.storageObjectPath)}?alt=media`))
    const headers = new Headers(init.headers)
    assert.equal(headers.get("authorization"), "Bearer SYN-token")
    const range = headers.get("range")
    seen.push(range)
    if (!range) return new Response(STORED, { status: 200, headers: { "Content-Length": String(STORED.length) } })
    const [, startText, endText] = /^bytes=(\d+)-(\d*)$/.exec(range) ?? []
    const start = Number(startText)
    if (start >= STORED.length) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${STORED.length}` } })
    }
    const end = endText ? Math.min(Number(endText), STORED.length - 1) : STORED.length - 1
    return new Response(STORED.subarray(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${STORED.length}`, "Content-Length": String(end - start + 1) },
    })
  }
}

test("download: a Range request is passed to storage and answered 206 with exactly those bytes", async () => {
  const seen: (string | null)[] = []
  storageHandler = fakeMediaStorage(seen)
  const app = express()
  app.get("/media", (req, res, next) => {
    sendStoredEvidence(req, res, META).catch(next)
  })
  const server = await startServer(app)
  try {
    const base = `http://127.0.0.1:${server.port}/media`

    const ranged = await fetch(base, { headers: { Range: "bytes=4-15" } })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers.get("content-range"), `bytes 4-15/${STORED.length}`)
    assert.equal(ranged.headers.get("content-length"), "12")
    assert.equal(ranged.headers.get("accept-ranges"), "bytes")
    assert.equal(ranged.headers.get("content-type"), "video/mp4")
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), STORED.subarray(4, 16))

    const whole = await fetch(base)
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get("accept-ranges"), "bytes", "tells the video player it can seek")
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), STORED)

    const past = await fetch(base, { headers: { Range: `bytes=${STORED.length + 10}-` } })
    assert.equal(past.status, 416)
    assert.equal(past.headers.get("content-range"), `bytes */${STORED.length}`)

    const multi = await fetch(base, { headers: { Range: "bytes=0-1,4-5" } })
    assert.equal(multi.status, 200, "a multi-range request gets the whole file")
    await multi.arrayBuffer()

    assert.deepEqual(seen, ["bytes=4-15", null, `bytes=${STORED.length + 10}-`, null])
  } finally {
    await server.close()
  }
})

test("download: storage that never answers times out", async () => {
  storageHandler = (_url, init) => abortable(init)
  await assert.rejects(openFirebaseStorageDownload(META.storageObjectPath, { timeoutMs: 50 }), /did not answer in time/)
})

test("download: a read that stalls halfway ends with an error instead of hanging", async () => {
  storageHandler = (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(STORED.subarray(0, 10)))
        // then nothing more, like a stalled connection; aborting the fetch errors the body as undici does
        init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason))
      },
    })
    return new Response(body, { status: 200 })
  }
  const download = await openFirebaseStorageDownload(META.storageObjectPath, { timeoutMs: 100 })
  assert.ok(download)
  const chunks: Buffer[] = []
  await assert.rejects(
    (async () => {
      for await (const chunk of download.body) chunks.push(chunk as Buffer)
    })(),
    /did not answer in time/,
  )
  assert.equal(Buffer.concat(chunks).length, 10)
})

test("download: a file missing from storage is null", async () => {
  storageHandler = () => new Response("SYN-missing", { status: 404 })
  assert.equal(await openFirebaseStorageDownload(META.storageObjectPath), null)
})
