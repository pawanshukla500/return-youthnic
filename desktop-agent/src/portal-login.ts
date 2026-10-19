import fs from "node:fs"
import path from "node:path"
import { loadAgentConfig } from "./config.js"
import { operatorAuthorization } from "./operator-session.js"
import { BrowserRunner } from "./browser-runner.js"
import { logger } from "./logger.js"

export const PORTAL_CHANNELS = [
  { name: "Meesho" },
  { name: "Flipkart" },
  { name: "Amazon" },
  { name: "Myntra VB" },
  { name: "Myntra EJ" },
  { name: "Ajio" },
] as const

export type PortalLoginRow = {
  id: number
  marketplaceId: number | null
  marketplaceName: string
  accountName: string
  portalUrl: string
  usernameMasked: string
  sessionSavedAt: string | null
}

type PortalChannelStatus = {
  name: string
  configured: boolean
  usernameMasked: string
  sessionSavedAt: string | null
}

type PortalSecret = {
  accountName: string
  portalUrl: string
  username: string
  password: string
}

export function profileDirFor(userDataDir: string, marketplace: string): string {
  const key = marketplace.toLowerCase().replace(/[^a-z0-9]/g, "_")
  return path.join(userDataDir, `profile-${key}`)
}

export function sessionMarkerPath(profileDir: string): string {
  return path.join(profileDir, "return-app-session.json")
}

export function readSessionSavedAt(profileDir: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionMarkerPath(profileDir), "utf8")) as { savedAt?: string }
    return parsed.savedAt || null
  } catch {
    return null
  }
}

function writeSessionMarker(profileDir: string, accountName: string): void {
  if (!profileDir) return
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(
    sessionMarkerPath(profileDir),
    JSON.stringify({ accountName, savedAt: new Date().toISOString() }),
    "utf8",
  )
}

function backend(): string {
  return loadAgentConfig().backendUrl.replace(/\/$/, "")
}

async function authHeaders(): Promise<Record<string, string>> {
  const authorization = operatorAuthorization()
  if (!authorization) throw new Error("Sign in on this desktop app before setting up a marketplace login.")
  return { Authorization: authorization, "Content-Type": "application/json" }
}

async function fetchPortalRows(): Promise<PortalLoginRow[]> {
  const headers = await authHeaders()
  const res = await fetch(`${backend()}/api/automation/credentials`, { headers })
  if (!res.ok) throw new Error("Could not read the bot logins saved in the web app.")
  const body = (await res.json()) as { credentials?: Array<Record<string, unknown>> }
  const userDataDir = loadAgentConfig().userDataDir
  return (body.credentials || []).map((row) => {
    const accountName = String(row.accountName || row.marketplaceName || "")
    return {
      id: Number(row.id),
      marketplaceId: row.marketplaceId == null ? null : Number(row.marketplaceId),
      marketplaceName: String(row.marketplaceName || accountName),
      accountName,
      portalUrl: String(row.portalUrl || ""),
      usernameMasked: String(row.usernameMasked || ""),
      sessionSavedAt: readSessionSavedAt(profileDirFor(userDataDir, accountName)),
    }
  })
}

export async function listPortalLogins(): Promise<{ channels: PortalChannelStatus[] }> {
  const rows = await fetchPortalRows()
  const userDataDir = loadAgentConfig().userDataDir
  const channels = PORTAL_CHANNELS.map((channel) => {
    const row = rows.find((item) => item.accountName.toLowerCase() === channel.name.toLowerCase() || item.marketplaceName.toLowerCase() === channel.name.toLowerCase())
    return {
      name: channel.name,
      configured: Boolean(row?.usernameMasked),
      usernameMasked: row?.usernameMasked || "",
      sessionSavedAt: row?.sessionSavedAt || readSessionSavedAt(profileDirFor(userDataDir, channel.name)),
    }
  })
  return { channels }
}

