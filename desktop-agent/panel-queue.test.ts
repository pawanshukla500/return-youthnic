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
  marketplacesToSkip,
  nextReadyPanels,
  PANEL_COOLDOWN_MS,
  panelKeyForMarketplace,
  pollJobSkippingHeldPanels,
  resetPanelRuntime,
} from "./src/panel-queue.js"
import { AgentBackendClient, type JobPollResult } from "./src/agent-client.js"

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

  it("names held and cooling-down panels as marketplaces to skip, never busy or idle ones", () => {
    resetPanelRuntime()
    assert.deepEqual(marketplacesToSkip(), [])
    markPanelResult("meesho", "prepared", "Waiting for approval")
    markPanelResult("myntra_vb", "manual_action", "OTP needed")
    for (let i = 0; i < 3; i++) markPanelResult("ajio", "failed", `SYN-boom-${i}`)
    markPanelBusy("amazon", 7, "preparing")
    assert.deepEqual(marketplacesToSkip(), ["Meesho", "Myntra VB", "Ajio"])
    clearPanelHold("meesho")
    assert.deepEqual(marketplacesToSkip(), ["Myntra VB", "Ajio"])
  })

  it("Rejoin rotation clears a cooldown's error count, so one more failure does not cool it down again", () => {
    resetPanelRuntime()
    for (let i = 0; i < 3; i++) markPanelResult("meesho", "failed", `SYN-boom-${i}`)
    assert.equal(getPanelRuntimeState("meesho"), "cooldown")
    clearPanelHold("meesho")
    markPanelResult("meesho", "failed", "SYN-boom-after-rejoin")
    assert.equal(getPanelRuntimeState("meesho"), "idle")
    assert.deepEqual(marketplacesToSkip(), [])
  })

  it("a cooldown ends on its own after PANEL_COOLDOWN_MS, and the next job is a single probe", (t) => {
    resetPanelRuntime()
    let now = Date.parse("2026-11-20T10:00:00Z")
    t.mock.method(Date, "now", () => now)
    for (let i = 0; i < 3; i++) markPanelResult("meesho", "failed", `SYN-boom-${i}`)
    assert.deepEqual(marketplacesToSkip(), ["Meesho"])
    now += PANEL_COOLDOWN_MS - 1
    assert.deepEqual(marketplacesToSkip(), ["Meesho"], "still cooling down one millisecond before the end")
    now += 1
    assert.deepEqual(marketplacesToSkip(), [], "an expired cooldown is no longer skipped")
    assert.equal(getPanelRuntimeState("meesho"), "idle")
    markPanelResult("meesho", "failed", "SYN-probe-fails")
    assert.equal(getPanelRuntimeState("meesho"), "cooldown", "a failed probe cools the panel down again")
    now += PANEL_COOLDOWN_MS
    markPanelResult("meesho", "completed", "SYN-ref-1")
    assert.equal(getPanelRuntimeState("meesho"), "idle")
    assert.equal(getPanelStatuses("C:/tmp-profiles").find((s) => s.key === "meesho")?.consecutiveErrors, 0, "a successful probe resets the count")
  })
})

describe("job poll skips held panels (checklist 3.1)", () => {
  type SynJob = { jobId: number; marketplace: string; stage: "queued" | "approved"; leases: number }

  // A fake backend with the server's lease rule: the oldest job leases, except
  // queued jobs of a marketplace named in skipMarketplaces. Each lease counts.
  function fakeClient(jobs: SynJob[]) {
    const polls: string[][] = []
    return {
      polls,
      async pollJob(skipMarketplaces: readonly string[]): Promise<JobPollResult> {
        polls.push([...skipMarketplaces])
        const skip = new Set(skipMarketplaces.map((name) => name.toLowerCase()))
        const job = jobs.find((j) => j.leases === 0 && !(j.stage === "queued" && skip.has(j.marketplace.toLowerCase())))
        if (!job) return { hasJob: false }
        job.leases += 1
        const stage = job.stage === "approved" ? "submitting" : "downloading_media"
        return { hasJob: true, job: { jobId: job.jobId, claimId: job.jobId, stage, marketplace: job.marketplace, orderNumber: `SYN-ORD-${job.jobId}`, trackingId: `SYN-AWB-${job.jobId}` } }
      },
    }
  }

  it("a held panel's queued job is never leased while other marketplaces keep flowing", async () => {
    resetPanelRuntime()
    markPanelResult("meesho", "prepared", "Waiting for approval")
    const meeshoQueued: SynJob = { jobId: 1, marketplace: "Meesho", stage: "queued", leases: 0 }
    const flipkartQueued: SynJob = { jobId: 2, marketplace: "Flipkart", stage: "queued", leases: 0 }
    const meeshoApproved: SynJob = { jobId: 3, marketplace: "Meesho", stage: "approved", leases: 0 }
    const client = fakeClient([meeshoQueued, flipkartQueued, meeshoApproved])

    const first = await pollJobSkippingHeldPanels(client)
    assert.equal(first.job?.jobId, 2, "another marketplace's job leases past the held one")
    const second = await pollJobSkippingHeldPanels(client)
    assert.equal(second.job?.jobId, 3, "the approved job for the held panel still leases to submit")
    assert.equal(second.job?.stage, "submitting")
    const third = await pollJobSkippingHeldPanels(client)
    assert.equal(third.hasJob, false)
    assert.equal(meeshoQueued.leases, 0, "the held panel's queued job never used an attempt")
    assert.deepEqual(client.polls, [["Meesho"], ["Meesho"], ["Meesho"]])

    clearPanelHold("meesho")
    const afterRejoin = await pollJobSkippingHeldPanels(client)
    assert.equal(afterRejoin.job?.jobId, 1, "Rejoin rotation lets the queued job lease again")
    assert.deepEqual(client.polls[3], [])
  })

  it("the real client sends the skip list on the poll URL and nothing when no panel is held", async () => {
    resetPanelRuntime()
    const urls: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ hasJob: false }), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as typeof fetch
    try {
      const client = new AgentBackendClient({
        agentUuid: "SYN-agent",
        agentName: "SYN-agent",
        backendUrl: "http://127.0.0.1:1",
        apiKey: "SYN-key",
        pollIntervalMs: 1000,
        heartbeatIntervalMs: 1000,
        followUpCheckIntervalMs: 1000,
        browserMode: "headless",
        browserPath: "",
        userDataDir: "SYN-dir",
        workDir: "SYN-dir",
        logLevel: "error",
      })
      // Registration writes the agent config file; this test covers only the poll.
      ;(client as unknown as { isRegistered: boolean }).isRegistered = true
      await pollJobSkippingHeldPanels(client)
      markPanelResult("meesho", "prepared", "Waiting for approval")
      markPanelResult("myntra_vb", "manual_action", "OTP needed")
      await pollJobSkippingHeldPanels(client)
    } finally {
      globalThis.fetch = realFetch
    }
    assert.equal(urls.length, 2)
    assert.equal(new URL(urls[0]).searchParams.has("skipMarketplaces"), false)
    assert.equal(new URL(urls[1]).searchParams.get("skipMarketplaces"), "Meesho,Myntra VB")
  })
})
