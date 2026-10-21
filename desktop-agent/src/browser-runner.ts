import child_process from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import WebSocket from "ws"
import { logger } from "./logger.js"

function whichBinaries(names: string[]): string | null {
  for (const name of names) {
    try {
      const found = child_process.execSync(
        process.platform === "win32" ? `where ${name} 2>nul` : `command -v ${name} 2>/dev/null`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      )
        .split(String.fromCharCode(10))
        .map((s) => s.trim())
        .filter(Boolean)[0]
      if (found && fs.existsSync(found)) return found
      if (found && !found.includes("/") && !found.includes("\\")) return found
    } catch {
      // not on PATH — fall through to fixed candidates
    }
  }
  return null
}

export function findSystemBrowser(): string | null {
  // Explicit override wins on every OS (used by warehouse PCs with a custom install path).
  const override = process.env.BROWSER_PATH?.trim()
  if (override && fs.existsSync(override)) return override

  if (process.platform === "win32") {
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
      if (c && fs.existsSync(c)) {
        return c
      }
    }
    return whichBinaries(["msedge.exe", "chrome.exe", "chromium.exe"])
  }

  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
    return whichBinaries(["google-chrome", "chromium", "chromium-browser", "microsoft-edge"])
  }

  // linux and every other POSIX OS (Ubuntu, Debian, Fedora, Arch, WSL)
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
    "/opt/microsoft/msedge/msedge",
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return whichBinaries([
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
  ])
}

export type BrowserSession = {
  browserProcess: child_process.ChildProcess
  wsUrl: string
  profileDir: string
  port: number
}

export class BrowserRunner {
  private ws: WebSocket | null = null
  private proc: child_process.ChildProcess | null = null
  private debugPort = 0
  /** Set by launch(). Declared so the profileDirectory getter is typed. */
  private profileDir = ""

