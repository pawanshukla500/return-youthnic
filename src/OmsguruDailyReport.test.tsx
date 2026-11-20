// The OMSGuru page's locks (rule 10): a control the server would refuse is disabled, with a title that says why.
// Server-rendered, no DOM: the header renders before any data loads, and the titles are plain functions.

import { test } from "node:test"
import assert from "node:assert/strict"
import { renderToString } from "react-dom/server"
import { OmsguruDailyReport, waOfflineTitle } from "./OmsguruDailyReport"
import type { SessionUser } from "./types"
import { WorkspaceContext } from "./workspace"

function settingsButton(role: string): string {
  const user: SessionUser = {
    id: 1,
    initials: "SYN",
    name: `SYN-${role}`,
    email: `SYN-${role}@example.test`,
    role,
    sidebarLabel: `SYN-${role}`,
    assignedMarketplaces: "SYN-All",
    scansToday: "0",
    status: "SYN-active",
    lastActive: "SYN-now",
  }
  const html = renderToString(
    <WorkspaceContext.Provider value={{ user, claimsBadge: "", headerDate: "", openPage: () => {}, setClaimsBadge: () => {} }}>
      <OmsguruDailyReport />
    </WorkspaceContext.Provider>,
  )
  const button = html.match(/<button[^>]*btn-icon-only[^>]*>/)
  assert.ok(button, "the Settings button is on the page")
  return button[0]
}

test("only an Admin can open OMSGuru settings: saving them and the WhatsApp test ping are Admin-only on the server", () => {
  for (const role of ["Supervisor", "Inward", "Scanner"]) {
    const button = settingsButton(role)
    assert.match(button, /disabled=""/, `${role} cannot open settings`)
    assert.match(button, /title="Only an administrator can change OMSGuru settings or send a WhatsApp test ping\."/)
  }
  const admin = settingsButton("Admin")
  assert.doesNotMatch(admin, /disabled/)
  assert.match(admin, /title="Configure Dropship Warehouse ID/)
})

test("a WhatsApp button's title gives the gateway's own reason, and names the server setting when one is missing", () => {
  assert.equal(waOfflineTitle({ connected: true }), null)

  // The reason server/whatsapp.ts whatsAppNotConfiguredReason gives when the login is missing.
  const notConfigured = waOfflineTitle({
    connected: false,
    error: "WhatsApp is not configured: missing gateway login (WHATSAPP_BASIC_AUTH)",
  })
  assert.equal(
    notConfigured,
    "WhatsApp gateway is offline: WhatsApp is not configured: missing gateway login (WHATSAPP_BASIC_AUTH)." +
      " The server administrator sets these in the server environment; OMSGuru settings cannot.",
  )

  // A configured gateway that is down: the reason only, no "set it up" advice.
  assert.equal(waOfflineTitle({ connected: false, error: "HTTP 502: Bad Gateway" }), "WhatsApp gateway is offline: HTTP 502: Bad Gateway.")
  assert.equal(waOfflineTitle({ connected: false, error: "fetch failed." }), "WhatsApp gateway is offline: fetch failed.")
  assert.match(waOfflineTitle({ connected: false })!, /not connected to WhatsApp/)
  assert.match(waOfflineTitle(null)!, /has not loaded/)
})