async function secretFromJobBundle(accountName: string): Promise<PortalSecret | null> {
  const config = loadAgentConfig()
  const jobsRes = await fetch(
    `${backend()}/api/automation/agent/jobs?agentUuid=${encodeURIComponent(config.agentUuid)}`,
    { headers: { "X-Agent-UUID": config.agentUuid, "X-Agent-Key": config.apiKey } },
  )
  if (!jobsRes.ok) return null
  const jobsBody = (await jobsRes.json()) as { rows?: Array<Record<string, unknown>> }
  const wanted = accountName.toLowerCase()
  const match = (jobsBody.rows || []).find((row) => String(row.marketplace || "").toLowerCase().includes(wanted) || wanted.includes(String(row.marketplace || "").toLowerCase()))
  const jobId = Number(match?.id || match?.jobId || 0)
  if (!jobId) return null
  const bundleRes = await fetch(`${backend()}/api/automation/jobs/${jobId}/bundle`, {
    headers: { "X-Agent-UUID": config.agentUuid, "X-Agent-Key": config.apiKey },
  })
  if (!bundleRes.ok) return null
  const bundle = (await bundleRes.json()) as {
    portalUrl?: string
    accountName?: string
    credentials?: { username?: string; password?: string }
  }
  const username = bundle.credentials?.username || ""
  const password = bundle.credentials?.password || ""
  if (!username || !password) return null
  return {
    accountName: bundle.accountName || accountName,
    portalUrl: bundle.portalUrl || "",
    username,
    password,
  }
}

async function secretFromAdminApi(accountName: string): Promise<PortalSecret | null> {
  const headers = await authHeaders()
  const res = await fetch(
    `${backend()}/api/automation/portal-login-secret?account=${encodeURIComponent(accountName)}`,
    { headers },
  )
  if (!res.ok) return null
  const body = (await res.json()) as PortalSecret
  if (!body.username || !body.password) return null
  return body
}

async function saveTypedLogin(row: PortalLoginRow, username: string, password: string): Promise<void> {
  const headers = await authHeaders()
  const res = await fetch(`${backend()}/api/admin/automation/credentials`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: row.id,
      marketplaceId: row.marketplaceId,
      accountName: row.accountName,
      portalUrl: row.portalUrl,
      username,
      password,
      automationMode: "assisted",
      requireApprovalBeforeSubmit: true,
      autoPrepare: true,
    }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || "Could not save the bot login.")
  }
}

