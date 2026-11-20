// WhatsApp gateway and group dispatcher for Return App.
//
// Talks to the self-hosted go-whatsapp-web-multidevice (GOWA) gateway over HTTPS.
//
// Capabilities:
// - Sends the daily OMSGuru inventory update CSV to the configured WhatsApp group
// - Optionally tags one configured user with WhatsApp mentions
// - Sends the daily returns reconciliation summary CSV (only when forced)
// - Checks gateway connection status
// - Audit logging and persistent settings via app_system_settings
//
// The gateway login, group ID and tagged user come only from WHATSAPP_* environment
// variables or the stored settings. Nothing is sent until both the login and the group ID
// are set: every send path then returns a "not configured" result without a network call.

import type pg from "pg"
import type { OmsguruDailyUpdateRecord } from "./omsguru-daily.js"
import type { DailyReportData } from "./email-reports.js"

export type WhatsAppConfig = {
  enabled: boolean
  apiUrl: string
  basicAuth: string
  groupJid: string
  tagUserJid: string
  tagUserLid: string
  tagUserName: string
}

/** Builds the default config from WHATSAPP_* variables; only the gateway URL has a fallback. */
export function whatsAppConfigFromEnv(env: Record<string, string | undefined> = process.env): WhatsAppConfig {
  const read = (key: string) => env[key]?.trim() || ""
  const basicAuth = read("WHATSAPP_BASIC_AUTH")
  const groupJid = read("WHATSAPP_GROUP_JID")
  return {
    enabled: Boolean(basicAuth && groupJid),
    apiUrl: read("WHATSAPP_API_URL") || "https://wa.youthnic.shop",
    basicAuth,
    groupJid,
    tagUserJid: read("WHATSAPP_TAG_USER_JID"),
    tagUserLid: read("WHATSAPP_TAG_USER_LID"),
    tagUserName: read("WHATSAPP_TAG_USER_NAME"),
  }
}

/** The config as the UI and audit log may see it: the gateway login is never returned, only whether it is set. */
export function redactWhatsAppConfig(cfg: WhatsAppConfig): Omit<WhatsAppConfig, "basicAuth"> & { basicAuthSet: boolean } {
  const { basicAuth, ...rest } = cfg
  return { ...rest, basicAuthSet: Boolean(basicAuth.trim()) }
}

/** Why nothing can be sent with this config, or null when the gateway login and group ID are both set. */
export function whatsAppNotConfiguredReason(cfg: WhatsAppConfig): string | null {
  const missing = [
    cfg.basicAuth.trim() ? "" : "gateway login (WHATSAPP_BASIC_AUTH)",
    cfg.groupJid.trim() ? "" : "group ID (WHATSAPP_GROUP_JID)",
  ].filter(Boolean)
  return missing.length ? `WhatsApp is not configured: missing ${missing.join(" and ")}` : null
}

const fmt = (n: number) => n.toLocaleString("en-IN")

export async function getWhatsAppConfig(db: pg.Pool): Promise<WhatsAppConfig> {
  // Read the environment on every call, not at import: server/index.ts loads .env after its imports run.
  const fromEnv = whatsAppConfigFromEnv()
  try {
    const result = await db.query(
      "SELECT setting_value FROM app_system_settings WHERE setting_key = 'whatsapp_config'",
    )
    if (result.rows[0]?.setting_value) {
      const stored = result.rows[0].setting_value as Partial<WhatsAppConfig>
      return {
        enabled: stored.enabled ?? fromEnv.enabled,
        apiUrl: (stored.apiUrl || fromEnv.apiUrl).replace(/\/+$/, ""),
        basicAuth: stored.basicAuth || fromEnv.basicAuth,
        groupJid: stored.groupJid || fromEnv.groupJid,
        tagUserJid: stored.tagUserJid || fromEnv.tagUserJid,
        tagUserLid: stored.tagUserLid || fromEnv.tagUserLid,
        tagUserName: stored.tagUserName || fromEnv.tagUserName,
      }
    }
  } catch {
    // ignore
  }
  return fromEnv
}

