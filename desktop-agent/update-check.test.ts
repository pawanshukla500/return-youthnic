import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { checkForUpdates, isNewerRelease } from "./src/update-check.js"

describe("desktop update check", () => {
  it("compares semver against desktop-v tags (run number ignored)", () => {
    assert.equal(isNewerRelease("1.2.0", "desktop-v1.2.0.16"), false)
    assert.equal(isNewerRelease("1.1.0", "desktop-v1.2.0.16"), true)
    assert.equal(isNewerRelease("1.2.0", "desktop-v1.1.0.12"), false)
    assert.equal(isNewerRelease("2.0.0", "desktop-v1.9.9.99"), false)
    assert.equal(isNewerRelease("1.2.0", "v1.0.58"), false)
  })

  it("reports an available update with a download link", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => [
        { tag_name: "v1.0.58", assets: [] },
        {
          tag_name: "desktop-v9.9.9.1",
          assets: [{ name: "setup.exe", browser_download_url: "https://example.invalid/setup.exe" }],
        },
      ],
    })) as unknown as typeof fetch
    const result = await checkForUpdates(fakeFetch)
    assert.equal(result.ok, true)
    assert.equal(result.updateAvailable, true)
    assert.equal(result.latestTag, "desktop-v9.9.9.1")
    assert.equal(result.downloadUrl, "https://example.invalid/setup.exe")
    assert.deepEqual(result.downloads, [{ name: "setup.exe", url: "https://example.invalid/setup.exe" }])
  })

  it("fails closed when the feed is unreachable", async () => {
    const failing = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch
    const result = await checkForUpdates(failing)
    assert.equal(result.ok, false)
    assert.equal(result.updateAvailable, false)
    assert.ok(result.error)
  })
})
