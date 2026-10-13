import { isAdminUser } from "./access"
import { PAGE_PATH } from "./routes"
import type { Page } from "./types"
import { Icon, ReturnLogo } from "./ui"
import { useWorkspace } from "./workspace"

// Shared page states used by every data page.
export function Loading({ label }: { label: string }) {
  return (
    <div className="page-content">
      <p className="boot-copy">{label}</p>
    </div>
  )
}

export function PageError({ message }: { message: string }) {
  return (
    <div className="page-content">
      <div className="form-error page-error">{message}</div>
    </div>
  )
}

const navItems: {
  id: Page
  label: string
  icon: "grid" | "scan" | "report" | "claim" | "upload" | "users"
  adminOnly: boolean
}[] = [
  { id: "dashboard", label: "Overview", icon: "grid", adminOnly: false },
  { id: "scan", label: "Scan returns", icon: "scan", adminOnly: false },
  { id: "reports", label: "Return register", icon: "report", adminOnly: false },
  { id: "claims", label: "Claims", icon: "claim", adminOnly: false },
  { id: "uploads", label: "Data uploads", icon: "upload", adminOnly: false },
  { id: "admin", label: "Admin", icon: "users", adminOnly: true },
]

export function Sidebar({
  page,
  collapsed,
  setCollapsed,
  logout,
}: {
  page: Page
  collapsed: boolean
  setCollapsed: (value: boolean) => void
  logout: () => void
}) {
  const { user, claimsBadge, openPage } = useWorkspace()
  // Administration is listed only for an administrator. The server refuses it to everyone else in any case.
  const visible = navItems.filter((item) => !item.adminOnly || isAdminUser(user))
  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="brand">
        <ReturnLogo />
      </div>
      <nav>
        <span className="nav-label">{!collapsed && "WORKSPACE"}</span>
        {visible.map((item) => (
          <a
            key={item.id}
            href={PAGE_PATH[item.id]}
            className={page === item.id ? "active" : ""}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
              event.preventDefault()
              openPage(item.id)
            }}
            title={item.label}
            aria-current={page === item.id ? "page" : undefined}
          >
            <Icon name={item.icon} />
            {!collapsed && <span>{item.label}</span>}
            {!collapsed && item.id === "claims" && <b>{claimsBadge}</b>}
          </a>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button onClick={logout}>
          <Icon name="logout" />
          {!collapsed && <span>Sign out</span>}
        </button>
        {!collapsed && (
          <div className="user-mini">
            <span>{user.initials}</span>
            <div>
              <strong>{user.name}</strong>
              <small>{user.sidebarLabel}</small>
            </div>
          </div>
        )}
        <button className="collapse-btn" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
          <Icon name="chevron" />
          {!collapsed && <span>Collapse menu</span>}
        </button>
      </div>
    </aside>
  )
}

export function Header({ page }: { page: Page }) {
  const { user, headerDate, openPage } = useWorkspace()
  const firstName = user.name.split(" ")[0]
  const titles: Record<Page, [string, string]> = {
    dashboard: ["Good morning, " + firstName, "Here’s what’s happening with your returns today."],
    scan: ["Scan returns", "Verify every item of a received return, then record its issues."],
    reports: ["Return register", "Every verified return, item by item, with its issues, tickets and scanner."],
    claims: ["Claim overview", "Track claim tickets and their status by marketplace."],
    uploads: ["Data uploads", "Load a marketplace return file as the active lookup data for that account."],
    admin: ["Admin settings", "Manage users, issue categories, logistics partners and marketplace accounts."],
  }
  return (
    <header className="topbar">
      <div>
        <h1>{titles[page][0]}</h1>
        <p>{titles[page][1]}</p>
      </div>
      <div className="header-actions">
        {/* The date comes from the server. It is shown, not chosen, so it is not a button. */}
        <div className="date-button">
          <Icon name="calendar" />
          <span>{headerDate}</span>
        </div>
        <button
          className="icon-button"
          aria-label="Notifications (not connected yet)"
          title="Notifications are not connected yet"
          disabled
        >
          <Icon name="bell" />
        </button>
        {page !== "scan" && (
          <button className="btn primary" onClick={() => openPage("scan")}>
            <Icon name="scan" /> Scan return
          </button>
        )}
      </div>
    </header>
  )
}
