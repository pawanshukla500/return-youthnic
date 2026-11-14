import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  ensureSupplierView,
  getBrowserWorkspaceRect,
  hasSupplierView,
  hideSupplierViews,
  layoutSupplierViews,
  notifyWindowGeometryChanged,
  registerSupplierView,
  setBrowserWorkspaceRect,
  setFullscreenSupplierView,
  setSupplierViewHost,
  showSupplierView,
  supplierViewBounds,
  supplierViewStatus,
  unregisterSupplierView,
  type SupplierViewHost,
} from "./src/native-browser-view.js"

type FakeView = { bounds: unknown; setBounds(bounds: unknown): void }

function fakeView(): FakeView {
  return {
    bounds: null,
    setBounds(bounds: unknown) {
      this.bounds = bounds
    },
  }
}

function toView(fake: FakeView) {
  return fake as unknown as Parameters<typeof registerSupplierView>[1]
}

function fakeHost() {
  const calls: string[] = []
  const host: SupplierViewHost = {
    addView: () => {
      calls.push("add")
    },
    removeView: () => {
      calls.push("remove")
    },
    contentBounds: () => ({ x: 0, y: 0, width: 1600, height: 900 }),
    showWindow: () => {
      calls.push("show")
    },
    focusWindow: () => {
      calls.push("focus")
    },
    isWindowDestroyed: () => false,
  }
  return { host, calls }
}

describe("main-window supplier view manager", () => {
  it("reports no views and hides nothing when empty", () => {
    setSupplierViewHost(null)
    assert.deepEqual(supplierViewStatus(), [])
    assert.deepEqual(hideSupplierViews(), [])
    assert.equal(showSupplierView("meesho"), false)
  })

  it("shows, hides and re-shows a registered view inside the shell host", () => {
    const { host, calls } = fakeHost()
    const view = fakeView()
    setSupplierViewHost(host)
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 520 })
    registerSupplierView("meesho", toView(view))
    assert.deepEqual(supplierViewStatus(), [{ panelKey: "meesho", visible: false }])

    assert.equal(showSupplierView("meesho"), true)
    // Focus discipline (VAL-WIN-004): low-level showSupplierView attaches the
    // view without touching OS focus. Explicit user actions use
    // showSupplierViewForUser(..., { focus: true }) instead.
    assert.deepEqual(calls, ["remove", "add"])
    assert.deepEqual(view.bounds, { x: 240, y: 150, width: 980, height: 520 })
    assert.deepEqual(supplierViewStatus(), [{ panelKey: "meesho", visible: true }])

    layoutSupplierViews()
    assert.deepEqual(view.bounds, { x: 240, y: 150, width: 980, height: 520 })

    assert.deepEqual(hideSupplierViews(), ["meesho"])
    assert.equal(calls[calls.length - 1], "remove")
    assert.deepEqual(supplierViewStatus(), [{ panelKey: "meesho", visible: false }])

    assert.equal(showSupplierView("meesho"), true)
    assert.deepEqual(supplierViewStatus(), [{ panelKey: "meesho", visible: true }])

    unregisterSupplierView("meesho", toView(view))
    assert.deepEqual(supplierViewStatus(), [])
    setBrowserWorkspaceRect(null)
    setSupplierViewHost(null)
  })

  it("refuses to show when the host window is gone", () => {
    const { host } = fakeHost()
    setSupplierViewHost({ ...host, isWindowDestroyed: () => true })
    const view = fakeView()
    registerSupplierView("flipkart", toView(view))
    assert.equal(showSupplierView("flipkart"), false)
    layoutSupplierViews()
    unregisterSupplierView("flipkart", toView(view))
    setSupplierViewHost(null)
  })
})

describe("ensureSupplierView for manually opened tabs", () => {
  it("reports no view for an unknown panel and a view after registration", () => {
    assert.equal(hasSupplierView("syn-unknown-panel"), false)
    const view = fakeView()
    registerSupplierView("syn-manual", toView(view))
    assert.equal(hasSupplierView("syn-manual"), true)
    assert.equal(hasSupplierView("tab-syn-manual"), true)
    unregisterSupplierView("syn-manual", toView(view))
    assert.equal(hasSupplierView("syn-manual"), false)
  })

  it("keeps an existing view without opening a second browser", async () => {
    const view = fakeView()
    registerSupplierView("syn-alive", toView(view))
    const created = await ensureSupplierView("syn-alive", "https://syn.example/portal")
    assert.equal(created, true)
    // The registered view is untouched (a second open would have thrown in plain node).
    assert.equal(hasSupplierView("syn-alive"), true)
    unregisterSupplierView("syn-alive", toView(view))
  })

  it("returns false instead of launching a browser when the native adapter is unavailable", async () => {
    // Plain-node test process: no Electron, so there is no in-window view to
    // create. The route keeps its metadata-only behaviour on those engines
    // and must never spawn an external system browser from here.
    const created = await ensureSupplierView("syn-headless", "https://syn.example/portal")
    assert.equal(created, false)
    assert.equal(hasSupplierView("syn-headless"), false)
    assert.deepEqual(supplierViewStatus(), [])
  })
})

