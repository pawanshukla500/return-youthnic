import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type LogLevel = "debug" | "info" | "warn" | "error"

// The installed app has no console, so every line also goes to a daily file. Files older than this are deleted.
const LOG_DIR = path.join(os.homedir(), ".taskflow-claim-agent", "logs")
const LOG_KEEP_DAYS = 7
let prunedForDay = ""

function writeLogLine(timestamp: string, line: string) {
  const day = timestamp.slice(0, 10)
  fs.mkdir(LOG_DIR, { recursive: true }, (mkdirError) => {
    if (mkdirError) return
    fs.appendFile(path.join(LOG_DIR, `bot-${day}.log`), `${line}\n`, () => undefined)
    if (prunedForDay === day) return
    prunedForDay = day
    fs.readdir(LOG_DIR, (readError, names) => {
      if (readError) return
      const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 3600_000
      for (const name of names) {
        const match = /^bot-(\d{4}-\d{2}-\d{2})\.log$/.exec(name)
        if (match && Date.parse(match[1]) < cutoff) fs.unlink(path.join(LOG_DIR, name), () => undefined)
      }
    })
  })
}

export class AgentLogger {
  private inMemoryLogs: Array<{ timestamp: string; level: LogLevel; message: string }> = []
  private onLogCallbacks: Array<(entry: { timestamp: string; level: LogLevel; message: string }) => void> = []

  constructor(private prefix = "ClaimAgent") {}

  debug(message: string, ...args: unknown[]) {
    this.log("debug", message, ...args)
  }

  info(message: string, ...args: unknown[]) {
    this.log("info", message, ...args)
  }

  warn(message: string, ...args: unknown[]) {
    this.log("warn", message, ...args)
  }

  error(message: string, ...args: unknown[]) {
    this.log("error", message, ...args)
  }

  private log(level: LogLevel, message: string, ...args: unknown[]) {
    const timestamp = new Date().toISOString()
    const formattedArgs = args.map((a) => {
      if (a instanceof Error) {
        const cause = (a as any).cause ? ` (cause: ${(a as any).cause?.message || (a as any).cause})` : ""
        return `${a.name}: ${a.message}${cause}`
      }
      if (typeof a === "object" && a !== null) {
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      }
      return String(a)
    })
    const formatted = formattedArgs.length > 0 ? `${message} ${formattedArgs.join(" ")}` : message

    const color =
      level === "error" ? "\x1b[31m" : level === "warn" ? "\x1b[33m" : level === "info" ? "\x1b[32m" : "\x1b[36m"
    const reset = "\x1b[0m"

    console.log(`[${timestamp}] ${color}[${level.toUpperCase()}]${reset} [${this.prefix}] ${formatted}`)
    writeLogLine(timestamp, `[${timestamp}] [${level.toUpperCase()}] [${this.prefix}] ${formatted}`)

    const entry = { timestamp, level, message: formatted }
    this.inMemoryLogs.push(entry)
    if (this.inMemoryLogs.length > 250) this.inMemoryLogs.shift()

    for (const cb of this.onLogCallbacks) {
      try {
        cb(entry)
      } catch {
        // ignore
      }
    }
  }

  onLog(cb: (entry: { timestamp: string; level: LogLevel; message: string }) => void) {
    this.onLogCallbacks.push(cb)
  }

  getRecentLogs() {
    return [...this.inMemoryLogs]
  }
}

export const logger = new AgentLogger("TaskFlowAgent")
