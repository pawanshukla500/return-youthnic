import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const apiPort = env.PORT || "3001"
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        // ws: the live-update WebSocket (/api/live) goes through the same proxy in development.
        "/api": { target: `http://127.0.0.1:${apiPort}`, ws: true },
      },
    },
  }
})
