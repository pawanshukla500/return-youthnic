import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  AUTO_UPDATES_STORAGE_KEY,
  LAST_CHECKED_STORAGE_KEY,
  classifyUpdateResult,
  formatLastChecked,
  pickSetupAsset,
  readAutoUpdatesPreference,
  readLastCheckedIso,
  writeAutoUpdatesPreference,
  writeLastCheckedIso,
} from "./Updates"
import type { UpdateCheckResult } from "../types/engine"

type StorageLike = Pick<Storage, "getItem" | "setItem"> | null

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> & {
  dump: () => Record<string, string>
} {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    dump: () => Object.fromEntries(map),
  }
}

function throwingStorage(): StorageLike {
  return {
    getItem: () => {
      throw new Error("denied")
    },
    setItem: () => {
      throw new Error("denied")
    },
  }
}

describe("Updates page preference persistence", () => {
  it("defaults auto-updates to on when never set or storage is unavailable", () => {
    assert.equal(readAutoUpdatesPreference(memoryStorage()), true)
    assert.equal(readAutoUpdatesPreference(null), true)
    assert.equal(readAutoUpdatesPreference(throwingStorage()), true)
  })

  it("reads the persisted auto-updates flag ('0' means off)", () => {
    assert.equal(readAutoUpdatesPreference(memoryStorage({ [AUTO_UPDATES_STORAGE_KEY]: "1" })), true)
    assert.equal(readAutoUpdatesPreference(memoryStorage({ [AUTO_UPDATES_STORAGE_KEY]: "0" })), false)
  })

  it("writes the auto-updates flag as '1'/'0'", () => {
    const storage = memoryStorage()
    writeAutoUpdatesPreference(storage, false)
    assert.equal(storage.getItem(AUTO_UPDATES_STORAGE_KEY), "0")
    writeAutoUpdatesPreference(storage, true)
    assert.equal(storage.getItem(AUTO_UPDATES_STORAGE_KEY), "1")
    writeAutoUpdatesPreference(null, false) // must not throw without storage
  })

  it("round-trips the last-checked ISO timestamp", () => {
    const storage = memoryStorage()
    assert.equal(readLastCheckedIso(storage), null)
    writeLastCheckedIso(storage, "2026-11-04T10:20:30.000Z")
    assert.equal(readLastCheckedIso(storage), "2026-11-04T10:20:30.000Z")
  })

  it("rejects a missing or unparseable last-checked value", () => {
    assert.equal(readLastCheckedIso(memoryStorage({ [LAST_CHECKED_STORAGE_KEY]: "not-a-date" })), null)
    assert.equal(readLastCheckedIso(throwingStorage()), null)
  })
})

describe("Updates page result classification", () => {
  const base: UpdateCheckResult = {
    ok: true,
    currentVersion: "1.2.0",
    latestTag: null,
    downloadUrl: null,
    downloads: [],
    updateAvailable: false,
  }

  it("classifies ok + updateAvailable as available", () => {
    assert.equal(
      classifyUpdateResult({ ...base, updateAvailable: true, latestTag: "desktop-v1.3.0.1" }),
      "available",
    )
  })

  it("classifies ok + !updateAvailable as up-to-date", () => {
    assert.equal(classifyUpdateResult({ ...base, latestTag: "desktop-v1.2.0.82" }), "up-to-date")
  })

  it("classifies !ok as error even if updateAvailable is set", () => {
    assert.equal(
      classifyUpdateResult({ ...base, ok: false, error: "Release feed answered HTTP 503.", updateAvailable: true }),
      "error",
    )
  })
})

describe("Updates page setup asset picking", () => {
  it("prefers the Windows .exe asset", () => {
    const picked = pickSetupAsset([
      { name: "Return.App.Setup.1.3.0.dmg", url: "https://example.invalid/setup.dmg" },
      { name: "Return.App.Setup.1.3.0.exe", url: "https://example.invalid/setup.exe" },
    ])
    assert.equal(picked?.name, "Return.App.Setup.1.3.0.exe")
  })

  it("falls back to the first asset with a URL, and yields null when none", () => {
    assert.equal(
      pickSetupAsset([{ name: "notes.txt", url: "" }]),
      null,
    )
    assert.equal(pickSetupAsset([{ name: "setup.dmg", url: "https://example.invalid/setup.dmg" }])?.name, "setup.dmg")
    assert.equal(pickSetupAsset([]), null)
    assert.equal(pickSetupAsset(null), null)
    assert.equal(pickSetupAsset(undefined), null)
  })
})

describe("Updates page last-checked formatting", () => {
  it("formats a valid ISO timestamp and rejects garbage", () => {
    const label = formatLastChecked("2026-11-04T10:20:30.000Z")
    assert.ok(label && label.length > 0)
    assert.equal(formatLastChecked("not-a-date"), null)
  })
})
