// In-memory sliding window rate limiter for security critical paths (authentication, brute force mitigation).
// Provides deterministic windowing, attempt counting, and lockout countdowns.

type AttemptRecord = {
  count: number
  firstAttempt: number
  lockedUntil: number
}

export class RateLimiter {
  private attempts = new Map<string, AttemptRecord>()
  private maxAttempts: number
  private windowMs: number
  private lockoutMs: number

  constructor(options: { maxAttempts?: number; windowMs?: number; lockoutMs?: number } = {}) {
    this.maxAttempts = options.maxAttempts ?? 5
    this.windowMs = options.windowMs ?? 5 * 60 * 1000 // 5 minutes
    this.lockoutMs = options.lockoutMs ?? 5 * 60 * 1000 // 5 minutes
  }

  isLocked(key: string, now: number = Date.now()): { locked: boolean; retryAfterSeconds: number } {
    const record = this.attempts.get(key)
    if (!record) return { locked: false, retryAfterSeconds: 0 }
    if (record.lockedUntil > now) {
      return {
        locked: true,
        retryAfterSeconds: Math.ceil((record.lockedUntil - now) / 1000),
      }
    }
    if (now - record.firstAttempt > this.windowMs) {
      this.attempts.delete(key)
      return { locked: false, retryAfterSeconds: 0 }
    }
    return { locked: false, retryAfterSeconds: 0 }
  }

  recordFailure(key: string, now: number = Date.now()): { locked: boolean; retryAfterSeconds: number } {
    let record = this.attempts.get(key)
    if (!record || now - record.firstAttempt > this.windowMs) {
      record = { count: 1, firstAttempt: now, lockedUntil: 0 }
      this.attempts.set(key, record)
      return { locked: false, retryAfterSeconds: 0 }
    }

    record.count += 1
    if (record.count >= this.maxAttempts) {
      record.lockedUntil = now + this.lockoutMs
      return {
        locked: true,
        retryAfterSeconds: Math.ceil(this.lockoutMs / 1000),
      }
    }

    return { locked: false, retryAfterSeconds: 0 }
  }

  reset(key: string): void {
    this.attempts.delete(key)
  }

  clear(): void {
    this.attempts.clear()
  }
}

// 5 failed login attempts per account in 5 minutes -> 5-minute lockout
export const loginRateLimiter = new RateLimiter({
  maxAttempts: 5,
  windowMs: 5 * 60 * 1000,
  lockoutMs: 5 * 60 * 1000,
})

// 25 attempts per IP in 5 minutes -> 5-minute lockout
export const ipRateLimiter = new RateLimiter({
  maxAttempts: 25,
  windowMs: 5 * 60 * 1000,
  lockoutMs: 5 * 60 * 1000,
})
