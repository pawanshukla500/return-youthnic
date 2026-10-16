import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type AgentConfig = {
  agentUuid: string
  agentName: string
  backendUrl: string
  apiKey: string
  pollIntervalMs: number
  heartbeatIntervalMs: number
  browserMode: "visible" | "headless"
  browserPath: string
  userDataDir: string
  workDir: string
  logLevel: "debug" | "info" | "warn" | "error"
}

export const DEFAULT_PRODUCTION_URL = "https://return.youthnic.shop"

export function loadAgentConfig(): AgentConfig {
  const homeDir = os.homedir()
  const baseDir = path.join(homeDir, ".taskflow-claim-agent")
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true })
  }

  const configFile = path.join(baseDir, "config.json")
  let saved: Partial<AgentConfig> = {}
  if (fs.existsSync(configFile)) {
    try {
      saved = JSON.parse(fs.readFileSync(configFile, "utf8"))
    } catch {
      // ignore
    }
  }

  const hostname = os.hostname()
  const defaultUuid = saved.agentUuid || `agent-${hostname.toLowerCase()}-${process.pid}-${Date.now().toString(36)}`

  // Always prioritize explicit env variables if set.
  // If saved.backendUrl is empty or points to legacy localhost/127.0.0.1, auto-upgrade to the production cloud VPS
  let backendUrl = process.env.BACKEND_URL || process.env.APP_URL || saved.backendUrl || DEFAULT_PRODUCTION_URL
  if (!process.env.BACKEND_URL && !process.env.APP_URL) {
    if (!backendUrl || backendUrl.includes("127.0.0.1") || backendUrl.includes("localhost")) {
      backendUrl = DEFAULT_PRODUCTION_URL
    }
  }

  const config: AgentConfig = {
    agentUuid: process.env.AGENT_UUID || saved.agentUuid || defaultUuid,
    agentName: process.env.AGENT_NAME || saved.agentName || `Warehouse-Agent-${hostname}`,
    backendUrl,
    apiKey: process.env.AGENT_API_KEY || saved.apiKey || "",
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || saved.pollIntervalMs || 10000),
    heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS || saved.heartbeatIntervalMs || 15000),
    browserMode: (process.env.BROWSER_MODE || saved.browserMode || "visible") as "visible" | "headless",
    browserPath: process.env.BROWSER_PATH || saved.browserPath || "",
    userDataDir: path.join(baseDir, "browser-profiles"),
    workDir: path.join(baseDir, "evidence-cache"),
    logLevel: (process.env.LOG_LEVEL || saved.logLevel || "info") as AgentConfig["logLevel"],
  }

  // Persist if first run or if legacy localhost URL was upgraded
  if (!fs.existsSync(configFile) || saved.backendUrl !== backendUrl) {
    try {
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8")
    } catch {
      // ignore
    }
  }

  return config
}

export function saveAgentConfig(updates: Partial<AgentConfig>): AgentConfig {
  const current = loadAgentConfig()
  const updated: AgentConfig = { ...current, ...updates }
  const homeDir = os.homedir()
  const configFile = path.join(homeDir, ".taskflow-claim-agent", "config.json")
  try {
    fs.writeFileSync(configFile, JSON.stringify(updated, null, 2), "utf8")
  } catch {
    // ignore
  }
  return updated
}

