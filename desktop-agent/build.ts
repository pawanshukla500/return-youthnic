import child_process from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const agentDir = path.join(root, "desktop-agent")
const distDir = path.join(agentDir, "dist")

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true })
}

console.log("[Build Agent] 1. Bundling with esbuild...")
child_process.execSync(
  `npx esbuild desktop-agent/src/index.ts --bundle --platform=node --format=cjs --outfile=desktop-agent/dist/agent-bundle.cjs`,
  { cwd: root, stdio: "inherit" },
)

console.log("[Build Agent] 2. Generating SEA preparation blob...")
child_process.execSync(`node --experimental-sea-config desktop-agent/sea-config.json`, {
  cwd: root,
  stdio: "inherit",
})

console.log("[Build Agent] 3. Copying node.exe binary...")
const nodeExe = process.execPath
const targetExe = path.join(distDir, "TaskFlowClaimAgent.exe")
fs.copyFileSync(nodeExe, targetExe)

console.log("[Build Agent] 4. Injecting SEA blob with postject...")
child_process.execSync(
  `npx --yes postject desktop-agent/dist/TaskFlowClaimAgent.exe NODE_SEA_BLOB desktop-agent/dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
  { cwd: root, stdio: "inherit" },
)

console.log("[Build Agent] DONE! Single Windows executable ready at:", targetExe)
