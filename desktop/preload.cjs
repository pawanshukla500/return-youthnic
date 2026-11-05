const { contextBridge, ipcRenderer } = require("electron")

/**
 * Typed desktop bridge exposed to the bundled renderer as window.desktopApp.
 *
 * Runs with contextIsolation (only ipcRenderer/contextBridge are used here):
 * no nodeIntegration, no raw ipcRenderer, no process/env/secret exposure. The
 * remote ENGINE_TOKEN never crosses this bridge — bearer auth stays in the
 * main process and is injected into engine-origin requests by webRequest.
 */
contextBridge.exposeInMainWorld("desktopApp", {
  isDesktop: true,
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke("desktop:get-app-info"),
  getEngineTarget: () => ipcRenderer.invoke("desktop:get-engine-target"),
  getBotStatus: () => ipcRenderer.invoke("desktop:get-bot-status"),
  toggleBot: () => ipcRenderer.invoke("desktop:toggle-bot"),
  onBotStatusChange: (callback) => {
    if (typeof callback !== "function") return () => {}
    const listener = (_event, status) => callback(status)
    ipcRenderer.on("desktop:bot-status-changed", listener)
    // Secure subscription lifetime: reloading the renderer must not leave a
    // duplicate listener behind, so unsubscribe is returned to the caller.
    return () => ipcRenderer.removeListener("desktop:bot-status-changed", listener)
  },
  sendNotification: (title, body) => {
    ipcRenderer.send("desktop:notify", { title, body })
  },
  setBrowserWorkspaceRect: (rect) => {
    // Validate before the payload crosses the bridge: only a null rect (hide
    // the view) or {x, y, width, height} with finite numbers is forwarded.
    if (rect === null || rect === undefined) {
      ipcRenderer.send("desktop:browser-rect", null)
      return
    }
    if (typeof rect !== "object") return
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null)
    const x = num(rect.x)
    const y = num(rect.y)
    const width = num(rect.width)
    const height = num(rect.height)
    if (x === null || y === null || width === null || height === null) return
    if (width < 0 || height < 0) return
    ipcRenderer.send("desktop:browser-rect", { x, y, width, height })
  },
  setBrowserFullscreen: (on) => {
    ipcRenderer.send("desktop:browser-fullscreen", on)
  },
})
