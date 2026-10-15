import child_process from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import WebSocket from "ws"
import { logger } from "./logger.js"

export function findSystemBrowser(): string | null {
  const candidates = [
    // Edge (installed on 100% of modern Windows PCs)
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    path.join(process.env.LOCALAPPDATA || "", "Microsoft\\Edge\\Application\\msedge.exe"),
    // Chrome
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  ]

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c
    }
  }
  return null
}

export type BrowserSession = {
  browserProcess: child_process.ChildProcess
  wsUrl: string
  profileDir: string
  port: number
}

export class BrowserRunner {
  private ws: WebSocket | null = null
  private nextId = 1
  private pendingCallbacks = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void }>()

  async launch(options: {
    executablePath?: string
    profileDir: string
    headless?: boolean
    port?: number
  }): Promise<BrowserSession> {
    const browserPath = options.executablePath || findSystemBrowser()
    if (!browserPath) {
      throw new Error("No compatible Chromium browser (Microsoft Edge or Chrome) found on this Windows system.")
    }

    const port = options.port || 9222
    const profileDir = path.resolve(options.profileDir)
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true })
    }

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,900",
    ]

    if (options.headless) {
      args.push("--headless=new")
    }

    logger.info(`Spawning browser: ${path.basename(browserPath)} on port ${port} (Headless: ${Boolean(options.headless)})...`)
    const proc = child_process.spawn(browserPath, args, {
      detached: false,
      stdio: "ignore",
    })

    // Poll until browser debugging port is ready
    let wsUrl = ""
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (res.ok) {
          const data = (await res.json()) as { webSocketDebuggerUrl: string }
          wsUrl = data.webSocketDebuggerUrl
          break
        }
      } catch {
        // Retry
      }
    }

    if (!wsUrl) {
      proc.kill()
      throw new Error(`Browser failed to start debugging endpoint on port ${port}.`)
    }

    logger.info(`Browser DevTools endpoint connected: ${wsUrl}`)
    return {
      browserProcess: proc,
      wsUrl,
      profileDir,
      port,
    }
  }

  async connectToPage(port: number): Promise<void> {
    const pagesRes = await fetch(`http://127.0.0.1:${port}/json/list`)
    const pages = (await pagesRes.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
    const targetPage = pages.find((p) => p.type === "page") || pages[0]
    if (!targetPage || !targetPage.webSocketDebuggerUrl) {
      throw new Error("No active browser tab found.")
    }

    this.ws = new WebSocket(targetPage.webSocketDebuggerUrl)

    await new Promise<void>((resolve, reject) => {
      this.ws!.on("open", () => resolve())
      this.ws!.on("error", (err) => reject(err))
    })

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString("utf8"))
        if (msg.id && this.pendingCallbacks.has(msg.id)) {
          const { resolve, reject } = this.pendingCallbacks.get(msg.id)!
          this.pendingCallbacks.delete(msg.id)
          if (msg.error) reject(new Error(msg.error.message || "CDP Error"))
          else resolve(msg.result)
        }
      } catch {
        // ignore
      }
    })

    // Enable Page and Runtime domains
    await this.send("Page.enable")
    await this.send("Runtime.enable")
    await this.send("DOM.enable")
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Browser WebSocket is not open.")
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pendingCallbacks.set(id, { resolve, reject })
      this.ws!.send(JSON.stringify({ id, method, params }))
    })
  }

  async navigate(url: string): Promise<void> {
    logger.info(`Navigating to: ${url}`)
    await this.send("Page.navigate", { url })
    // Wait for load event
    await new Promise((r) => setTimeout(r, 3000))
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    return result?.result?.value as T
  }

  async captureScreenshot(outputPath: string): Promise<string> {
    const result = await this.send("Page.captureScreenshot", { format: "png" })
    const base64Data = result?.data
    if (base64Data) {
      const buffer = Buffer.from(base64Data, "base64")
      const dir = path.dirname(outputPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(outputPath, buffer)
      logger.info(`Screenshot captured: ${outputPath}`)
      return outputPath
    }
    return ""
  }

  async detectCaptchaOrOtp(): Promise<{ challengeDetected: boolean; reason?: string }> {
    const isChallenge = await this.evaluate<boolean>(`
      (() => {
        const text = document.body ? document.body.innerText.toLowerCase() : '';
        const hasCaptcha = text.includes('verify you are human') ||
                           text.includes('enter the characters') ||
                           text.includes('captcha') ||
                           document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"], #captcha, .captcha') !== null;
        const hasOtp = text.includes('enter otp') ||
                       text.includes('verification code') ||
                       document.querySelector('input[name*="otp"], input[autocomplete="one-time-code"]') !== null;
        return hasCaptcha || hasOtp;
      })()
    `)

    if (isChallenge) {
      return { challengeDetected: true, reason: "CAPTCHA or OTP challenge detected on marketplace portal" }
    }
    return { challengeDetected: false }
  }

  async close(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
  }
}
