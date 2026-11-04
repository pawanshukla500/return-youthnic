import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Desktop renderer build. The Electron main process serves the production
// output from `desktop/renderer/dist` on the privileged returnapp://desktop
// scheme; in development the shell loads http://localhost:5180 instead.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    strictPort: true,
  },
})
