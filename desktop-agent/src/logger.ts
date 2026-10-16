export type LogLevel = "debug" | "info" | "warn" | "error"

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