export async function completePortalLogin(
  browser: BrowserRunner,
  input: { marketplace: string; portalUrl: string; username: string; password: string; waitMs?: number },
): Promise<{ ok: boolean; message: string }> {
  const portalUrl = input.portalUrl
  if (!portalUrl) return { ok: false, message: `${input.marketplace} has no supplier portal address.` }

  await browser.navigate(portalUrl)
  await browser.delay(1500)

  let typed = false
  let announcedOtp = false
  const deadline = Date.now() + (input.waitMs ?? 180000)
  const meesho = input.marketplace.toLowerCase().includes("meesho")

  while (Date.now() < deadline) {
    if (meesho) {
      const landing = await browser.evaluate<boolean>(`Boolean(document.querySelector('#loginbutton, a[href*="/login"]'))`)
      const already = await loggedIn(browser, input.marketplace)
      if (landing && !already) {
        await browser.humanClick('#loginbutton, a[href*="/login"]')
        await browser.delay(1500)
      }
    }

    if (await loggedIn(browser, input.marketplace)) {
      writeSessionMarker(browser.profileDirectory, input.marketplace)
      logger.info(`${input.marketplace} login saved in the browser profile on this PC.`)
      return { ok: true, message: `${input.marketplace} is signed in and the cookies are saved on this PC.` }
    }

    const hasPasswordBox = await browser.evaluate<boolean>(`Boolean(document.querySelector('input[type="password"], input[name="password"]'))`)
    if (!typed && hasPasswordBox && input.username && input.password) {
      const userSelector = meesho
        ? 'input[name="emailOrPhone"]'
        : 'input[name="emailOrPhone"], input[type="email"], input[name="username"], input[type="text"]'
      logger.info(`Typing the saved ${input.marketplace} bot login (${input.username.length} characters in the ID).`)
      const typedUser = await browser.humanType(userSelector, input.username)
      if (typedUser) {
        await browser.delay(800)
        await browser.humanType('input[type="password"], input[name="password"]', input.password)
        await browser.delay(800)
        await browser.evaluate(`
          (() => {
            const btn = Array.from(document.querySelectorAll('button, input[type="submit"]')).find((el) => {
              const label = ((el.textContent || el.value || '') + '').trim().toLowerCase();
              return label === 'log in' || label === 'login' || label === 'sign in' || label === 'continue' || label === 'submit';
            }) || document.querySelector('button[type="submit"]');
            if (btn) btn.click();
          })()
        `)
        typed = true
        await browser.delay(3000)
      }
    }

    const challenge = await browser.detectCaptchaOrOtp()
    if (challenge.challengeDetected && !announcedOtp) {
      announcedOtp = true
      logger.info(`${input.marketplace} is asking for a code. Type it in the supplier browser window. This app will save the cookies when the supplier panel opens.`)
    }

    await browser.delay(4000)
  }

  if (!input.username || !input.password) {
    return {
      ok: false,
      message: `${input.marketplace} has no bot password saved. Enter the ID and password in Marketplace logins, then save the cookies.`,
    }
  }
  if (announcedOtp) {
    return {
      ok: false,
      message: `${input.marketplace} is still waiting for the code in the supplier browser window. Type the code there. The cookies are saved when the supplier panel opens.`,
    }
  }
  return {
    ok: false,
    message: `${input.marketplace} did not finish signing in. The saved bot ID was used. Open the supplier browser window and complete the login so the cookies can be saved.`,
  }
}

async function loggedIn(browser: BrowserRunner, marketplace: string): Promise<boolean> {
  const meesho = marketplace.toLowerCase().includes("meesho")
  return browser.evaluate<boolean>(`
    (() => {
      const text = document.body ? document.body.innerText : '';
      const password = Boolean(document.querySelector('input[type="password"], input[name="password"]'));
      if (${meesho ? "true" : "false"}) {
        const url = window.location.href.toLowerCase();
        const inPanel = url.includes("/growth/") && !url.includes("/login");
        const welcome = text.includes("Welcome back") || text.includes("Pending Orders");
        return (inPanel || welcome) && !password;
      }
      const url = window.location.href.toLowerCase();
      return text.length > 80 && !password && !url.includes('login') && !url.includes('signin') && !url.includes('sign-in');
    })()
  `)
}

let heldBrowser: BrowserRunner | null = null

export function holdPortalBrowser(browser?: BrowserRunner): boolean {
  if (browser) heldBrowser = browser
  return heldBrowser !== null
}

export async function closePortalLoginBrowser(): Promise<void> {
  if (!heldBrowser) return
  const browser = heldBrowser
  heldBrowser = null
  await browser.close()
}

export async function savePortalLogin(
  marketplace: string,
  username: string,
  password: string,
): Promise<{ ok: boolean; status: number; message: string }> {
  const name = marketplace.trim()
  const idValue = username.trim()
  if (!name || !idValue || !password) {
    return { ok: false, status: 400, message: "Choose a marketplace and enter the supplier ID and password." }
  }
  const rows = await fetchPortalRows()
  const row = rows.find((item) => item.accountName.toLowerCase() === name.toLowerCase())
  if (!row) return { ok: false, status: 404, message: `${name} is not in the marketplace accounts.` }
  await saveTypedLogin(row, idValue, password)
  return { ok: true, status: 200, message: `${name} bot login saved.` }
}

