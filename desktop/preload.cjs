const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("desktopApp", {
  isDesktop: true,
  platform: process.platform,
  version: "1.0.0",
  sendNotification: (title, body) => {
    ipcRenderer.send("desktop:notify", { title, body })
  },
  getBotStatus: () => ipcRenderer.invoke("desktop:get-bot-status"),
  toggleBot: () => ipcRenderer.invoke("desktop:toggle-bot"),
  onBotStatusChange: (callback) => {
    ipcRenderer.on("desktop:bot-status-changed", (_event, data) => callback(data))
  },
})
