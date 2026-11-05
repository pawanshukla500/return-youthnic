/**
 * Windows GUI Acceptance Automation Test for Return App (v1.3.0)
 *
 * Runs against the actual packaged Windows executable (`dist-electron/win-unpacked/Return App.exe`).
 * Uses Chrome DevTools Protocol (CDP) to verify:
 *   1. Offline / engine-down resilience: bundled renderer mounts `returnapp://desktop/index.html` and renders connecting state.
 *   2. Online navigation suite: operator sign-in gate, 7 navigation tabs, bounded marketplace browser viewport,
 *      and low-spec hardware discipline (V8 heap < 256MB).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      };
    });
  }

  async send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error("Evaluation exception: " + JSON.stringify(res.exceptionDetails));
    }
    return res.result?.value;
  }

  async waitForUrl(predicate, maxRetries = 20, delayMs = 500) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const url = await this.evaluate("window.location.href");
        if (predicate(url)) return url;
      } catch {
        // ignore
      }
      await sleep(delayMs);
    }
    const finalUrl = await this.evaluate("window.location.href").catch(() => "unknown");
    throw new Error(`Timeout waiting for URL predicate. Final URL: ${finalUrl}`);
  }

  async captureScreenshot(outputPath) {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.data, "base64");
    fs.writeFileSync(outputPath, buffer);
    console.log(`Saved screenshot to ${outputPath}`);
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPageTarget(port, maxRetries = 40, delayMs = 500) {
  const url = `http://127.0.0.1:${port}/json`;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const targets = await res.json();
        const found = targets.find((t) => t.type === "page" && (t.url.includes("returnapp://") || t.url.includes("about:blank") || t.url.includes("desktop")));
        if (found) return found;
      }
    } catch {
      // ignore
    }
    await sleep(delayMs);
  }
  throw new Error(`Timeout waiting for page target on port ${port}`);
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function main() {
  console.log("=== STARTING REAL WINDOWS GUI ACCEPTANCE TEST ===");
  const exePath = path.resolve("dist-electron/win-unpacked/Return App.exe");
  const screenshotsDir = path.resolve("docs/screenshots");
  fs.mkdirSync(screenshotsDir, { recursive: true });

  console.log("\n=======================================================");
  console.log("TEST 1: OFFLINE / ENGINE UNAVAILABLE RESILIENCE");
  console.log("=======================================================");
  const blocker = net.createServer((socket) => {
    // Reset immediately so HTTP client receives ECONNRESET and fails immediately
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(3005, "127.0.0.1", () => {
      blocker.removeListener("error", reject);
      blocker.on("error", () => {});
      resolve();
    });
  });
  console.log("✓ Simulated engine unavailable by blocking 127.0.0.1:3005");

  let appProc = spawn(exePath, ["--remote-debugging-port=9222"], {
    detached: false,
    stdio: "pipe",
    env: cleanEnv(),
  });

  try {
    const pageTarget = await waitForPageTarget(9222);
    console.log("✓ Connected to CDP. Target URL:", pageTarget.url);

    const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    const url = await cdp.waitForUrl((u) => u.startsWith("returnapp://desktop/"));
    console.log("✓ Bundled renderer URL verified:", url);

    const pageTitle = await cdp.evaluate("document.title");
    console.log("✓ Document title:", pageTitle);

    await sleep(1500);

    const bodySnippet = await cdp.evaluate("document.body.innerText.slice(0, 300)");
    console.log("✓ Offline view rendered without crash. Snippet:\n", bodySnippet);
    if (!bodySnippet || (!bodySnippet.toLowerCase().includes("claim bot") && !bodySnippet.toLowerCase().includes("sign in") && !bodySnippet.toLowerCase().includes("connecting"))) {
      throw new Error(`Expected offline UI snippet to render, got: ${bodySnippet}`);
    }

    await cdp.captureScreenshot(path.join(screenshotsDir, "gui-01-offline-state.png"));
    cdp.close();

    console.log("✓ Closing offline test instance...");
    spawn("taskkill", ["/PID", String(appProc.pid), "/T", "/F"]);
    await sleep(3000);
  } finally {
    if (appProc && !appProc.killed) {
      try { spawn("taskkill", ["/PID", String(appProc.pid), "/T", "/F"]); } catch {}
    }
    blocker.close();
    await sleep(2500);
  }

  console.log("\n=======================================================");
  console.log("TEST 2: ONLINE BUNDLED RENDERER + NAVIGATION SUITE");
  console.log("=======================================================");
  appProc = spawn(exePath, ["--remote-debugging-port=9223"], {
    detached: false,
    stdio: "pipe",
    env: cleanEnv(),
  });

  try {
    const pageTarget = await waitForPageTarget(9223);
    console.log("✓ Connected to online instance. Target URL:", pageTarget.url);

    const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // Install mock fetch on new documents so online test behavior is 100% deterministic
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        (() => {
          window.__testSignedIn = false;
          const origFetch = window.fetch;
          window.fetch = async (resource, init) => {
            const rawUrl = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
            if (rawUrl.includes('/api/operator/login')) {
              window.__testSignedIn = true;
              return new Response(JSON.stringify({
                ok: true,
                user: { name: "Pawan Shukla", email: "ops@youthnic.shop", role: "Admin" }
              }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (rawUrl.includes('/api/operator/session')) {
              return new Response(JSON.stringify({
                signedIn: window.__testSignedIn,
                user: window.__testSignedIn ? { name: "Pawan Shukla", email: "ops@youthnic.shop", role: "Admin" } : null
              }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (rawUrl.includes('/api/status')) {
              return new Response(JSON.stringify({
                isRunning: true,
                isCurrentlyProcessing: false,
                activeJobInfo: null,
                activeSummary: null,
                nextPollCountdown: 42,
                lastHeartbeatTime: new Date().toLocaleTimeString(),
                lastPollTime: new Date().toLocaleTimeString(),
                backendUrl: "https://return.youthnic.shop",
                signedIn: window.__testSignedIn
              }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (rawUrl.includes('/api/panels')) {
              return new Response(JSON.stringify({
                panels: [
                  { marketplace: "Meesho", panelKey: "meesho", name: "Meesho", status: "idle", consecutiveFailures: 0, automated: true, state: "idle" },
                  { marketplace: "Flipkart", panelKey: "flipkart", name: "Flipkart", status: "idle", consecutiveFailures: 0, automated: false, state: "idle" },
                  { marketplace: "Amazon", panelKey: "amazon", name: "Amazon", status: "idle", consecutiveFailures: 0, automated: false, state: "idle" }
                ]
              }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (rawUrl.includes('/api/jobs')) {
              return new Response(JSON.stringify([
                { jobId: 101, claimId: 2001, marketplace: "Meesho", stage: "idle", attemptCount: 1, updatedAt: new Date().toISOString() }
              ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (rawUrl.includes('/api/follow-ups')) {
              return new Response(JSON.stringify({
                rows: [],
                total: 0,
                summary: { active: 0, due: 0, resolved: 0, withErrors: 0 }
              }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (rawUrl.includes('/api/portal-browser')) {
              return new Response(JSON.stringify({
                views: [],
                tabs: [{ tabId: "tab-meesho", panelKey: "meesho", label: "Meesho", mode: "background", title: "Supplier Panel" }]
              }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (rawUrl.includes('/api/updates/check')) {
              return new Response(JSON.stringify({
                ok: true,
                currentVersion: "1.3.0",
                latestTag: "desktop-v1.3.0.1",
                updateAvailable: false
              }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return origFetch(resource, init);
          };
        })()
      `
    });

    await cdp.send("Page.reload");
    const url = await cdp.waitForUrl((u) => u.startsWith("returnapp://desktop/"));
    console.log("✓ Online renderer loaded from returnapp:// scheme:", url);

    await sleep(2000);

    const hasLoginGate = await cdp.evaluate(`
      Boolean(document.querySelector('form[aria-label="Operator sign-in"]'))
    `);
    console.log("✓ Operator sign-in gate visible:", hasLoginGate);
    if (!hasLoginGate) throw new Error("Operator sign-in gate was not rendered on initial launch!");
    await cdp.captureScreenshot(path.join(screenshotsDir, "gui-02-login-gate.png"));

    console.log("\n--- Submitting operator credentials to unlock desktop shell ---");
    await cdp.evaluate(`
      (() => {
        const emailInput = document.getElementById("gate-email");
        const passInput = document.getElementById("gate-password");
        if (emailInput && passInput) {
          emailInput.value = "ops@youthnic.shop";
          emailInput.dispatchEvent(new Event("input", { bubbles: true }));
          passInput.value = "dummy-pass";
          passInput.dispatchEvent(new Event("input", { bubbles: true }));
          const form = document.querySelector('form[aria-label="Operator sign-in"]');
          if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        }
      })()
    `);

    await sleep(2500);

    const navItems = await cdp.evaluate(`
      (() => Array.from(document.querySelectorAll("nav button, nav a")).map(el => el.textContent.trim()))()
    `);
    console.log("✓ Sidebar navigation rendered:", navItems);
    const expectedTabs = ["Dashboard", "Claims", "Browsers", "Follow-ups", "AI Center", "Settings", "Updates"];
    for (const expected of expectedTabs) {
      if (!navItems.includes(expected)) {
        throw new Error(`Expected sidebar tab '${expected}' was not found in: ${JSON.stringify(navItems)}`);
      }
    }

    const headerText = await cdp.evaluate(`
      (() => {
        const el = document.querySelector("header") || document.body;
        return el ? el.innerText : "";
      })()
    `);
    console.log("✓ Header operator greeting:", headerText.slice(0, 80));
    if (!headerText.includes("Pawan Shukla")) {
      throw new Error(`Expected header to display operator name 'Pawan Shukla', got: ${headerText}`);
    }

    await cdp.captureScreenshot(path.join(screenshotsDir, "gui-03-dashboard.png"));

    console.log("Navigating to Browsers tab...");
    await cdp.evaluate(`
      (() => {
        const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Browsers"));
        if (btn) btn.click();
      })()
    `);
    await sleep(1500);

    const browsersWorkspace = await cdp.evaluate(`
      (() => {
        const vp = document.getElementById("browser-workspace-viewport") || document.querySelector("[data-workspace-viewport]");
        if (vp) {
          const rect = vp.getBoundingClientRect();
          return { found: true, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
        return { found: false };
      })()
    `);
    console.log("✓ Bounded Browsers workspace viewport:", browsersWorkspace);
    if (!browsersWorkspace.found) {
      throw new Error("Bounded workspace viewport #browser-workspace-viewport was not found in DOM!");
    }
    if (browsersWorkspace.x < 150) {
      throw new Error(`Workspace x coordinate (${browsersWorkspace.x}) overlaps sidebar!`);
    }
    console.log("✓ Verified: Supplier view is strictly bounded and does NOT overlap sidebar!");
    await cdp.captureScreenshot(path.join(screenshotsDir, "gui-04-browsers-tab.png"));

    console.log("Navigating to Claims tab...");
    await cdp.evaluate(`
      (() => {
        const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Claims"));
        if (btn) btn.click();
      })()
    `);
    await sleep(1500);
    await cdp.captureScreenshot(path.join(screenshotsDir, "gui-05-claims-tab.png"));

    console.log("Navigating to Follow-ups tab...");
    await cdp.evaluate(`
      (() => {
        const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Follow-ups"));
        if (btn) btn.click();
      })()
    `);
    await sleep(1500);
    await cdp.captureScreenshot(path.join(screenshotsDir, "gui-08-follow-ups.png"));

    console.log("Navigating to Settings tab...");
    await cdp.evaluate(`
      (() => {
        const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Settings"));
        if (btn) btn.click();
      })()
    `);
    await sleep(1500);
    await cdp.captureScreenshot(path.join(screenshotsDir, "gui-06-settings-tab.png"));

    console.log("Navigating to AI Center tab...");
    await cdp.evaluate(`
      (() => {
        const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("AI Center"));
        if (btn) btn.click();
      })()
    `);
    await sleep(1500);
    await cdp.captureScreenshot(path.join(screenshotsDir, "gui-07-ai-center.png"));

    console.log("Navigating to Updates tab...");
    await cdp.evaluate(`
      (() => {
        const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Updates"));
        if (btn) btn.click();
      })()
    `);
    await sleep(1500);
    await cdp.captureScreenshot(path.join(screenshotsDir, "gui-09-updates.png"));

    const memory = await cdp.evaluate(`
      (() => {
        return window.performance && window.performance.memory ? {
          usedJSHeapSize: (window.performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(2) + " MB",
          totalJSHeapSize: (window.performance.memory.totalJSHeapSize / 1024 / 1024).toFixed(2) + " MB",
          jsHeapSizeLimit: (window.performance.memory.jsHeapSizeLimit / 1024 / 1024).toFixed(2) + " MB",
        } : "not available";
      })()
    `);
    console.log("✓ Renderer V8 Heap Memory:", memory);
    if (memory && typeof memory === "object" && memory.usedJSHeapSize) {
      const usedMB = parseFloat(memory.usedJSHeapSize);
      if (usedMB > 256) throw new Error(`V8 Heap Memory exceeded 256MB limit: ${usedMB} MB`);
    }

    cdp.close();
    console.log("✓ Terminating test application...");
    spawn("taskkill", ["/PID", String(appProc.pid), "/T", "/F"]);
    await sleep(2000);

    console.log("\n=======================================================");
    console.log("✓ ALL 8 ACCEPTANCE CRITERIA PASSED IN REAL WINDOWS EXE");
    console.log("=======================================================");
  } catch (err) {
    if (appProc) {
      spawn("taskkill", ["/PID", String(appProc.pid), "/T", "/F"]);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in GUI test:", err);
  process.exit(1);
});
