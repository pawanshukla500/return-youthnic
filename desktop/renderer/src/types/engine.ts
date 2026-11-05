/**
 * Engine API DTOs — audited shapes from desktop-agent (desktop-app-server.ts,
 * panel-queue.ts, native-browser-view.ts, agent-client.ts, portal-login.ts,
 * update-check.ts, ai-center-routes.ts, ai-memory-panel.ts). Field names match
 * the wire format exactly; keep them in sync when the engine changes.
 */

export type NightlyWindowStatus = {
  nightlyOnly: boolean
  inWindow: boolean
  nextWindowStartIso: string
  msUntilWindow: number
}

export type AiAssistStatus = {
  enabled: boolean
  calls: number
  failures: number
  lastLatencyMs: number | null
  lastModel: string
}

/** GET /api/status */
export type StatusSnapshot = {
  isRunning: boolean
  isCurrentlyProcessing: boolean
  activeJobInfo: unknown
  activeSummary: string | null
  nextPollCountdown: number
  lastHeartbeatTime: string
  lastPollTime: string
  lastFollowUpCheckTime: string
  followUpChecksRun: number
  lastFollowUpResult: string
  backendUrl: string
  agentUuid: string
  agentName: string
  signedIn: boolean
  /**
   * Audit note: the current /api/status wire projection does not yet include
   * nightlyWindow/browserAdapter (they exist on the internal engineStatus()
   * and therefore under /api/v1/engine/info's `status`). Optional until the
   * engine projection adds them.
   */
  nightlyWindow?: NightlyWindowStatus
  browserAdapter?: string
}

/** GET /api/health (never requires auth, liveness only) */
export type HealthResult = {
  ok: boolean
  status: 'busy' | 'running' | 'idle'
  uptimeSeconds: number
}

/** GET /api/operator/session → { signedIn, user } and POST /api/operator/login → { ok, user } */
export type OperatorProfile = {
  name: string
  email: string
  role: string
}

export type OperatorSessionResponse = {
  signedIn: boolean
  user: OperatorProfile | null
}

export type OperatorLoginResponse = {
  ok: boolean
  user?: OperatorProfile
}

export type EngineErrorBody = {
  error?: string
  code?: string
}

/** GET /api/jobs (an array of rows) */
export type JobLogEntry = {
  level: string
  message: string
  timestamp: string
}

export type JobRow = {
  id: number
  claimId: number
  marketplace: string
  accountName: string
  orderNumber: string
  trackingId: string
  marketplaceClaimId: string
  stage: string
  manualActionReason: string | null
  claimReason: string | null
  claimTitle: string | null
  updatedAt: string
  attempts: number
  maxAttempts: number
  logs: JobLogEntry[]
  [k: string]: unknown
}

/** GET /api/follow-ups?pageSize=100 */
export type FollowUpRow = {
  marketplace: string
  accountName: string
  orderNumber: string
  marketplaceClaimId: string
  claimStatus: string
  statusAtLastCheck: string
  lastCheckedAt: string
  nextCheckAt: string
  checkCount: number
  isActive: boolean
  checkIntervalHours: number
  errorStreak: number
  stopReason: string | null
  lastError: string | null
  [k: string]: unknown
}

export type FollowUpsSummary = {
  active: number
  due: number
  resolved: number
  withErrors: number
  [k: string]: unknown
}

export type FollowUpsResponse = {
  rows: FollowUpRow[]
  total: number
  summary: FollowUpsSummary
}

/** GET /api/panels → { panels: PanelStatus[] } */
export type PanelRuntimeState =
  | 'idle'
  | 'preparing'
  | 'submitting'
  | 'prepared'
  | 'manual_action'
  | 'cooldown'
  | 'disabled'

export type PanelStatus = {
  key: string
  name: string
  portalUrl: string
  automated: boolean
  profileDir: string
  sessionSavedAt: string | null
  state: PanelRuntimeState
  activeJobId: number | null
  consecutiveErrors: number
  lastResult: string | null
  lastResultAt: string | null
}

export type PanelsResponse = {
  panels: PanelStatus[]
}

