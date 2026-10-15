import { type FormEvent, useEffect, useRef, useState } from "react"
import { ApiError, api, downloadFile } from "../api"
import type { AdminIssueCategory, ProductMasterPreview, ProductMasterState } from "../types"
import { Badge, DataTable, Icon, MarketplaceBadge, PartnerBadge, Modal } from "../ui"

type AdminUser = {
  id: number
  initials: string
  name: string
  email: string
  role: string
  marketplaces: string
  scansToday: string
  status: string
  lastActive: string
  canReceiveReports?: boolean
}

type DeviceSession = {
  id: number
  userId: number
  userName: string
  userEmail: string
  userRole: string
  deviceName: string
  userAgent: string
  ipAddress: string
  isRemembered: boolean
  createdAt: string
  lastActiveAt: string
  expiresAt: string
  idleExpiresAt: string
  isCurrent?: boolean
}

type IssueOption = { id: number; label: string; categoryCode: string; claimAmount: number }

type PartnerAlias = { id: number; alias: string; aliasKey: string; marketplace: string; active: boolean }
type PartnerDomain = { id: number; host: string; active: boolean }
type PartnerRow = {
  id: number
  name: string
  active: boolean
  aliases: PartnerAlias[]
  domains: PartnerDomain[]
}

type AccountRow = {
  id: number
  name: string
  code: string
  status: string
  tone: "neutral" | "success" | "warning" | "danger"
  lastSynced: string
  activeLookupCount: number
  canManage: boolean
}

type ReportsConfig = {
  dailyEnabled: boolean
  dailyTime: string
  weeklyEnabled: boolean
  weeklyDay: number
  weeklyTime: string
  timezone: string
  sender: string
  recipientEmails: string[]
}

type ReportHistoryItem = {
  id: number
  type: string
  periodKey: string
  recipients: string[]
  status: string
  sentAt: string | null
  error: string | null
  createdAt: string
}

type SessionConfig = {
  rememberDurationDays: number
  rememberIdleDays: number
  standardDurationHours: number
  standardIdleHours: number
}

const TABS = [
  "Users",
  "Issue configuration",
  "Logistics partners",
  "Product SKU master",
  "Marketplace accounts",
  "Claim templates",
  "System",
]

const count = (value: number) => value.toLocaleString("en-US")

type AliasDraft = { alias: string; marketplace: string }

