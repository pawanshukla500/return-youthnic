import fs from "node:fs"
import path from "node:path"
import { parseSpreadsheet } from "../sheets.js"

const filesDir = "C:/Users/Pawan Shukla/Desktop/Return File Formate"

function auditAmazon() {
  const fullPath = path.join(filesDir, "Amazon Return.csv")
  const buffer = fs.readFileSync(fullPath)
  const result = parseSpreadsheet(buffer, "Amazon", "Amazon Return.csv")

  let blankRev = 0
  let blankRevValidFwd = 0
  let bothBlank = 0
  const typeCounts: Record<string, number> = {}
  const statusCounts: Record<string, number> = {}

  const sampleBlankRevValidFwd: any[] = []

  for (const r of result.rows) {
    const rev = r.trackingId || ""
    const fwd = r.forwardTrackingId || ""
    const raw = r.raw || {}
    const rawRev = raw["reverse_leg_tracking_id"] || ""
    const rawFwd = raw["forward_leg_tracking_id"] || ""
    const type = r.returnType || "BLANK"
    const status = raw["return_status"] || "BLANK"

    if (!rawRev) {
      blankRev++
      typeCounts[type] = (typeCounts[type] || 0) + 1
      statusCounts[status] = (statusCounts[status] || 0) + 1
      if (rawFwd) {
        blankRevValidFwd++
        if (sampleBlankRevValidFwd.length < 5) {
          sampleBlankRevValidFwd.push({
            orderId: r.orderId,
            shipmentId: r.displayOrderItemId,
            sku: r.sku,
            fwd: rawFwd,
            type: r.returnType,
            status,
            carrier: r.courier
          })
        }
      } else {
        bothBlank++
      }
    }
  }
  console.log("\n--- AMAZON PROPER PARSED ANALYSIS ---")
  console.log({ totalRows: result.rows.length, blankRev, blankRevValidFwd, bothBlank, typeCounts, statusCounts })
  console.log("Sample blank reverse with valid forward:", sampleBlankRevValidFwd)
}

function auditMeesho() {
  const fullPath = path.join(filesDir, "Meesho Return.csv")
  const buffer = fs.readFileSync(fullPath)
  const result = parseSpreadsheet(buffer, "Meesho", "Meesho Return.csv")

  const hostMap: Record<string, { count: number; carriers: Set<string>; sampleUrl: string; sampleAwb: string }> = {}

  for (const r of result.rows) {
    const url = r.trackingUrl || ""
    const awb = r.csvTrackingId || ""
    const carrier = r.courier || ""
    if (!url) continue
    try {
      const u = new URL(url)
      const host = u.hostname.toLowerCase()
      if (!hostMap[host]) {
        hostMap[host] = { count: 0, carriers: new Set(), sampleUrl: url, sampleAwb: awb }
      }
      hostMap[host].count++
      hostMap[host].carriers.add(carrier)
    } catch {}
  }

  console.log("\n--- MEESHO PROPER PARSED ANALYSIS ---")
  for (const [host, info] of Object.entries(hostMap)) {
    console.log(`Host: ${host}`)
    console.log(`  Count: ${info.count}`)
    console.log(`  Carriers: ${[...info.carriers].join(", ")}`)
    console.log(`  Sample URL: ${info.sampleUrl}`)
    console.log(`  Sample AWB: ${info.sampleAwb}`)
  }
}

auditAmazon()
auditMeesho()
