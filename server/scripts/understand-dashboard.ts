import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const viewerPath = path.join(os.homedir(), ".understand-anything", "package", "bin", "viewer.mjs");
const child = spawn(process.execPath, [viewerPath, process.cwd(), ...process.argv.slice(2)], {
  stdio: "inherit"
});
child.on("exit", (code) => process.exit(code ?? 0));