export async function testPortalLogin(
  marketplace: string,
  username: string,
  password: string,
): Promise<{ ok: boolean; message: string }> {
  await closePortalLoginBrowser()
  const result = await signInMarketplace({
    accountName: marketplace,
    username: username.trim() || undefined,
    password: password || undefined,
    holdOnPrompt: true,
  })
  if (result.ok) {
    const requeued = await requeueMarketplaceJobs(marketplace)
    return {
      ok: true,
      message: requeued
        ? `${result.message} ${requeued} waiting claim is back in the queue.`
        : result.message,
    }
  }
  return { ok: false, message: result.message }
}

export async function queueOneClaim(jobId: number): Promise<{ ok: boolean; status: number; message: string }> {
  if (!jobId) return { ok: false, status: 400, message: "Choose a claim." }
  const headers = await authHeaders()
  const retry = await fetch(`${backend()}/api/automation/jobs/${jobId}/retry`, { method: "POST", headers })
  if (!retry.ok) {
    const body = (await retry.json().catch(() => ({}))) as { error?: string }
    return { ok: false, status: retry.status, message: body.error || "Could not queue that claim." }
  }
  return { ok: true, status: 200, message: "That claim is back in the queue." }
}

export async function signInMarketplace(input: {
  accountName: string
  username?: string
  password?: string
  holdOnPrompt?: boolean
}): Promise<{ ok: boolean; needsPassword?: boolean; message: string }> {
  const rows = await fetchPortalRows()
  const row = rows.find((item) => item.accountName.toLowerCase() === input.accountName.toLowerCase())
  if (!row) return { ok: false, message: `No marketplace account named ${input.accountName}.` }

  let secret: PortalSecret | null = null
  if (input.username && input.password) {
    await saveTypedLogin(row, input.username, input.password)
    secret = {
      accountName: row.accountName,
      portalUrl: row.portalUrl,
      username: input.username,
      password: input.password,
    }
  } else {
    secret = (await secretFromAdminApi(row.accountName)) || (await secretFromJobBundle(row.accountName))
  }

  if (!secret) {
    return {
      ok: false,
      needsPassword: true,
      message: `${row.accountName} needs the bot ID and password once. They will be saved with the other marketplace logins.`,
    }
  }

  const config = loadAgentConfig()
  const profileDir = profileDirFor(config.userDataDir, row.accountName)
  const browser = new BrowserRunner()
  const session = await browser.launch({ profileDir, headless: false, port: 9333 })
  try {
    await browser.connectToPage(session.port)
    const result = await completePortalLogin(browser, {
      marketplace: row.accountName,
      portalUrl: secret.portalUrl || row.portalUrl,
      username: secret.username,
      password: secret.password,
    })
    if (!result.ok && input.holdOnPrompt) {
      heldBrowser = browser
    }
    return result
  } finally {
    if (heldBrowser !== browser) await browser.close()
  }
}

export async function requeueMarketplaceJobs(accountName: string): Promise<number> {
  const headers = await authHeaders()
  const config = loadAgentConfig()
  const jobsRes = await fetch(
    `${backend()}/api/automation/agent/jobs?agentUuid=${encodeURIComponent(config.agentUuid)}`,
    { headers: { "X-Agent-UUID": config.agentUuid, "X-Agent-Key": config.apiKey } },
  )
  if (!jobsRes.ok) return 0
  const jobsBody = (await jobsRes.json()) as { rows?: Array<Record<string, unknown>> }
  const wanted = accountName.toLowerCase()
  let reset = 0
  for (const row of jobsBody.rows || []) {
    const marketplace = String(row.marketplace || "").toLowerCase()
    if (!marketplace.includes(wanted) && !wanted.includes(marketplace)) continue
    if (String(row.stage) !== "manual_intervention_required") continue
    const id = Number(row.id || row.jobId || 0)
    if (!id) continue
    const retry = await fetch(`${backend()}/api/automation/jobs/${id}/retry`, { method: "POST", headers })
    if (retry.ok) reset += 1
  }
  return reset
}
