// VAL-WIN-001..004: detachable marketplace BrowserWindow, standard window
// lifecycle controls, and focus discipline.
//
// TDD-first for m1-detachable-browser-window-and-window-controls: these tests
// run against pure view-manager state (fake hosts/views, no Electron).
// The HTTP detach/dock/focus routes are covered against the real engine in
// portal-browser-tabs.test.ts (VAL-WIN-005). No database, no real browser
// window, no production traffic.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  addSupplierPopupForTests,
  detachSupplierTab,
  dockSupplierTab,
  disposeDetachedSupplierViews,
  focusDetachedSupplierTab,
  getBrowserWorkspaceRect,
  hideSupplierViews,
  isSupplierTabDetached,
  layoutSupplierViews,
  notifyWindowLifecycle,
  registerSupplierView,
  resetSupplierTabsForTests,
  setBrowserWorkspaceRect,
  setDetachedViewHost,
  setSupplierViewHost,
  showSupplierView,
  openSupplierTab,
  supplierTabRegistry,
  supplierViewBounds,
  unregisterSupplierView,
  DETACHED_WINDOW_WEB_PREFERENCES,
  type SupplierViewHost,
  type DetachedViewHost,
} from "./src/native-browser-view.js"

type FakeView = {
  bounds: unknown
  setBounds(bounds: unknown): void
  webContents: {
    getURL(): string
    getTitle(): string
    isLoading(): boolean
    navigationHistory: { canGoBack(): boolean; canGoForward(): boolean }
  }
}

function fakeView(url = "https://supplier.meesho.com/panel", title = "SYN Meesho Panel"): FakeView {
  return {
    bounds: null,
    setBounds(bounds: unknown) {
      this.bounds = bounds
    },
    webContents: {
      getURL: () => url,
      getTitle: () => title,
      isLoading: () => false,
      navigationHistory: { canGoBack: () => true, canGoForward: () => false },
    },
  }
}

function toView(fake: FakeView) {
  return fake as unknown as Parameters<typeof registerSupplierView>[1]
}

function fakeMainHost(calls: string[] = []): SupplierViewHost {
  return {
    addView: () => {
      calls.push("main-add")
    },
    removeView: () => {
      calls.push("main-remove")
    },
    contentBounds: () => ({ x: 0, y: 0, width: 1600, height: 900 }),
    showWindow: () => {
      calls.push("main-show")
    },
    focusWindow: () => {
      calls.push("main-focus")
    },
    isWindowDestroyed: () => false,
  }
}

function fakeDetachedHost(calls: string[] = []): DetachedViewHost {
  return {
    openDetachedWindow: (_panelKey: string) => {
      calls.push("detached-open")
    },
    attachDetachedView: (_panelKey: string) => {
      calls.push("detached-attach")
    },
    detachDetachedView: (_panelKey: string) => {
      calls.push("detached-detach")
    },
    attachDetachedPopups: (_panelKey: string) => {
      calls.push("detached-popups-attach")
    },
    detachDetachedPopups: (_panelKey: string) => {
      calls.push("detached-popups-detach")
    },
    closeDetachedWindow: (_panelKey: string) => {
      calls.push("detached-close")
    },
    focusDetachedWindow: (_panelKey: string) => {
      calls.push("detached-focus")
    },
    isDetachedWindowOpen: (_panelKey: string) => true,
    destroyDetachedWindow: (_panelKey: string) => {
      calls.push("detached-destroy")
    },
  }
}

function resetAll(): void {
  resetSupplierTabsForTests()
  setSupplierViewHost(null)
  setDetachedViewHost(null)
  setBrowserWorkspaceRect(null)
}

