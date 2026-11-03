import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  getBrowserWorkspaceRect,
  hideSupplierViews,
  layoutSupplierViews,
  registerSupplierView,
  setBrowserWorkspaceRect,
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
    registerSupplierView("meesho", toView(view))
    assert.deepEqual(supplierViewStatus(), [{ panelKey: "meesho", visible: false }])

    assert.equal(showSupplierView("meesho"), true)
    assert.deepEqual(calls, ["remove", "add", "show", "focus"])
    assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1600, height: 900 })
    assert.deepEqual(supplierViewStatus(), [{ panelKey: "meesho", visible: true }])

    layoutSupplierViews()
    assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1600, height: 900 })

    assert.deepEqual(hideSupplierViews(), ["meesho"])
    assert.equal(calls[calls.length - 1], "remove")
    assert.deepEqual(supplierViewStatus(), [{ panelKey: "meesho", visible: false }])

    assert.equal(showSupplierView("meesho"), true)
    assert.deepEqual(supplierViewStatus(), [{ panelKey: "meesho", visible: true }])

    unregisterSupplierView("meesho", toView(view))
    assert.deepEqual(supplierViewStatus(), [])
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

describe("dashboard browser workspace rect", () => {
  it("fills the window when no workspace rect is set", () => {
    const { host } = fakeHost()
    setSupplierViewHost(host)
    setBrowserWorkspaceRect(null)
    assert.equal(getBrowserWorkspaceRect(), null)
    assert.deepEqual(supplierViewBounds(), { x: 0, y: 0, width: 1600, height: 900 })
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
})
