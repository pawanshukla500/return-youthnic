import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Request, Response } from "express"
import { DEFAULT_RELEASE, getMobileReleaseInfo, handleApkDownload, handleLatestRelease, resolveMobileRelease } from "../mobile-release.js"
import { submissionFrom } from "../register-routes.js"
import { normalizeTracking, validateScanSubmission, type CategoryRule, type SubIssueRule } from "../register-rules.js"

// Invariant 9: Test data is synthetic, and every value starts with SYN-.
const SYN_AWB_EXACT = "SYN-1490711818486605"
const SYN_CLIENT_SCAN_KEY = "SYN-MOBILE-1-1728734000000-abcd1234"

test("mobile release manifest returns valid release configuration", () => {
  const release = getMobileReleaseInfo()
  assert.ok(release.versionCode >= 10020, "versionCode must be >= 10020")
  assert.ok(typeof release.versionName === "string" && release.versionName.length > 0, "versionName must be string")
  assert.ok(typeof release.sha256 === "string" && release.sha256.length > 0, "sha256 must be string")
  assert.ok(release.sizeBytes > 0, "sizeBytes must be positive integer")
  assert.ok(release.notes.length > 0, "release notes must be present")
  assert.ok(typeof release.downloadUrl === "string" && release.downloadUrl.startsWith("https://"), "downloadUrl must be valid https URL")
})

test("mobile submission parser preserves exact tracking string without scientific truncation", () => {
  const payload = {
    shipmentId: 101,
    clientScanKey: SYN_CLIENT_SCAN_KEY,
    scannedTracking: SYN_AWB_EXACT,
    notes: "SYN-Verification note",
    items: [
      {
        itemId: 201,
        receivedQty: 1,
        verified: true,
        issues: [
          {
            categoryCode: "CLEAR",
            subIssueId: null,
            qty: 1,
            ticketCode: "",
            notes: "",
          },
        ],
      },
    ],
  }

  const submission = submissionFrom(payload)
  assert.equal(submission.shipmentId, 101)
  assert.equal(submission.scannedTracking, SYN_AWB_EXACT)
  assert.equal(submission.clientScanKey, SYN_CLIENT_SCAN_KEY)
  assert.equal(submission.items.length, 1)
  assert.equal(submission.items[0].itemId, 201)
  assert.equal(submission.items[0].receivedQty, 1)
  assert.equal(submission.items[0].verified, true)
  assert.equal(submission.items[0].issues[0].categoryCode, "CLEAR")
})

test("mobile multi-product return parcel maps each item separately", () => {
  const payload = {
    shipmentId: 102,
    clientScanKey: SYN_CLIENT_SCAN_KEY,
    scannedTracking: "SYN-AWB-MULTI-001",
    notes: "SYN-Two items in parcel",
    items: [
      {
        itemId: 301,
        receivedQty: 1,
        verified: true,
        issues: [
          {
            categoryCode: "MISSING_COMPONENT",
            subIssueId: 501,
            qty: 1,
            ticketCode: "",
            notes: "SYN-Missing Dupatta",
          },
        ],
      },
      {
        itemId: 302,
        receivedQty: 2,
        verified: true,
        issues: [
          {
            categoryCode: "CLEAR",
            subIssueId: null,
            qty: 2,
            ticketCode: "",
            notes: "",
          },
        ],
      },
    ],
  }

  const submission = submissionFrom(payload)
  assert.equal(submission.items.length, 2)
  assert.equal(submission.items[0].issues[0].subIssueId, 501)
  assert.equal(submission.items[1].receivedQty, 2)
})

// The categories the server seeds (server/schema-import.sql) with the scan-bench rule that no ticket ID is typed.
const SEEDED_CATEGORIES: CategoryRule[] = [
  { code: "no_issue", label: "No issue", isClear: true, isMissing: false, requiresTicket: false, allowsSubIssue: false, requiresSubIssue: false, active: true },
  { code: "missing_component", label: "Missing product or component", isClear: false, isMissing: true, requiresTicket: false, allowsSubIssue: true, requiresSubIssue: true, active: true },
  { code: "wrong_product", label: "Wrong product", isClear: false, isMissing: false, requiresTicket: false, allowsSubIssue: false, requiresSubIssue: false, active: true },
  { code: "damaged_product", label: "Damaged product", isClear: false, isMissing: false, requiresTicket: false, allowsSubIssue: false, requiresSubIssue: false, active: true },
]
const SEEDED_SUB_ISSUES: SubIssueRule[] = [{ id: 501, label: "SYN Dupatta", categoryCode: "missing_component", active: true }]

