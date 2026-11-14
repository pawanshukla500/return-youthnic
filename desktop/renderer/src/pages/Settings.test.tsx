import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import SettingsPage, { MARKETPLACES, channelStatusLabel, panelKeyForMarketplaceName, pingLabel } from './Settings'
import type { PortalChannelStatus, TestConnectionResult } from '../types/engine'

// tsx compiles JSX with the classic React.createElement transform when the
// suite runs from the repository root (the root tsconfig's include does not
// cover desktop/renderer), so Settings.tsx and the ui/* components resolve
// React as a global. Provide it here — this SSR test intentionally uses no
// DOM (see test-setup/register-dom.ts for the full component-test setup).
;(globalThis as { React?: typeof React }).React = React

/* Pure helper parity with the engine (desktop-agent/panel-queue.ts,
   desktop-app-server.ts dashboard script). */

test('panelKeyForMarketplaceName maps the six marketplaces to panel keys', () => {
  assert.equal(panelKeyForMarketplaceName('Meesho'), 'meesho')
  assert.equal(panelKeyForMarketplaceName('flipkart'), 'flipkart')
  assert.equal(panelKeyForMarketplaceName('Amazon'), 'amazon')
  assert.equal(panelKeyForMarketplaceName('Myntra VB'), 'myntra_vb')
  assert.equal(panelKeyForMarketplaceName('myntra_vb'), 'myntra_vb')
  assert.equal(panelKeyForMarketplaceName('Myntra EJ'), 'myntra_ej')
  assert.equal(panelKeyForMarketplaceName('myntra ej'), 'myntra_ej')
  assert.equal(panelKeyForMarketplaceName('Ajio'), 'ajio')
  assert.equal(panelKeyForMarketplaceName(''), 'unknown')
})

function channel(partial: Partial<PortalChannelStatus>): PortalChannelStatus {
  return { name: 'Meesho', configured: false, usernameMasked: '', sessionSavedAt: null, ...partial }
}

test('channelStatusLabel follows session > configured > missing', () => {
  assert.equal(channelStatusLabel(channel({})), 'Not connected')
  assert.equal(channelStatusLabel(channel({ configured: true, usernameMasked: 'ab***' })), 'ID saved')
  assert.equal(channelStatusLabel(channel({ configured: true, sessionSavedAt: '2026-11-04T00:00:00Z' })), 'Connected — cookies saved')
})

test('pingLabel reports latency on success and the message on failure', () => {
  assert.equal(pingLabel({ ok: true, status: 200, message: 'OK', latencyMs: 123 }), '✓ Connected (123ms)')
  assert.equal(pingLabel({ ok: false, status: 503, message: 'No connection', latencyMs: 0 }), '✕ No connection')
})

/* SSR smoke render: effects do not run under renderToString, so the page must
   render its static shell (sections, the supplier-login disclosure, live
   regions) from empty state without the engine, the bridge, or a DOM. The
   supplier login form starts collapsed — opening it needs channel data or a
   deep link, both of which only arrive through effects. */

test('MARKETPLACES lists the six claim panels with engine-exact names', () => {
  assert.deepEqual(
    MARKETPLACES.map((entry) => entry.name),
    ['Meesho', 'Flipkart', 'Amazon', 'Myntra VB', 'Myntra EJ', 'Ajio'],
  )
})

test('SettingsPage renders its settings shell without the engine or a DOM', () => {
  const html = renderToString(<SettingsPage />)

  assert.match(html, /Settings/)
  // First-time setup panel.
  assert.match(html, /Connect each supplier panel/)
  assert.match(html, /Loading supplier panels/)
  // Supplier login section starts collapsed: compact summary + disclosure
  // button, no credential fields in the static shell.
  assert.match(html, /Supplier login/)
  assert.match(html, /Saved supplier logins stay on this PC/)
  assert.match(html, /Loading supplier login status…/)
  assert.match(html, /Fix or change a supplier login/)
  assert.ok(!html.includes('id="portal-marketplace"'), 'login form must stay hidden until opened')
  assert.ok(!html.includes('id="portal-password"'), 'password field must stay hidden until opened')
  assert.ok(!html.includes('type="password"'), 'no password input in the collapsed shell')
  // Backend server section.
  assert.match(html, /Backend server/)
  assert.match(html, /Test Ping/)
  assert.match(html, /signs you out on purpose/)
  // Security + app info panels.
  assert.match(html, /Security/)
  assert.match(html, /App info/)
  // Supplier browser controls.
  assert.match(html, /Show supplier browser/)
  assert.match(html, /Hide supplier browser/)
  assert.match(html, /Browsers tab/)
  // Result messages are announced to screen readers.
  assert.match(html, /aria-live="polite"/)
})
