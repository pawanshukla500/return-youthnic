# Architecture Decision Record — Marketplace Claims Management System

Status: **accepted** (2026-10-21)
Scope: desktop shell, automation engine, browser driver, AI service, deployment topology.

This record answers the technology-comparison step in the desktop application brief. It
is written against the code that actually exists in this repository, not against a green
field, so "migration cost" means real files and real risk.

---

## 1. Context

The system must handle the full marketplace claim lifecycle and run in three modes:
Windows desktop, Linux desktop, and headless Linux server. It must stay light on 4 GB /
2-core warehouse PCs (`AGENTS.md` rule 13) and must be portable to a Linux server without
a rewrite.

Before this decision, the repository already had:

- `desktop/main.ts` — an Electron main process (~660 lines) that owned the window, tray,
  single-instance lock, auto-start, **and its own copy of the worker loop**.
- `desktop-agent/` — a pure-Node automation engine: raw Chrome DevTools Protocol over
  `ws` (`browser-runner.ts`), six isolated panel profiles (`panel-queue.ts`),
  `portal-login.ts`, marketplace engines, a local HTTP dashboard (`desktop-app-server.ts`,
  ~1 450 lines) that **also** had a copy of the worker loop, DPAPI secrets, update check.
- Server side: `claim-automation-service.ts`, `schema-claim-automation.sql`, job leases,
  agent heartbeats, `marketplace_credentials`.

So the browser automation, session management, queueing and packaging already existed and
shipped on three operating systems. The real defect was architectural, not technological:
**two worker loops**, and an engine that could not run without the desktop window.

---

## 2. Options considered

### 2.1 Desktop shell

| Option | Size (approx.) | Idle RAM | Cost to adopt here | Verdict |
|---|---|---|---|---|
| **Electron** (current) | ~150 MB installed | ~120–180 MB with `--max-old-space-size=256`, `--renderer-process-limit=2` | Zero. Window, tray, scheduled task, auto-start, DPAPI secrets, 3-OS packaging all exist and ship. | **Keep** |
| **Tauri** (Rust + WebView) | ~10 MB | ~40–70 MB | High. Needs a Rust toolchain (not installed here), rewrites the tray, IPC, auto-start, scheduled-task and secret-storage code, and uses WebKitGTK on Linux (a different renderer from Windows, doubling UI QA). Tauri cannot embed Chromium, so the CDP browser automation would still be a separate sidecar. | Deferred |
| **.NET (MAUI/Avalonia)** | ~80 MB | ~150 MB | High. Adds a second toolchain and a second implementation of the queue/lease/panel logic that already works in TypeScript against the same PostgreSQL. No functional gain. | Rejected |
| **Rust (native shell)** | ~15 MB | low | High. Same rewrite cost as Tauri with even less of a web-UI story. | Rejected |

**Decision: keep Electron as the Mode 1/2 shell.**

The deciding factor is that this application's value is *browser automation and queue
correctness*, not window chrome. Electron already ships a working, low-spec-tuned shell,
and its Node runtime lets the automation engine run in-process or as a sidecar with no
interop layer. Tauri's real advantages (binary size, idle RAM) are genuine but do not
outweigh a rewrite of a shipping shell that cannot even be built on this machine.

Tauri stays a **documented, deferred option**. The migration boundary is deliberately
narrow: the shell must talk to the engine **only** through the control API (section 3), so
a future Tauri shell would replace `desktop/main.ts` and nothing else.

### 2.2 Browser automation driver

| Option | Cost here | Trade-off |
|---|---|---|
| **Raw CDP over `ws`** (current) | Zero. `browser-runner.ts` launches the *system* browser with `--remote-debugging-port` and speaks CDP directly. | No bundled browser download, works with the Edge/Chrome the warehouse PCs already have, and headless Chromium on Linux is the same protocol. More selector/timing code to maintain. |
| **Playwright** | High. ~300 MB browser download (bad for 4 GB disk and CI), plus a rewrite of `browser-runner.ts` and all six marketplace engines. | Better auto-waiting, tracing and cross-platform headless reliability. |
| **Puppeteer** | Medium–high. | Similar to Playwright with a smaller API surface; still a browser download. |

**Decision: keep raw CDP against the system browser.**

Playwright can be adopted **incrementally later** without losing the system-browser model,
because `chromium.connectOverCDP()` attaches to an already-running browser. That keeps the
option open at low cost. Adopting it now would mean a large rewrite for no Linux-server
benefit: headless Chromium over CDP is already the Linux path.

### 2.3 AI reply service

See `ai-provider-comparison.md`. The provider is deliberately **not** fixed yet; the
integration is provider-agnostic and the key lives **server-side**, because the "no
secrets" rule forbids shipping an API key inside the desktop application.

---

## 3. Target architecture

```
                    ┌──────────────────────────────┐
                    │  Desktop shell (Electron)    │  Mode 1 / 2
                    │  desktop/main.ts             │  thin client:
                    │  window + tray only          │  window + tray
                    └──────────────┬───────────────┘
                                   │ control API (HTTP + SSE)
        ┌──────────────────────────┴───────────────────────────┐
        │                                                      │
        ▼ (embedded, 127.0.0.1)                (remote, ENGINE_TOKEN)
┌──────────────────────────────────────────┐   ┌──────────────────────────────┐
│  Automation engine (Node)                │◄──│  Linux server (Mode 3)       │
│  desktop-agent/src/desktop-app-server.ts │   │  Docker / systemd, headless  │
│  ─ one worker loop ─                     │   │  Chromium over CDP           │
│  ─ panel queue, browser runner ─         │   └──────────────────────────────┘
│  ─ control API + health ─                │
└──────────────┬───────────────────────────┘
               │ HTTPS (agent API key + operator session)
               ▼
┌──────────────────────────────────────────┐
│  Return App backend (Express + Postgres) │
│  claim-automation-service, leases,       │
│  claims, evidence, audit                 │
└──────────────────────────────────────────┘
```

Key properties:

1. **One worker loop.** The engine owns it. The Electron shell no longer has a copy.
2. **The engine does not need a window.** Mode 3 runs it under systemd or Docker with
   `--no-window`.
3. **The shell is a client.** Local by default; remote when `RETURN_ENGINE_URL` is set.
4. **Fail-closed exposure.** A non-loopback bind requires `ENGINE_TOKEN` or the engine
   refuses to start (`engine-config.ts`).
5. **Portable state.** `AGENT_DATA_DIR` relocates config, profiles, evidence cache, logs
   and the operator session, so a container volume holds all engine state.

---

## 4. Consequences

**Good**

- Closing the desktop window can never interrupt a claim on a server (Mode 3).
- The same engine binary serves all three modes; Linux support is a binding change, not a
  port.
- Adding a second engine for throughput is configuration, not code.
- The desktop shell shrank from ~660 to a thin window/tray client.

**Costs / risks**

- The shell's adaptive polling moved into the engine; the engine's scheduler is now the
  only one, so a bug there affects every mode.
- Remote mode is protected by a single shared bearer token, not per-user auth. It is a
  service-to-service credential. Do not expose it directly to the internet.
- The dashboard HTML is served by the engine, so in remote mode the browser needs the
  bearer token. Electron injects it; a plain browser does not, by design.

**Not done**

- No live claim has been filed from a Linux server in this repository's history.
- Assisted panels (Flipkart, Amazon, Myntra, Ajio) still need a visible browser and an
  operator, so they are not useful headless yet.
- AI replies are designed but not implemented.
