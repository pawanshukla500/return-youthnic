import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { followUpExecutionBundle } from "./src/follow-up-bundle.js"
import { getAutomationEngine } from "./src/marketplaces/registry.js"

/**
 * A follow-up check builds a synthetic execution bundle. The marketplace classes
 * read the job object only inside execute(), which a follow-up never calls, so
 * these tests pin the two things that matter: the panel-relevant fields are real,
 * and nothing pretends a filing happened.
 */

describe("follow-up execution bundle", () => {
  const bundle = followUpExecutionBundle({
    claimId: 42,
    marketplace: "Meesho",
    accountName: "vb-exports-meesho",
    portalUrl: "https://supplier.meesho.com/panel/v2/new/returns/claims",
  })

  it("carries the claim and the panel the check needs", () => {
    assert.equal(bundle.claimId, 42)
    assert.equal(bundle.marketplace, "Meesho")
    assert.equal(bundle.accountName, "vb-exports-meesho")
    assert.equal(bundle.portalUrl, "https://supplier.meesho.com/panel/v2/new/returns/claims")
  })

  it("carries no evidence, because a status check uploads nothing", () => {
    assert.deepEqual(bundle.evidenceFiles, [])
  })

  it("does not pretend a filing job happened", () => {
    // jobId 0 plus a distinct stage keeps a follow-up from being mistaken for a
    // real job if it is ever logged next to one by mistake.
    assert.equal(bundle.jobId, 0)
    assert.equal(bundle.stage, "follow_up")
    assert.equal(bundle.automationMode, "follow_up")
    assert.equal(bundle.requireApprovalBeforeSubmit, false)
  })

  it("never carries supplier credentials, because the saved session signs in", () => {
    assert.deepEqual(bundle.credentials, { username: "", password: "", authState: {} })
  })

  it("requires every field of JobExecutionBundle so the type drives the shape", () => {
    for (const key of ["jobId", "claimId", "stage", "marketplace", "accountName", "portalUrl", "credentials", "claim", "evidenceFiles"] as const) {
      assert.ok(key in bundle, `expected ${key} in the follow-up bundle`)
    }
    assert.equal(bundle.claim.totalPrice, 0)
    assert.equal(bundle.claim.orderNumber, "")
  })
})

describe("ticket status reader contract", () => {
  // Until a marketplace implements checkClaimStatus(), the engine must say so
  // rather than guess a ticket state. The server stops the follow-up on that
  // answer, so a wrong "supported: true" would silently close live tickets.
  for (const marketplace of ["Meesho", "Flipkart", "Amazon", "Myntra VB", "Myntra EJ", "Ajio"]) {
    it(`${marketplace} does not advertise a status reader it has not built`, async () => {
      const engine = getAutomationEngine(
        marketplace,
        {} as never,
        followUpExecutionBundle({ claimId: 1, marketplace, accountName: "SYN", portalUrl: "" }),
        new Map(),
        ".",
      )
      const result = await engine.checkClaimStatus("SYN-TICKET-1")
      assert.equal(result.supported, false, `${marketplace} must not report a ticket state it did not read`)
      if (!result.supported) assert.match(result.reason, /not implemented/)
    })
  }
})