function mobileBody(issueFor: Record<number, Record<string, unknown> | null>, received: Record<number, number>) {
  return {
    shipmentId: 101,
    clientScanKey: SYN_CLIENT_SCAN_KEY,
    scannedTracking: SYN_AWB_EXACT,
    notes: "",
    items: Object.keys(received).map((id) => ({
      itemId: Number(id),
      receivedQty: received[Number(id)],
      verified: true,
      issues: issueFor[Number(id)] ? [issueFor[Number(id)]] : [],
    })),
  }
}

// This is the body the Android app builds (android/.../data/ScanPayload.kt). Its unit tests build the same shape.
test("mobile scan body: a clear line sends no issue and a missing or damaged line follows the server's category rules", () => {
  const items = [
    { id: 201, expectedQty: 1 },
    { id: 202, expectedQty: 2 },
    { id: 203, expectedQty: 1 },
  ]
  const body = mobileBody(
    {
      201: null,
      202: { categoryCode: "missing_component", subIssueId: 501, qty: 2, ticketCode: "", notes: "" },
      203: { categoryCode: "damaged_product", subIssueId: null, qty: 1, ticketCode: "", notes: "SYN torn" },
    },
    { 201: 1, 202: 0, 203: 1 },
  )
  const verdict = validateScanSubmission(items, submissionFrom(body), SEEDED_CATEGORIES, SEEDED_SUB_ISSUES)
  assert.deepEqual(verdict, { ok: true })
})

test("mobile scan body: the uppercase codes the old app sent are refused, and a clear line must not carry an issue", () => {
  const items = [{ id: 201, expectedQty: 1 }]
  const old = mobileBody({ 201: { categoryCode: "CLEAR", subIssueId: null, qty: 1, ticketCode: "", notes: "" } }, { 201: 1 })
  const refused = validateScanSubmission(items, submissionFrom(old), SEEDED_CATEGORIES, SEEDED_SUB_ISSUES)
  assert.equal(refused.ok, false)

  const asIssue = mobileBody({ 201: { categoryCode: "no_issue", subIssueId: null, qty: 1, ticketCode: "", notes: "" } }, { 201: 1 })
  const alsoRefused = validateScanSubmission(items, submissionFrom(asIssue), SEEDED_CATEGORIES, SEEDED_SUB_ISSUES)
  assert.equal(alsoRefused.ok, false)
})

test("mobile scan body: a missing item must cover exactly the units not received", () => {
  const items = [{ id: 202, expectedQty: 2 }]
  const wrongQty = mobileBody(
    { 202: { categoryCode: "missing_component", subIssueId: 501, qty: 1, ticketCode: "", notes: "" } },
    { 202: 0 },
  )
  assert.equal(validateScanSubmission(items, submissionFrom(wrongQty), SEEDED_CATEGORIES, SEEDED_SUB_ISSUES).ok, false)

  const partial = mobileBody(
    { 202: { categoryCode: "missing_component", subIssueId: 501, qty: 1, ticketCode: "", notes: "" } },
    { 202: 1 },
  )
  assert.deepEqual(validateScanSubmission(items, submissionFrom(partial), SEEDED_CATEGORIES, SEEDED_SUB_ISSUES), { ok: true })
})

test("normalizeTracking cleans Amazon Order ID formats and barcode prefixes", () => {
  assert.equal(normalizeTracking("408-4485117-1368304").value, "408-4485117-1368304")
  assert.equal(normalizeTracking("ORD: 408-4485117-1368304").value, "408-4485117-1368304")
  assert.equal(normalizeTracking("#408-4485117-1368304").value, "408-4485117-1368304")
  assert.equal(normalizeTracking("ORDER: 40844851171368304").value, "408-4485117-1368304")
  assert.equal(normalizeTracking("40844851171368304").value, "408-4485117-1368304")
})

// Release APKs are signed only from GitHub secrets. These checks stop a keystore password, key alias
// or keystore file from coming back into this public repository.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const readRepoFile = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8")

