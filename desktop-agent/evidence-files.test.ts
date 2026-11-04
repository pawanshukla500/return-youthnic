// Evidence endpoint helpers: path safety (traversal, separators, oversized
// names), claim-id validation, .part exclusion in listings, the extension
// content-type map and stream headers. All data is synthetic SYN-* files in
// a temp directory.

import { after, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  EVIDENCE_CLAIM_ID_PATTERN,
  EVIDENCE_MAX_FILE_NAME_LENGTH,
  evidenceContentType,
  evidenceDisposition,
  evidenceStreamHeaders,
  isValidEvidenceClaimId,
  listEvidenceFiles,
  resolveEvidenceFile,
} from "./src/evidence-files.js"

const tempDirs: string[] = []
let workDir = ""
let claimDir = ""

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "SYN-evidence-"))
  tempDirs.push(workDir)
  claimDir = path.join(workDir, "claim-SYN-1")
  fs.mkdirSync(claimDir, { recursive: true })
})

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

describe("isValidEvidenceClaimId", () => {
  it("accepts ids within the pinned pattern", () => {
    assert.ok(EVIDENCE_CLAIM_ID_PATTERN.test("SYN-1"))
    assert.ok(EVIDENCE_CLAIM_ID_PATTERN.test("a"))
    assert.ok(EVIDENCE_CLAIM_ID_PATTERN.test("A9_z-X".repeat(6).slice(0, 40)))
    assert.ok(isValidEvidenceClaimId("123456"))
  })

  it("rejects ids with path characters, spaces, empties and oversize ids", () => {
    for (const bad of ["", "a b", "../x", "a/b", "a\\b", "x".repeat(41), ".", "..", "%2e%2e"]) {
      assert.equal(isValidEvidenceClaimId(bad), false, `expected ${JSON.stringify(bad)} to be rejected`)
    }
  })
})

describe("resolveEvidenceFile", () => {
  it("resolves a plain file name inside the claim dir", () => {
    assert.equal(resolveEvidenceFile(workDir, "SYN-1", "SYN-a.png"), path.join(claimDir, "SYN-a.png"))
  })

  it("rejects traversal: .., nested .., and encoded-decoded ..", () => {
    assert.equal(resolveEvidenceFile(workDir, "SYN-1", ".."), null)
    assert.equal(resolveEvidenceFile(workDir, "SYN-1", "../secret.txt"), null)
    assert.equal(resolveEvidenceFile(workDir, "SYN-1", "sub/../../secret.txt"), null)
    // The route receives url.pathname from the WHATWG parser. A full-segment
    // %2e%2e is resolved as a dot segment, so the traversal can never reach
    // the route as a literal ".." — what remains is a plain, inert path.
    const collapsed = new URL("http://127.0.0.1/api/evidence/SYN-1/%2e%2e/secret.txt").pathname
    assert.ok(!collapsed.includes(".."), "the URL parser collapses a %2e%2e segment before routing")
    // An encoded slash inside a segment is not decoded by the parser and the
    // OS never decodes %2f either, so the name stays a literal inert file.
    const encodedSlash = new URL("http://127.0.0.1/api/evidence/SYN-1/..%2fsecret.txt").pathname
    const segments = encodedSlash.slice("/api/evidence/".length).split("/")
    assert.equal(segments.length, 2, "one segment: the encoded slash never splits the path")
    const resolved = resolveEvidenceFile(workDir, segments[0], segments[1])
    assert.ok(resolved !== null && resolved.startsWith(path.resolve(claimDir) + path.sep), "still inside the claim dir")
  })

  it("rejects absolute paths on both separator styles", () => {
    assert.equal(resolveEvidenceFile(workDir, "SYN-1", "/etc/passwd"), null)
    assert.equal(resolveEvidenceFile(workDir, "SYN-1", "C:\\Windows\\secret.txt"), null)
    assert.equal(resolveEvidenceFile(workDir, "SYN-1", "C:/Windows/secret.txt"), null)
  })

  it("rejects separators, NUL, empty and oversized names", () => {
    assert.equal(resolveEvidenceFile(workDir, "SYN-1", ""), null)
    assert.equal(resolveEvidenceFile(workDir, "SYN-1", "a/b.txt"), null)
    assert.equal(resolveEvidenceFile(workDir, "SYN-1", "a\\b.txt"), null)
    assert.equal(resolveEvidenceFile(workDir, "SYN-1", "a\0b.txt"), null)
    assert.equal(resolveEvidenceFile(workDir, "SYN-1", "x".repeat(EVIDENCE_MAX_FILE_NAME_LENGTH + 1)), null)
    assert.equal(resolveEvidenceFile(workDir, "SYN-1", "x".repeat(EVIDENCE_MAX_FILE_NAME_LENGTH)), path.join(claimDir, "x".repeat(EVIDENCE_MAX_FILE_NAME_LENGTH)))
  })

  it("rejects an invalid claim id before touching the disk", () => {
    assert.equal(resolveEvidenceFile(workDir, "../evil", "SYN-a.png"), null)
    assert.equal(resolveEvidenceFile(workDir, "bad id", "SYN-a.png"), null)
  })
})