/** POST /api/panels/:key/clear → { ok, panels } */
export type PanelClearResponse = {
  ok: boolean
  panels: PanelStatus[]
}

/** POST /api/scheduler/toggle?action=start|pause → { ok, isRunning } */
export type SchedulerToggleResponse = {
  ok: boolean
  isRunning: boolean
}

/** POST /api/scheduler/poll-now → { ok } */
export type OkResponse = {
  ok: boolean
}

/** GET /api/test-connection */
export type TestConnectionResult = {
  ok: boolean
  status: number
  message: string
  latencyMs: number
}

/** GET /api/config (apiKey stripped server-side) / POST /api/config */
export type EngineConfig = {
  agentUuid: string
  agentName: string
  backendUrl: string
  pollIntervalMs: number
  heartbeatIntervalMs: number
  followUpCheckIntervalMs: number
  browserMode: 'visible' | 'headless'
  browserPath: string
  userDataDir: string
  workDir: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export type ConfigResponse = {
  config: EngineConfig
}

export type ConfigUpdateResponse = {
  ok: boolean
  signedOut?: boolean
  config?: EngineConfig
}

/** GET /api/v1/engine/info */
export type EngineInfo = {
  engine: string
  version: string
  platform: string
  arch: string
  node: string
  pid: number
  engineMode: string
  bindHost: string
  bindPort: number
  uptimeSeconds: number
  dataDir: string
  status: Record<string, unknown>
  panels: Array<{ key: string; name: string; state: string; automated: boolean; sessionSaved: boolean }>
}

/** GET /api/security */
export type SecurityStatus = {
  osCredentialStore: boolean
  detail: string
}

/** GET /api/updates/check */
export type UpdateAsset = {
  name: string
  url: string
}

export type UpdateCheckResult = {
  ok: boolean
  currentVersion: string
  latestTag: string | null
  downloadUrl: string | null
  downloads: UpdateAsset[]
  updateAvailable: boolean
  error?: string
}

/** GET /api/portal-logins → { channels } */
export type PortalChannelStatus = {
  name: string
  configured: boolean
  usernameMasked: string
  sessionSavedAt: string | null
}

export type PortalLoginsResponse = {
  channels: PortalChannelStatus[]
}

/** POST /api/portal-logins/test */
export type PortalLoginTestResult = {
  ok: boolean
  message?: string
  [k: string]: unknown
}

/** GET /api/portal-browser (multi-tab snapshot; legacy top-level fields kept) */
export type SupplierViewStatus = {
  panelKey: string
  visible: boolean
  [k: string]: unknown
}

export type SupplierTabMode = 'active' | 'background' | 'detached' | 'closed'

export type TabActiveClaim = {
  claimId: string
  orderId?: string
  awb?: string
  stage?: string
  statusText?: string
  paused: boolean
} | null

export type BrowserTab = {
  tabId: string
  panelKey: string
  label: string
  accountName: string
  partition: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  mode: SupplierTabMode
  workerOwned: boolean
  activeClaim: TabActiveClaim
}

export type BrowserSnapshot = {
  views: SupplierViewStatus[]
  tabs: BrowserTab[]
  activeTabId: string | null
  open: boolean
  panelKey: string | null
  label: string | null
  url: string
  title: string
  held: boolean
  reason: string | null
}

/** GET /api/logs/stream — SSE `{ timestamp, level, message }` lines */
export type LogStreamEvent = {
  timestamp: string
  level: string
  message: string
}

/* ------------------------------------------------------------------ */
/* AI Center (/api/v1/ai-center/*)                                      */
/* ------------------------------------------------------------------ */

export type ProviderId = 'meta' | 'openai' | 'kimi' | 'anthropic' | 'google' | 'zai' | 'gateway'

export type AiCatalogModel = {
  id: string
  label: string
  verified: boolean
  strengths: string[]
  supportsTools: boolean
  supportsReasoning: boolean
  contextWindow?: number
}

export type AiProviderCatalogEntry = {
  id: Exclude<ProviderId, 'gateway'>
  name: string
  docUrl: string
  transport: 'openai-compatible' | 'anthropic-messages' | 'gemini-generateContent'
  defaultModel: string
  models: AiCatalogModel[]
  pricing: Record<string, { inputPer1M: number | null; outputPer1M: number | null; provenance: string }>
}

/** GET /api/v1/ai-center/catalog */
export type AiCatalogResponse = {
  version: number
  tasks: Array<{ id: string; label: string }>
  providers: AiProviderCatalogEntry[]
}

export type AiProviderStatus = {
  id: Exclude<ProviderId, 'gateway'>
  name: string
  hasKey: boolean
  defaultModel: string
  baseUrlOverride: string
  lastSuccessAt: string | null
  lastError: string | null
  lastErrorCategory: string | null
}

/** GET /api/v1/ai-center/providers */
export type AiProvidersResponse = {
  encryptionAvailable: boolean
  rtdbConfigured: boolean
  providers: AiProviderStatus[]
}

/** GET /api/v1/ai-center/routing → { routing } */
export type AiTaskRoute = {
  mode: 'auto' | 'manual'
  primary: { provider: string; model: string }
  fallback: { provider: string; model: string } | null
  reasoningEffort?: string
  maxTokens?: number
  maxCalls?: number
  timeoutMs?: number
}

export type AiRouting = {
  version: 1
  auto: boolean
  monthlyBudgetUsd: number | null
  defaultTimeoutMs: number
  tasks: Record<string, AiTaskRoute>
  updatedAt: string
}

export type AiRoutingResponse = {
  routing: AiRouting
}

export type TokenUsage = {
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  reasoningTokens?: number
}

/** GET /api/v1/ai-center/usage */
export type AiUsageRecord = {
  at: string
  provider: string
  model: string
  task: string
  ok: boolean
  errorCategory: string | null
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  reasoningTokens: number | null
  latencyMs: number
  estimatedUsd: number | null
  pricingProvenance: string
}

export type AiUsageSummary = {
  total: number
  successful: number
  failed: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
  estimatedUsd: number
  unknownPricing: number
  avgLatencyMs: number | null
  byProvider: Record<string, { calls: number; estimatedUsd: number }>
  byModel: Record<string, { calls: number; estimatedUsd: number }>
  byTask: Record<string, { calls: number; estimatedUsd: number }>
}

export type AiUsage = {
  summary: AiUsageSummary
  records: AiUsageRecord[]
}

/** GET /api/v1/ai-center/activity */
export type AiActivityEntry = {
  id: string
  at: string
  endAt: string | null
  claimId: number
  marketplace: string
  agentFunction: string
  provider: string
  model: string
  stage: string
  memoryHit: boolean
  result: string
  errorCategory: string | null
  fallback: boolean
  approval: 'none-required' | 'pending' | 'approved' | 'rejected'
}

export type AiActivity = {
  activity: AiActivityEntry[]
}

/* ------------------------------------------------------------------ */
/* AI memory (/api/v1/ai-memory)                                        */
/* ------------------------------------------------------------------ */

export type AiUsageSnapshot = {
  calls: number
  failures: number
  lastLatencyMs: number | null
  lastModel: string
  lastUsage: TokenUsage | null
}

export type AiMemoryProcedure = {
  id: string
  marketplace: string
  errorSignature: string
  title: string
  steps: string[]
  status: string
  updatedAt: string
}

export type AiMemoryEvent = {
  at: string
  claimId: number
  marketplace: string
  step: string
  outcome: 'success' | 'failure' | 'ai_proposal' | 'human_review' | 'memory_hit'
  note: string
}

/** GET /api/v1/ai-memory */
export type AiMemoryResponse = {
  procedures: AiMemoryProcedure[]
  events: AiMemoryEvent[]
  recentEventCap: number
  usage: AiUsageSnapshot
  assistEnabled: boolean
}

export type AiMemoryDisableResponse = {
  ok: boolean
  id: string
  changed: boolean
}

/* ------------------------------------------------------------------ */
/* Evidence (new local routes)                                          */
/* ------------------------------------------------------------------ */

export type EvidenceFile = {
  name: string
  sizeBytes: number
  mtimeIso: string
  [k: string]: unknown
}