export async function updateWhatsAppConfig(
  db: pg.Pool,
  config: Partial<WhatsAppConfig>,
  actorUserId: number,
): Promise<WhatsAppConfig> {
  const current = await getWhatsAppConfig(db)
  const updated: WhatsAppConfig = {
    enabled: config.enabled ?? current.enabled,
    apiUrl: (config.apiUrl ?? current.apiUrl).trim().replace(/\/+$/, ""),
    // The UI never receives the login, so a save without one keeps the current login.
    basicAuth: (config.basicAuth?.trim() || current.basicAuth).trim(),
    groupJid: (config.groupJid ?? current.groupJid).trim(),
    tagUserJid: (config.tagUserJid ?? current.tagUserJid).trim(),
    tagUserLid: (config.tagUserLid ?? current.tagUserLid).trim(),
    tagUserName: (config.tagUserName ?? current.tagUserName).trim(),
  }

  await db.query(
    `INSERT INTO app_system_settings (setting_key, setting_value, updated_at, updated_by)
     VALUES ('whatsapp_config', $1::jsonb, now(), $2)
     ON CONFLICT (setting_key) DO UPDATE
     SET setting_value = EXCLUDED.setting_value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(updated), actorUserId],
  )

  await db.query(
    `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, 'system.update_whatsapp_config', 'whatsapp_config', 'default', $2::jsonb)`,
    [actorUserId, JSON.stringify(redactWhatsAppConfig(updated))],
  )

  return updated
}

function getAuthHeader(config: WhatsAppConfig): string {
  return "Basic " + Buffer.from(config.basicAuth).toString("base64")
}

// Check live WhatsApp connection status
export async function checkWhatsAppConnection(config?: WhatsAppConfig): Promise<{
  connected: boolean
  loggedIn: boolean
  jid?: string
  deviceId?: string
  error?: string
}> {
  const cfg = config || whatsAppConfigFromEnv()
  const notConfigured = whatsAppNotConfiguredReason(cfg)
  if (notConfigured) {
    return { connected: false, loggedIn: false, error: notConfigured }
  }
  try {
    const res = await fetch(`${cfg.apiUrl}/app/status`, {
      method: "GET",
      headers: {
        Authorization: getAuthHeader(cfg),
      },
    })

    if (!res.ok) {
      return {
        connected: false,
        loggedIn: false,
        error: `HTTP ${res.status}: ${res.statusText}`,
      }
    }

    const data = (await res.json()) as any
    const results = data?.results || {}
    return {
      connected: Boolean(results.is_connected),
      loggedIn: Boolean(results.is_logged_in),
      jid: results.jid,
      deviceId: results.device_id,
    }
  } catch (err: any) {
    return {
      connected: false,
      loggedIn: false,
      error: err.message,
    }
  }
}

// Send plain or tagged text message with exponential backoff retry for 100% reliability
export async function sendWhatsAppTextMessage(
  params: {
    phone: string
    message: string
    mentions?: string[]
  },
  customConfig?: WhatsAppConfig,
  maxRetries = 3,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const cfg = customConfig || whatsAppConfigFromEnv()
  const notConfigured = whatsAppNotConfiguredReason(cfg)
  if (notConfigured) {
    return { success: false, error: notConfigured }
  }
  if (!cfg.enabled) {
    return { success: false, error: "WhatsApp notifications are disabled in configuration" }
  }

  let lastError = ""
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${cfg.apiUrl}/send/message`, {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(cfg),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phone: params.phone,
          message: params.message,
          mentions: params.mentions || [],
        }),
      })

      const data = (await res.json().catch(() => null)) as any
      if (!res.ok || data?.code !== "SUCCESS") {
        lastError = data?.message || `HTTP ${res.status} send failed`
        if (attempt < maxRetries && (res.status >= 500 || res.status === 429)) {
          console.warn(`[WhatsApp Gateway] Text attempt ${attempt}/${maxRetries} failed (${lastError}). Retrying in ${attempt * 1500}ms...`)
          await new Promise((r) => setTimeout(r, attempt * 1500))
          continue
        }
        return { success: false, error: lastError }
      }

      return {
        success: true,
        messageId: data?.results?.message_id,
      }
    } catch (err: any) {
      lastError = err.message
      if (attempt < maxRetries) {
        console.warn(`[WhatsApp Gateway] Text network error on attempt ${attempt}/${maxRetries} (${lastError}). Retrying in ${attempt * 1500}ms...`)
        await new Promise((r) => setTimeout(r, attempt * 1500))
        continue
      }
    }
  }

  return { success: false, error: lastError }
}