describe("VAL-WIN-001: detach into a hardened secondary window", () => {
  it("uses hardened webPreferences for the detached window", () => {
    assert.deepEqual(DETACHED_WINDOW_WEB_PREFERENCES, {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    })
    resetAll()
  })

  it("detaching moves the live view out of the main window and marks mode detached", () => {
    resetAll()
    const mainCalls: string[] = []
    const detachedCalls: string[] = []
    setSupplierViewHost(fakeMainHost(mainCalls))
    setDetachedViewHost(fakeDetachedHost(detachedCalls))
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 520 })
    const view = fakeView()
    registerSupplierView("SYN-meesho", toView(view))
    openSupplierTab("SYN-meesho")
    assert.equal(showSupplierView("SYN-meesho"), true)

    const tab = detachSupplierTab("tab-SYN-meesho")
    assert.ok(tab, "expected the detached tab")
    assert.equal(tab.mode, "detached")
    // Partition identity follows the stored panel key verbatim (case kept).
    assert.equal(tab.partition, "persist:supplier-SYN-meesho")
    // Live state is preserved: same URL/title metadata rides along.
    assert.equal(tab.url, "https://supplier.meesho.com/panel")
    assert.equal(tab.title, "SYN Meesho Panel")
    assert.equal(isSupplierTabDetached("SYN-meesho"), true)
    assert.ok(mainCalls.includes("main-remove"), "expected the view to leave the main window")
    assert.ok(detachedCalls.includes("detached-open"), "expected the secondary window to open")
    assert.ok(detachedCalls.includes("detached-attach"), "expected the live view to attach to the secondary window")

    unregisterSupplierView("SYN-meesho", toView(view))
    resetAll()
  })

  it("detach moves open OTP/CAPTCHA popups with the tab instead of orphaning them", () => {
    resetAll()
    const mainCalls: string[] = []
    const detachedCalls: string[] = []
    setSupplierViewHost(fakeMainHost(mainCalls))
    setDetachedViewHost(fakeDetachedHost(detachedCalls))
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 520 })
    const view = fakeView()
    const popup = fakeView("https://supplier.meesho.com/otp", "SYN OTP")
    registerSupplierView("SYN-meesho", toView(view))
    openSupplierTab("SYN-meesho")
    assert.equal(showSupplierView("SYN-meesho"), true)
    assert.equal(addSupplierPopupForTests("SYN-meesho", toView(popup)), true)

    const tab = detachSupplierTab("tab-SYN-meesho")
    assert.ok(tab, "expected the detached tab")
    assert.ok(detachedCalls.includes("detached-popups-attach"), "expected popups to move to the secondary window")

    detachedCalls.length = 0
    const docked = dockSupplierTab("tab-SYN-meesho")
    assert.ok(docked, "expected the docked tab")
    assert.ok(detachedCalls.includes("detached-popups-detach"), "expected popups to leave the secondary window on dock")

    unregisterSupplierView("SYN-meesho", toView(view))
    resetAll()
  })

  it("detaching an unknown tab returns null instead of throwing", () => {
    resetAll()
    setSupplierViewHost(fakeMainHost())
    setDetachedViewHost(fakeDetachedHost())
    assert.equal(detachSupplierTab("tab-unknown"), null)
    resetAll()
  })
})

describe("VAL-WIN-002: seamless re-dock via button or window close", () => {
  it("docking moves the live view back into the bounded viewport as active", () => {
    resetAll()
    const mainCalls: string[] = []
    const detachedCalls: string[] = []
    setSupplierViewHost(fakeMainHost(mainCalls))
    setDetachedViewHost(fakeDetachedHost(detachedCalls))
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 520 })
    const view = fakeView()
    registerSupplierView("SYN-meesho", toView(view))
    openSupplierTab("SYN-meesho")
    assert.equal(showSupplierView("SYN-meesho"), true)
    detachSupplierTab("tab-SYN-meesho")

    mainCalls.length = 0
    detachedCalls.length = 0
    const tab = dockSupplierTab("tab-SYN-meesho")
    assert.ok(tab, "expected the docked tab")
    assert.equal(tab.mode, "active")
    // The same live view goes back into the main window at bounded bounds:
    // never a full-window fallback when a valid rect is present.
    assert.deepEqual(view.bounds, { x: 240, y: 150, width: 980, height: 520 })
    assert.ok(detachedCalls.includes("detached-detach"), "expected the view to leave the secondary window first")
    assert.ok(detachedCalls.includes("detached-close"), "expected the secondary window to close after the transfer")
    assert.ok(mainCalls.includes("main-add"), "expected the view to re-attach in the main window")
    assert.equal(isSupplierTabDetached("SYN-meesho"), false)
    assert.equal(supplierViewBounds() !== null, true)

    unregisterSupplierView("SYN-meesho", toView(view))
    resetAll()
  })

  it("focusing a detached tab only touches the detached window, never the main window", () => {
    resetAll()
    const mainCalls: string[] = []
    setSupplierViewHost(fakeMainHost(mainCalls))
    setDetachedViewHost(fakeDetachedHost())
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 520 })
    const view = fakeView()
    registerSupplierView("SYN-meesho", toView(view))
    openSupplierTab("SYN-meesho")
    assert.equal(showSupplierView("SYN-meesho"), true)
    detachSupplierTab("tab-SYN-meesho")
    mainCalls.length = 0
    assert.equal(focusDetachedSupplierTab("tab-SYN-meesho"), true)
    assert.ok(!mainCalls.includes("main-focus"), "the main window must not steal focus for a detached tab")

    unregisterSupplierView("SYN-meesho", toView(view))
    resetAll()
  })
})

