import { useState } from 'react'
import { AgentsPanel } from './ai-center/AgentsPanel'
import { MemoryPanel } from './ai-center/MemoryPanel'
import { ProvidersPanel } from './ai-center/ProvidersPanel'
import { RoutingPanel } from './ai-center/RoutingPanel'
import { UsagePanel } from './ai-center/UsagePanel'

type SubTabId = 'providers' | 'routing' | 'agents' | 'usage' | 'memory'

const SUBTABS: Array<{ id: SubTabId; label: string }> = [
  { id: 'providers', label: 'Providers' },
  { id: 'routing', label: 'Routing' },
  { id: 'agents', label: 'Agents' },
  { id: 'usage', label: 'Usage & Costs' },
  { id: 'memory', label: 'Learning & Memory' },
]

/**
 * AI Center page. Five sub-tabs with local state (no router): Providers
 * (keys/models/status), Routing (read-only task table + monthly budget),
 * Agents (worker activity ledger), Usage & Costs (records + date filters),
 * and Learning & Memory (approved procedure mirror + local kill-switch).
 *
 * Every panel stays mounted — so usage-filter inputs survive tab switches —
 * but each one polls the engine only while its sub-tab is selected
 * (60-second sub-tab-scoped polling via `active`). All reads and mutations go
 * through the typed engine API in services/engineApi; no invented numbers.
 */
export default function AiCenterPage() {
  const [subTab, setSubTab] = useState<SubTabId>('providers')

  return (
    <section aria-labelledby="ai-center-title">
      <h1 id="ai-center-title" className="font-display text-xl font-bold text-ink">
        AI Center
      </h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Your own provider keys, model routing, agent activity, and usage costs. Keys are encrypted with
        the OS credential store on this PC, never shown again, and never sent anywhere except the provider
        API. The claim worker stays deterministic: memory first, then a low-cost model, then human review.
      </p>

      <div role="tablist" aria-label="AI Center sections" className="mt-4 flex flex-wrap gap-1 border-b border-line">
        {SUBTABS.map((tab) => {
          const selected = tab.id === subTab
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`ai-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`ai-panel-${tab.id}`}
              onClick={() => setSubTab(tab.id)}
              className={`-mb-px rounded-t-lg border-b-2 px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue ${
                selected ? 'border-green text-ink' : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      <div className="mt-4">
        <div
          role="tabpanel"
          id="ai-panel-providers"
          aria-labelledby="ai-tab-providers"
          hidden={subTab !== 'providers'}
        >
          <ProvidersPanel active={subTab === 'providers'} />
        </div>
        <div
          role="tabpanel"
          id="ai-panel-routing"
          aria-labelledby="ai-tab-routing"
          hidden={subTab !== 'routing'}
        >
          <RoutingPanel active={subTab === 'routing'} />
        </div>
        <div
          role="tabpanel"
          id="ai-panel-agents"
          aria-labelledby="ai-tab-agents"
          hidden={subTab !== 'agents'}
        >
          <AgentsPanel active={subTab === 'agents'} />
        </div>
        <div
          role="tabpanel"
          id="ai-panel-usage"
          aria-labelledby="ai-tab-usage"
          hidden={subTab !== 'usage'}
        >
          <UsagePanel active={subTab === 'usage'} />
        </div>
        <div
          role="tabpanel"
          id="ai-panel-memory"
          aria-labelledby="ai-tab-memory"
          hidden={subTab !== 'memory'}
        >
          <MemoryPanel active={subTab === 'memory'} />
        </div>
      </div>
    </section>
  )
}