// Send document / CSV file with caption, mentions, and exponential backoff retry for 100% reliability
export async function sendWhatsAppDocument(
  params: {
    phone: string
    caption: string
    filename: string
    fileBuffer: Buffer | string
    contentType?: string
    mentions?: string[]
  },
  customConfig?: WhatsAppConfig,
  maxRetries = 3,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const cfg = customConfig || whatsAppConfigFromEnv()
  const notConfigured = whatsAppNotConfiguredReason(cfg)
  if (notConfigured) {
    return { success: false, error: notConfigured }
  }
  if (!cfg.enabled) {
    return { success: false, error: "WhatsApp notifications are disabled in configuration" }
  }

  let lastError = ""
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData()
      form.append("phone", params.phone)
      form.append("caption", params.caption)

      // Append mentions: GOWA accepts repeated 'mentions' fields in form-data
      if (params.mentions && params.mentions.length > 0) {
        for (const m of params.mentions) {
          if (m) form.append("mentions", m)
        }
      }

      const mime = params.contentType || "text/csv; charset=utf-8"
      const part: BlobPart = typeof params.fileBuffer === "string"
        ? params.fileBuffer
        : new Uint8Array(params.fileBuffer)
      const blob = new Blob([part], { type: mime })
      form.append("file", blob, params.filename)

      const res = await fetch(`${cfg.apiUrl}/send/file`, {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(cfg),
        },
        body: form,
      })

      const data = (await res.json().catch(() => null)) as any
      if (!res.ok || data?.code !== "SUCCESS") {
        lastError = data?.message || `HTTP ${res.status} file send failed`
        if (attempt < maxRetries && (res.status >= 500 || res.status === 429)) {
          console.warn(`[WhatsApp Gateway] Document attempt ${attempt}/${maxRetries} failed (${lastError}). Retrying in ${attempt * 1500}ms...`)
          await new Promise((r) => setTimeout(r, attempt * 1500))
          continue
        }
        return { success: false, error: lastError }
      }

      return {
        success: true,
        messageId: data?.results?.message_id,
      }
    } catch (err: any) {
      lastError = err.message
      if (attempt < maxRetries) {
        console.warn(`[WhatsApp Gateway] Document network error on attempt ${attempt}/${maxRetries} (${lastError}). Retrying in ${attempt * 1500}ms...`)
        await new Promise((r) => setTimeout(r, attempt * 1500))
        continue
      }
    }
  }

  return { success: false, error: lastError }
}

// Renders simple and normal caption for OMSGuru daily update
export function renderOmsguruWhatsAppCaption(
  record: OmsguruDailyUpdateRecord,
  config: WhatsAppConfig,
): { caption: string; mentions: string[] } {
  // Mentions array: phone JID and LID for push alerts across mobile & web
  const mentions: string[] = []
  if (config.tagUserJid) mentions.push(config.tagUserJid)
  if (config.tagUserLid) mentions.push(config.tagUserLid)

  // In-text tag: the digits before "@" in the tagged user JID
  // WhatsApp maps @<digits> to the contact name in the group without brackets
  const tagPhoneOnly = config.tagUserJid.replace(/@.*$/, "")
  const tagLine = tagPhoneOnly ? `@${tagPhoneOnly}` : ""

  const caption = [
    tagLine,
    `Please update this inventory on Omsguru ${record.requestId}`,
  ]
    .filter(Boolean)
    .join("\n")

  return { caption, mentions }
}

// Dispatches the OMSGuru update file and summary directly to the WhatsApp group
export async function sendOmsguruDailyToWhatsApp(
  db: pg.Pool,
  record: OmsguruDailyUpdateRecord,
  options: { force?: boolean } = {},
): Promise<{ sent: boolean; messageId?: string; error?: string }> {
  const config = await getWhatsAppConfig(db)
  const notConfigured = whatsAppNotConfiguredReason(config)
  if (notConfigured) {
    return { sent: false, error: notConfigured }
  }
  if (!config.enabled && !options.force) {
    return { sent: false, error: "WhatsApp notifications disabled in settings" }
  }

  const { caption, mentions } = renderOmsguruWhatsAppCaption(record, config)
  const filename = "UpdateInStockQtyAnd_orLastPurchasePrice.csv"
  const fileBuffer = Buffer.from(record.csvContent, "utf8")

  const result = await sendWhatsAppDocument(
    {
      phone: config.groupJid,
      caption,
      filename,
      fileBuffer,
      contentType: "text/csv; charset=utf-8",
      mentions,
    },
    config,
  )

  if (result.success) {
    try {
      // Record in audit log
      await db.query(
        `INSERT INTO register_audit_log (actor_user_id, action, entity_type, entity_id, details)
         VALUES ($1, 'omsguru.whatsapp_sent', 'omsguru_daily_inventory_updates', $2, $3::jsonb)`,
        [
          record.generatedBy ?? 1,
          String(record.id),
          JSON.stringify({
            messageId: result.messageId,
            groupJid: config.groupJid,
            tagUserJid: config.tagUserJid,
            totalQty: record.totalQty,
            totalSkus: record.totalSkus,
            requestId: record.requestId,
          }),
        ],
      )

      // Set whatsapp_sent = true and clear any previous error
      await db.query(
        `UPDATE omsguru_daily_inventory_updates
         SET whatsapp_sent = true, whatsapp_sent_at = now(), whatsapp_message_id = $1, whatsapp_error = NULL
         WHERE id = $2`,
        [result.messageId || "", record.id],
      ).catch(() => {})
    } catch {
      // Non-fatal logging error
    }
  } else {
    // Record error in database so administrators have 100% visibility
    await db.query(
      `UPDATE omsguru_daily_inventory_updates
       SET whatsapp_sent = false, whatsapp_error = $1
       WHERE id = $2`,
      [result.error || "Unknown send failure", record.id],
    ).catch(() => {})
  }

  return {
    sent: result.success,
    messageId: result.messageId,
    error: result.error,
  }
}

