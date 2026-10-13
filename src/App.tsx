import { useEffect, useState } from "react"
import { api, ApiError } from "./api"
import { isAdminUser } from "./access"
import { pageFromPath, PAGE_PATH } from "./routes"
import { Header, PageError, Sidebar } from "./shell"
import type { Page, SessionUser } from "./types"
import { ReturnLogo } from "./ui"
import { Admin } from "./pages/Admin"
import { Claims } from "./pages/Claims"
import { Dashboard } from "./pages/Dashboard"
import { Login } from "./pages/Login"
import { Reports } from "./pages/Reports"
import { ScanReturns } from "./pages/ScanReturns"
import { Uploads } from "./pages/Uploads"
import { WorkspaceContext, type WorkspaceValue } from "./workspace"

const PAGE_TITLES: Record<Page, string> = {
  dashboard: "Overview · Return Operations",
  scan: "Scan Returns · Return Operations",
  reports: "Return Register · Return Operations",
  claims: "Claims · Return Operations",
  uploads: "Data Uploads · Return Operations",
  admin: "Admin Settings · Return Operations",
}

// Session handling and page routing only. Each page lives in src/pages/.
// The header date and claims badge come from the server once a session exists. Nothing is shown before that.
export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [claimsBadge, setClaimsBadge] = useState("0")
  const [headerDate, setHeaderDate] = useState("")
  const [page, setPage] = useState<Page>(() => pageFromPath(window.location.pathname))
  const [collapsed, setCollapsed] = useState(false)
  const [booting, setBooting] = useState(true)
  const [connectionError, setConnectionError] = useState<string | null>(null)

  const openPage = (next: Page) => {
    const path = PAGE_PATH[next]
    if (window.location.pathname !== path) window.history.pushState(null, "", path)
    setPage(next)
  }

  useEffect(() => {
    document.title = PAGE_TITLES[page] || "Return Operations"
  }, [page])

  useEffect(() => {
    const onPop = () => setPage(pageFromPath(window.location.pathname))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const checkSession = async () => {
    setBooting(true)
    setConnectionError(null)
    try {
      const data = await api<{ user: SessionUser; claimsBadge: string; headerDate: string }>("/api/auth/me")
      setUser(data.user)
      setClaimsBadge(data.claimsBadge)
      setHeaderDate(data.headerDate)
      setConnectionError(null)

      // Scanner role defaults to /scan
      const isScanner = String(data.user.role || "").trim().toLowerCase() === "scanner"
      if (isScanner && (window.location.pathname === "/" || window.location.pathname === "/dashboard")) {
        window.history.replaceState(null, "", "/scan")
        setPage("scan")
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null)
        setConnectionError(null)
      } else {
        // Network or 503 error: do NOT wipe existing user state if already authenticated
        setConnectionError("Unable to connect to warehouse return service. Checking connection…")
      }
    } finally {
      setBooting(false)
    }
  }

  useEffect(() => {
    void checkSession()
  }, [])

  const logout = async () => {
    try {
      await api("/api/auth/logout", { method: "POST" })
    } catch {
      // Ignore network errors on logout
    }
    setUser(null)
    setPage("dashboard")
    window.history.pushState(null, "", "/")
  }

  if (booting) {
    return (
      <div className="boot-screen">
        <ReturnLogo />
      </div>
    )
  }

  if (connectionError && !user) {
    return (
      <div className="boot-screen connection-error-screen">
        <ReturnLogo />
        <div className="connection-error-card">
          <h3>Connection Unavailable</h3>
          <p>{connectionError}</p>
          <button className="btn primary" onClick={() => void checkSession()}>
            Retry connection
          </button>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <Login
        onLogin={(session) => {
          setUser(session.user)
          setClaimsBadge(session.claimsBadge)
          setHeaderDate(session.headerDate)
          setBooting(false)
          setConnectionError(null)
          const isScanner = String(session.user.role || "").trim().toLowerCase() === "scanner"
          if (isScanner) {
            window.history.replaceState(null, "", "/scan")
            setPage("scan")
          } else {
            setPage("dashboard")
          }
        }}
      />
    )
  }

  const workspace: WorkspaceValue = {
    user,
    claimsBadge,
    headerDate,
    openPage,
    setClaimsBadge,
  }

  return (
    <WorkspaceContext.Provider value={workspace}>
      <div className="app-shell">
        <Sidebar page={page} collapsed={collapsed} setCollapsed={setCollapsed} logout={logout} />
        <main className={page === "scan" ? "main-area scan-main" : "main-area"}>
          {connectionError && (
            <div className="network-warning-banner" role="alert">
              <span>{connectionError}</span>
              <button className="btn-inline-retry" onClick={() => void checkSession()}>
                Reconnect
              </button>
            </div>
          )}
          <Header page={page} />
          {page === "dashboard" && <Dashboard />}
          {page === "scan" && <ScanReturns />}
          {page === "reports" && <Reports />}
          {page === "claims" && <Claims />}
          {page === "uploads" && <Uploads />}
          {page === "admin" &&
            (isAdminUser(user) ? <Admin /> : <PageError message="Only an administrator can open this page." />)}
        </main>
      </div>
    </WorkspaceContext.Provider>
  )
}
