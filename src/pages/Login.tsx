import { FormEvent, useState } from "react"
import { api, ApiError } from "../api"
import type { SessionUser } from "../types"
import { Badge, ReturnLogo } from "../ui"

export function Login({
  onLogin,
}: {
  onLogin: (session: { user: SessionUser; claimsBadge: string; headerDate: string }) => void
}) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [rememberDevice, setRememberDevice] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError("")
    try {
      const data = await api<{
        token: string
        user: SessionUser
        claimsBadge: string
        headerDate: string
        rememberDevice?: boolean
      }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password, rememberDevice }),
      })
      // Session is preserved in HttpOnly cookie; zero localStorage usage
      onLogin(data)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("Incorrect email or password.")
      } else if (err instanceof ApiError && err.status === 403) {
        setError(err.message || "This account has been disabled. Contact an administrator.")
      } else if (err instanceof ApiError && err.status === 429) {
        setError(err.message || "Too many failed attempts. Please wait a few minutes before retrying.")
      } else if (err instanceof ApiError && err.status === 503) {
        setError("Warehouse database service is currently unavailable. Please check connection and try again.")
      } else {
        setError(err instanceof Error ? err.message : "Unable to sign in. Please verify your connection.")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-shell">
      <section className="login-story">
        <div className="brand brand-light">
          <ReturnLogo light />
        </div>
        <div className="story-copy">
          <Badge tone="glass">Operations in sync</Badge>
          <h1>Every return, clearly accounted for.</h1>
          <p>
            Scan, inspect, claim, and understand every marketplace return from
            one reliable warehouse workspace.
          </p>
        </div>
        <div className="story-meta">
          <span>VB Exports · Warehouse Return Operations</span>
        </div>
      </section>
      <section className="login-panel">
        <form className="login-card" onSubmit={submit} noValidate={false}>
          <div className="mobile-brand">
            <ReturnLogo />
          </div>
          <div className="login-title-block">
            <span className="eyebrow">WAREHOUSE ACCESS</span>
            <h2>Sign in to your workspace</h2>
            <p>Enter your credentials to continue to return scanning operations.</p>
          </div>

          <div className="form-group">
            <label htmlFor="login-email">Email address</label>
            <input
              id="login-email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                setError("")
              }}
              placeholder="name@company.com"
              autoComplete="username"
              required
              disabled={busy}
            />
          </div>

          <div className="form-group">
            <label htmlFor="login-password">Password</label>
            <div className="password-wrap">
              <input
                id="login-password"
                name="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                  setError("")
                }}
                placeholder="Enter password"
                autoComplete="current-password"
                required
                disabled={busy}
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((shown) => !shown)}
                aria-pressed={showPassword}
                aria-label={showPassword ? "Hide password" : "Show password"}
                tabIndex={0}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <div className="remember-group">
            <label className="remember-device-label" htmlFor="remember-device">
              <input
                type="checkbox"
                id="remember-device"
                name="rememberDevice"
                checked={rememberDevice}
                onChange={(event) => setRememberDevice(event.target.checked)}
                disabled={busy}
              />
              <span className="remember-text">
                <strong>Remember this device</strong>
                <small>Keep this warehouse terminal signed in for up to 30 days</small>
              </span>
            </label>
          </div>

          {error && (
            <div className="form-error" role="alert" aria-live="assertive">
              {error}
            </div>
          )}

          <button className="btn primary wide login-submit-btn" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? (
              <span className="btn-loading">
                <span className="login-spinner" />
                Signing in…
              </span>
            ) : (
              "Sign in"
            )}
          </button>
        </form>
      </section>
    </main>
  )
}
