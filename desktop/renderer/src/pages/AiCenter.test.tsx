import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import AiCenterPage from './AiCenter'

// Provide React as global for SSR test without DOM
;(globalThis as { React?: typeof React }).React = React

test('AiCenterPage renders static shell with accessible headings and description', () => {
  const html = renderToString(<AiCenterPage />)
  assert.ok(html.includes('id="ai-center-title"'), 'heading id present')
  assert.ok(html.includes('AI Center'), 'page title present')
  assert.ok(html.includes('Your own provider keys, model routing'), 'description paragraph present')
  assert.ok(html.includes('Keys are encrypted with'), 'security notice present')
})

test('AiCenterPage renders all five accessible sub-tabs', () => {
  const html = renderToString(<AiCenterPage />)
  assert.ok(html.includes('role="tablist"'), 'tablist present')
  assert.ok(html.includes('aria-label="AI Center sections"'), 'tablist label present')

  const expectedTabs = [
    { id: 'providers', label: 'Providers' },
    { id: 'routing', label: 'Routing' },
    { id: 'agents', label: 'Agents' },
    { id: 'usage', label: 'Usage &amp; Costs' }, // HTML escaped
    { id: 'memory', label: 'Learning &amp; Memory' },
  ]

  for (const tab of expectedTabs) {
    assert.ok(html.includes(`id="ai-tab-${tab.id}"`), `tab button for ${tab.id}`)
    assert.ok(html.includes(`id="ai-panel-${tab.id}"`), `tabpanel for ${tab.id}`)
    assert.ok(html.includes(tab.label), `tab label for ${tab.label}`)
  }
})

test('AiCenterPage defaults to the Providers sub-tab being active', () => {
  const html = renderToString(<AiCenterPage />)
  assert.ok(html.includes('id="ai-tab-providers" aria-selected="true"'), 'providers tab selected by default')
  assert.ok(html.includes('id="ai-panel-providers" aria-labelledby="ai-tab-providers"'), 'providers panel labeled')
  // Other tab panels start with hidden attribute
  assert.ok(html.includes('id="ai-panel-routing" aria-labelledby="ai-tab-routing" hidden=""'), 'routing panel hidden')
  assert.ok(html.includes('id="ai-panel-agents" aria-labelledby="ai-tab-agents" hidden=""'), 'agents panel hidden')
  assert.ok(html.includes('id="ai-panel-usage" aria-labelledby="ai-tab-usage" hidden=""'), 'usage panel hidden')
  assert.ok(html.includes('id="ai-panel-memory" aria-labelledby="ai-tab-memory" hidden=""'), 'memory panel hidden')
})
