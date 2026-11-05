import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatUrlPill, hasClosedTabs, openTabs, resolveActiveTab } from './Browsers'
import type { BrowserTab } from '../types/engine'

function tab(overrides: Partial<BrowserTab> & { tabId: string }): BrowserTab {
  return {
    panelKey: 'meesho',
    label: 'Meesho',
    accountName: 'Meesho',
    partition: 'persist:supplier-meesho',
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    mode: 'active',
    workerOwned: false,
    activeClaim: null,
    ...overrides,
  }
}

test('openTabs drops closed tabs and keeps order', () => {
  const tabs = [
    tab({ tabId: 'tab-meesho', mode: 'active' }),
    tab({ tabId: 'tab-flipkart', panelKey: 'flipkart', mode: 'closed' }),
    tab({ tabId: 'tab-amazon', panelKey: 'amazon', mode: 'background' }),
  ]
  assert.deepEqual(
    openTabs(tabs).map((t) => t.tabId),
    ['tab-meesho', 'tab-amazon'],
  )
  assert.equal(openTabs([]).length, 0)
})

test('hasClosedTabs is true only when a closed tab exists', () => {
  assert.equal(hasClosedTabs([tab({ tabId: 'tab-a', mode: 'closed' })]), true)
  assert.equal(hasClosedTabs([tab({ tabId: 'tab-a', mode: 'active' })]), false)
  assert.equal(hasClosedTabs([]), false)
})

test('resolveActiveTab prefers the snapshot activeTabId and skips closed matches', () => {
  const tabs = [
    tab({ tabId: 'tab-meesho', mode: 'active' }),
    tab({ tabId: 'tab-flipkart', panelKey: 'flipkart', mode: 'background' }),
  ]
  assert.equal(resolveActiveTab({ tabs, activeTabId: 'tab-flipkart' })?.tabId, 'tab-flipkart')
  // A closed tab is never resolved as active even when activeTabId points at it.
  const closed = [tab({ tabId: 'tab-meesho', mode: 'closed' }), tab({ tabId: 'tab-flipkart', panelKey: 'flipkart', mode: 'active' })]
  assert.equal(resolveActiveTab({ tabs: closed, activeTabId: 'tab-meesho' })?.tabId, 'tab-flipkart')
})

test('resolveActiveTab falls back active → detached → null', () => {
  const detached = tab({ tabId: 'tab-ajio', panelKey: 'ajio', mode: 'detached' })
  assert.equal(resolveActiveTab({ tabs: [detached], activeTabId: null })?.tabId, 'tab-ajio')
  assert.equal(resolveActiveTab({ tabs: [], activeTabId: null }), null)
  assert.equal(resolveActiveTab(null), null)
  // Background tabs are never the fallback choice.
  const background = tab({ tabId: 'tab-amazon', panelKey: 'amazon', mode: 'background' })
  assert.equal(resolveActiveTab({ tabs: [background], activeTabId: null }), null)
})

test('formatUrlPill never emits HTML and mirrors the old pill text', () => {
  assert.equal(formatUrlPill(null), 'No supplier page open')
  assert.equal(formatUrlPill(tab({ tabId: 'tab-x', mode: 'closed', url: 'https://example.com' })), 'No supplier page open')
  assert.equal(formatUrlPill(tab({ tabId: 'tab-x', accountName: '' })), '(loading supplier page…)')
  assert.equal(
    formatUrlPill(tab({ tabId: 'tab-x', url: 'https://supplier.meesho.com', title: 'Meesho Supplier Panel' })),
    'https://supplier.meesho.com — Meesho Supplier Panel · Meesho',
  )
})
