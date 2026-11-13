import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  clampWindowBounds,
  parseSavedBounds,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
} from "./window-bounds.js"

/**
 * The desktop shell restores saved window bounds across restarts. These tests
 * pin the sanity rules so a garbage file (e.g. the reported 159x27 restore) or
 * a removed monitor can never again leave the operator with a broken window.
 */

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const secondary = { workArea: { x: 1920, y: 0, width: 1280, height: 720 } }

describe("parseSavedBounds", () => {
  it("accepts a well-formed rect", () => {
    assert.deepEqual(parseSavedBounds({ x: 10, y: 20, width: 1400, height: 900 }), { x: 10, y: 20, width: 1400, height: 900 })
  })

  it("rejects non-objects and null", () => {
    assert.equal(parseSavedBounds(null), null)
    assert.equal(parseSavedBounds("1400x900"), null)
    assert.equal(parseSavedBounds(42), null)
    assert.equal(parseSavedBounds([0, 0, 1400, 900]), null)
  })

  it("rejects missing fields and wrong types", () => {
    assert.equal(parseSavedBounds({ x: 0, y: 0, width: 1400 }), null)
    assert.equal(parseSavedBounds({ x: "0", y: 0, width: 1400, height: 900 }), null)
  })

  it("rejects non-finite and non-positive sizes", () => {
    assert.equal(parseSavedBounds({ x: 0, y: 0, width: Number.NaN, height: 900 }), null)
    assert.equal(parseSavedBounds({ x: 0, y: 0, width: 1400, height: Number.POSITIVE_INFINITY }), null)
    assert.equal(parseSavedBounds({ x: 0, y: 0, width: 0, height: 900 }), null)
    assert.equal(parseSavedBounds({ x: 0, y: 0, width: 1400, height: -20 }), null)
  })

  it("accepts negative positions from multi-monitor layouts", () => {
    // A monitor left of the primary has negative coordinates; that is geometry,
    // not corruption, and the center check in clampWindowBounds handles it.
    assert.deepEqual(parseSavedBounds({ x: -1400, y: 100, width: 1400, height: 900 }), { x: -1400, y: 100, width: 1400, height: 900 })
  })
})

describe("clampWindowBounds", () => {
  it("keeps a valid on-screen rect unchanged", () => {
    const saved = { x: 100, y: 60, width: 1400, height: 900 }
    assert.deepEqual(clampWindowBounds(saved, [primary, secondary]), saved)
  })

  it("clamps a garbage 159x27 size up to the window minimum, keeping an on-screen position", () => {
    assert.deepEqual(clampWindowBounds({ x: 200, y: 150, width: 159, height: 27 }, [primary]), {
      x: 200,
      y: 150,
      width: WINDOW_MIN_WIDTH,
      height: WINDOW_MIN_HEIGHT,
    })
  })

  it("keeps a window whose center is on the secondary display", () => {
    const saved = { x: 2300, y: 100, width: 1400, height: 900 }
    assert.deepEqual(clampWindowBounds(saved, [primary, secondary]), saved)
  })

  it("falls back to a centered 1280x860 default when the center is on no display", () => {
    // Persisted while docked to a monitor that is no longer connected.
    const result = clampWindowBounds({ x: 5000, y: 400, width: 1400, height: 900 }, [primary])
    assert.deepEqual(result, {
      x: Math.round((primary.workArea.width - DEFAULT_WINDOW_WIDTH) / 2),
      y: Math.round((primary.workArea.height - DEFAULT_WINDOW_HEIGHT) / 2),
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
    })
  })

  it("falls back to a centered default when saved fully off-screen to the left", () => {
    const result = clampWindowBounds({ x: -3000, y: 100, width: 1400, height: 900 }, [primary, secondary])
    assert.deepEqual(result, {
      x: Math.round((primary.workArea.width - DEFAULT_WINDOW_WIDTH) / 2),
      y: Math.round((primary.workArea.height - DEFAULT_WINDOW_HEIGHT) / 2),
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
    })
  })

  it("clamps the centered default position into a work area smaller than the default size", () => {
    const tiny = { workArea: { x: 0, y: 0, width: 1024, height: 700 } }
    const result = clampWindowBounds({ x: 9999, y: 9999, width: 1400, height: 900 }, [tiny])
    assert.deepEqual(result, { x: 0, y: 0, width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT })
  })

  it("returns the plain default at the origin when no display information exists", () => {
    assert.deepEqual(clampWindowBounds({ x: 0, y: 0, width: 159, height: 27 }, []), {
      x: 0,
      y: 0,
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
    })
  })

  it("treats a center exactly on the work-area edge as on-screen", () => {
    // Window whose center sits exactly on the right/bottom edge of the work area.
    const saved = { x: 1358, y: 688, width: 1024, height: 680 }
    assert.deepEqual(clampWindowBounds(saved, [primary]), saved)
  })
})
