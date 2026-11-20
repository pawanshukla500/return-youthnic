import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { checkForUpdates, isNewerRelease, selectWindowsSetupAsset } from "./src/update-check.js"

function feed(releases: unknown[]): typeof fetch {
  return (async () => ({ ok: true, json: async () => releases })) as unknown as typeof fetch
}

function withExe(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    assets: [{ name: `Return.App.Setup.${tag}.exe`, browser_download_url: `https://example.invalid/${tag}.exe` }],
    ...extra,
  }
}

async function checkAs(version: string, fetchImpl: typeof fetch) {
  const before = process.env.RETURN_APP_VERSION
  process.env.RETURN_APP_VERSION = version
  try {
    return await checkForUpdates(fetchImpl)
  } finally {
    if (before === undefined) delete process.env.RETURN_APP_VERSION
    else process.env.RETURN_APP_VERSION = before
  }
}

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

  it("offers the Windows .exe even when other OS installers are listed first", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => [
        {
          tag_name: "desktop-v9.9.9.1",
          assets: [
            { name: "Return.App.Setup.9.9.9.dmg", browser_download_url: "https://example.invalid/setup.dmg" },
            { name: "Return.App.Setup.9.9.9.deb", browser_download_url: "https://example.invalid/setup.deb" },
            { name: "Return.App.Setup.9.9.9.exe", browser_download_url: "https://example.invalid/setup.exe" },
          ],
        },
      ],
    })) as unknown as typeof fetch
    const result = await checkForUpdates(fakeFetch)
    assert.equal(result.ok, true)
    assert.equal(result.downloadUrl, "https://example.invalid/setup.exe")
    assert.deepEqual(selectWindowsSetupAsset(result.downloads), {
      name: "Return.App.Setup.9.9.9.exe",
      url: "https://example.invalid/setup.exe",
    })
  })

  it("picks the highest desktop release, not the first one listed (order seen on 2026-11-20)", async () => {
    const result = await checkAs(
      "1.3.9",
      feed([
        { tag_name: "v1.0.80", assets: [{ name: "return-scan.apk", browser_download_url: "https://example.invalid/a.apk" }] },
        { tag_name: "v1.0.76", assets: [{ name: "return-scan.apk", browser_download_url: "https://example.invalid/b.apk" }] },
        withExe("desktop-v1.3.9.154"),
        withExe("desktop-v1.3.10.157"),
      ]),
    )
    assert.equal(result.ok, true)
    assert.equal(result.latestTag, "desktop-v1.3.10.157")
    assert.equal(result.downloadUrl, "https://example.invalid/desktop-v1.3.10.157.exe")
    assert.equal(result.updateAvailable, true)
  })

  it("compares version parts as numbers: 1.3.100 is newer than 1.3.99", async () => {
    const result = await checkAs("1.3.99", feed([withExe("desktop-v1.3.100.5"), withExe("desktop-v1.3.99.9")]))
    assert.equal(result.latestTag, "desktop-v1.3.100.5")
    assert.equal(result.updateAvailable, true)
    const reversed = await checkAs("1.3.99", feed([withExe("desktop-v1.3.99.9"), withExe("desktop-v1.3.100.5")]))
    assert.equal(reversed.latestTag, "desktop-v1.3.100.5")
  })

  it("breaks a same-version tie on the run number", async () => {
    const result = await checkAs("1.3.10", feed([withExe("desktop-v1.3.10.99"), withExe("desktop-v1.3.10.160")]))
    assert.equal(result.latestTag, "desktop-v1.3.10.160")
    assert.equal(result.updateAvailable, false)
  })

  it("skips a newer desktop release that has no Windows .exe", async () => {
    const result = await checkAs(
      "1.3.9",
      feed([
        {
          tag_name: "desktop-v1.3.11.200",
          assets: [
            { name: "latest.yml", browser_download_url: "https://example.invalid/latest.yml" },
            { name: "Return.App.Setup.1.3.11.exe.blockmap", browser_download_url: "https://example.invalid/x.blockmap" },
          ],
        },
        withExe("desktop-v1.3.10.157"),
      ]),
    )
    assert.equal(result.latestTag, "desktop-v1.3.10.157")
    assert.equal(result.downloadUrl, "https://example.invalid/desktop-v1.3.10.157.exe")
  })

  it("skips draft and prerelease desktop releases", async () => {
    const result = await checkAs(
      "1.3.10",
      feed([
        withExe("desktop-v1.3.12.1", { draft: true }),
        withExe("desktop-v1.3.11.1", { prerelease: true }),
        withExe("desktop-v1.3.10.157"),
      ]),
    )
    assert.equal(result.latestTag, "desktop-v1.3.10.157")
    assert.equal(result.updateAvailable, false)
  })

  it("reports no release when no desktop release qualifies", async () => {
    const result = await checkAs("1.3.10", feed([withExe("desktop-v1.3.12.1", { draft: true }), { tag_name: "v1.0.80", assets: [] }]))
    assert.equal(result.ok, true)
    assert.equal(result.latestTag, null)
    assert.equal(result.updateAvailable, false)
  })

  it("fails closed when the feed is unreachable", async () => {
    const failing = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch
    const result = await checkForUpdates(failing)
    assert.equal(result.ok, false)
    assert.equal(result.updateAvailable, false)
    assert.ok(result.error)
  })
})