describe("dashboard browser workspace rect", () => {
  it("stays hidden when no workspace rect is set instead of filling the window", () => {
    const { host } = fakeHost()
    setSupplierViewHost(host)
    setBrowserWorkspaceRect(null)
    assert.equal(getBrowserWorkspaceRect(), null)
    assert.equal(supplierViewBounds(), null)
    // The null rect must also hide visible views instead of re-fitting them.
    const view = fakeView()
    registerSupplierView("SYN-meesho", toView(view))
    assert.equal(showSupplierView("SYN-meesho"), false)
    unregisterSupplierView("SYN-meesho", toView(view))
    setSupplierViewHost(null)
  })

  it("stays hidden when the workspace rect is smaller than 120x120", () => {
    const { host } = fakeHost()
    setSupplierViewHost(host)
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 119, height: 500 })
    assert.equal(supplierViewBounds(), null)
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 119 })
    assert.equal(supplierViewBounds(), null)
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 0, height: 0 })
    assert.equal(supplierViewBounds(), null)
    setBrowserWorkspaceRect(null)
    setSupplierViewHost(null)
  })

  it("confines a visible view to the dashboard workspace rect", () => {
    const { host } = fakeHost()
    const view = fakeView()
    setSupplierViewHost(host)
    registerSupplierView("meesho", toView(view))
    setBrowserWorkspaceRect({ x: 10, y: 200, width: 800, height: 500 })
    assert.deepEqual(supplierViewBounds(), { x: 10, y: 200, width: 800, height: 500 })
    assert.equal(showSupplierView("meesho"), true)
    assert.deepEqual(view.bounds, { x: 10, y: 200, width: 800, height: 500 })
    layoutSupplierViews()
    assert.deepEqual(view.bounds, { x: 10, y: 200, width: 800, height: 500 })
    unregisterSupplierView("meesho", toView(view))
    setBrowserWorkspaceRect(null)
    setSupplierViewHost(null)
  })

  it("clamps an oversized rect into the window instead of overflowing", () => {
    const { host } = fakeHost()
    setSupplierViewHost(host)
    setBrowserWorkspaceRect({ x: -50, y: 850, width: 5000, height: 5000 })
    assert.deepEqual(supplierViewBounds(), { x: 0, y: 850, width: 1600, height: 50 })
    setBrowserWorkspaceRect(null)
    setSupplierViewHost(null)
  })

  it("detaches visible views when the rect becomes null (sidebar tab switch)", () => {
    const { host, calls } = fakeHost()
    const view = fakeView()
    setSupplierViewHost(host)
    registerSupplierView("SYN-meesho", toView(view))
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 520 })
    assert.equal(showSupplierView("SYN-meesho"), true)
    assert.deepEqual(supplierViewStatus(), [{ panelKey: "SYN-meesho", visible: true }])

    // Switching away from Browsers reports desktop:browser-rect = null.
    setBrowserWorkspaceRect(null)
    assert.equal(supplierViewBounds(), null)
    assert.ok(calls.includes("remove"), "expected the view to detach from the window")
    assert.deepEqual(supplierViewStatus(), [{ panelKey: "SYN-meesho", visible: false }])

    // Switching back re-attaches at the exact bounded coordinates.
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 520 })
    assert.equal(showSupplierView("SYN-meesho"), true)
    assert.deepEqual(view.bounds, { x: 240, y: 150, width: 980, height: 520 })
    unregisterSupplierView("SYN-meesho", toView(view))
    setBrowserWorkspaceRect(null)
    setSupplierViewHost(null)
  })

  it("expands to the full window only through explicit fullscreen mode", () => {
    const { host } = fakeHost()
    setSupplierViewHost(host)
    setBrowserWorkspaceRect(null)
    setFullscreenSupplierView(true)
    assert.deepEqual(supplierViewBounds(), { x: 0, y: 0, width: 1600, height: 900 })
    setFullscreenSupplierView(false)
    assert.equal(supplierViewBounds(), null)
    setSupplierViewHost(null)
  })

  it("escape exits fullscreen back to bounded coordinates", () => {
    const { host } = fakeHost()
    const view = fakeView()
    setSupplierViewHost(host)
    registerSupplierView("SYN-meesho", toView(view))
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 520 })
    setFullscreenSupplierView(true)
    assert.deepEqual(supplierViewBounds(), { x: 0, y: 0, width: 1600, height: 900 })
    setFullscreenSupplierView(false)
    assert.deepEqual(supplierViewBounds(), { x: 240, y: 150, width: 980, height: 520 })
    assert.equal(showSupplierView("SYN-meesho"), true)
    assert.deepEqual(view.bounds, { x: 240, y: 150, width: 980, height: 520 })
    unregisterSupplierView("SYN-meesho", toView(view))
    setBrowserWorkspaceRect(null)
    setSupplierViewHost(null)
  })

  it("re-syncs bounds after window resize, move, maximize and DPI changes", () => {
    const { host } = fakeHost()
    const view = fakeView()
    setSupplierViewHost(host)
    registerSupplierView("SYN-meesho", toView(view))
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 520 })
    assert.equal(showSupplierView("SYN-meesho"), true)
    for (const event of ["resize", "move", "maximize", "unmaximize", "display-metrics-changed"] as const) {
      notifyWindowGeometryChanged(event)
      assert.deepEqual(view.bounds, { x: 240, y: 150, width: 980, height: 520 }, `stale bounds after ${event}`)
    }
    unregisterSupplierView("SYN-meesho", toView(view))
    setBrowserWorkspaceRect(null)
    setSupplierViewHost(null)
  })
})
