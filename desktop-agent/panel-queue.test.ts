import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  CLAIM_PANELS,
  clearPanelHold,
  getPanelRuntimeState,
  getPanelStatuses,
  isPanelHeld,
  markPanelBusy,
  markPanelResult,
  nextReadyPanels,
  panelKeyForMarketplace,
  resetPanelRuntime,
} from "./src/panel-queue.js"

describe("panel-wise continuous claim queue", () => {
  it("covers all six supplier panels with isolated profiles", () => {
    resetPanelRuntime()
    assert.equal(CLAIM_PANELS.length, 6)
    const names: string[] = CLAIM_PANELS.map((p) => p.name)
    for (const expected of ["Meesho", "Flipkart", "Amazon", "Myntra VB", "Myntra EJ", "Ajio"]) {
      assert.ok(names.includes(expected), `missing panel ${expected}`)
    }
    const statuses = getPanelStatuses("C:/tmp-profiles")
    assert.equal(statuses.length, 6)
    const dirs = new Set(statuses.map((s) => s.profileDir))
    assert.equal(dirs.size, 6)
    for (const s of statuses) {
      assert.equal(s.state, "idle")
      assert.equal(s.activeJobId, null)
    }
  })

  it("maps job marketplace labels to panel keys (Myntra EJ vs VB split)", () => {
    assert.equal(panelKeyForMarketplace("Meesho"), "meesho")
    assert.equal(panelKeyForMarketplace("Flipkart"), "flipkart")
    assert.equal(panelKeyForMarketplace("Amazon IN"), "amazon")
    assert.equal(panelKeyForMarketplace("Myntra VB"), "myntra_vb")
    assert.equal(panelKeyForMarketplace("Myntra EJ"), "myntra_ej")
    assert.equal(panelKeyForMarketplace("Ajio"), "ajio")
  })

  it("rotates round-robin and skips busy/held panels so filing continues", () => {
    resetPanelRuntime()
    markPanelBusy("meesho", 11, "submitting")
    markPanelResult("flipkart", "manual_action", "OTP needed")
    const order = nextReadyPanels(6)
    assert.ok(!order.includes("meesho"), "busy panel must be skipped")
    assert.ok(!order.includes("flipkart"), "held panel must be skipped")
    assert.ok(order.includes("amazon"))
    assert.ok(order.includes("ajio"))
    // Rotation advances: a second call starts from the next ready panel.
    const again = nextReadyPanels(6)
    assert.deepEqual(new Set(again), new Set(order))
    assert.ok(again[0] !== order[0] || order.length === 1)
    clearPanelHold("flipkart")
    const afterClear = nextReadyPanels(6)
    assert.ok(afterClear.includes("flipkart"))
  })

  it("cools a panel down after 3 straight failures, others keep filing", () => {
    resetPanelRuntime()
    markPanelResult("meesho", "failed", "boom 1")
    markPanelResult("meesho", "failed", "boom 2")
    let statuses = getPanelStatuses("C:/tmp-profiles")
    assert.equal(statuses.find((s) => s.key === "meesho")?.state, "idle")
    markPanelResult("meesho", "failed", "boom 3")
    statuses = getPanelStatuses("C:/tmp-profiles")
    assert.equal(statuses.find((s) => s.key === "meesho")?.state, "cooldown")
    const ready = nextReadyPanels(6)
    assert.ok(!ready.includes("meesho"))
    assert.ok(ready.includes("amazon"))
    assert.ok(ready.includes("flipkart"))
  })

  it("a completed panel rejoins the rotation immediately", () => {
    resetPanelRuntime()
    markPanelBusy("amazon", 42, "submitting")
    assert.ok(!nextReadyPanels(6).includes("amazon"))
    markPanelResult("amazon", "completed", "case 123")
    const statuses = getPanelStatuses("C:/tmp-profiles")
    assert.equal(statuses.find((s) => s.key === "amazon")?.state, "idle")
    assert.equal(statuses.find((s) => s.key === "amazon")?.consecutiveErrors, 0)
    assert.ok(nextReadyPanels(6).includes("amazon"))
  })

  it("a prepared panel waits for operator approval without blocking other panels", () => {
    resetPanelRuntime()
    assert.equal(isPanelHeld("meesho"), false)
    markPanelBusy("meesho", 99, "preparing")
    markPanelResult("meesho", "prepared", "Waiting for approval")
    assert.equal(getPanelRuntimeState("meesho"), "prepared")
    assert.equal(isPanelHeld("meesho"), true)
    const statuses = getPanelStatuses("C:/tmp-profiles")
    assert.equal(statuses.find((s) => s.key === "meesho")?.state, "prepared")
    const ready = nextReadyPanels(6)
    assert.ok(!ready.includes("meesho"), "prepared panel must not be leased for new preparing jobs")
    assert.ok(ready.includes("amazon"), "other panels continue filing round-robin")
    clearPanelHold("meesho")
    assert.equal(isPanelHeld("meesho"), false)
    assert.equal(getPanelRuntimeState("meesho"), "idle")
    assert.ok(nextReadyPanels(6).includes("meesho"), "clearing hold restores panel to ready rotation")
  })
})