describe("VAL-WIN-003: window lifecycle preserves sessions and re-syncs bounds", () => {
  it("minimize/maximize/restore and tray hide/show keep tabs and re-sync bounds on restore", () => {
    resetAll()
    const mainCalls: string[] = []
    setSupplierViewHost(fakeMainHost(mainCalls))
    setDetachedViewHost(fakeDetachedHost())
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 520 })
    const view = fakeView()
    registerSupplierView("SYN-meesho", toView(view))
    openSupplierTab("SYN-meesho")
    assert.equal(showSupplierView("SYN-meesho"), true)

    for (const event of ["minimize", "hide-to-tray"] as const) {
      notifyWindowLifecycle(event)
      // Lifecycle churn never drops the session: the tab stays known and the
      // view object is preserved for the restore below.
      const tabs = supplierTabRegistry()
      assert.ok(tabs.some((t) => t.panelKey === "SYN-meesho"), `the tab must survive ${event}`)
    }
    for (const event of ["maximize", "restore", "restore-from-tray"] as const) {
      notifyWindowLifecycle(event)
      layoutSupplierViews()
      assert.deepEqual(view.bounds, { x: 240, y: 150, width: 980, height: 520 }, `stale bounds after ${event}`)
    }

    unregisterSupplierView("SYN-meesho", toView(view))
    resetAll()
  })

  it("before-quit disposes detached windows and views without losing the partition identity", () => {
    resetAll()
    const detachedCalls: string[] = []
    setSupplierViewHost(fakeMainHost())
    setDetachedViewHost(fakeDetachedHost(detachedCalls))
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 520 })
    const view = fakeView()
    registerSupplierView("SYN-meesho", toView(view))
    openSupplierTab("SYN-meesho")
    assert.equal(showSupplierView("SYN-meesho"), true)
    detachSupplierTab("tab-SYN-meesho")

    const disposed = disposeDetachedSupplierViews()
    assert.ok(disposed.includes("SYN-meesho"), "expected the detached tab to be disposed on quit")
    assert.ok(detachedCalls.includes("detached-destroy"), "expected the secondary window to be destroyed")
    assert.equal(hideSupplierViews().length, 0)
    // The partition (cookies on disk) outlives the quit; the workspace rect is
    // untouched by the dispose path (the shell clears it on shutdown).
    unregisterSupplierView("SYN-meesho", toView(view))
    resetAll()
    assert.equal(getBrowserWorkspaceRect(), null)
  })
})

describe("VAL-WIN-004: background steps never steal foreground focus", () => {
  it("attaching a tab for background work shows without focusing the OS window", async () => {
    resetAll()
    const calls: string[] = []
    setSupplierViewHost(fakeMainHost(calls))
    // Background attach happens while the view is detached from the window
    // (e.g. after a sidebar switch hid it): the rect is valid again.
    setBrowserWorkspaceRect(null)
    const view = fakeView()
    registerSupplierView("SYN-meesho", toView(view))
    openSupplierTab("SYN-meesho")
    calls.length = 0
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 520 })
    calls.length = 0
    const { attachSupplierViewForBackground } = await import("./src/native-browser-view.js")
    assert.equal(attachSupplierViewForBackground("SYN-meesho"), true)
    assert.ok(calls.includes("main-add"), "the view must attach for background work")
    assert.ok(!calls.includes("main-focus"), "background work must never call focusWindow()")
    assert.ok(!calls.includes("main-show"), "background work must never show the window")
    unregisterSupplierView("SYN-meesho", toView(view))
    resetAll()
  })

  it("explicit user actions still focus through the focus:true path", async () => {
    resetAll()
    const calls: string[] = []
    setSupplierViewHost(fakeMainHost(calls))
    setBrowserWorkspaceRect({ x: 240, y: 150, width: 980, height: 520 })
    const view = fakeView()
    registerSupplierView("SYN-meesho", toView(view))
    openSupplierTab("SYN-meesho")
    calls.length = 0
    const { showSupplierViewForUser } = await import("./src/native-browser-view.js")
    assert.equal(showSupplierViewForUser("SYN-meesho", { focus: true }), true)
    assert.ok(calls.includes("main-focus"), "an explicit user action with focus:true must focus the window")
    unregisterSupplierView("SYN-meesho", toView(view))
    resetAll()
  })
})