test("build.gradle takes release signing only from the four RS_* variables", () => {
  const gradle = readRepoFile("android/app/build.gradle")
  const signing = gradle.slice(gradle.indexOf("signingConfigs {"), gradle.indexOf("buildTypes {"))
  assert.ok(signing.length > 0, "signingConfigs block found")
  assert.doesNotMatch(signing, /(storePassword|keyAlias|keyPassword)\s*\(?\s*["']/, "no literal password or alias")
  assert.doesNotMatch(signing, /\?:/, "no literal fallback after System.getenv")
  assert.doesNotMatch(signing, /\bdebug\s*\{/, "debug builds keep Android's default debug key")
  assert.doesNotMatch(gradle, /release\.keystore/, "no committed keystore path")
  for (const name of ["RS_KEYSTORE", "RS_KEYSTORE_PASSWORD", "RS_KEY_ALIAS", "RS_KEY_PASSWORD"]) {
    assert.match(signing, new RegExp(`System\\.getenv\\("${name}"\\)`))
  }
  // A literal stored in a variable and then passed to a signing property must fail too. With the
  // System.getenv("...") calls removed, the signing block holds no string literal at all, and every value
  // given to a signing property is a variable read from System.getenv and assigned nowhere else in the file.
  assert.doesNotMatch(signing.replace(/System\.getenv\("[A-Z_]+"\)/g, ""), /["']/, "no string literal in signingConfigs")
  for (const use of signing.matchAll(/\b(?:storeFile file|storePassword|keyAlias|keyPassword)\s*\(?\s*([A-Za-z_]\w*)/g)) {
    const id = use[1]
    assert.match(signing, new RegExp(`\\bdef ${id} = System\\.getenv\\("RS_[A-Z_]+"\\)`), `${id} is read from System.getenv`)
    assert.equal(gradle.match(new RegExp(`\\b${id}\\s*=(?!=)`, "g"))?.length, 1, `${id} is assigned only once`)
  }
})

test("pull-request APK builds never receive the signing secrets", () => {
  const workflow = readRepoFile(".github/workflows/return-scan-apk.yml")
  const steps = workflow.split(/\n\s*- name: /).slice(1)
  const withSecrets = steps.filter((step) => /secrets\.ANDROID_/.test(step))
  assert.ok(withSecrets.length >= 2, "the keystore and signed-build steps are found")
  for (const step of withSecrets) {
    assert.match(step, /\n\s*if: github\.event_name != 'pull_request'/, `step "${step.split("\n")[0].trim()}" runs only outside pull requests`)
  }
  assert.ok(
    steps.some((step) => /if: github\.event_name == 'pull_request'/.test(step) && /assembleRelease/.test(step) && !/secrets\./.test(step)),
    "a secret-free review build exists for pull requests",
  )
})

test("the APK workflow signs from secrets, fails on a missing one and pins the signer", () => {
  const workflow = readRepoFile(".github/workflows/return-scan-apk.yml")
  for (const match of workflow.matchAll(/^\s*(RS_[A-Z_]+):\s*(.+)$/gm)) {
    assert.match(match[2], /^\$\{\{ (secrets\.|runner\.temp \}\}\/)/, `${match[1]} must come from a secret`)
  }
  assert.doesNotMatch(workflow, /app\/release\.keystore/, "no fallback to a committed keystore")
  for (const name of ["ANDROID_KEYSTORE_B64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) {
    assert.ok(workflow.includes(`\${{ secrets.${name} }}`), `${name} is read from secrets`)
  }
  assert.ok(workflow.includes("::error::Repository secret $name is not set"), "a missing secret fails loudly")
  assert.ok(workflow.includes("--print-certs"), "the signing certificate is printed")
  assert.ok(workflow.includes("${{ vars.ANDROID_SIGNER_SHA256 }}"), "the signer can be pinned")
})

test(".gitignore exempts no keystore", () => {
  const lines = readRepoFile(".gitignore").split(/\r?\n/)
  assert.ok(lines.includes("*.keystore"))
  assert.ok(!lines.some((line) => line.startsWith("!") && /\.(keystore|jks)$/.test(line)))
})

// Checklist 12.4: the fallback update manifest follows the published release and never
// borrows another release's hash. These tests share the resolver's module cache and run in
// order: the cache starts empty, and the first test uses past timestamps so the route test
// after it still finds the cache due for a refresh.
test("fallback manifest file and DEFAULT_RELEASE are identical and name v1.0.80", () => {
  assert.deepEqual(JSON.parse(readRepoFile("data/return-scan-release.json")), DEFAULT_RELEASE)
  assert.equal(DEFAULT_RELEASE.versionCode, 10080)
  assert.equal(DEFAULT_RELEASE.versionName, "1.0.80")
  assert.ok(DEFAULT_RELEASE.downloadUrl?.endsWith("/v1.0.80/ReturnScan-v1.0.80.apk"))
  assert.match(DEFAULT_RELEASE.sha256, /^[a-f0-9]{64}$/)
})

const SYN_DIGEST = "a".repeat(64)
const synRelease = (run: number, digest?: string) => ({
  tag_name: `v1.0.${run}`,
  draft: false,
  prerelease: false,
  body: `SYN-release ${run}`,
  published_at: "2026-11-20T00:00:00Z",
  html_url: `https://example.invalid/SYN-release-${run}`,
  assets: [{
    name: `SYN-ReturnScan-v1.0.${run}.apk`,
    size: 1234,
    browser_download_url: `https://example.invalid/SYN-ReturnScan-v1.0.${run}.apk`,
    ...(digest ? { digest: `sha256:${digest}` } : {}),
  }],
})
const githubReplies = (list: unknown[]) => async () => new Response(JSON.stringify(list), { status: 200 })

function fakeRoute() {
  const out: { json?: any; redirect?: string } = {}
  const res = {
    json: (body: unknown) => { out.json = body },
    redirect: (url: string) => { out.redirect = url },
    setHeader: () => {},
    sendFile: () => {},
  } as unknown as Response
  return { req: { headers: {}, protocol: "https" } as unknown as Request, res, out }
}

test("a GitHub release without its own digest is not offered; the request times out and a failure is cached", async (t) => {
  const timeout = t.mock.method(AbortSignal, "timeout")
  const fetchMock = t.mock.method(globalThis, "fetch", githubReplies([synRelease(9001)]))
  const t0 = Date.now() - 2 * 24 * 60 * 60 * 1000

  const served = await resolveMobileRelease(t0)
  assert.deepEqual(served, DEFAULT_RELEASE, "the fallback is served, not v1.0.9001 with a borrowed hash")
  assert.equal(fetchMock.mock.callCount(), 1)
  const init = fetchMock.mock.calls[0].arguments[1] as RequestInit
  assert.ok(init.signal instanceof AbortSignal, "the GitHub request carries an abort signal")
  const ms = Number(timeout.mock.calls[0].arguments[0])
  assert.ok(ms > 0 && ms <= 10_000, `timeout is at most 10s (got ${ms})`)

  await resolveMobileRelease(t0 + 60_000)
  assert.equal(fetchMock.mock.callCount(), 1, "a failure is not retried on the next request")

  fetchMock.mock.mockImplementation(async () => { throw new TypeError("SYN-network down") })
  assert.deepEqual(await resolveMobileRelease(t0 + 5 * 60_000), DEFAULT_RELEASE, "an outage serves the fallback")
  assert.equal(fetchMock.mock.callCount(), 2, "retried once the failure window passes")
})

test("the download route and the manifest route resolve the same live release", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", githubReplies([synRelease(9002, SYN_DIGEST)]))

  const download = fakeRoute()
  await handleApkDownload(download.req, download.res)
  assert.equal(download.out.redirect, "https://example.invalid/SYN-ReturnScan-v1.0.9002.apk", "download follows the live release, not the static default")

  const manifest = fakeRoute()
  await handleLatestRelease(manifest.req, manifest.res)
  assert.equal(manifest.out.json.versionCode, 19002)
  assert.equal(manifest.out.json.sha256, SYN_DIGEST)
  assert.equal(manifest.out.json.downloadUrl, download.out.redirect)
  assert.equal(fetchMock.mock.callCount(), 1, "a good answer is cached")
})

test("a newer release without a digest does not displace the last good release", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", githubReplies([synRelease(9003), synRelease(9002, SYN_DIGEST)]))
  const served = await resolveMobileRelease(Date.now() + 11 * 60_000)
  assert.equal(fetchMock.mock.callCount(), 1, "the success cache expired, so GitHub was asked again")
  assert.equal(served.versionCode, 19002)
  assert.equal(served.sha256, SYN_DIGEST)
})
