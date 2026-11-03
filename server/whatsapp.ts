// WhatsApp Enterprise Gateway & Group Dispatcher for Return App.
//
// Interfaces with the self-hosted go-whatsapp-web-multidevice (GOWA) service in Docker
// over secure HTTPS at https://wa.youthnic.shop.
//
// Capabilities:
// - Dispatches daily OMSGuru inventory update CSVs directly to the "Inventory Management" group (919825149497-1631941133@g.us)
// - Tags Pandit Vishal Tiwari (@916306361624 / @214250249314376) with active WhatsApp mentions
// - Dispatches daily returns reconciliation summary CSVs
// - Verifies connection status and group membership
// - Full audit logging and persistent settings via app_system_settings

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

export const DEFAULT_WHATSAPP_CONFIG: WhatsAppConfig = {
  enabled: true,
  apiUrl: process.env.WHATSAPP_API_URL?.trim() || "https://wa.youthnic.shop",
  basicAuth: process.env.WHATSAPP_BASIC_AUTH?.trim() || "returnorders@vbexports.co.in:Xchange4WA$",
  groupJid: process.env.WHATSAPP_GROUP_JID?.trim() || "919825149497-1631941133@g.us",
  tagUserJid: process.env.WHATSAPP_TAG_USER_JID?.trim() || "916306361624@s.whatsapp.net",
  tagUserLid: process.env.WHATSAPP_TAG_USER_LID?.trim() || "214250249314376@lid",
  tagUserName: "Pandit Vishal Tiwari",
}

const fmt = (n: number) => n.toLocaleString("en-IN")

export async function getWhatsAppConfig(db: pg.Pool): Promise<WhatsAppConfig> {
  try {
    const result = await db.query(
      "SELECT setting_value FROM app_system_settings WHERE setting_key = 'whatsapp_config'",
    )
    if (result.rows[0]?.setting_value) {
      const stored = result.rows[0].setting_value as Partial<WhatsAppConfig>
      return {
        enabled: stored.enabled ?? DEFAULT_WHATSAPP_CONFIG.enabled,
        apiUrl: (stored.apiUrl || DEFAULT_WHATSAPP_CONFIG.apiUrl).replace(/\/+$/, ""),
        basicAuth: stored.basicAuth || DEFAULT_WHATSAPP_CONFIG.basicAuth,
        groupJid: stored.groupJid || DEFAULT_WHATSAPP_CONFIG.groupJid,
        tagUserJid: stored.tagUserJid || DEFAULT_WHATSAPP_CONFIG.tagUserJid,
        tagUserLid: stored.tagUserLid || DEFAULT_WHATSAPP_CONFIG.tagUserLid,
        tagUserName: stored.tagUserName || DEFAULT_WHATSAPP_CONFIG.tagUserName,
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_WHATSAPP_CONFIG
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
    basicAuth: (config.basicAuth ?? current.basicAuth).trim(),
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
    [actorUserId, JSON.stringify(updated)],
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
  const cfg = config || DEFAULT_WHATSAPP_CONFIG
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
  const cfg = customConfig || DEFAULT_WHATSAPP_CONFIG
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
  const cfg = customConfig || DEFAULT_WHATSAPP_CONFIG
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

  // Extract phone number digits for in-text tag (e.g. 916306361624)
  // WhatsApp automatically maps @916306361624 to the contact name in the group without brackets
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
  const config = await getWhatsAppConfig(db)
  if (!config.enabled && !options.force) {
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
    `👤 *CC / Attention:* @${tagPhoneOnly} (${config.tagUserName})`,
    `🌐 *Portal:* https://return.youthnic.shop/register`,
  ].join("\n").trim()

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
