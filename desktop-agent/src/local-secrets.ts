import { createRequire } from "node:module"
import { logger } from "./logger.js"

/**
 * Local secret protection for the desktop claim bot.
 *
 * When this code runs inside the packaged Electron app, secrets (operator
 * session token, per-PC API key) are encrypted with the OS credential store
 * via Electron safeStorage — DPAPI on Windows, Keychain on macOS, Secret
 * Service on Linux. Anywhere else (source runs, plain Node) the secret is
 * kept in the existing file format so the bot keeps working; the dashboard
 * reports which mode is active so an operator can see it.
 *
 * Format: "dpapi:<base64>" when encrypted, raw plaintext otherwise (legacy
 * files stay readable and are upgraded to encrypted on the next sign-in).
 */

const PREFIX = "dpapi:"

type SafeStorageApi = {
  isEncryptionAvailable: () => boolean
  encryptString: (plainText: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

function electronSafeStorage(): SafeStorageApi | null {
  try {
    const req = createRequire(import.meta.url)
    const electron = req("electron") as { safeStorage?: SafeStorageApi }
    const ss = electron?.safeStorage
    if (!ss || typeof ss.isEncryptionAvailable !== "function") return null
    if (!ss.isEncryptionAvailable()) return null
    return ss
  } catch {
    return null
  }
}

/** True when OS-level encryption (e.g. Windows DPAPI) is available. */
export function localEncryptionAvailable(): boolean {
  return electronSafeStorage() !== null
}

/** Encrypt for storage. Falls back to plaintext when no OS store exists. */
export function protectSecret(plainText: string): string {
  if (!plainText) return ""
  if (plainText.startsWith(PREFIX)) return plainText
  try {
    const ss = electronSafeStorage()
    if (!ss) return plainText
    return PREFIX + ss.encryptString(plainText).toString("base64")
  } catch (err) {
    logger.warn("Local secret encryption failed; keeping the existing file format.", err)
    return plainText
  }
}

/**
 * Decrypt a stored value. Returns null only when the value was encrypted
 * and cannot be decrypted on this machine (operator must sign in again).
 */
export function revealSecret(stored: string): string | null {
  if (!stored) return null
  if (!stored.startsWith(PREFIX)) return stored
  try {
    const ss = electronSafeStorage()
    if (!ss) return null
    return ss.decryptString(Buffer.from(stored.slice(PREFIX.length), "base64"))
  } catch (err) {
    logger.warn("Stored secret cannot be decrypted on this machine.", err)
    return null
  }
}
