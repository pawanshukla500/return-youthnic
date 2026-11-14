import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { localEncryptionAvailable as sourceRunAvailable } from "./src/local-secrets.js"

/**
 * Regression test for the packaged-app DPAPI breakage: in the esbuild CJS
 * bundle (`npm run desktop:build`) `import.meta.url` shims to `undefined`, so
 * a `createRequire(import.meta.url)` base throws and OS encryption is never
 * found (operator screenshot: "Secure credential storage is unavailable").
 *
 * This test bundles the REAL local-secrets module with the same esbuild
 * invocation shape as the desktop build (bundle, platform=node, format=cjs,
 * target=node20), with `electron` stubbed through a temp node_modules whose
 * safeStorage is a reversible xor — no network, no Electron. It asserts the
 * bundled module reaches the stub (fix works) and that the pre-fix
 * `createRequire(import.meta.url)` logic in the same bundle shape does not
 * (negative control — the test can actually catch the regression).
 */

const testDir = dirname(fileURLToPath(import.meta.url))
const localSecretsEntry = join(testDir, "src", "local-secrets.ts")

const ELECTRON_STUB = `// Test stub simulating Electron's safeStorage in the packaged app.
const KEY = 0x5a
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(String(plainText), "utf8").map((b) => b ^ KEY),
  decryptString: (encrypted) => Buffer.from(encrypted).map((b) => b ^ KEY).toString("utf8"),
}
module.exports = { safeStorage }
`

const NEGATIVE_CONTROL_ENTRY = `// The PRE-FIX logic: createRequire(import.meta.url) fails in a CJS bundle.
import { createRequire } from "node:module"
function oldSafeStorage() {
  try {
    const req = createRequire(import.meta.url)
    const electron = req("electron")
    const ss = electron?.safeStorage
    if (!ss || typeof ss.isEncryptionAvailable !== "function") return null
    if (!ss.isEncryptionAvailable()) return null
    return ss
  } catch {
    return null
  }
}
globalThis.__oldAvailable = oldSafeStorage() !== null
`

type BundleCheck = { available: boolean; stored: string; roundtrip: boolean }

/** Bundles entrySource as CJS in a temp dir with an electron stub on its module path. */
async function bundleWithStubElectron(entrySource: string, entryName: string): Promise<{ dir: string; bundle: string }> {
  const dir = mkdtempSync(join(tmpdir(), "local-secrets-bundle-"))
  mkdirSync(join(dir, "node_modules", "electron"), { recursive: true })
  writeFileSync(join(dir, "node_modules", "electron", "package.json"), JSON.stringify({ name: "electron", version: "0.0.0-sim", main: "index.js" }))
  writeFileSync(join(dir, "node_modules", "electron", "index.js"), ELECTRON_STUB)
  const entry = join(dir, entryName)
  writeFileSync(entry, entrySource)
  const bundle = join(dir, "bundle.cjs")
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: bundle,
    logLevel: "silent",
  })
  return { dir, bundle }
}

describe("local-secrets in the esbuild CJS bundle shape", () => {
  it("source-run sanity: no electron in plain node, so the fallback path reports unavailable", () => {
    assert.equal(sourceRunAvailable(), false)
  })

  it("reaches safeStorage when bundled CJS (DPAPI path works in the packaged shape)", async () => {
    const { dir, bundle } = await bundleWithStubElectron(
      `import { localEncryptionAvailable, protectSecret, revealSecret } from ${JSON.stringify(localSecretsEntry)}\n` +
        `const secret = "SYN-bundle-secret-1"\n` +
        `const stored = protectSecret(secret)\n` +
        `globalThis.__bundleCheck = {\n` +
        `  available: localEncryptionAvailable(),\n` +
        `  stored,\n` +
        `  roundtrip: revealSecret(stored) === secret,\n` +
        `}\n`,
      "entry.ts",
    )
    try {
      createRequire(join(dir, "probe.cjs"))(bundle)
      const check = (globalThis as { __bundleCheck?: BundleCheck }).__bundleCheck
      delete (globalThis as { __bundleCheck?: BundleCheck }).__bundleCheck
      assert.ok(check, "bundled probe must report its result")
      assert.equal(check.available, true, "bundled localEncryptionAvailable() must be true with a reachable safeStorage")
      assert.ok(check.stored.startsWith("dpapi:"), `protectSecret must use the dpapi prefix, got: ${check.stored}`)
      assert.equal(check.roundtrip, true, "protect/reveal must round-trip the secret")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("negative control: the pre-fix createRequire(import.meta.url) logic fails in the same bundle shape", async () => {
    const { dir, bundle } = await bundleWithStubElectron(NEGATIVE_CONTROL_ENTRY, "old-entry.ts")
    try {
      createRequire(join(dir, "probe.cjs"))(bundle)
      assert.equal(
        (globalThis as { __oldAvailable?: boolean }).__oldAvailable,
        false,
        "pre-fix logic must not reach safeStorage in a CJS bundle",
      )
    } finally {
      delete (globalThis as { __oldAvailable?: boolean }).__oldAvailable
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