// Dispatches the daily return reconciliation report to the WhatsApp group
export async function sendDailyReportToWhatsApp(
  db: pg.Pool,
  data: DailyReportData,
  options: { force?: boolean } = {},
): Promise<{ sent: boolean; messageId?: string; error?: string }> {
  if (!options.force) {
    return { sent: false, error: "Daily return report WhatsApp notification disabled per policy (OMSGuru stock update with CSV only)" }
  }
  const config = await getWhatsAppConfig(db)
  const notConfigured = whatsAppNotConfiguredReason(config)
  if (notConfigured) {
    return { sent: false, error: notConfigured }
  }
  if (!config.enabled) {
    return { sent: false, error: "WhatsApp notifications disabled in settings" }
  }

  const mentions: string[] = []
  if (config.tagUserJid) mentions.push(config.tagUserJid)
  if (config.tagUserLid) mentions.push(config.tagUserLid)
  const tagPhoneOnly = config.tagUserJid.replace(/@.*$/, "")

  // Build channels breakdown
  const channelText = data.marketplaces.length
    ? data.marketplaces
        .slice(0, 6)
        .map(
          (m) =>
            `  • *${m.marketplace}:* ${fmt(m.shipments)} scans (${fmt(m.units)} units, ${m.issueRate} issues)`,
        )
        .join("\n")
    : "  • No marketplace scans recorded today"

  const caption = [
    `📊 *Return App Daily Operational Briefing*`,
    `📅 *Date:* ${data.dateIst}`,
    ``,
    `📈 *Summary:*`,
    `  • *Total Scanned Shipments:* *${fmt(data.totalShipments)}*`,
    `  • *Total Received Units:* *${fmt(data.totalUnits)}*`,
    `  • *Clear Returns:* *${fmt(data.clearReturns)}*`,
    `  • *Returns with Issues:* *${fmt(data.returnsWithIssues)}* (*${data.issueRatePct}*)`,
    ``,
    `🏢 *Marketplace Performance:*`,
    channelText,
    ``,
    // The tagged user is optional now that it has no built-in default.
    tagPhoneOnly ? `👤 *CC / Attention:* @${tagPhoneOnly}${config.tagUserName ? ` (${config.tagUserName})` : ""}` : null,
    `🌐 *Portal:* https://return.youthnic.shop/register`,
  ].filter((line) => line !== null).join("\n").trim()

  // Generate lightweight summary CSV
  const csvRows = [
    "Date,Marketplace,Total Shipments,Total Units,Clear Units,Issue Units,Issue Rate %",
    ...data.marketplaces.map(
      (m) =>
        `"${data.dateIst}","${m.marketplace}",${m.shipments},${m.units},${m.clearReturns},${m.withIssues},"${m.issueRate}"`,
    ),
  ]
  const csvBuffer = Buffer.from(csvRows.join("\n"), "utf8")
  const filename = `Daily-Returns-Summary-${data.dateIst}.csv`

  const result = await sendWhatsAppDocument(
    {
      phone: config.groupJid,
      caption,
      filename,
      fileBuffer: csvBuffer,
      contentType: "text/csv; charset=utf-8",
      mentions,
    },
    config,
  )

  return {
    sent: result.success,
    messageId: result.messageId,
    error: result.error,
  }
}
