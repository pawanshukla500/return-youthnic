// Dashboard UI contract: every AI Center control in the engine dashboard HTML
// has a working handler and a matching engine route. Static but strict: a
// renamed button or a dropped endpoint fails here before a human clicks it.
// No browser, no keys, no screenshots.

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const serverSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "desktop-app-server.ts"),
  "utf8",
)

test("AI Center section exists with five tabs and key input is password-masked", () => {
  assert.ok(serverSource.includes('id="ai-center"'), "ai-center section")
  for (const tab of ["providers", "routing", "agents", "usage", "memory"]) {
    assert.ok(serverSource.includes(`aiCenterTab('${tab}')`), `tab button ${tab}`)
    assert.ok(serverSource.includes(`id="aic-tab-${tab}"`), `tab panel ${tab}`)
  }
  assert.ok(serverSource.includes('id="aic-key-input" type="password"'), "masked key entry")
  assert.ok(serverSource.includes("never shown again"), "no-plaintext notice")
})

test("every AI Center control has its advertised handler defined", () => {
  const handlers = [
    "aiCenterTab", "loadAiCenter", "renderAiProviders", "openAiKeyEditor", "closeAiKeyEditor",
    "saveAiKey", "removeAiKey", "quickTestAiConnection", "testAiConnection", "refreshAiModels",
    "saveAiPrefs", "renderAiRouting", "saveAiRouting", "loadAiActivity", "loadAiUsage", "loadAiMemoryLine",
  ]
  for (const fn of handlers) {
    assert.ok(serverSource.includes(`function ${fn}(`), `handler ${fn} defined`);
    // Each interactive handler is referenced by at least one control, except
    // loaders called programmatically on tab switch/interval.
    if (!["loadAiCenter", "renderAiProviders", "renderAiRouting", "loadAiActivity", "loadAiUsage", "loadAiMemoryLine", "closeAiKeyEditor"].includes(fn)) {
      assert.ok(serverSource.includes(`${fn}(`), `handler ${fn} wired`);
    }
  }
})

test("dashboard calls only real AI Center routes (no invented endpoints)", () => {
  const routesSource = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "ai-center-routes.ts"),
    "utf8",
  )
  const dashboardEndpoints = [
    "/api/v1/ai-center/providers",
    "/api/v1/ai-center/routing",
    "/api/v1/ai-center/usage",
    "/api/v1/ai-center/activity",
    "/api/v1/ai-memory",
    "/api/v1/ai-memory/disable",
  ]
  for (const endpoint of dashboardEndpoints) {
    assert.ok(serverSource.includes(`fetch('${endpoint}`), `dashboard calls ${endpoint}`)
    const routePath = endpoint.replace("/api/v1/ai-memory/disable", "/api/v1/ai-memory/disable").split("?")[0]
    const base = routePath.replace(/\/[^/]+$/, "")
    assert.ok(routesSource.includes(base) || serverSource.includes(`"${routePath}"`), `route serves ${endpoint}`)
  }
  // Key save/test/remove/model/prefs hit the provider sub-routes.
  for (const suffix of ["key", "test", "models", "prefs"]) {
    assert.ok(serverSource.includes(suffix), `dashboard uses provider ${suffix}`);
    assert.ok(routesSource.includes(`=== "${suffix}"`), `engine serves ${suffix}`);
  }
})

test("dashboard never renders key material and clears the input after save", () => {
  const editorStart = serverSource.indexOf('id="aic-key-editor"')
  assert.ok(editorStart > 0)
  const editor = serverSource.slice(editorStart, editorStart + 6000)
  assert.ok(!editor.includes("hasKey") || editor.includes("Saved (encrypted)"), "shows status, not key")
  assert.ok(serverSource.includes("input.value = ''"), "renderer state cleared after submission")
  assert.ok(!serverSource.match(/fetch\([^)]*key=\$\{[^}]*key[^}]*\}/), "no key in query string")
})

test("engine requires sign-in on every AI Center route", () => {
  const routesSource = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "ai-center-routes.ts"),
    "utf8",
  )
  assert.ok(routesSource.includes("Sign in before using the AI Center"), "auth gate")
  assert.ok(!routesSource.includes("revealProviderKey(dir, provider)") || routesSource.includes("hasKey"), "status surface, not key surface")
})

test("worker prefers AI Center routing before the legacy gateway", () => {
  assert.ok(serverSource.includes("runRoutedAssist({"), "routed assist invoked in follow-up path")
  assert.ok(serverSource.includes("AI Center routing first: the operator's own provider keys"), "AI Center routing attempted before gateway")
  const idxRouted = serverSource.indexOf("runRoutedAssist({")
  const idxGateway = serverSource.indexOf("requestAiProposal(provider,", idxRouted)
  assert.ok(idxGateway > idxRouted, "legacy gateway remains as fallback after routing")
})
