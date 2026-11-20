// HTTP security headers sent on every response of the Express server: the web console, the API and static files.

import type { Express } from "express"

// Enforced. Only directives that cannot change how the console loads: framing is already refused by X-Frame-Options,
// and the console uses no <object>, <embed> or <base>.
export const ENFORCED_CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"

// Report-only. The intended full policy: the browser logs each violation in its console and blocks nothing.
// To enforce it, send it as Content-Security-Policy instead of ENFORCED_CSP once the console shows no violations.
// Known violation to fix first: the inline onclick on the Iron batch slip page (server/iron.ts).
export const REPORT_ONLY_CSP = [
  "default-src 'self'",
  "script-src 'self'", // index.html loads one module script, no inline script
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // React style props; Google Fonts CSS in src/index.css
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:", // product images come from many marketplace and CDN hosts
  "media-src 'self' blob: https:", // claim evidence is streamed by this server
  "connect-src 'self'", // the API and the same-origin /api/live WebSocket
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

export function applySecurityHeaders(app: Express): void {
  app.disable("x-powered-by")
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("X-Frame-Options", "DENY")
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
    res.setHeader("X-XSS-Protection", "1; mode=block")
    res.setHeader("Content-Security-Policy", ENFORCED_CSP)
    res.setHeader("Content-Security-Policy-Report-Only", REPORT_ONLY_CSP)
    next()
  })
}