  get profileDirectory(): string {
    return this.profileDir
  }
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
      throw new Error(
        "No compatible Chromium browser (Microsoft Edge, Google Chrome, or Chromium) found. Install Chrome/Chromium or set BROWSER_PATH to its executable.",
      )
    }

    const port = options.port || 9222
    this.debugPort = port
    const profileDir = path.resolve(options.profileDir)
    this.profileDir = profileDir
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
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-default-apps",
      "--metrics-recording-only",
      "--js-flags=--max-old-space-size=256",
    ]

    if (options.headless) {
      args.push("--headless=new")
    }

    logger.info(`Spawning browser: ${path.basename(browserPath)} on port ${port} (Headless: ${Boolean(options.headless)})...`)
    const proc = child_process.spawn(browserPath, args, {
      // Detached on POSIX so the whole browser tree lives in its own process
      // group and close() can stop it with kill(-pid) on Linux/macOS.
      detached: process.platform !== "win32",
      stdio: "ignore",
    })
    this.proc = proc

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
    this.debugPort = port
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

  async delay(ms = 1000): Promise<void> {
    await new Promise((r) => setTimeout(r, ms))
  }

  async humanType(selector: string, text: string): Promise<boolean> {
    const focused = await this.evaluate<boolean>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
        if ('select' in el && typeof el.select === 'function') {
          el.select();
        }
        return true;
      })()
    `)

    if (!focused) {
      logger.warn(`humanType: Element not found for selector: ${selector}`)
      return false
    }

    // Short pause after clicking/focusing
    await this.delay(300)

    // Clear existing text if any
    await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(el, '');
          } else {
            el.value = '';
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `)

    // Type character by character with human-like randomized intervals (40-90ms)
    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      try {
        await this.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          text: char,
          unmodifiedText: char,
          key: char,
        })
        await this.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: char,
        })
      } catch {
        // fallback to JS injection
      }

      const intended = text.slice(0, i + 1)
      await this.evaluate(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return;
          const intended = ${JSON.stringify(intended)};
          const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(el, intended);
          } else {
            el.value = intended;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()
      `)

      const keystrokeInterval = Math.floor(Math.random() * 50) + 40
      await new Promise((r) => setTimeout(r, keystrokeInterval))
    }

    // 1-second delay after finishing typing
    await this.delay(1000)
    return true
  }

  async clickByTextIncludes(text: string): Promise<boolean> {
    return this.evaluate<boolean>(`
      (() => {
        const wanted = ${JSON.stringify(text)}.toLowerCase();
        const nodes = [];
        const visit = (root) => {
          root.querySelectorAll('*').forEach((el) => {
            nodes.push(el);
            if (el.shadowRoot) visit(el.shadowRoot);
          });
        };
        visit(document);
        const match = nodes.find((el) => el.children.length === 0 && (el.textContent || '').trim().toLowerCase().includes(wanted))
          || nodes.find((el) => (el.textContent || '').trim().toLowerCase() === wanted);
        if (!match) return false;
        const clickable = match.closest('a, button, [role="button"]') || match;
        clickable.click();
        return true;
      })()
    `)
  }

  async clickByExactText(text: string): Promise<boolean> {
    return this.evaluate<boolean>(`
      (() => {
        const wanted = ${JSON.stringify(text)};
        const nodes = [];
        const visit = (root) => {
          root.querySelectorAll('*').forEach((el) => {
            nodes.push(el);
            if (el.shadowRoot) visit(el.shadowRoot);
          });
        };
        visit(document);
        const exact = nodes.find((el) => (el.textContent || '').trim() === wanted && el.children.length === 0)
          || nodes.find((el) => (el.textContent || '').trim() === wanted);
        if (!exact) return false;
        const clickable = exact.closest('a, button, [role="button"]') || exact;
        clickable.click();
        return true;
      })()
    `)
  }

  async clickVisibleLabel(text: string): Promise<boolean> {
    const point = await this.evaluate<{ x: number; y: number } | null>(`
      (() => {
        const wanted = ${JSON.stringify(text)}.toLowerCase();
        const nodes = [];
        const visit = (root) => {
          root.querySelectorAll('*').forEach((el) => {
            nodes.push(el);
            if (el.shadowRoot) visit(el.shadowRoot);
          });
        };
        visit(document);
        let best = null;
        let bestArea = Infinity;
        for (const el of nodes) {
          const box = el.getBoundingClientRect();
          const text = (el.textContent || '').trim().toLowerCase();
          if (text !== wanted || box.width < 20 || box.height < 8 || box.width > 700) continue;
          const area = box.width * box.height;
          if (area < bestArea) {
            best = el;
            bestArea = area;
          }
        }
        if (!best) return null;
        best.scrollIntoView({ block: 'center' });
        const box = best.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      })()
    `)
    if (!point || point.y < 0 || point.y > 2000) return false
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y })
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 })
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 })
    await this.delay(1000)
    return true
  }

  /** Clicks a visible label through the page DOM, on its nearest clickable ancestor. Returns that ancestor's link, if it has one. */
  async clickLabelInDom(text: string): Promise<{ clicked: boolean; href: string }> {
    const result = await this.evaluate<{ clicked: boolean; href: string } | null>(`
      (() => {
        const wanted = ${JSON.stringify(text)}.toLowerCase();
        const nodes = [];
        const visit = (root) => {
          root.querySelectorAll('*').forEach((el) => {
            nodes.push(el);
            if (el.shadowRoot) visit(el.shadowRoot);
          });
        };
        visit(document);
        let best = null;
        let bestArea = Infinity;
        for (const el of nodes) {
          const box = el.getBoundingClientRect();
          if ((el.textContent || '').trim().toLowerCase() !== wanted || box.width < 20 || box.height < 8) continue;
          const area = box.width * box.height;
          if (area < bestArea) { best = el; bestArea = area; }
        }
        if (!best) return { clicked: false, href: '' };
        let target = best;
        let href = '';
        let el = best;
        for (let depth = 0; el && depth < 8; depth++) {
          if (el.tagName === 'A' && el.getAttribute('href')) { href = el.href; target = el; break; }
          const clickable = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || typeof el.onclick === 'function' || getComputedStyle(el).cursor === 'pointer';
          if (clickable) target = el;
          const root = el.getRootNode();
          el = el.parentElement || (root && root.host) || null;
        }
        const box = target.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
        target.dispatchEvent(new PointerEvent('pointerdown', opts));
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        target.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
        target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
        target.click();
        return { clicked: true, href };
      })()
    `)
    await this.delay(1000)
    return result || { clicked: false, href: "" }
  }

  async humanClick(selector: string): Promise<boolean> {
    const clicked = await this.evaluate<boolean>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
        el.click();
        return true;
      })()
    `)

    if (!clicked) {
      logger.warn(`humanClick: Element not found for selector: ${selector}`)
      return false
    }

    // 1-second delay after every click as requested
    await this.delay(1000)
    return true
  }

  async uploadViaChooser(buttonText: string, filePath: string): Promise<boolean> {
    if (!this.debugPort) return false
    const version = (await (await fetch(`http://127.0.0.1:${this.debugPort}/json/version`)).json()) as { webSocketDebuggerUrl: string }
    const browserWs = new WebSocket(version.webSocketDebuggerUrl)
    let next = 1
    let chooserId = 0
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
    browserWs.on("message", (raw) => {
      const data = JSON.parse(raw.toString("utf8"))
      if (data.method === "Page.fileChooserOpened" && data.params?.backendNodeId) {
        chooserId = data.params.backendNodeId
      }
      if (data.id && pending.has(data.id)) {
        const waiter = pending.get(data.id)!
        pending.delete(data.id)
        if (data.error) waiter.reject(new Error(data.error.message || "CDP Error"))
        else waiter.resolve(data.result)
      }
    })
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      const id = next++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        browserWs.send(JSON.stringify({ id, method, params, sessionId }))
      })
    }
    await new Promise<void>((resolve, reject) => {
      browserWs.once("open", () => resolve())
      browserWs.once("error", (error) => reject(error))
    })
    try {
      const targets = await send("Target.getTargets") as { targetInfos?: Array<{ targetId: string; type: string; url: string }> }
      const page = (targets.targetInfos || []).find((item) => item.type === "page")
      if (!page) return false
      const attached = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true }) as { sessionId?: string }
      const sessionId = attached.sessionId
      if (!sessionId) return false
      await send("Page.enable", {}, sessionId)
      await send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId)
      const opened = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("file chooser timeout")), 8000)
        const check = setInterval(() => {
          if (!chooserId) return
          clearInterval(check)
          clearTimeout(timer)
          resolve()
        }, 40)
      })
      const point = await send("Runtime.evaluate", {
        expression: `(() => {
          const nodes = [];
          const visit = (root) => { root.querySelectorAll('button').forEach((el) => { nodes.push(el); if (el.shadowRoot) visit(el.shadowRoot) }) };
          visit(document);
          const wanted = ${JSON.stringify(buttonText)};
          const button = nodes.find((el) => (el.textContent || '').trim() === wanted);
          if (!button) return '';
          button.scrollIntoView({ block: 'center' });
          const box = button.getBoundingClientRect();
          return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
        })()`,
        returnByValue: true,
      }, sessionId) as { result?: { value?: string } }
      const raw = point.result?.value || ""
      if (!raw) return false
      const { x, y } = JSON.parse(raw) as { x: number; y: number }
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId)
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId)
      await opened
      await send("DOM.setFileInputFiles", { backendNodeId: chooserId, files: [filePath] }, sessionId)
      await send("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId)
      return true
    } catch (error) {
      logger.warn(`uploadViaChooser failed for ${buttonText}`, error)
      return false
    } finally {
      browserWs.close()
    }
  }

  async setFileInputFiles(selector: string, filePaths: string[]): Promise<boolean> {
    try {
      await this.evaluate(`
        (() => {
          if (window.__returnFileBridge) return;
          window.__returnFileBridge = true;
          const original = HTMLInputElement.prototype.dispatchEvent;
          HTMLInputElement.prototype.dispatchEvent = function(event) {
            try {
              if (event && event.type === 'change' && this.type === 'file' && this.files && this.files.length) {
                const key = Object.keys(this).find((name) => name.startsWith('__reactProps'));
                const onChange = key && this[key] && this[key].onChange;
                if (typeof onChange === 'function') onChange(event);
              }
            } catch (error) {
              // The page handler owns its own errors.
            }
            return original.call(this, event);
          };
        })()
      `)
      const doc = await this.send("DOM.getDocument", { depth: -1 })
      const query = await this.send("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      })
      if (query && query.nodeId) {
        await this.send("DOM.setFileInputFiles", {
          nodeId: query.nodeId,
          files: filePaths,
        })
        await this.delay(1000)
        return true
      }
    } catch (err) {
      logger.warn(`setFileInputFiles failed for selector: ${selector}`, err)
    }
    return false
  }

  async close(): Promise<void> {
    if (this.ws) {
      try {
        await this.send("Browser.close", {}).catch(() => undefined)
      } catch {
        // ignore
      }
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
      // Give the browser a moment to write the profile cookies before the process tree is stopped.
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }

    if (this.proc) {
      try {
        if (!this.proc.killed && this.proc.pid) {
          if (process.platform === "win32") {
            try {
              child_process.execSync(`taskkill /pid ${this.proc.pid} /T /F`, { stdio: "ignore" })
            } catch {
              this.proc.kill("SIGKILL")
            }
          } else {
            // POSIX (Linux/macOS): stop the whole browser process tree so no
            // headless child survives on 4GB warehouse terminals.
            try {
              process.kill(-this.proc.pid, "SIGTERM")
              await new Promise((r) => setTimeout(r, 1500))
              try {
                process.kill(-this.proc.pid, "SIGKILL")
              } catch {
                // already gone
              }
            } catch {
              try {
                child_process.execSync(`pkill -P ${this.proc.pid}`, { stdio: "ignore" })
              } catch {
                // ignore — best effort child cleanup
              }
              this.proc.kill("SIGKILL")
            }
          }
        }
      } catch {
        // ignore
      }
      this.proc = null
    }
  }
}