describe("listEvidenceFiles", () => {
  it("lists top-level files sorted by name, skipping .part files and directories", () => {
    fs.writeFileSync(path.join(claimDir, "SYN-b.jpg"), "SYN-2")
    fs.writeFileSync(path.join(claimDir, "SYN-a.png"), "SYN-1")
    fs.writeFileSync(path.join(claimDir, "SYN-c.mp4.part"), "SYN-partial")
    fs.mkdirSync(path.join(claimDir, "SYN-sub"))
    fs.writeFileSync(path.join(claimDir, "SYN-sub", "SYN-nested.txt"), "SYN-nested")

    const files = listEvidenceFiles(workDir, "SYN-1")
    assert.deepEqual(files.map((f) => f.name), ["SYN-a.png", "SYN-b.jpg"])
    assert.equal(files[0].sizeBytes, 5)
    assert.ok(!Number.isNaN(Date.parse(files[0].mtimeIso)))
  })

  it("returns an empty list for a claim dir that does not exist", () => {
    assert.deepEqual(listEvidenceFiles(workDir, "SYN-missing"), [])
  })

  it("returns an empty list for an invalid claim id", () => {
    assert.deepEqual(listEvidenceFiles(workDir, "../x"), [])
  })
})

describe("evidenceContentType / evidenceDisposition", () => {
  it("maps the pinned extensions", () => {
    const expected: Record<string, string> = {
      "SYN-a.png": "image/png",
      "SYN-a.jpg": "image/jpeg",
      "SYN-a.jpeg": "image/jpeg",
      "SYN-a.webp": "image/webp",
      "SYN-a.mp4": "video/mp4",
      "SYN-a.webm": "video/webm",
      "SYN-a.pdf": "application/pdf",
      "SYN-a.txt": "text/plain; charset=utf-8",
    }
    for (const [name, type] of Object.entries(expected)) {
      assert.equal(evidenceContentType(name), type, name)
    }
    assert.equal(evidenceContentType("SYN-a.bin"), "application/octet-stream")
    assert.equal(evidenceContentType("SYN-noext"), "application/octet-stream")
  })

  it("is case-insensitive on the extension", () => {
    assert.equal(evidenceContentType("SYN-A.PNG"), "image/png")
  })

  it("dispositions images and video inline and everything else as attachment", () => {
    for (const name of ["SYN-a.png", "SYN-a.jpg", "SYN-a.jpeg", "SYN-a.webp", "SYN-a.mp4", "SYN-a.webm"]) {
      assert.equal(evidenceDisposition(name), "inline", name)
    }
    for (const name of ["SYN-a.pdf", "SYN-a.txt", "SYN-a.bin", "SYN-noext"]) {
      assert.equal(evidenceDisposition(name), "attachment", name)
    }
  })
})

describe("evidenceStreamHeaders", () => {
  it("carries content type, length and an inline disposition for images", () => {
    assert.deepEqual(evidenceStreamHeaders("SYN-a.png", 123), {
      "Content-Type": "image/png",
      "Content-Length": "123",
      "Content-Disposition": 'inline; filename="SYN-a.png"',
    })
  })

  it("downloads non-preview types as attachments", () => {
    assert.equal(evidenceStreamHeaders("SYN-a.pdf", 7)["Content-Disposition"], 'attachment; filename="SYN-a.pdf"')
  })
})