export function Admin() {
  const [tab, setTab] = useState("Users")
  const [users, setUsers] = useState<AdminUser[]>([])
  const [issues, setIssues] = useState<IssueOption[]>([])
  const [categories, setCategories] = useState<AdminIssueCategory[]>([])
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [partners, setPartners] = useState<PartnerRow[]>([])
  const [system, setSystem] = useState<{ title: string; detail: string; status: string; tone: string }[]>([])
  const [productMaster, setProductMaster] = useState<ProductMasterState | null>(null)
  const [pmPreview, setPmPreview] = useState<ProductMasterPreview | null>(null)
  const [pmFilename, setPmFilename] = useState("")
  const [pmFile, setPmFile] = useState<File | null>(null)
  const [pmMarketplace, setPmMarketplace] = useState("")
  const [pmConfirmed, setPmConfirmed] = useState(false)
  const [pmError, setPmError] = useState("")
  const [pmNotice, setPmNotice] = useState("")
  const [pmBusy, setPmBusy] = useState(false)
  const pmFileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState("")

  // Issue options & partners state
  const [newOption, setNewOption] = useState("")
  const [optionError, setOptionError] = useState("")
  const [savingOption, setSavingOption] = useState(false)
  const [categoryError, setCategoryError] = useState("")
  const [newCategory, setNewCategory] = useState("")
  const [savingCategory, setSavingCategory] = useState(false)
  const [newPartner, setNewPartner] = useState("")
  const [partnerError, setPartnerError] = useState("")
  const [aliasDrafts, setAliasDrafts] = useState<Record<number, AliasDraft>>({})

  // Active Sessions state
  const [sessions, setSessions] = useState<DeviceSession[]>([])
  const [sessionNotice, setSessionNotice] = useState("")
  const [sessionError, setSessionError] = useState("")

  // Resend reports state
  const [reportsConfig, setReportsConfig] = useState<ReportsConfig | null>(null)
  const [reportHistory, setReportHistory] = useState<ReportHistoryItem[]>([])
  const [savingReports, setSavingReports] = useState(false)
  const [reportsNotice, setReportsNotice] = useState("")
  const [reportsError, setReportsError] = useState("")
  const [newRecipient, setNewRecipient] = useState("")
  const [testEmailTarget, setTestEmailTarget] = useState("")
  const [testReportType, setTestReportType] = useState<"daily" | "weekly">("daily")
  const [testReportBusy, setTestReportBusy] = useState(false)
  const [testReportResult, setTestReportResult] = useState<string | null>(null)

  // Session Security Settings state
  const [sessionConfig, setSessionConfig] = useState<SessionConfig | null>(null)
  const [savingSessionConfig, setSavingSessionConfig] = useState(false)
  const [sessionConfigNotice, setSessionConfigNotice] = useState("")

  // Sales & Payment Database Synchronization state
  const [paymentState, setPaymentState] = useState<{
    configured: boolean
    pendingCount: number
    syncedCount: number
    lastRun: {
      id: number
      status: string
      startedAt: string
      completedAt: string | null
      checked: number
      matched: number
      updated: number
      totalAmount: number
      error: string | null
    } | null
    scheduledTime: string
  } | null>(null)
  const [syncingPayment, setSyncingPayment] = useState(false)
  const [paymentNotice, setPaymentNotice] = useState("")
  const [paymentError, setPaymentError] = useState("")

  // Unmapped Listing SKUs state
  const [unmappedSummary, setUnmappedSummary] = useState<{
    totalUnmapped: number
    pendingResolution: number
    byMarketplace: Array<{ marketplace: string; count: number }>
  } | null>(null)
  const [refreshingUnmapped, setRefreshingUnmapped] = useState(false)
  const [unmappedNotice, setUnmappedNotice] = useState("")

  // Add User & Password Reset state
  const [addUserOpen, setAddUserOpen] = useState(false)
  const [newUserName, setNewUserName] = useState("")
  const [newUserEmail, setNewUserEmail] = useState("")
  const [newUserPassword, setNewUserPassword] = useState("")
  const [newUserRole, setNewUserRole] = useState("Scanner")
  const [newUserAllMarkets, setNewUserAllMarkets] = useState(true)
  const [newUserMarketIds, setNewUserMarketIds] = useState<number[]>([])
  const [creatingUser, setCreatingUser] = useState(false)
  const [userModalError, setUserModalError] = useState("")

  const [resetModalUser, setResetModalUser] = useState<AdminUser | null>(null)
  const [resetNewPassword, setResetNewPassword] = useState("")
  const [resettingPassword, setResettingPassword] = useState(false)
  const [resetError, setResetError] = useState("")

  const loadUsers = () =>
    api<{ users: AdminUser[] }>("/api/admin/users")
      .then((data) => setUsers(data.users))
      .catch((err: Error) => setError(err.message))

  const loadPartners = () =>
    api<{ partners: PartnerRow[] }>("/api/admin/logistics-partners")
      .then((data) => setPartners(data.partners))
      .catch((err: Error) => setPartnerError(err.message))

  const loadSessions = () =>
    api<{ sessions: DeviceSession[] }>("/api/admin/sessions")
      .then((data) => setSessions(data.sessions))
      .catch((err: Error) => setSessionError(err.message))

  const loadReportsConfig = () =>
    api<{ config: ReportsConfig; history: ReportHistoryItem[] }>("/api/admin/reports/config")
      .then((data) => {
        setReportsConfig(data.config)
        setReportHistory(data.history)
      })
      .catch((err: Error) => setReportsError(err.message))

  const loadSessionConfig = () =>
    api<{ config: SessionConfig }>("/api/admin/settings/sessions")
      .then((data) => setSessionConfig(data.config))
      .catch(() => undefined)

  const handleCreateUser = async (e: FormEvent) => {
    e.preventDefault()
    setUserModalError("")
    if (!newUserName.trim() || newUserName.trim().length < 2) {
      setUserModalError("Name must be at least 2 characters.")
      return
    }
    if (!newUserEmail.trim() || !newUserEmail.includes("@")) {
      setUserModalError("Please provide a valid email address.")
      return
    }
    if (!newUserPassword || newUserPassword.length < 10) {
      setUserModalError("Password must be at least 10 characters long.")
      return
    }
    if (!newUserAllMarkets && newUserMarketIds.length === 0) {
      setUserModalError("Please assign at least one marketplace account, or select 'All marketplaces'.")
      return
    }

    setCreatingUser(true)
    try {
      await api("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          name: newUserName.trim(),
          email: newUserEmail.trim().toLowerCase(),
          password: newUserPassword,
          role: newUserRole,
          allMarketplaces: newUserAllMarkets,
          marketplaceIds: newUserMarketIds,
        }),
      })
      setSessionNotice(`User "${newUserName.trim()}" created successfully.`)
      setAddUserOpen(false)
      setNewUserName("")
      setNewUserEmail("")
      setNewUserPassword("")
      setNewUserRole("Scanner")
      setNewUserAllMarkets(true)
      setNewUserMarketIds([])
      await loadUsers()
    } catch (err) {
      setUserModalError(err instanceof Error ? err.message : "Failed to create user.")
    } finally {
      setCreatingUser(false)
    }
  }

  const toggleUserStatus = async (user: AdminUser) => {
    const nextStatus = user.status === "Active" ? "Disabled" : "Active"
    const confirmMsg =
      nextStatus === "Disabled"
        ? `Disable account for "${user.name}"? This will immediately revoke all their active warehouse sessions.`
        : `Re-activate account for "${user.name}"?`
    if (!window.confirm(confirmMsg)) return

    try {
      await api(`/api/admin/users/${user.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      })
      setSessionNotice(`Account for ${user.name} is now ${nextStatus}.`)
      await loadUsers()
      await loadSessions()
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : "Failed to update user status.")
    }
  }

  const handleResetPassword = async (e: FormEvent) => {
    e.preventDefault()
    if (!resetModalUser) return
    if (!resetNewPassword || resetNewPassword.length < 10) {
      setResetError("Password must be at least 10 characters long.")
      return
    }
    setResettingPassword(true)
    setResetError("")
    try {
      await api(`/api/admin/users/${resetModalUser.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ password: resetNewPassword }),
      })
      setSessionNotice(`Password for ${resetModalUser.name} reset. All existing sessions revoked.`)
      setResetModalUser(null)
      setResetNewPassword("")
      await loadSessions()
    } catch (err) {
      setResetError(err instanceof Error ? err.message : "Failed to reset password.")
    } finally {
      setResettingPassword(false)
    }
  }

  useEffect(() => {
    Promise.all([
      api<{ users: AdminUser[] }>("/api/admin/users"),
      api<{ options: IssueOption[] }>("/api/admin/issue-options"),
      api<{ categories: AdminIssueCategory[] }>("/api/admin/issue-categories"),
      api<{ accounts: AccountRow[] }>("/api/admin/accounts"),
      api<{ partners: PartnerRow[] }>("/api/admin/logistics-partners"),
      api<{ items: { title: string; detail: string; status: string; tone: string }[] }>("/api/admin/system"),
      api<{ state: ProductMasterState }>("/api/admin/product-master"),
      api<{ sessions: DeviceSession[] }>("/api/admin/sessions").catch(() => ({ sessions: [] })),
      api<{ config: ReportsConfig; history: ReportHistoryItem[] }>("/api/admin/reports/config").catch(() => ({
        config: null,
        history: [],
      })),
      api<{ config: SessionConfig }>("/api/admin/settings/sessions").catch(() => ({ config: null })),
    ])
      .then(
        ([
          userData,
          optionData,
          categoryData,
          accountData,
          partnerData,
          systemData,
          productData,
          sessionData,
          reportsData,
          sessionConfData,
        ]) => {
          setUsers(userData.users)
          setIssues(optionData.options)
          setCategories(categoryData.categories)
          setAccounts(accountData.accounts)
          setPartners(partnerData.partners)
          setSystem(systemData.items)
          setProductMaster(productData.state)
          setSessions(sessionData.sessions)
          if (reportsData.config) {
            setReportsConfig(reportsData.config)
            setReportHistory(reportsData.history)
          }
          if (sessionConfData.config) setSessionConfig(sessionConfData.config)
          loadPaymentStatus()
          loadUnmappedSummary()
        },
      )
      .catch((err: Error) => setError(err.message))
  }, [])

  // User actions
  const toggleUserReport = async (user: AdminUser) => {
    const nextVal = !user.canReceiveReports
    try {
      await api(`/api/admin/users/${user.id}/reports`, {
        method: "PATCH",
        body: JSON.stringify({ canReceiveReports: nextVal }),
      })
      setUsers((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, canReceiveReports: nextVal } : u)),
      )
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to toggle report setting")
    }
  }

  const revokeAllForUser = async (user: AdminUser) => {
    if (!window.confirm(`Revoke all active device sessions for ${user.name}? They will be prompted to sign in again.`)) return
    try {
      await api(`/api/admin/users/${user.id}/revoke-sessions`, { method: "POST" })
      setSessionNotice(`Revoked all sessions for ${user.name}.`)
      await loadSessions()
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : "Failed to revoke sessions.")
    }
  }

  const revokeSingleSession = async (session: DeviceSession) => {
    if (!window.confirm(`Revoke session on "${session.deviceName}" (${session.ipAddress})?`)) return
    try {
      await api(`/api/admin/sessions/${session.id}/revoke`, { method: "POST" })
      setSessionNotice(`Session revoked successfully.`)
      await loadSessions()
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : "Failed to revoke session.")
    }
  }

  // Reports config actions
  const saveReportsConfig = async (e: FormEvent) => {
    e.preventDefault()
    if (!reportsConfig) return
    setSavingReports(true)
    setReportsError("")
    setReportsNotice("")
    try {
      const res = await api<{ config: ReportsConfig }>("/api/admin/reports/config", {
        method: "POST",
        body: JSON.stringify(reportsConfig),
      })
      setReportsConfig(res.config)
      setReportsNotice("Report schedule and recipient preferences saved successfully.")
    } catch (err) {
      setReportsError(err instanceof Error ? err.message : "Failed to save reports configuration.")
    } finally {
      setSavingReports(false)
    }
  }

  const addReportRecipient = () => {
    const email = newRecipient.trim().toLowerCase()
    if (!email || !email.includes("@")) return
    if (!reportsConfig) return
    if (reportsConfig.recipientEmails.includes(email)) return
    setReportsConfig({
      ...reportsConfig,
      recipientEmails: [...reportsConfig.recipientEmails, email],
    })
    setNewRecipient("")
  }

  const removeReportRecipient = (email: string) => {
    if (!reportsConfig) return
    setReportsConfig({
      ...reportsConfig,
      recipientEmails: reportsConfig.recipientEmails.filter((e) => e !== email),
    })
  }

  const sendTestReportAction = async () => {
    setTestReportBusy(true)
    setTestReportResult(null)
    setReportsError("")
    try {
      const res = await api<{ success: boolean; message: string; previewSummary: Record<string, unknown> }>(
        "/api/admin/reports/send-test",
        {
          method: "POST",
          body: JSON.stringify({
            reportType: testReportType,
            targetEmail: testEmailTarget.trim() || undefined,
          }),
        },
      )
      setTestReportResult(res.message)
      await loadReportsConfig()
    } catch (err) {
      setReportsError(err instanceof Error ? err.message : "Failed to send test report.")
    } finally {
      setTestReportBusy(false)
    }
  }

  // Payment sync actions
  const loadPaymentStatus = () =>
    api<{
      ok: boolean
      configured: boolean
      pendingCount: number
      syncedCount: number
      lastRun: any
      scheduledTime: string
    }>("/api/payment/status")
      .then((data) => setPaymentState(data))
      .catch(() => setPaymentState(null))

  const triggerPaymentSync = async (forceAll: boolean = false) => {
    setSyncingPayment(true)
    setPaymentNotice("")
    setPaymentError("")
    try {
      const res = await api<{
        ok: boolean
        status: string
        details: string
        updated: number
        totalAmount: number
      }>("/api/payment/sync", {
        method: "POST",
        body: JSON.stringify({ forceAll }),
      })
      if (res.status === "success") {
        setPaymentNotice(res.details)
      } else {
        setPaymentError(res.details)
      }
      await loadPaymentStatus()
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : "Payment sync failed.")
    } finally {
      setSyncingPayment(false)
    }
  }

  // Unmapped Listing SKUs actions
  const loadUnmappedSummary = () =>
    api<{
      summary: {
        totalUnmapped: number
        pendingResolution: number
        byMarketplace: Array<{ marketplace: string; count: number }>
      }
    }>("/api/admin/product-master/unmapped")
      .then((data) => setUnmappedSummary(data.summary))
      .catch(() => undefined)

  const handleRefreshUnmapped = async () => {
    setRefreshingUnmapped(true)
    setUnmappedNotice("")
    try {
      const data = await api<{
        summary: {
          totalUnmapped: number
          pendingResolution: number
          byMarketplace: Array<{ marketplace: string; count: number }>
        }
      }>("/api/admin/product-master/unmapped/refresh", { method: "POST" })
      setUnmappedSummary(data.summary)
      setUnmappedNotice("Unmapped listing SKUs scanned and refreshed successfully.")
    } catch (err) {
      setPmError(err instanceof Error ? err.message : "Failed to refresh unmapped listing SKUs.")
    } finally {
      setRefreshingUnmapped(false)
    }
  }

  // Session security config actions
  const saveSessionConfig = async (e: FormEvent) => {
    e.preventDefault()
    if (!sessionConfig) return
    setSavingSessionConfig(true)
    setSessionConfigNotice("")
    try {
      const res = await api<{ config: SessionConfig }>("/api/admin/settings/sessions", {
        method: "POST",
        body: JSON.stringify(sessionConfig),
      })
      setSessionConfig(res.config)
      setSessionConfigNotice("Device session security lifetimes updated.")
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to save session settings")
    } finally {
      setSavingSessionConfig(false)
    }
  }

  // Issue option actions
  const addOption = async () => {
    const label = newOption.trim()
    if (!label) return
    setSavingOption(true)
    setOptionError("")
    try {
      const created = await api<{ option: IssueOption }>("/api/admin/issue-options", {
        method: "POST",
        body: JSON.stringify({ label, categoryCode: "missing_component" }),
      })
      setIssues((current) => [...current, created.option])
      setNewOption("")
    } catch (err) {
      setOptionError(err instanceof Error ? err.message : "Could not add the option")
    } finally {
      setSavingOption(false)
    }
  }

  const removeOption = async (option: IssueOption) => {
    if (!window.confirm(`Remove "${option.label}"? Scanners will stop seeing it. Past scans keep their label.`)) return
    setOptionError("")
    try {
      await api(`/api/admin/issue-options/${option.id}`, { method: "DELETE" })
      setIssues((current) => current.filter((item) => item.id !== option.id))
    } catch (err) {
      setOptionError(err instanceof Error ? err.message : "Could not remove the option")
    }
  }

  const updateOptionClaimAmount = async (option: IssueOption, value: string) => {
    const claimAmount = Number(value)
    if (!Number.isFinite(claimAmount) || claimAmount < 0) {
      setOptionError("Claim amount must be zero or more.")
      return
    }
    setOptionError("")
    try {
      const updated = await api<{ option: IssueOption }>(
        `/api/admin/issue-options/${option.id}/claim-amount`,
        { method: "PATCH", body: JSON.stringify({ claimAmount }) },
      )
      setIssues((current) => current.map((item) => item.id === option.id ? updated.option : item))
    } catch (err) {
      setOptionError(err instanceof Error ? err.message : "Could not save the claim amount")
    }
  }

  const changeCategory = async (code: string, changes: { active?: boolean; requiresTicket?: boolean }) => {
    setCategoryError("")
    try {
      const updated = await api<{ category: { code: string; active: boolean; requiresTicket: boolean } }>(
        `/api/admin/issue-categories/${encodeURIComponent(code)}`,
        { method: "PATCH", body: JSON.stringify(changes) },
      )
      setCategories((current) =>
        current.map((entry) =>
          entry.code === code
            ? { ...entry, active: updated.category.active, requiresTicket: updated.category.requiresTicket }
            : entry,
        ),
      )
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : "The category was not changed.")
    }
  }

  const addCategory = async (event: FormEvent) => {
    event.preventDefault()
    const label = newCategory.trim()
    if (!label) return
    setCategoryError("")
    setSavingCategory(true)
    try {
      const data = await api<{ category: AdminIssueCategory }>("/api/admin/issue-categories", {
        method: "POST",
        body: JSON.stringify({ label }),
      })
      setCategories((current) => [...current, data.category])
      setNewCategory("")
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : "Could not add the category.")
    } finally {
      setSavingCategory(false)
    }
  }

  // Partner actions
  const partnerChange = async (work: () => Promise<unknown>) => {
    setPartnerError("")
    try {
      await work()
      await loadPartners()
    } catch (err) {
      setPartnerError(err instanceof Error ? err.message : "The change was not saved.")
    }
  }

  const addPartner = (event: FormEvent) => {
    event.preventDefault()
    const name = newPartner.trim()
    if (!name) return
    void partnerChange(async () => {
      await api("/api/admin/logistics-partners", { method: "POST", body: JSON.stringify({ name }) })
      setNewPartner("")
    })
  }

  const togglePartner = (partner: PartnerRow) =>
    partnerChange(() =>
      api(`/api/admin/logistics-partners/${partner.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !partner.active }),
      }),
    )

  const addAlias = (partner: PartnerRow) => {
    const draft = aliasDrafts[partner.id] ?? { alias: "", marketplace: "" }
    if (!draft.alias.trim()) return
    void partnerChange(async () => {
      await api(`/api/admin/logistics-partners/${partner.id}/aliases`, {
        method: "POST",
        body: JSON.stringify({ alias: draft.alias, marketplace: draft.marketplace }),
      })
      setAliasDrafts((current) => ({ ...current, [partner.id]: { alias: "", marketplace: "" } }))
    })
  }

  const toggleAlias = (alias: PartnerAlias) =>
    partnerChange(() =>
      api(`/api/admin/logistics-partner-aliases/${alias.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !alias.active }),
      }),
    )

  // Product master actions
  const previewProductMasterFile = async (file: File) => {
    setPmError("")
    setPmNotice("")
    setPmConfirmed(false)
    setPmFile(file)
    setPmFilename(file.name)
    setPmBusy(true)
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("marketplace", pmMarketplace)
      const data = await api<{ preview: ProductMasterPreview; filename: string }>("/api/admin/product-master/preview", {
        method: "POST",
        body,
      })
      setPmPreview(data.preview)
    } catch (err) {
      setPmPreview(null)
      setPmError(err instanceof Error ? err.message : "Could not read that file")
    } finally {
      setPmBusy(false)
    }
  }

  const loadProductMaster = async () => {
    const file = pmFile
    if (!file) {
      setPmError("Choose a file first.")
      return
    }
    setPmBusy(true)
    setPmError("")
    setPmNotice("")
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("marketplace", pmMarketplace)
      body.append("confirm", "true")
      const data = await api<{ result: { inserted: number; removed: number }; state: ProductMasterState }>(
        "/api/admin/product-master/import",
        { method: "POST", body },
      )
      setProductMaster(data.state)
      setPmNotice(
        `Loaded ${data.result.inserted.toLocaleString("en-US")} listing SKUs. Replaced ${data.result.removed.toLocaleString("en-US")} earlier rows.`,
      )
      setPmPreview(null)
      setPmConfirmed(false)
      setPmFilename("")
      setPmFile(null)
      if (pmFileRef.current) pmFileRef.current.value = ""
    } catch (err) {
      setPmError(err instanceof ApiError ? err.message : "The product master was not loaded.")
    } finally {
      setPmBusy(false)
    }
  }

  const pmReady = Boolean(pmPreview) && !pmPreview?.fatal && (pmPreview?.rows ?? 0) > 0 && pmConfirmed

  return (
    <div className="page-content">
      {error && <div className="form-error page-error">{error}</div>}

      <div className="admin-tabs">
        {TABS.map((name) => (
          <button
            className={tab === name ? "active" : ""}
            aria-pressed={tab === name}
            onClick={() => setTab(name)}
            key={name}
          >
            {name}
          </button>
        ))}
      </div>

      {/* -------------------- TAB 1: USERS & ACTIVE SESSIONS -------------------- */}
      {tab === "Users" && (
        <section className="panel admin-panel">
          <div className="panel-head">
            <div>
              <h2>Team members & device access</h2>
              <p>Manage access, assigned marketplace channels, report authorization and live warehouse device sessions</p>
            </div>
            <button className="btn primary" onClick={() => { setAddUserOpen(true); setUserModalError("") }}>
              + Add user
            </button>
          </div>

          {sessionNotice && <div className="form-success" style={{ margin: "0 20px 12px" }}>{sessionNotice}</div>}
          {sessionError && <div className="form-error" style={{ margin: "0 20px 12px" }}>{sessionError}</div>}

          {users.length === 0 && (
            <div className="config-list">
              <div>No users yet. Click "+ Add user" above to create an authorized team account.</div>
            </div>
          )}

          <DataTable
            columns={[
              {
                key: "user",
                header: "User",
                render: (user) => (
                  <div className="user-cell">
                    <span>{user.initials}</span>
                    <div>
                      <strong>{user.name}</strong>
                      <small>{user.email}</small>
                    </div>
                  </div>
                ),
              },
              { key: "role", header: "Role", render: (user) => <strong>{user.role}</strong> },
              { key: "markets", header: "Assigned channels", render: (user) => user.marketplaces || "All marketplaces" },
              { key: "scans", header: "Scans today", render: (user) => <strong>{user.scansToday}</strong> },
              {
                key: "status",
                header: "Status",
                render: (user) => (
                  <button
                    className="status-toggle-btn"
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
                    title={`Click to ${user.status === "Active" ? "disable" : "activate"} user account`}
                    onClick={() => void toggleUserStatus(user)}
                  >
                    <Badge tone={user.status === "Active" ? "success" : "neutral"}>
                      {user.status === "Active" ? "Active ✓" : "Disabled ✕"}
                    </Badge>
                  </button>
                ),
              },
              { key: "active", header: "Last active", render: (user) => user.lastActive },
              {
                key: "reports",
                header: "Reports",
                render: (user) => (
                  <button
                    className={`btn ${user.canReceiveReports ? "primary" : "secondary"}`}
                    style={{ fontSize: 11, padding: "3px 8px", height: "auto" }}
                    title={user.canReceiveReports ? "Receives automated Resend email reports" : "Click to authorize for automated reports"}
                    onClick={() => void toggleUserReport(user)}
                  >
                    {user.canReceiveReports ? "Recipient ✓" : "Off"}
                  </button>
                ),
              },
              {
                key: "actions",
                header: "Security Actions",
                render: (user) => (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      className="btn secondary"
                      style={{ fontSize: 11, padding: "3px 8px", height: "auto" }}
                      title={`Revoke all active device sessions for ${user.name}`}
                      onClick={() => void revokeAllForUser(user)}
                    >
                      Revoke logins
                    </button>
                    <button
                      className="btn secondary"
                      style={{ fontSize: 11, padding: "3px 8px", height: "auto" }}
                      title={`Reset password for ${user.name}`}
                      onClick={() => {
                        setResetModalUser(user)
                        setResetNewPassword("")
                        setResetError("")
                      }}
                    >
                      Reset password
                    </button>
                  </div>
                ),
              },
            ]}
            rows={users}
            rowKey={(user) => String(user.id)}
          />

          {/* Modal: Add User */}
          {addUserOpen && (
            <Modal onClose={() => setAddUserOpen(false)}>
              <form onSubmit={handleCreateUser} style={{ display: "grid", gap: 16, padding: "8px 4px" }}>
                <div>
                  <h3 style={{ margin: "0 0 6px" }}>Add New Team Member</h3>
                  <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>
                    Create an authorized warehouse user account. Public registration is permanently disabled.
                  </p>
                </div>

                {userModalError && <div className="form-error">{userModalError}</div>}

                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
                  Full Name
                  <input
                    type="text"
                    value={newUserName}
                    onChange={(e) => setNewUserName(e.target.value)}
                    placeholder="e.g. Ramesh Patel"
                    required
                    style={{ height: 42, padding: "0 12px", borderRadius: 8, border: "1px solid var(--line)" }}
                  />
                </label>

                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
                  Email Address (Login)
                  <input
                    type="email"
                    value={newUserEmail}
                    onChange={(e) => setNewUserEmail(e.target.value)}
                    placeholder="e.g. ramesh@youthnic.shop"
                    required
                    style={{ height: 42, padding: "0 12px", borderRadius: 8, border: "1px solid var(--line)" }}
                  />
                </label>

                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
                  Initial Password (minimum 10 characters)
                  <input
                    type="password"
                    value={newUserPassword}
                    onChange={(e) => setNewUserPassword(e.target.value)}
                    placeholder="Enter at least 10 characters"
                    required
                    minLength={10}
                    style={{ height: 42, padding: "0 12px", borderRadius: 8, border: "1px solid var(--line)" }}
                  />
                </label>

                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
                  Role & Access Level
                  <select
                    value={newUserRole}
                    onChange={(e) => setNewUserRole(e.target.value)}
                    style={{ height: 42, padding: "0 12px", borderRadius: 8, border: "1px solid var(--line)", background: "white" }}
                  >
                    <option value="Scanner">Scanner (Scanning & return inspection only)</option>
                    <option value="Supervisor">Supervisor (Operations, reports, uploads, claims)</option>
                    <option value="Inward">Inward Team (Records ironed units received back)</option>
                    <option value="Admin">Admin (Full system and user access)</option>
                  </select>
                </label>

                <div style={{ display: "grid", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Marketplace Scope</span>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="marketScopeRadio"
                      checked={newUserAllMarkets}
                      onChange={() => setNewUserAllMarkets(true)}
                    />
                    All Marketplaces (Recommended for warehouse staff)
                  </label>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="marketScopeRadio"
                      checked={!newUserAllMarkets}
                      onChange={() => setNewUserAllMarkets(false)}
                    />
                    Specific accounts only
                  </label>
                  {!newUserAllMarkets && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: 8, background: "#f8faf9", borderRadius: 8 }}>
                      {accounts.map((acc) => (
                        <label key={acc.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={newUserMarketIds.includes(acc.id)}
                            onChange={(e) => {
                              if (e.target.checked) setNewUserMarketIds((prev) => [...prev, acc.id])
                              else setNewUserMarketIds((prev) => prev.filter((id) => id !== acc.id))
                            }}
                          />
                          {acc.name}
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
                  <button type="button" className="btn secondary" onClick={() => setAddUserOpen(false)} disabled={creatingUser}>
                    Cancel
                  </button>
                  <button type="submit" className="btn primary" disabled={creatingUser}>
                    {creatingUser ? "Creating user…" : "Create user"}
                  </button>
                </div>
              </form>
            </Modal>
          )}

          {/* Modal: Reset Password */}
          {resetModalUser && (
            <Modal onClose={() => setResetModalUser(null)}>
              <form onSubmit={handleResetPassword} style={{ display: "grid", gap: 16, padding: "8px 4px" }}>
                <div>
                  <h3 style={{ margin: "0 0 6px" }}>Reset Password for {resetModalUser.name}</h3>
                  <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>
                    Setting a new password will immediately invalidate all active sessions for this user on warehouse devices.
                  </p>
                </div>

                {resetError && <div className="form-error">{resetError}</div>}

                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
                  New Password (minimum 10 characters)
                  <input
                    type="password"
                    value={resetNewPassword}
                    onChange={(e) => setResetNewPassword(e.target.value)}
                    placeholder="Enter at least 10 characters"
                    required
                    minLength={10}
                    style={{ height: 42, padding: "0 12px", borderRadius: 8, border: "1px solid var(--line)" }}
                  />
                </label>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
                  <button type="button" className="btn secondary" onClick={() => setResetModalUser(null)} disabled={resettingPassword}>
                    Cancel
                  </button>
                  <button type="submit" className="btn primary" disabled={resettingPassword}>
                    {resettingPassword ? "Updating…" : "Update & invalidate sessions"}
                  </button>
                </div>
              </form>
            </Modal>
          )}

          {/* Active device sessions list */}
          <div className="panel-head" style={{ marginTop: 24, borderTop: "1px solid var(--line)" }}>
            <div>
              <h3>Active warehouse & device sessions ({sessions.length})</h3>
              <p>Live authenticated sessions across warehouse scanners and office computers. Instant server-side revocation.</p>
            </div>
            <button className="btn secondary" onClick={() => void loadSessions()}>
              Refresh sessions
            </button>
          </div>

          <DataTable
            columns={[
              {
                key: "device",
                header: "Device / Terminal",
                render: (s) => (
                  <div className="session-device-cell">
                    <strong>
                      {s.deviceName} {s.isCurrent && <span className="session-badge-current">This device</span>}
                    </strong>
                    <small>IP: {s.ipAddress || "Unknown"}</small>
                  </div>
                ),
              },
              { key: "user", header: "User", render: (s) => `${s.userName} (${s.userRole})` },
              {
                key: "mode",
                header: "Session mode",
                render: (s) => (
                  <Badge tone={s.isRemembered ? "success" : "neutral"}>
                    {s.isRemembered ? "Remembered (30d)" : "Standard (24h)"}
                  </Badge>
                ),
              },
              { key: "lastActive", header: "Last active", render: (s) => s.lastActiveAt },
              {
                key: "action",
                header: "Revoke",
                render: (s) => (
                  <button
                    className="btn secondary"
                    style={{ fontSize: 11, padding: "3px 8px", height: "auto" }}
                    onClick={() => void revokeSingleSession(s)}
                  >
                    Revoke
                  </button>
                ),
              },
            ]}
            rows={sessions}
            rowKey={(s) => String(s.id)}
            empty="No active persistent device sessions recorded."
          />
        </section>
      )}

      {/* -------------------- TAB 2: ISSUE CONFIGURATION -------------------- */}
      {tab === "Issue configuration" && (
        <section className="admin-split">
          <article className="panel admin-panel">
            <div className="panel-head">
              <div>
                <h2>Missing-item sub-issues</h2>
                <p>What a scanner operator can choose when a product piece is missing (e.g. Dupatta, Belt, Inner)</p>
              </div>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void addOption()
              }}
              style={{ display: "flex", gap: 8, padding: "0 20px 12px" }}
            >
              <input
                aria-label="New option name"
                value={newOption}
                onChange={(event) => setNewOption(event.target.value)}
                placeholder="Option name, e.g. Dupatta"
                maxLength={60}
                style={{ flex: 1 }}
              />
              <button className="btn primary" type="submit" disabled={!newOption.trim() || savingOption}>
                + Add option
              </button>
            </form>
            {optionError && (
              <div className="form-error" style={{ margin: "0 20px 12px" }}>
                {optionError}
              </div>
            )}
            <div className="config-list">
              {issues.length === 0 && (
                <div>No sub-issues yet. Scanners must choose one when an item is missing, so add at least one.</div>
              )}
              {issues.map((option) => (
                <div key={option.id}>
                  <strong>{option.label}</strong>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    ₹
                    <input
                      aria-label={`${option.label} claim amount`}
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={option.claimAmount}
                      onBlur={(event) => void updateOptionClaimAmount(option, event.target.value)}
                      style={{ width: 92, height: 32 }}
                    />
                  </label>
                  <Badge tone="success">Active</Badge>
                  <button aria-label={`Remove ${option.label}`} onClick={() => void removeOption(option)}>
                    <Icon name="close" />
                  </button>
                </div>
              ))}
            </div>
          </article>

          <aside className="panel admin-panel">
            <div className="panel-head">
              <div>
                <h2>Received issue categories</h2>
                <p>
                  Switch a category off to stop scanners choosing it. The scan bench asks for a ticket ID only when
                  “Needs a ticket ID” is turned on.
                </p>
              </div>
            </div>
            <form onSubmit={addCategory} style={{ display: "flex", gap: 8, padding: "0 20px 12px" }}>
              <input
                aria-label="New category name"
                value={newCategory}
                onChange={(event) => setNewCategory(event.target.value)}
                placeholder="Category name, e.g. Iron Send"
                maxLength={60}
                style={{ flex: 1 }}
              />
              <button className="btn primary" type="submit" disabled={!newCategory.trim() || savingCategory}>
                + Add category
              </button>
            </form>
            {categoryError && (
              <div className="form-error" style={{ margin: "0 20px 12px" }}>
                {categoryError}
              </div>
            )}
            <div className="config-list">
              {categories.map((category) => (
                <div key={category.code}>
                  <strong>{category.label}</strong>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={category.active}
                      disabled={category.isClear}
                      onChange={(event) => void changeCategory(category.code, { active: event.target.checked })}
                    />
                    Active
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={category.requiresTicket}
                      disabled={category.isClear}
                      onChange={(event) => void changeCategory(category.code, { requiresTicket: event.target.checked })}
                    />
                    Needs ticket
                  </label>
                </div>
              ))}
            </div>
            <p style={{ padding: "0 20px 16px", color: "#64748b", fontSize: 12 }}>
              “No issue” is permanent. The verification rules for missing units, sub-issues and tickets are fixed in code.
            </p>
          </aside>
        </section>
      )}

      {/* -------------------- TAB 3: LOGISTICS PARTNERS -------------------- */}
      {tab === "Logistics partners" && (
        <section className="panel admin-panel">
          <div className="panel-head">
            <div>
              <h2>Logistics partners & courier detection</h2>
              <p>
                Courier names from marketplace upload files map to these partners. delhiveryexpress and delhiversurface are Delhivery.
                A partner or a courier name alias is switched off, never deleted.
              </p>
            </div>
          </div>
          {partnerError && (
            <div className="form-error" style={{ margin: "0 20px 12px" }}>
              {partnerError}
            </div>
          )}
          <form onSubmit={addPartner} style={{ display: "flex", gap: 8, padding: "0 20px 12px" }}>
            <input
              aria-label="New partner name"
              value={newPartner}
              onChange={(event) => setNewPartner(event.target.value)}
              placeholder="Partner name, for example Ecom Express"
              maxLength={60}
              style={{ flex: 1 }}
            />
            <button className="btn primary" type="submit" disabled={!newPartner.trim()}>
              + Add partner
            </button>
          </form>
          <div className="config-list">
            {partners.length === 0 && <div>No logistics partners configured.</div>}
            {partners.map((partner) => {
              const aliasDraft = aliasDrafts[partner.id] ?? { alias: "", marketplace: "" }
              return (
                <div key={partner.id} className="partner-card">
                  <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <PartnerBadge name={partner.name} />
                    <Badge tone={partner.active ? "success" : "neutral"}>{partner.active ? "Active" : "Switched off"}</Badge>
                    <button className="btn secondary" onClick={() => void togglePartner(partner)}>
                      {partner.active ? "Switch off" : "Switch on"}
                    </button>
                  </div>
                  <div style={{ display: "grid", gap: 4, paddingLeft: 12 }}>
                    <small>Courier names (aliases)</small>
                    {partner.aliases.length === 0 && <small>None yet.</small>}
                    {partner.aliases.map((alias) => (
                      <div key={alias.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span>
                          {alias.alias} <small>({alias.marketplace || "All channels"})</small>
                        </span>
                        <Badge tone={alias.active ? "success" : "neutral"}>{alias.active ? "Active" : "Off"}</Badge>
                        <button className="btn secondary" onClick={() => void toggleAlias(alias)}>
                          {alias.active ? "Switch off" : "Switch on"}
                        </button>
                      </div>
                    ))}
                    <form
                      onSubmit={(event) => {
                        event.preventDefault()
                        addAlias(partner)
                      }}
                      style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
                    >
                      <input
                        aria-label={`New courier name for ${partner.name}`}
                        value={aliasDraft.alias}
                        onChange={(event) =>
                          setAliasDrafts((current) => ({
                            ...current,
                            [partner.id]: { ...aliasDraft, alias: event.target.value },
                          }))
                        }
                        placeholder="Courier alias as typed in reports"
                        maxLength={60}
                      />
                      <select
                        aria-label={`Account for the courier name of ${partner.name}`}
                        value={aliasDraft.marketplace}
                        onChange={(event) =>
                          setAliasDrafts((current) => ({
                            ...current,
                            [partner.id]: { ...aliasDraft, marketplace: event.target.value },
                          }))
                        }
                      >
                        <option value="">All marketplaces</option>
                        {accounts.map((account) => (
                          <option key={account.id} value={account.name}>
                            {account.name}
                          </option>
                        ))}
                      </select>
                      <button className="btn secondary" type="submit" disabled={!aliasDraft.alias.trim()}>
                        + Add courier name
                      </button>
                    </form>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* -------------------- TAB 4: PRODUCT SKU MASTER -------------------- */}
      {tab === "Product SKU master" && (
        <section className="panel admin-panel">
          <div className="panel-head">
            <div>
              <h2>Product SKU master & catalog mappings</h2>
              <p>
                Channel listing SKU to VB EXPORT product SKU resolution, category and channel image links.
                A specific marketplace mapping takes precedence over all-marketplaces rules.
              </p>
            </div>
            <button
              type="button"
              className="btn secondary"
              disabled={pmBusy}
              title={pmBusy ? "A file is being read" : "Download a header-only CSV for the product SKU master"}
              onClick={() =>
                downloadFile("/api/admin/product-master/template", "product-sku-master-template.csv").catch((err: Error) =>
                  setPmError(err.message),
                )
              }
            >
              <Icon name="file" /> Download template
            </button>
          </div>

          {/* 6 Responsive Summary Cards */}
          {productMaster && (
            <div className="master-summary-grid">
              <div className="master-stat-card">
                <div className="master-stat-head">
                  <span className="master-stat-label">Total Mapping Rows</span>
                  <Badge tone="success">Catalog</Badge>
                </div>
                <div className="master-stat-value">{count(productMaster.rows)}</div>
                <div className="master-stat-sub">Active database records</div>
              </div>

              <div className="master-stat-card">
                <div className="master-stat-head">
                  <span className="master-stat-label">Listing SKUs</span>
                  <Badge tone="neutral">Channel</Badge>
                </div>
                <div className="master-stat-value">{count(productMaster.listings)}</div>
                <div className="master-stat-sub">Unique marketplace listing keys</div>
              </div>

              <div className="master-stat-card">
                <div className="master-stat-head">
                  <span className="master-stat-label">Product SKUs</span>
                  <Badge tone="neutral">Internal</Badge>
                </div>
                <div className="master-stat-value">{count(productMaster.masters)}</div>
                <div className="master-stat-sub">Unique VB Export parent items</div>
              </div>

              <div className="master-stat-card">
                <div className="master-stat-head">
                  <span className="master-stat-label">Rows with Image Links</span>
                  <Badge tone={productMaster.withImage > 0 ? "success" : "warning"}>
                    {productMaster.rows > 0 ? `${Math.round((productMaster.withImage / productMaster.rows) * 100)}%` : "0%"}
                  </Badge>
                </div>
                <div className="master-stat-value">{count(productMaster.withImage)}</div>
                <div className="master-stat-sub">Direct channel image links</div>
              </div>

              <div className="master-stat-card">
                <div className="master-stat-head">
                  <span className="master-stat-label">Last Upload</span>
                  <Icon name="calendar" size={14} />
                </div>
                <div className="master-stat-value" style={{ fontSize: 16, marginTop: 4 }}>
                  {productMaster.lastLoadedAt}
                </div>
                <div className="master-stat-sub">Catalog state update</div>
              </div>

              <div className="master-stat-card">
                <div className="master-stat-head">
                  <span className="master-stat-label">Upload Scope</span>
                  <Badge tone="neutral">
                    {productMaster.marketplaces.length === 0 ? "Global" : `${productMaster.marketplaces.length} scopes`}
                  </Badge>
                </div>
                <div className="master-stat-value" style={{ fontSize: 15, marginTop: 4 }}>
                  {productMaster.marketplaces.length === 0
                    ? "All marketplaces"
                    : productMaster.marketplaces.map((m) => m.marketplace).join(", ")}
                </div>
                <div className="master-stat-sub">Channel resolution precedence</div>
              </div>
            </div>
          )}

          {/* Action panels: Scope selector, template download, and replacement dropzone */}
          <div className="master-action-grid">
            <div className="master-panel-card">
              <h4>1. Select Scope & Upload Replacement File</h4>
              <p>
                Leave scope at <strong>All marketplaces</strong> to apply rows globally, or choose a specific marketplace
                to override mappings for that channel only.
              </p>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#475569" }}>TARGET MARKETPLACE SCOPE</span>
                <select
                  value={pmMarketplace}
                  aria-label="Marketplace scope for product master"
                  onChange={(event) => {
                    setPmMarketplace(event.target.value)
                    setPmPreview(null)
                    setPmConfirmed(false)
                    setPmError("")
                    setPmNotice("")
                    setPmFilename("")
                    setPmFile(null)
                    if (pmFileRef.current) pmFileRef.current.value = ""
                  }}
                  style={{ height: 38, borderRadius: 6, border: "1px solid var(--line)" }}
                >
                  <option value="">All marketplaces (Global)</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.name}>
                      {account.name} ({account.code || account.name})
                    </option>
                  ))}
                </select>
              </label>

              <div
                className={`drop-zone ${pmFilename ? "done" : ""}`}
                role="button"
                tabIndex={pmBusy ? -1 : 0}
                aria-disabled={pmBusy}
                onClick={() => {
                  if (!pmBusy) pmFileRef.current?.click()
                }}
                onKeyDown={(event) => {
                  if (pmBusy) return
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    pmFileRef.current?.click()
                  }
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  const file = event.dataTransfer.files?.[0]
                  if (file && !pmBusy) void previewProductMasterFile(file)
                }}
                style={{ padding: "20px 16px" }}
              >
                <span>
                  <Icon name={pmFilename ? "check" : "upload"} size={22} />
                </span>
                <h3 style={{ fontSize: 13, margin: "8px 0 2px" }}>
                  {pmBusy ? "Analyzing catalog file…" : pmFilename || "Drop new product master file here"}
                </h3>
                <p style={{ margin: 0 }}>.CSV or .XLSX, up to 25 MB</p>
              </div>

              <input
                ref={pmFileRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                hidden
                aria-label="Product SKU master file"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void previewProductMasterFile(file)
                }}
              />
            </div>

            <div className="master-panel-card">
              <h4>2. Expected Columns & Verification</h4>
              <p>The parser expects the following header structure:</p>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#475569", lineHeight: 1.6 }}>
                <li><strong>Channel Listing SKU Code</strong> (Marketplace item identifier)</li>
                <li><strong>Product SkuCode</strong> (VB Exports internal item code)</li>
                <li><strong>Product Category</strong> (e.g. Kurta, Suit Set, Dress)</li>
                <li><strong>Channel Image URL</strong> (Public HTTP/HTTPS catalog photo)</li>
              </ul>
              <div style={{ marginTop: "auto", display: "flex", gap: 10 }}>
                <button
                  type="button"
                  className="btn secondary"
                  style={{ flex: 1 }}
                  onClick={() =>
                    downloadFile("/api/admin/product-master/template", "product-sku-master-template.csv").catch(
                      (err: Error) => setPmError(err.message),
                    )
                  }
                >
                  <Icon name="file" /> Download CSV template
                </button>
              </div>
            </div>
          </div>

          {/* Unmapped Listing SKUs Card */}
          <div className="report-admin-card" style={{ margin: "0 20px 16px", padding: 18, background: "#fff", borderRadius: 10, border: "1px solid var(--line)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Unmapped Listing SKUs (Missing Product SKU Linkup)</h4>
                  <Badge tone={(unmappedSummary?.pendingResolution ?? 0) > 0 ? "warning" : "success"}>
                    {unmappedSummary ? `${unmappedSummary.pendingResolution} Pending` : "Loading..."}
                  </Badge>
                </div>
                <p style={{ margin: "6px 0 0", color: "#64748b", fontSize: 12 }}>
                  When scanned returns or uploaded reports contain marketplace listing SKUs that have not yet been linked to a VB Export Product SKU,
                  they are stored here. Download the pre-filled template with missing SKUs, fill in the Product SkuCode, and re-upload above to link them.
                </p>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={handleRefreshUnmapped}
                  disabled={refreshingUnmapped}
                  title="Re-scan all active return listings to detect missing mappings"
                >
                  <Icon name="scan" size={13} /> {refreshingUnmapped ? "Scanning..." : "Re-scan Missing"}
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() =>
                    downloadFile(
                      "/api/admin/product-master/unmapped/download" + (pmMarketplace ? `?marketplace=${encodeURIComponent(pmMarketplace)}` : ""),
                      pmMarketplace ? `unmapped-skus-${pmMarketplace.toLowerCase().replace(/[^a-z0-9]/g, "-")}.csv` : "unmapped-listing-skus.csv"
                    ).catch((err: Error) => setPmError(err.message))
                  }
                  title="Download CSV containing all unmapped listing SKUs ready to be filled and uploaded"
                >
                  <Icon name="file" size={13} /> Download Missing SKUs CSV
                </button>
              </div>
            </div>

            {unmappedNotice && <div className="form-success" style={{ marginTop: 10 }}>{unmappedNotice}</div>}

            {unmappedSummary && unmappedSummary.byMarketplace.length > 0 && (
              <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase" }}>By Marketplace:</span>
                {unmappedSummary.byMarketplace.map((mp) => (
                  <span
                    key={mp.marketplace}
                    style={{
                      background: "#f1f5f9",
                      padding: "4px 8px",
                      borderRadius: 6,
                      fontSize: 12,
                      border: "1px solid #e2e8f0",
                      fontWeight: 600,
                      color: "#334155"
                    }}
                  >
                    {mp.marketplace}: <span style={{ color: "#0f6b56" }}>{mp.count}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {pmError && <div className="form-error" style={{ margin: "0 20px 12px" }}>{pmError}</div>}
          {pmNotice && <div className="form-success" style={{ margin: "0 20px 12px" }}>{pmNotice}</div>}

          {/* Validation Summary when a preview file is analyzed */}
          {pmPreview && (
            <div style={{ margin: "0 20px 16px", padding: 16, background: "#f8fafc", borderRadius: 10, border: "1px solid #cbd5e1" }}>
              {pmPreview.fatal ? (
                <div className="form-error">{pmPreview.fatal}</div>
              ) : (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <h4 style={{ margin: 0, fontSize: 14 }}>File Validation Summary: {pmFilename}</h4>
                    <Badge tone="success">{count(pmPreview.rows)} rows scannable</Badge>
                  </div>

                  <div className="master-summary-grid" style={{ padding: 0, marginBottom: 14 }}>
                    <div className="master-stat-card">
                      <span className="master-stat-label">File Rows</span>
                      <strong className="master-stat-value">{count(pmPreview.rows)}</strong>
                    </div>
                    <div className="master-stat-card">
                      <span className="master-stat-label">Listing SKUs</span>
                      <strong className="master-stat-value">{count(pmPreview.listings)}</strong>
                    </div>
                    <div className="master-stat-card">
                      <span className="master-stat-label">Product SKUs</span>
                      <strong className="master-stat-value">{count(pmPreview.masters)}</strong>
                    </div>
                    <div className="master-stat-card">
                      <span className="master-stat-label">With Image</span>
                      <strong className="master-stat-value">{count(pmPreview.withImage)}</strong>
                    </div>
                    <div className="master-stat-card">
                      <span className="master-stat-label">Conflicts</span>
                      <strong className="master-stat-value" style={{ color: pmPreview.conflictCount > 0 ? "#d97706" : "#16a34a" }}>
                        {count(pmPreview.conflictCount)}
                      </strong>
                    </div>
                  </div>

                  {pmPreview.conflictCount > 0 && (
                    <div className="upload-warnings" style={{ marginBottom: 12 }}>
                      <strong>{count(pmPreview.conflictCount)} listing SKUs have multiple product SKU mappings in this file.</strong>
                      <p>The last row for each is kept. Check these rows before confirming replacement.</p>
                    </div>
                  )}

                  {pmPreview.sample.length > 0 && (
                    <DataTable
                      columns={[
                        { key: "listing", header: "Channel Listing SKU", render: (r) => r.listingSku },
                        { key: "master", header: "Product SKU", render: (r) => r.masterSku },
                        { key: "category", header: "Category", render: (r) => r.category || "—" },
                        { key: "image", header: "Image Link", render: (r) => (r.imageUrl ? "Yes ✓" : "—") },
                      ]}
                      rows={pmPreview.sample.slice(0, 5)}
                      rowKey={(r) => r.listingSku}
                    />
                  )}

                  <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                    <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={pmConfirmed}
                        onChange={(e) => setPmConfirmed(e.target.checked)}
                      />
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>
                        I confirm that loading this file replaces the current product master catalog
                      </span>
                    </label>

                    <button
                      className="btn primary"
                      disabled={!pmReady || pmBusy}
                      onClick={() => void loadProductMaster()}
                      style={{ alignSelf: "flex-start" }}
                    >
                      {pmBusy ? "Loading catalog…" : `Commit & Replace with ${count(pmPreview.rows)} rows`} <Icon name="arrow" />
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Current Master Sample */}
          <div className="panel-head" style={{ marginTop: 12 }}>
            <div>
              <h3>Current active master catalog (Top 20 sample)</h3>
              <p>Active listing-to-product SKU links used during marketplace return physical check-in.</p>
            </div>
          </div>

          <DataTable
            columns={[
              { key: "scope", header: "Scope", render: (r) => r.marketplace || "All channels" },
              { key: "listing", header: "Channel Listing SKU", render: (r) => <strong>{r.listingSku}</strong> },
              { key: "master", header: "Product SKU", render: (r) => r.masterSku },
              { key: "category", header: "Category", render: (r) => r.category || "—" },
              { key: "image", header: "Image Link", render: (r) => (r.imageUrl ? <Badge tone="success">Available</Badge> : <Badge tone="neutral">None</Badge>) },
            ]}
            rows={productMaster?.sample ?? []}
            rowKey={(r) => `${r.marketplace}-${r.listingSku}`}
            empty="The product master is empty. Upload a CSV/XLSX file above to load catalog mappings."
          />
        </section>
      )}

      {/* -------------------- TAB 5: MARKETPLACE ACCOUNTS -------------------- */}
      {tab === "Marketplace accounts" && (
        <section className="panel admin-panel">
          <div className="panel-head">
            <div>
              <h2>Marketplace accounts ({accounts.length})</h2>
              <p>
                Integrated channels for VB Exports return scanning. Each account manages its own independent active lookup
                table. Myntra EJ and Myntra VB are isolated accounts.
              </p>
            </div>
            <button className="btn primary" disabled title="Connecting additional accounts is not enabled in this phase">
              + Connect channel
            </button>
          </div>

          <div className="account-grid-v2">
            {accounts.map((account) => {
              const hasActiveLookup = account.activeLookupCount > 0
              return (
                <div className="account-card-v2" key={account.id}>
                  <div className="account-card-header">
                    <MarketplaceBadge name={account.name} />
                    <span className="account-code-pill">{account.code || account.name.toUpperCase()}</span>
                  </div>

                  <div className="account-metrics">
                    <div className="account-metric-item">
                      <small>Active Lookup</small>
                      <strong style={{ color: hasActiveLookup ? "#16a34a" : "#64748b" }}>
                        {count(account.activeLookupCount)} rows
                      </strong>
                    </div>
                    <div className="account-metric-item">
                      <small>Data Status</small>
                      <Badge tone={account.tone}>{account.status}</Badge>
                    </div>
                  </div>

                  <div className="account-footer">
                    <span className="account-last-sync">
                      <Icon name="calendar" size={13} /> {account.lastSynced}
                    </span>
                    <a
                      href={`/uploads?account=${encodeURIComponent(account.name)}`}
                      className="btn secondary"
                      style={{ fontSize: 11, padding: "4px 10px", height: "auto", textDecoration: "none" }}
                      title={`Open uploads for ${account.name}`}
                    >
                      View uploads →
                    </a>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* -------------------- TAB 6: CLAIM TEMPLATES -------------------- */}
      {tab === "Claim templates" && <ClaimTemplatesTab />}

      {/* -------------------- TAB 7: SYSTEM & RESEND EMAIL REPORTS -------------------- */}
      {tab === "System" && (
        <section className="panel admin-panel">
          <div className="panel-head">
            <div>
              <h2>System status & operational reports</h2>
              <p>PostgreSQL connectivity, Resend automated email delivery schedules and device session security settings</p>
            </div>
          </div>

          {/* System Status Highlights */}
          <div className="system-list">
            {system.map((item) => (
              <div key={item.title}>
                <Icon name="check" />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </span>
                <Badge tone={item.tone}>{item.status}</Badge>
              </div>
            ))}
          </div>

          {/* Resend Automated Reports Configuration */}
          <div className="report-admin-card" style={{ marginTop: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16 }}>Resend Automated Operational Reports</h3>
                <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 12 }}>
                  Sender: <strong>{reportsConfig?.sender || "return.scan@youthnic.shop"}</strong> · Timezone: <strong>Asia/Kolkata (IST)</strong>
                </p>
              </div>
              <Badge tone={reportsConfig?.dailyEnabled || reportsConfig?.weeklyEnabled ? "success" : "neutral"}>
                {reportsConfig?.dailyEnabled || reportsConfig?.weeklyEnabled ? "Active & Scheduled" : "Disabled"}
              </Badge>
            </div>

            {reportsNotice && <div className="form-success">{reportsNotice}</div>}
            {reportsError && <div className="form-error">{reportsError}</div>}

            {reportsConfig && (
              <form onSubmit={saveReportsConfig} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div className="report-schedule-grid">
                  {/* Daily Report */}
                  <div className="schedule-card">
                    <div className="schedule-card-head">
                      <strong>Daily Operations Report</strong>
                      <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={reportsConfig.dailyEnabled}
                          onChange={(e) => setReportsConfig({ ...reportsConfig, dailyEnabled: e.target.checked })}
                        />
                        <span style={{ fontSize: 12, fontWeight: 600 }}>Enabled</span>
                      </label>
                    </div>
                    <p style={{ margin: 0, fontSize: 12, color: "#64748b" }}>
                      Sends total scans, physical quantities, clear vs issue rates, channel breakdown and operator productivity.
                    </p>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                      <span style={{ fontWeight: 600, color: "#334155" }}>Delivery Time (IST):</span>
                      <input
                        type="time"
                        value={reportsConfig.dailyTime}
                        onChange={(e) => setReportsConfig({ ...reportsConfig, dailyTime: e.target.value })}
                        style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line)" }}
                      />
                    </label>
                  </div>

                  {/* Weekly Report */}
                  <div className="schedule-card">
                    <div className="schedule-card-head">
                      <strong>Weekly Management Report</strong>
                      <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={reportsConfig.weeklyEnabled}
                          onChange={(e) => setReportsConfig({ ...reportsConfig, weeklyEnabled: e.target.checked })}
                        />
                        <span style={{ fontSize: 12, fontWeight: 600 }}>Enabled</span>
                      </label>
                    </div>
                    <p style={{ margin: 0, fontSize: 12, color: "#64748b" }}>
                      Covers Monday–Sunday period. Includes daily volume trends, issue categories, and prior-week comparisons.
                    </p>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                      <span style={{ fontWeight: 600, color: "#334155" }}>Monday Delivery (IST):</span>
                      <input
                        type="time"
                        value={reportsConfig.weeklyTime}
                        onChange={(e) => setReportsConfig({ ...reportsConfig, weeklyTime: e.target.value })}
                        style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line)" }}
                      />
                    </label>
                  </div>
                </div>

                {/* Recipient list */}
                <div>
                  <strong style={{ fontSize: 13, color: "#1e293b" }}>Authorized Report Recipients</strong>
                  <p style={{ margin: "2px 0 8px", fontSize: 12, color: "#64748b" }}>
                    Active Admins and Supervisors configured to receive automated reports.
                  </p>
                  <div className="recipient-tags">
                    {reportsConfig.recipientEmails.map((email) => (
                      <span className="recipient-tag" key={email}>
                        {email}
                        <button type="button" onClick={() => removeReportRecipient(email)} title="Remove recipient">
                          ×
                        </button>
                      </span>
                    ))}
                    {reportsConfig.recipientEmails.length === 0 && (
                      <span style={{ fontSize: 12, color: "#94a3b8" }}>
                        No override emails added. Defaults to all active Admin/Supervisor users marked in Team members.
                      </span>
                    )}
                  </div>

                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <input
                      type="email"
                      placeholder="Add authorized recipient email..."
                      value={newRecipient}
                      onChange={(e) => setNewRecipient(e.target.value)}
                      style={{ maxWidth: 300, height: 34, padding: "0 10px", borderRadius: 6, border: "1px solid var(--line)" }}
                    />
                    <button type="button" className="btn secondary" onClick={addReportRecipient} disabled={!newRecipient.trim()}>
                      + Add
                    </button>
                  </div>
                </div>

                <button className="btn primary" type="submit" disabled={savingReports} style={{ alignSelf: "flex-start" }}>
                  {savingReports ? "Saving..." : "Save report schedule & recipients"}
                </button>
              </form>
            )}

            {/* Test Report Section */}
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
              <strong style={{ fontSize: 13, color: "#1e293b" }}>Send Test Report (Admin only)</strong>
              <p style={{ margin: "2px 0 10px", fontSize: 12, color: "#64748b" }}>
                Verify Resend delivery and inspect report format without waiting for the scheduled delivery time.
              </p>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <select
                  value={testReportType}
                  onChange={(e) => setTestReportType(e.target.value as "daily" | "weekly")}
                  style={{ height: 36, borderRadius: 6, border: "1px solid var(--line)" }}
                >
                  <option value="daily">Daily report preview</option>
                  <option value="weekly">Weekly report preview</option>
                </select>

                <input
                  type="email"
                  placeholder="Target test email (leave blank for yourself)"
                  value={testEmailTarget}
                  onChange={(e) => setTestEmailTarget(e.target.value)}
                  style={{ minWidth: 260, height: 36, padding: "0 10px", borderRadius: 6, border: "1px solid var(--line)" }}
                />

                <button className="btn secondary" type="button" onClick={() => void sendTestReportAction()} disabled={testReportBusy}>
                  {testReportBusy ? "Sending test..." : "Send test report now"}
                </button>
              </div>

              {testReportResult && (
                <div className="form-success" style={{ marginTop: 10 }}>
                  {testReportResult}
                </div>
              )}
            </div>

            {/* Recent Scheduled Report Runs History */}
            {reportHistory.length > 0 && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
                <strong style={{ fontSize: 13, color: "#1e293b" }}>Recent Report Delivery Log</strong>
                <DataTable
                  columns={[
                    { key: "key", header: "Period Key", render: (r) => <strong>{r.periodKey}</strong> },
                    { key: "type", header: "Type", render: (r) => <Badge tone="neutral">{r.type.toUpperCase()}</Badge> },
                    {
                      key: "status",
                      header: "Status",
                      render: (r) => (
                        <Badge tone={r.status === "sent" ? "success" : r.status === "failed" ? "danger" : "warning"}>
                          {r.status}
                        </Badge>
                      ),
                    },
                    { key: "sentAt", header: "Sent (IST)", render: (r) => r.sentAt || r.createdAt },
                    { key: "recipients", header: "Recipients", render: (r) => `${r.recipients.length} recipients` },
                    { key: "error", header: "Details", render: (r) => r.error ? <span style={{ color: "#dc2626" }}>{r.error}</span> : "Success" },
                  ]}
                  rows={reportHistory}
                  rowKey={(r) => String(r.id)}
                />
              </div>
            )}
          </div>

          {/* Sales & Payment Database Synchronization */}
          <div className="report-admin-card" style={{ marginTop: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16 }}>Sales & Order Payment Sync (PAYMENT_DATABASE_URL)</h3>
                <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 12 }}>
                  Fetches verified sale amounts for scanned returns across all marketplaces · Scheduled nightly at <strong>04:30 AM IST</strong>
                </p>
              </div>
              <Badge tone={paymentState?.configured ? "success" : "neutral"}>
                {paymentState?.configured ? "Database Connected & Active" : "PAYMENT_DATABASE_URL Pending"}
              </Badge>
            </div>

            {paymentNotice && <div className="form-success" style={{ marginTop: 12 }}>{paymentNotice}</div>}
            {paymentError && <div className="form-error" style={{ marginTop: 12 }}>{paymentError}</div>}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginTop: 16 }}>
              <div style={{ background: "#f8fafc", padding: "12px 16px", borderRadius: 8, border: "1px solid var(--line)" }}>
                <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>AWAITING PAYMENT SYNC</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: (paymentState?.pendingCount ?? 0) > 0 ? "#d97706" : "#0f6b56" }}>
                  {(paymentState?.pendingCount ?? 0).toLocaleString()}
                </div>
                <small style={{ color: "#94a3b8" }}>Scanned items missing sale amount</small>
              </div>

              <div style={{ background: "#f8fafc", padding: "12px 16px", borderRadius: 8, border: "1px solid var(--line)" }}>
                <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>SYNCED SALE AMOUNTS</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: "#0f6b56" }}>
                  {(paymentState?.syncedCount ?? 0).toLocaleString()}
                </div>
                <small style={{ color: "#94a3b8" }}>Scanned items with verified amount</small>
              </div>

              <div style={{ background: "#f8fafc", padding: "12px 16px", borderRadius: 8, border: "1px solid var(--line)" }}>
                <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>SCHEDULED CRON</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#1e293b", marginTop: 4 }}>
                  04:30 AM IST
                </div>
                <small style={{ color: "#94a3b8" }}>Twice-weekly check & nightly cron</small>
              </div>
            </div>

            {paymentState?.lastRun && (
              <div style={{ marginTop: 14, padding: "10px 14px", background: "#f1f5f9", borderRadius: 6, fontSize: 12, color: "#334155" }}>
                <strong>Last Sync Run:</strong> {new Date(paymentState.lastRun.startedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST ·{" "}
                Status: <strong style={{ color: paymentState.lastRun.status === "success" ? "#0f6b56" : "#dc2626" }}>{paymentState.lastRun.status.toUpperCase()}</strong> ·{" "}
                Checked: {paymentState.lastRun.checked} · Matched: {paymentState.lastRun.matched} ·{" "}
                Total Amount: ₹{paymentState.lastRun.totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                {paymentState.lastRun.error && <span style={{ color: "#dc2626", marginLeft: 8 }}>({paymentState.lastRun.error})</span>}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center" }}>
              <button
                type="button"
                className="btn primary"
                onClick={() => void triggerPaymentSync(false)}
                disabled={syncingPayment || !paymentState?.configured}
                title={paymentState?.configured ? "Trigger payment sync now" : "Configure PAYMENT_DATABASE_URL in .env to enable sync"}
              >
                {syncingPayment ? "Syncing from Payment DB..." : "⚡ Sync Payment Amounts Now"}
              </button>

              <button
                type="button"
                className="btn secondary"
                onClick={() => void triggerPaymentSync(true)}
                disabled={syncingPayment || !paymentState?.configured}
                title="Re-check all items, even previously synced"
              >
                Force Refresh All
              </button>
            </div>
          </div>

          {/* Persistent Device Login & Security Settings */}
          {sessionConfig && (
            <div className="report-admin-card">
              <h3 style={{ margin: 0, fontSize: 16 }}>Warehouse Device Persistent Login Security</h3>
              <p style={{ margin: "4px 0 12px", color: "#64748b", fontSize: 12 }}>
                Configure session lifetimes for trusted warehouse workstations and mobile devices.
              </p>

              {sessionConfigNotice && <div className="form-success">{sessionConfigNotice}</div>}

              <form onSubmit={saveSessionConfig} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                  <span style={{ fontWeight: 600 }}>Remembered device duration (days)</span>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={sessionConfig.rememberDurationDays}
                    onChange={(e) => setSessionConfig({ ...sessionConfig, rememberDurationDays: Number(e.target.value) })}
                    style={{ height: 34, padding: "0 8px", borderRadius: 6, border: "1px solid var(--line)" }}
                  />
                  <small style={{ color: "#64748b" }}>Max 60 days (default: 30 days)</small>
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                  <span style={{ fontWeight: 600 }}>Remembered idle timeout (days)</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={sessionConfig.rememberIdleDays}
                    onChange={(e) => setSessionConfig({ ...sessionConfig, rememberIdleDays: Number(e.target.value) })}
                    style={{ height: 34, padding: "0 8px", borderRadius: 6, border: "1px solid var(--line)" }}
                  />
                  <small style={{ color: "#64748b" }}>Inactivity logout limit (default: 7 days)</small>
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                  <span style={{ fontWeight: 600 }}>Standard session duration (hours)</span>
                  <input
                    type="number"
                    min={1}
                    max={72}
                    value={sessionConfig.standardDurationHours}
                    onChange={(e) => setSessionConfig({ ...sessionConfig, standardDurationHours: Number(e.target.value) })}
                    style={{ height: 34, padding: "0 8px", borderRadius: 6, border: "1px solid var(--line)" }}
                  />
                  <small style={{ color: "#64748b" }}>Non-remembered logins (default: 24h)</small>
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                  <span style={{ fontWeight: 600 }}>Standard idle timeout (hours)</span>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={sessionConfig.standardIdleHours}
                    onChange={(e) => setSessionConfig({ ...sessionConfig, standardIdleHours: Number(e.target.value) })}
                    style={{ height: 34, padding: "0 8px", borderRadius: 6, border: "1px solid var(--line)" }}
                  />
                  <small style={{ color: "#64748b" }}>Non-remembered idle (default: 4h)</small>
                </label>

                <div style={{ gridColumn: "1 / -1" }}>
                  <button className="btn primary" type="submit" disabled={savingSessionConfig}>
                    {savingSessionConfig ? "Saving..." : "Update session lifetimes"}
                  </button>
                </div>
              </form>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

// ---- Claim templates tab ----

type ClaimTemplateFieldDTO = {
  id: number
  fieldKey: string
  fieldLabel: string
  fieldType: string
  required: boolean
  minCount: number
  maxCount: number
  maxFileSizeMb: number
  sortOrder: number
  active: boolean
}

type ClaimTemplateDTO = {
  id: number
  marketplaceId: number | null
  marketplaceName: string
  name: string
  description: string
  active: boolean
  sortOrder: number
  fields: ClaimTemplateFieldDTO[]
}

function ClaimTemplatesTab() {
  const [templates, setTemplates] = useState<ClaimTemplateDTO[]>([])
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")
  const [newMarketplace, setNewMarketplace] = useState("")
  const [creating, setCreating] = useState(false)
  const [createFormError, setCreateFormError] = useState("")

  // Field creation state
  const [fieldDrafts, setFieldDrafts] = useState<Record<number, { key: string; label: string; type: string; required: boolean; min: number; max: number; maxMb: number }>>({})
  const [fieldErrors, setFieldErrors] = useState<Record<number, string>>({})

  const load = () => {
    setLoading(true)
    Promise.all([
      api<{ templates: ClaimTemplateDTO[] }>("/api/claims/templates"),
      api<{ accounts: AccountRow[] }>("/api/admin/accounts"),
    ])
      .then(([tplData, acctData]) => {
        setTemplates(tplData.templates)
        setAccounts(acctData.accounts)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const createTemplate = async () => {
    setCreating(true)
    setCreateFormError("")
    try {
      const body: Record<string, unknown> = { name: newName, description: newDescription }
      if (newMarketplace) body.marketplaceId = Number(newMarketplace)
      await api("/api/admin/claims/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      setNewName("")
      setNewDescription("")
      setNewMarketplace("")
      load()
    } catch (err) {
      setCreateFormError(err instanceof Error ? err.message : "Failed to create template")
    } finally {
      setCreating(false)
    }
  }

  const toggleActive = async (tpl: ClaimTemplateDTO) => {
    try {
      await api(`/api/admin/claims/templates/${tpl.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !tpl.active }),
      })
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update template")
    }
  }

  const addField = async (templateId: number) => {
    const draft = fieldDrafts[templateId]
    if (!draft || !draft.key.trim() || !draft.label.trim()) return
    setFieldErrors({ ...fieldErrors, [templateId]: "" })
    try {
      await api(`/api/admin/claims/templates/${templateId}/fields`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fieldKey: draft.key,
          fieldLabel: draft.label,
          fieldType: draft.type,
          required: draft.required,
          minCount: draft.min,
          maxCount: draft.max,
          maxFileSizeMb: draft.maxMb,
        }),
      })
      setFieldDrafts({ ...fieldDrafts, [templateId]: { key: "", label: "", type: "image", required: true, min: 1, max: 10, maxMb: 25 } })
      load()
    } catch (err) {
      setFieldErrors({ ...fieldErrors, [templateId]: err instanceof Error ? err.message : "Failed to add field" })
    }
  }

  const deactivateField = async (fieldId: number, templateId: number) => {
    try {
      await api(`/api/admin/claims/template-fields/${fieldId}/deactivate`, { method: "PATCH" })
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to deactivate field")
    }
  }

  if (loading) return <p className="boot-copy">Loading claim templates…</p>
  if (error) return <div className="form-error page-error">{error}</div>

  return (
    <section className="panel admin-panel">
      <div className="panel-head">
        <div>
          <h2>Claim templates ({templates.length})</h2>
          <p>Configurable marketplace claim evidence templates. Editable; no code-level rules.</p>
        </div>
      </div>

      {/* Create new template */}
      <div style={{ padding: 16, borderBottom: "1px solid var(--line)" }}>
        <h4 style={{ margin: "0 0 8px" }}>Create template</h4>
        {createFormError && <div className="form-error" style={{ marginBottom: 8 }}>{createFormError}</div>}
        <div className="filter-row">
          <input
            type="text"
            placeholder="Template name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={120}
            style={{ flex: 1 }}
          />
          <select value={newMarketplace} onChange={(e) => setNewMarketplace(e.target.value)}>
            <option value="">All marketplaces</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Description (optional)"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn primary" disabled={!newName.trim() || creating} onClick={createTemplate}>
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </div>

      {/* Template list */}
      <div style={{ padding: 16 }}>
        {templates.length === 0 ? (
          <p className="muted">No claim templates configured. Create one above.</p>
        ) : (
          <div className="account-grid-v2">
            {templates.map((tpl) => (
              <div className="account-card-v2" key={tpl.id}>
                <div className="account-card-header">
                  <div>
                    <h4>{tpl.name}</h4>
                    <p style={{ fontSize: 11, color: "#64748b" }}>{tpl.marketplaceName}</p>
                  </div>
                  <Badge tone={tpl.active ? "success" : "neutral"}>{tpl.active ? "Active" : "Inactive"}</Badge>
                </div>
                {tpl.description && <p style={{ fontSize: 12, color: "#475569", margin: "4px 0 8px" }}>{tpl.description}</p>}

                {/* Fields */}
                <div style={{ marginTop: 8 }}>
                  <strong style={{ fontSize: 11, textTransform: "uppercase", color: "#64748b" }}>Fields</strong>
                  {tpl.fields.length === 0 ? (
                    <p className="muted" style={{ fontSize: 12 }}>No fields defined.</p>
                  ) : (
                    <table className="media-table" style={{ marginTop: 6 }}>
                      <thead>
                        <tr>
                          <th>Key</th>
                          <th>Label</th>
                          <th>Type</th>
                          <th>Required</th>
                          <th>Limits</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {tpl.fields.map((f) => (
                          <tr key={f.id} className={f.active ? "" : "inactive"}>
                            <td>{f.fieldKey}</td>
                            <td>{f.fieldLabel}</td>
                            <td>{f.fieldType}</td>
                            <td>{f.required ? "Yes" : "No"}</td>
                            <td>{f.minCount}-{f.maxCount} files, {f.maxFileSizeMb} MB each</td>
                            <td>
                              {f.active && (
                                <button className="btn secondary small" onClick={() => deactivateField(f.id, tpl.id)}>
                                  Deactivate
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Add field */}
                <div style={{ marginTop: 8, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
                  {fieldErrors[tpl.id] && <div className="form-error" style={{ marginBottom: 4 }}>{fieldErrors[tpl.id]}</div>}
                  <div className="filter-row" style={{ flexWrap: "wrap", gap: 4 }}>
                    <input
                      type="text"
                      placeholder="field_key"
                      value={fieldDrafts[tpl.id]?.key || ""}
                      onChange={(e) => setFieldDrafts({
                        ...fieldDrafts,
                        [tpl.id]: { ...(fieldDrafts[tpl.id] || { key: "", label: "", type: "image", required: true, min: 1, max: 10, maxMb: 25 }), key: e.target.value },
                      })}
                      style={{ width: 120 }}
                    />
                    <input
                      type="text"
                      placeholder="Field label"
                      value={fieldDrafts[tpl.id]?.label || ""}
                      onChange={(e) => setFieldDrafts({
                        ...fieldDrafts,
                        [tpl.id]: { ...(fieldDrafts[tpl.id] || { key: "", label: "", type: "image", required: true, min: 1, max: 10, maxMb: 25 }), label: e.target.value },
                      })}
                      style={{ width: 120 }}
                    />
                    <select
                      value={fieldDrafts[tpl.id]?.type || "image"}
                      onChange={(e) => setFieldDrafts({
                        ...fieldDrafts,
                        [tpl.id]: { ...(fieldDrafts[tpl.id] || { key: "", label: "", type: "image", required: true, min: 1, max: 10, maxMb: 25 }), type: e.target.value },
                      })}
                      style={{ width: 90 }}
                    >
                      <option value="image">Image</option>
                      <option value="video">Video</option>
                      <option value="document">Document</option>
                    </select>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={fieldDrafts[tpl.id]?.required ?? true}
                        onChange={(e) => setFieldDrafts({
                          ...fieldDrafts,
                          [tpl.id]: { ...(fieldDrafts[tpl.id] || { key: "", label: "", type: "image", required: true, min: 1, max: 10, maxMb: 25 }), required: e.target.checked },
                        })}
                      />
                      Required
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={20}
                      title="Minimum required files"
                      value={fieldDrafts[tpl.id]?.min ?? 1}
                      onChange={(e) => setFieldDrafts({
                        ...fieldDrafts,
                        [tpl.id]: { ...(fieldDrafts[tpl.id] || { key: "", label: "", type: "image", required: true, min: 1, max: 10, maxMb: 25 }), min: Number(e.target.value) },
                      })}
                      style={{ width: 64 }}
                    />
                    <input
                      type="number"
                      min={1}
                      max={20}
                      title="Maximum files"
                      value={fieldDrafts[tpl.id]?.max ?? 10}
                      onChange={(e) => setFieldDrafts({
                        ...fieldDrafts,
                        [tpl.id]: { ...(fieldDrafts[tpl.id] || { key: "", label: "", type: "image", required: true, min: 1, max: 10, maxMb: 25 }), max: Number(e.target.value) },
                      })}
                      style={{ width: 64 }}
                    />
                    <input
                      type="number"
                      min={1}
                      max={100}
                      title="Maximum megabytes per file"
                      value={fieldDrafts[tpl.id]?.maxMb ?? 25}
                      onChange={(e) => setFieldDrafts({
                        ...fieldDrafts,
                        [tpl.id]: { ...(fieldDrafts[tpl.id] || { key: "", label: "", type: "image", required: true, min: 1, max: 10, maxMb: 25 }), maxMb: Number(e.target.value) },
                      })}
                      style={{ width: 70 }}
                    />
                    <button
                      className="btn secondary small"
                      disabled={!(fieldDrafts[tpl.id]?.key?.trim()) || !(fieldDrafts[tpl.id]?.label?.trim())}
                      onClick={() => addField(tpl.id)}
                    >
                      Add field
                    </button>
                  </div>
                </div>

                {/* Toggle active */}
                <div style={{ marginTop: 8 }}>
                  <button className="btn secondary small" onClick={() => toggleActive(tpl)}>
                    {tpl.active ? "Deactivate template" : "Activate template"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
