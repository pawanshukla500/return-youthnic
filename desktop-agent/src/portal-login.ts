import { loadAgentConfig } from "./config.js"
import { operatorAuthorization } from "./operator-session.js"
import { openSupplierBrowser, resolveBrowserAdapterKind, type SupplierBrowserApi } from "./browser-adapter.js"
import { panelKeyForMarketplace } from "./panel-queue.js"
import { profileDirFor, readSessionSavedAt, supplierSessionDir, writeSessionMarker } from "./supplier-session.js"
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
  const config = loadAgentConfig()
  const kind = resolveBrowserAdapterKind()
  return (body.credentials || []).map((row) => {
    const accountName = String(row.accountName || row.marketplaceName || "")
    return {
      id: Number(row.id),
      marketplaceId: row.marketplaceId == null ? null : Number(row.marketplaceId),
      marketplaceName: String(row.marketplaceName || accountName),
      accountName,
      portalUrl: String(row.portalUrl || ""),
      usernameMasked: String(row.usernameMasked || ""),
      sessionSavedAt: readSessionSavedAt(supplierSessionDir(config.userDataDir, accountName, kind)),
    }
  })
}

export async function listPortalLogins(): Promise<{ channels: PortalChannelStatus[] }> {
  const rows = await fetchPortalRows()
  const config = loadAgentConfig()
  const kind = resolveBrowserAdapterKind()
  const channels = PORTAL_CHANNELS.map((channel) => {
    const row = rows.find((item) => item.accountName.toLowerCase() === channel.name.toLowerCase() || item.marketplaceName.toLowerCase() === channel.name.toLowerCase())
    return {
      name: channel.name,
      configured: Boolean(row?.usernameMasked),
      usernameMasked: row?.usernameMasked || "",
      sessionSavedAt: row?.sessionSavedAt || readSessionSavedAt(supplierSessionDir(config.userDataDir, channel.name, kind)),
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

/**
 * Resolves marketplace credentials from local environment variables if available.
 * Supports MEESHOID / MEESHO_PWD (and standard aliases) for zero-configuration Meesho logins.
 */
export function secretFromEnvironment(accountName: string): PortalSecret | null {
  const norm = accountName.toLowerCase()
  if (norm.includes("meesho")) {
    const username = (process.env.MEESHOID || process.env.MEESHO_ID || process.env.MEESHO_USERNAME || "").trim()
    const password = (process.env.MEESHO_PWD || process.env.MEESHO_PASSWORD || process.env.MEESHO_PASS || "").trim()
    if (username && password) {
      return {
        accountName,
        portalUrl: "https://supplier.meesho.com/panel/v3/new/root/login",
        username,
        password,
      }
    }
  }
  return null
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
  browser: SupplierBrowserApi,
  input: { marketplace: string; portalUrl: string; username: string; password: string; waitMs?: number; sessionDir?: string },
): Promise<{ ok: boolean; message: string }> {
  const portalUrl = input.portalUrl
  if (!portalUrl) return { ok: false, message: `${input.marketplace} has no supplier portal address.` }

  await browser.navigate(portalUrl)
  await browser.delay(1500)

  const envSecret = secretFromEnvironment(input.marketplace)
  const username = input.username || envSecret?.username || ""
  const password = input.password || envSecret?.password || ""

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
      writeSessionMarker(input.sessionDir || supplierSessionDir(loadAgentConfig().userDataDir, input.marketplace, resolveBrowserAdapterKind()), input.marketplace)
      logger.info(`${input.marketplace} login saved in the browser profile on this PC.`)
      return { ok: true, message: `${input.marketplace} is signed in and the cookies are saved on this PC.` }
    }

    const hasPasswordBox = await browser.evaluate<boolean>(`Boolean(document.querySelector('input[type="password"], input[name="password"]'))`)
    if (!typed && hasPasswordBox && username && password) {
      const userSelector = meesho
        ? 'input[name="emailOrPhone"]'
        : 'input[name="emailOrPhone"], input[type="email"], input[name="username"], input[type="text"]'
      logger.info(`Typing the saved ${input.marketplace} bot login (${username.length} characters in the ID).`)
      const typedUser = await browser.humanType(userSelector, username)
      if (typedUser) {
        await browser.delay(800)
        await browser.humanType('input[type="password"], input[name="password"]', password)
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

  if (!username || !password) {
    return {
      ok: false,
      message: `${input.marketplace} has no bot password saved. Enter the ID and password in Marketplace logins, or configure MEESHOID & MEESHO_PWD in .env, then save the cookies.`,
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

/**
 * Evaluates whether a marketplace supplier portal is in an authenticated session state.
 * Rejects login pages and visible password fields, while verifying positive markers like
 * panel URL fragments or authenticated dashboard greetings (e.g. "Welcome back", "Pending Orders").
 */
export function isPortalLoggedIn(marketplace: string, url: string, text: string = "", hasPasswordInput: boolean = false): boolean {
  const lowerUrl = url.toLowerCase()
  if (lowerUrl.includes("/login") || lowerUrl.includes("/root/login") || lowerUrl.includes("signin") || lowerUrl.includes("sign-in")) {
    return false
  }
  if (hasPasswordInput) {
    return false
  }
  if (marketplace.toLowerCase().includes("meesho")) {
    const inPanel = lowerUrl.includes("/growth/") || lowerUrl.includes("/experience/") || lowerUrl.includes("/panel/v3/new/")
    const welcome = text.includes("Welcome back") || text.includes("Pending Orders")
    return inPanel || welcome
  }
  return text.length > 80
}

async function loggedIn(browser: SupplierBrowserApi, marketplace: string): Promise<boolean> {
  return browser.evaluate<boolean>(`
    (() => {
      const text = document.body ? document.body.innerText : '';
      const password = Boolean(document.querySelector('input[type="password"], input[name="password"]'));
      const fn = ${isPortalLoggedIn.toString()};
      return fn(${JSON.stringify(marketplace)}, window.location.href, text, password);
    })()
  `)
}

let heldBrowser: SupplierBrowserApi | null = null

export function holdPortalBrowser(browser?: SupplierBrowserApi): boolean {
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

/**
 * Tests supplier portal login in the background using saved, bundled, or environment credentials.
 */
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

/**
 * Retries a single claim job by queuing it back for processing.
 */
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

/**
 * Signs into a marketplace supplier panel using saved, job bundle, or environment credentials.
 */
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
  let envSyncWarning = ""
  if (input.username && input.password) {
    await saveTypedLogin(row, input.username, input.password)
    secret = {
      accountName: row.accountName,
      portalUrl: row.portalUrl,
      username: input.username,
      password: input.password,
    }
  } else {
    const fromApi = (await secretFromAdminApi(row.accountName)) || (await secretFromJobBundle(row.accountName))
    if (fromApi) {
      secret = fromApi
    } else {
      const fromEnv = secretFromEnvironment(row.accountName)
      if (fromEnv) {
        secret = fromEnv
        if (!row.usernameMasked) {
          try {
            await saveTypedLogin(row, fromEnv.username, fromEnv.password)
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            logger.warn(`Could not save environment credentials for ${row.accountName} to backend: ${reason}`)
            envSyncWarning = `Environment credentials for ${row.accountName} were used for browser sign-in but remain unsaved on the backend (${reason}). An administrator can persist them under Marketplace Logins.`
          }
        }
      }
    }
  }

  if (!secret) {
    return {
      ok: false,
      needsPassword: true,
      message: `${row.accountName} needs the bot ID and password once. They will be saved with the other marketplace logins.`,
    }
  }

  const config = loadAgentConfig()
  const kind = resolveBrowserAdapterKind()
  // Supplier sign-in always goes through the selected adapter: the embedded
  // WebContentsView in the desktop app, the external system browser everywhere
  // else. A hardcoded BrowserRunner here used to
  // bypass the adapter, so Test Login ignored the native mode entirely.
  const handle = await openSupplierBrowser({
    panelKey: panelKeyForMarketplace(row.accountName),
    profileDir: profileDirFor(config.userDataDir, row.accountName),
    headless: false,
    port: 9333,
  })
  const browser = handle.browser
  try {
    const result = await completePortalLogin(browser, {
      marketplace: row.accountName,
      portalUrl: secret.portalUrl || row.portalUrl,
      username: secret.username,
      password: secret.password,
      sessionDir: supplierSessionDir(config.userDataDir, row.accountName, kind),
    })
    if (!result.ok && input.holdOnPrompt) {
      heldBrowser = browser
    }
    if (result.ok && envSyncWarning) {
      result.message = `${result.message} Note: ${envSyncWarning}`
    }
    return result
  } finally {
    if (heldBrowser !== browser) await handle.close()
  }
}

/**
 * Retries failed or paused automation jobs for a specific marketplace account.
 */
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
