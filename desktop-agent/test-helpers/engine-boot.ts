// Test-only engine boot for operator-login-flow.test.ts: starts the real
// desktop engine HTTP server (plus sign-in resume, like the shell does) and
// stays alive until the parent test kills this process. Never used in
// production; the packaged app boots through desktop/main.ts instead.
import { resumeClaimBotIfSignedIn, startDesktopAppServer } from "../src/desktop-app-server.ts"

await startDesktopAppServer()
await resumeClaimBotIfSignedIn()
console.log("ENGINE_READY")
