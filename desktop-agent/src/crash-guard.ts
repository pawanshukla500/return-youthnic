import { logger } from "./logger.js"

/**
 * Process-level crash guards for the 24/7 claim engine.
 *
 * A warehouse PC or a Linux server runs this engine for weeks. Two failure
 * modes matter:
 *
 *   1. An unawaited promise rejects (a failed HTTP call, a closed browser
 *      socket). Node's default is to crash the whole process. That is wrong
 *      here: one failed request must not stop the bot.
 *   2. An uncaught exception leaves the process in an unknown state. Continuing
 *      would risk filing a claim twice or leaking browser processes. The safe
 *      move is to log synchronously and exit non-zero, so the supervisor
 *      (Windows Scheduled Task, systemd, Docker) starts a clean process.
 *
 * Install once, as early as possible in every entry point.
 */

let installed = false

export type CrashGuardOptions = {
  /** Called after a fatal error is logged, instead of process.exit(1). */
  onFatal?: (err: unknown) => void
}

export function installCrashGuards(options: CrashGuardOptions = {}): void {
  if (installed) return
  installed = true

  process.on("unhandledRejection", (reason) => {
    // Almost always one failed request. Log it and keep filing.
    logger.error("Unhandled promise rejection (continuing):", reason)
  })

  process.on("uncaughtException", (err) => {
    logger.fatalSync("Uncaught exception (exiting so the supervisor restarts a clean process):", err)
    if (options.onFatal) {
      try {
        options.onFatal(err)
      } catch {
        // A failing handler must not change the outcome.
      }
      return
    }
    process.exit(1)
  })
}

/** Test-only: forget that guards were installed. */
export function resetCrashGuards(): void {
  installed = false
}
