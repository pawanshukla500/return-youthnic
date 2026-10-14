import { type FormEvent, useCallback, useEffect, useRef, useState } from "react"
import { ApiError, api } from "../api"
import type {
  AccountOption,
  IssueCategory,
  LookupCandidate,
  LookupItem,
  LookupResponse,
  LookupShipment,
  ScanReceipt,
  ShiftCard,
  SubIssue,
} from "../types"
import { Badge, Icon, Modal, PartnerBadge } from "../ui"
import { LiveSyncBadge, useLiveChanges } from "../live"
import { useWorkspace } from "../workspace"

// Only absolute http(s) links are shown. The app fetches and caches them, so a marketplace
// link renders on this screen without the browser asking the marketplace again.
function isImageUrl(value: string) {
  return /^https?:\/\//i.test(value)
}

function catalogImageSrc(value: string) {
  if (!isImageUrl(value)) return ""
  return `/api/catalog-image?url=${encodeURIComponent(value)}`
}

// Labels for the server's match values. The server decides the match; these only name it for the scanner.
const MATCHED_FIELD_LABELS: Record<string, string> = {
  tracking_id: "Primary tracking ID",
  alt_tracking_id: "Alternate tracking ID",
  order_number: "Order ID (manual entry)",
}
const MATCHED_LEG_LABELS: Record<string, string> = {
  return: "Return leg",
  forward: "Forward leg",
  unknown: "Not known",
}
const TRACKING_SOURCE_LABELS: Record<string, string> = {
  return_tracking: "Return AWB (file column)",
  forward_tracking: "Forward AWB (return AWB blank)",
  tracking_id: "Tracking ID (file column)",
  tracking_url: "Tracking link (verified)",
}

type IssueForm = {
  uid: string
  categoryCode: string
  subIssueId: string
  qty: string
  ticketCode: string
  notes: string
}

type LineForm = {
  verified: boolean
  // The text typed in the box. Empty until the employee enters it, so nothing is assumed.
  received: string
  issues: IssueForm[]
}

let issueCounter = 0
function nextUid(): string {
  issueCounter += 1
  return `issue-${issueCounter}`
}

// The garment size in a SKU, for the size chip. The same tokens as extractGarmentSize on the server.
const SIZE_TOKENS: Record<string, string> = {
  xs: "XS", s: "S", m: "M", l: "L", xl: "XL", xxl: "XXL", "2xl": "XXL", "3xl": "3XL", xxxl: "3XL", "4xl": "4XL", "5xl": "5XL", "6xl": "6XL",
}
export function sizeFromSku(...values: string[]): string {
  for (const value of values) {
    const text = String(value || "").trim()
    if (!text) continue
    if (/\b(free\s*size|freesize)\b/i.test(text)) return "Free Size"
    const match = text.match(/[_\-\s](xs|s|m|l|xl|xxl|2xl|3xl|xxxl|4xl|5xl|6xl)(?:[_\-\s]|$)/i)
    if (match) return SIZE_TOKENS[match[1].toLowerCase()] ?? ""
  }
  return ""
}

// The big result banner shown after every scan, so the result reads from across the bench.
type FeedbackTone = "ok" | "iron" | "issue" | "duplicate" | "notfound" | "error"
type ScanFeedback = {
  tone: FeedbackTone
  title: string
  awb: string
  detail: string
  sku: string
  size: string
  image: string
  at: number
}
type SessionOutcome = "clear" | "issue" | "iron"

const FEEDBACK_ICON: Record<FeedbackTone, "check" | "alert" | "search" | "iron"> = {
  ok: "check",
  iron: "iron",
  issue: "alert",
  duplicate: "alert",
  notfound: "search",
  error: "alert",
}

const IST_CLOCK = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "Asia/Kolkata" })

// Short names for the bench. The code and the stored label stay as they are.
const CHIP_LABEL: Record<string, string> = {
  no_issue: "Normal Return",
  iron_send: "Iron Send",
  damaged_product: "Damaged",
  missing_component: "Missing Item",
  wrong_product: "Wrong Product",
  sku_change: "SKU Change",
  size_change: "Size Change",
  other_issue: "Other",
}
const CHIP_ORDER = ["no_issue", "iron_send", "damaged_product", "wrong_product", "missing_component", "sku_change", "size_change", "other_issue"]

const FREQUENCY_STORAGE_KEY = "return_scan_issue_frequency"

// High baseline scores ensuring healthy initial order: No Issue 1st, Iron Send 2nd, Damaged 3rd, etc.
const BASELINE_FREQUENCIES: Record<string, number> = {
  no_issue: 100000,
  iron_send: 50000,
  damaged_product: 40000,
  wrong_product: 30000,
  missing_component: 20000,
  sku_change: 15000,
  size_change: 10000,
  other_issue: 5000,
}

export function getIssueFrequency(code: string): number {
  try {
    const raw = localStorage.getItem(FREQUENCY_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, number>
      if (typeof parsed[code] === "number") {
        return (BASELINE_FREQUENCIES[code] ?? 0) + parsed[code]
      }
    }
  } catch {}
  return BASELINE_FREQUENCIES[code] ?? 0
}

export function recordIssueUsage(code: string) {
  if (!code) return
  try {
    const raw = localStorage.getItem(FREQUENCY_STORAGE_KEY)
    const counts: Record<string, number> = raw ? JSON.parse(raw) : {}
    counts[code] = (counts[code] ?? 0) + 1
    localStorage.setItem(FREQUENCY_STORAGE_KEY, JSON.stringify(counts))
  } catch {}
}

export interface CategoryTheme {
  primary: string
  bgLight: string
  bgSelected: string
  textLight: string
  textSelected: string
  border: string
}

export const CATEGORY_THEMES: Record<string, CategoryTheme> = {
  no_issue: {
    primary: "#059669",
    bgLight: "#ecfdf5",
    bgSelected: "#059669",
    textLight: "#065f46",
    textSelected: "#ffffff",
    border: "#a7f3d0",
  },
  iron_send: {
    primary: "#2563eb",
    bgLight: "#eff6ff",
    bgSelected: "#2563eb",
    textLight: "#1d4ed8",
    textSelected: "#ffffff",
    border: "#bfdbfe",
  },
  damaged_product: {
    primary: "#dc2626",
    bgLight: "#fef2f2",
    bgSelected: "#dc2626",
    textLight: "#b91c1c",
    textSelected: "#ffffff",
    border: "#fecaca",
  },
  wrong_product: {
    primary: "#d97706",
    bgLight: "#fffbeb",
    bgSelected: "#d97706",
    textLight: "#b45309",
    textSelected: "#ffffff",
    border: "#fde68a",
  },
  missing_component: {
    primary: "#e11d48",
    bgLight: "#fff1f2",
    bgSelected: "#e11d48",
    textLight: "#be123c",
    textSelected: "#ffffff",
    border: "#fecdd3",
  },
  sku_change: {
    primary: "#7c3aed",
    bgLight: "#f5f3ff",
    bgSelected: "#7c3aed",
    textLight: "#6d28d9",
    textSelected: "#ffffff",
    border: "#ddd6fe",
  },
  size_change: {
    primary: "#0d9488",
    bgLight: "#f0fdfa",
    bgSelected: "#0d9488",
    textLight: "#0f766e",
    textSelected: "#ffffff",
    border: "#99f6e4",
  },
  other_issue: {
    primary: "#475569",
    bgLight: "#f8fafc",
    bgSelected: "#475569",
    textLight: "#334155",
    textSelected: "#ffffff",
    border: "#cbd5e1",
  },
}

export function getCategoryTheme(code: string): CategoryTheme {
  return (
    CATEGORY_THEMES[code] ?? {
      primary: "#0284c7",
      bgLight: "#f0f9ff",
      bgSelected: "#0284c7",
      textLight: "#0369a1",
      textSelected: "#ffffff",
      border: "#bae6fd",
    }
  )
}

function chipLabel(category: IssueCategory): string {
  return CHIP_LABEL[category.code] ?? category.label
}

function orderedCategories(categories: IssueCategory[]): IssueCategory[] {
  return [...categories].sort((a, b) => {
    // Clear / No Issue is always the first choice
    if (a.isClear && !b.isClear) return -1
    if (!a.isClear && b.isClear) return 1
    const freqA = getIssueFrequency(a.code)
    const freqB = getIssueFrequency(b.code)
    if (freqB !== freqA) return freqB - freqA
    const rankA = CHIP_ORDER.indexOf(a.code)
    const rankB = CHIP_ORDER.indexOf(b.code)
    const orderA = rankA === -1 ? CHIP_ORDER.length : rankA
    const orderB = rankB === -1 ? CHIP_ORDER.length : rankB
    if (orderA !== orderB) return orderA - orderB
    return a.label.localeCompare(b.label)
  })
}

function normalLines(shipment: LookupShipment): Record<number, LineForm> {
  const ready: Record<number, LineForm> = {}
  for (const item of shipment.items) {
    ready[item.itemId] = { verified: true, received: String(item.expectedQty), issues: [] }
  }
  return ready
}

function issueReady(ready: Record<number, LineForm>, categories: IssueCategory[]): boolean {
  const issues = Object.values(ready).flatMap((line) => line.issues)
  if (issues.length === 0) return false
  return issues.every((issue) => {
    const category = categories.find((entry) => entry.code === issue.categoryCode)
    if (!category) return false
    if (category.requiresSubIssue && !issue.subIssueId) return false
    if (category.requiresTicket && !issue.ticketCode.trim()) return false
    return true
  })
}

function freshLines(shipment: LookupShipment): Record<number, LineForm> {
  const lines: Record<number, LineForm> = {}
  for (const item of shipment.items) lines[item.itemId] = { verified: false, received: "", issues: [] }
  return lines
}

// The same rules the server applies, for the messages shown while typing. The server decides on save.
function linePlan(item: LookupItem, line: LineForm, categories: IssueCategory[]): { problems: string[]; missing: number } {
  const label = `Item ${item.marketplaceSku || item.itemId}`
  const problems: string[] = []
  const received = Number(line.received)
  if (line.received === "" || !Number.isInteger(received) || received < 0 || received > item.expectedQty) {
    problems.push(`${label}: enter the received quantity, from 0 to ${item.expectedQty}.`)
    return { problems, missing: 0 }
  }
  if (!line.verified) problems.push(`${label}: tick the physical check.`)
  const missing = item.expectedQty - received
  let missingQty = 0
  let otherQty = 0
  for (const issue of line.issues) {
    const category = categories.find((entry) => entry.code === issue.categoryCode)
    const qty = Number(issue.qty)
    if (!category) {
      problems.push(`${label}: choose an issue category.`)
      continue
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > item.expectedQty) {
      problems.push(`${label}: ${category.label} needs a quantity from 1 to ${item.expectedQty}.`)
      continue
    }
    if (category.requiresSubIssue && !issue.subIssueId) problems.push(`${label}: choose what is missing.`)
    if (category.requiresTicket && !issue.ticketCode.trim()) problems.push(`${label}: ${category.label} needs a ticket ID.`)
    if (category.isMissing) missingQty += qty
    else otherQty += qty
  }
  if (missingQty !== missing) {
    problems.push(`${label}: ${missing} unit(s) not received, and the missing-item issues cover ${missingQty}.`)
  }
  if (otherQty > received) {
    problems.push(`${label}: other issues cover ${otherQty} unit(s), which is more than the ${received} received.`)
  }
  return { problems, missing }
}

function playScanChime(type: "success" | "issue" | "error" | "iron" = "success") {
  try {
    const AudioContextClass =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return
    const ctx = new AudioContextClass()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    if (type === "success") {
      osc.frequency.setValueAtTime(587.33, ctx.currentTime)
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08)
      gain.gain.setValueAtTime(0.18, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.25)
    } else if (type === "iron") {
      // Two short equal beeps: saved, and set aside for ironing.
      osc.frequency.setValueAtTime(660, ctx.currentTime)
      gain.gain.setValueAtTime(0.18, ctx.currentTime)
      gain.gain.setValueAtTime(0.001, ctx.currentTime + 0.09)
      gain.gain.setValueAtTime(0.18, ctx.currentTime + 0.14)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.26)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.27)
    } else if (type === "issue") {
      osc.frequency.setValueAtTime(440, ctx.currentTime)
      osc.frequency.setValueAtTime(349.23, ctx.currentTime + 0.1)
      gain.gain.setValueAtTime(0.2, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.3)
    } else {
      osc.frequency.setValueAtTime(220, ctx.currentTime)
      gain.gain.setValueAtTime(0.25, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.25)
    }
  } catch {
    // AudioContext ignored
  }
}

export type ScannerState =
  | "READY"
  | "LOOKUP"
  | "VERIFYING"
  | "SAVING"
  | "SAVED"
  | "LOOKUP_ERROR"
  | "SAVE_ERROR"
  | "DUPLICATE"
  | "AMBIGUOUS_MATCH"

const STATE_LABELS: Record<ScannerState, string> = {
  READY: "Ready to scan",
  LOOKUP: "Looking up AWB...",
  VERIFYING: "Verifying parcel",
  SAVING: "Saving scan...",
  SAVED: "Saved to database",
  LOOKUP_ERROR: "Lookup error",
  SAVE_ERROR: "Save failed — Retry",
  DUPLICATE: "Duplicate scan",
  AMBIGUOUS_MATCH: "Choose account",
}

function accountColorDot(accName: string): string {
  const lower = accName.toLowerCase()
  if (lower.includes("amazon")) return "#f59e0b"
  if (lower.includes("flipkart")) return "#2563eb"
  if (lower.includes("meesho")) return "#db2777"
  if (lower.includes("myntra")) return "#e11d48"
  if (lower.includes("ajio")) return "#0d9488"
  if (lower.includes("shopify")) return "#10b981"
  return "#136c57"
}

export function ScanReturns() {
  const { openPage, setClaimsBadge, user } = useWorkspace()
  const [scannerState, setScannerState] = useState<ScannerState>("READY")
  const scannerStateRef = useRef<ScannerState>("READY")
  scannerStateRef.current = scannerState

  const [scanQueue, setScanQueue] = useState<string[]>([])
  const scanQueueRef = useRef<string[]>([])
  scanQueueRef.current = scanQueue

  const scannerBufferRef = useRef<{ text: string; lastTime: number }>({ text: "", lastTime: 0 })

  const [tracking, setTracking] = useState("")
  // The AWB the employee scanned, normalized the same way the server normalizes it. It is sent with the save, so the
  // scan records which AWB was read.
  const [scannedAwb, setScannedAwb] = useState("")
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [marketplace, setMarketplace] = useState("Auto detect")
  const [response, setResponse] = useState<LookupResponse | null>(null)
  const [shipment, setShipment] = useState<LookupShipment | null>(null)
  const [lines, setLines] = useState<Record<number, LineForm>>({})
  const [clientKey, setClientKey] = useState("")
  const [notes, setNotes] = useState("")
  const [error, setError] = useState("")
  const [errorDetails, setErrorDetails] = useState<string[]>([])
  const [notice, setNotice] = useState("")
  const [receipt, setReceipt] = useState<ScanReceipt | null>(null)
  const [savedScanId, setSavedScanId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [issueRecorded, setIssueRecorded] = useState(false)
  const [multiOpen, setMultiOpen] = useState(false)
  const [verifyModalOpen, setVerifyModalOpen] = useState(false)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [continuousMode, setContinuousMode] = useState<boolean>(() => {
    return localStorage.getItem("scanner_continuous_mode") !== "false"
  })
  const [isInputFocused, setIsInputFocused] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {})
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {})
    }
  }

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener("fullscreenchange", handleFsChange)
    return () => document.removeEventListener("fullscreenchange", handleFsChange)
  }, [])

  const [videoRecordingEnabled, setVideoRecordingEnabled] = useState<boolean>(() => {
    return localStorage.getItem("scanner_video_recording_enabled") === "true"
  })
  const [shift, setShift] = useState<ShiftCard | null>(null)
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null)
  // This workstation's session: scans saved here, by their latest outcome, and lookups that found nothing or a duplicate.
  const [sessionOutcomes, setSessionOutcomes] = useState<Record<number, SessionOutcome>>({})
  const [sessionMisses, setSessionMisses] = useState({ notFound: 0, duplicate: 0 })
  const [remoteSaved, setRemoteSaved] = useState("")
  const [categories, setCategories] = useState<IssueCategory[]>([])
  const [subIssues, setSubIssues] = useState<SubIssue[]>([])
  const [previewOpen, setPreviewOpen] = useState(false)
  const [brokenImage, setBrokenImage] = useState("")
  const [activeItem, setActiveItem] = useState(0)

  const scanInput = useRef<HTMLInputElement>(null)
  const multiTimer = useRef<number | null>(null)
  const benchRef = useRef<{ key: string; corrected: boolean } | null>(null)
  const pendingLines = useRef<Record<number, LineForm> | null>(null)
  const saveFlight = useRef<Promise<void> | null>(null)
  const categoriesRef = useRef(categories)
  categoriesRef.current = categories
  const videoElement = useRef<HTMLVideoElement>(null)
  const cameraStream = useRef<MediaStream | null>(null)
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const recordingChunks = useRef<Blob[]>([])
  const activeEvidenceAwb = useRef("")
  const lastVideoUrlRef = useRef("")
  // True when the recording for the current return produced a video. Read when that return is saved.
  const videoReadyRef = useRef(false)
  // Resolves a pending stop request once the recorder has written its last chunk.
  const stopResolver = useRef<((hasVideo: boolean) => void) | null>(null)
  const [cameraStatus, setCameraStatus] = useState<"idle" | "connecting" | "ready" | "recording" | "error">("idle")
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [capturedImages, setCapturedImages] = useState<string[]>([])
  const [lastVideoUrl, setLastVideoUrl] = useState("")
  const [lastEvidenceAwb, setLastEvidenceAwb] = useState("")
  const [savedEvidenceCount, setSavedEvidenceCount] = useState(0)

  // Focuses the barcode scan input only in safe states (READY, LOOKUP_ERROR, DUPLICATE).
  // Never steals focus while user is in VERIFYING, SAVING, or SAVE_ERROR.
  const focusScanInput = useCallback(() => {
    const current = scannerStateRef.current
    if (current === "READY" || current === "LOOKUP_ERROR" || current === "DUPLICATE") {
      scanInput.current?.focus()
    }
  }, [])

  // Explicit state transition helper that manages state and restores scanner input focus when appropriate.
  const transitionTo = useCallback((nextState: ScannerState) => {
    scannerStateRef.current = nextState
    setScannerState(nextState)
    if (nextState === "READY" || nextState === "LOOKUP_ERROR" || nextState === "DUPLICATE") {
      window.requestAnimationFrame(() => {
        scanInput.current?.focus()
      })
    }
  }, [])

  // Controlled autofocus on page mount and when the window/tab regains focus.
  useEffect(() => {
    window.requestAnimationFrame(() => scanInput.current?.focus())
    const handleWindowFocus = () => {
      const current = scannerStateRef.current
      if (current === "READY" || current === "LOOKUP_ERROR" || current === "DUPLICATE") {
        scanInput.current?.focus()
      }
    }
    window.addEventListener("focus", handleWindowFocus)

    api<{ shift: ShiftCard; issueCategories: IssueCategory[]; subIssues: SubIssue[] }>("/api/scan/session")
      .then((data) => {
        setShift(data.shift)
        setCategories(data.issueCategories)
        setSubIssues(data.subIssues)
      })
      .catch((err: Error) => setError(err.message))
    // Only the accounts this user may use are offered. The server enforces this again on every lookup.
    api<{ accounts: AccountOption[] }>("/api/accounts")
      .then((data) => setAccounts(data.accounts))
      .catch((err: Error) => setError(err.message))

    return () => window.removeEventListener("focus", handleWindowFocus)
  }, [])

  // Live updates: scans saved on other workstations and phones refresh today's figures. If the parcel on screen was
  // saved somewhere else, say so before this bench saves it (the server refuses a second save in any case).
  const shipmentRef = useRef<LookupShipment | null>(null)
  shipmentRef.current = shipment
  const savedScanIdRef = useRef<number | null>(null)
  savedScanIdRef.current = savedScanId
  useLiveChanges((change) => {
    api<{ shift: ShiftCard }>("/api/scan/session")
      .then((data) => setShift(data.shift))
      .catch(() => {})
    const current = shipmentRef.current
    if (
      current &&
      change.shipmentId === current.shipmentId &&
      change.kind === "scan.saved" &&
      change.scanId !== savedScanIdRef.current &&
      change.actorId !== user.id
    ) {
      setRemoteSaved(`This return (${current.trackingId}) was just saved on another device. Scan the next parcel.`)
    }
  }, 300)

  // A click on an empty part of the page puts the cursor back in the scan box, so the bench never stays "not listening".
  useEffect(() => {
    const onPointerUp = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (!target || target.closest("input, textarea, select, button, a, label, [role='dialog'], .modal, video")) return
      if (window.getSelection()?.toString()) return
      focusScanInput()
    }
    document.addEventListener("pointerup", onPointerUp)
    return () => document.removeEventListener("pointerup", onPointerUp)
  }, [focusScanInput])

  // Focus watchdog: when the bench is idle and focus has drifted to a button or the page (after tapping an issue chip,
  // the sidebar, or switching windows), the cursor goes back to the scan box. Text fields, selects and open dialogs are
  // never interrupted.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hasFocus()) return
      const active = document.activeElement as HTMLElement | null
      if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return
      if (document.querySelector(".modal-backdrop")) return
      focusScanInput()
    }, 1000)
    return () => window.clearInterval(timer)
  }, [focusScanInput])

  useEffect(() => {
    if (cameraStatus !== "recording") return
    const timer = window.setInterval(() => setRecordingSeconds((seconds) => seconds + 1), 1000)
    return () => window.clearInterval(timer)
  }, [cameraStatus])

  useEffect(() => {
    return () => {
      if (mediaRecorder.current?.state === "recording") mediaRecorder.current.stop()
      cameraStream.current?.getTracks().forEach((track) => track.stop())
      if (lastVideoUrlRef.current) URL.revokeObjectURL(lastVideoUrlRef.current)
    }
  }, [])

  const connectCamera = async () => {
    setCameraStatus("connecting")
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      cameraStream.current = stream
      if (videoElement.current) {
        videoElement.current.srcObject = stream
        await videoElement.current.play()
      }
      setCameraStatus("ready")
      scanInput.current?.focus()
    } catch {
      setCameraStatus("error")
    }
  }

  // Stops the webcam. A recording in progress is finished first, so its video is kept.
  const disconnectCamera = async () => {
    await stopEvidenceRecording()
    cameraStream.current?.getTracks().forEach((track) => track.stop())
    cameraStream.current = null
    if (videoElement.current) videoElement.current.srcObject = null
    setCameraStatus("idle")
  }

  // Starts recording for one return. Uses refs, not React state, so it sees the current recorder.
  const startEvidenceRecording = (awb: string) => {
    if (!videoRecordingEnabled) return
    const stream = cameraStream.current
    if (!stream || !stream.active) return
    if (mediaRecorder.current?.state === "recording") return
    try {
      recordingChunks.current = []
      activeEvidenceAwb.current = awb
      videoReadyRef.current = false
      setRecordingSeconds(0)
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (event) => {
        if (event.data.size) recordingChunks.current.push(event.data)
      }
      recorder.onstop = () => {
        const videoBlob = new Blob(recordingChunks.current, { type: recorder.mimeType || "video/webm" })
        if (videoBlob.size) {
          videoReadyRef.current = true
          setLastVideoUrl((current) => {
            if (current) URL.revokeObjectURL(current)
            const nextUrl = URL.createObjectURL(videoBlob)
            lastVideoUrlRef.current = nextUrl
            return nextUrl
          })
          setLastEvidenceAwb(activeEvidenceAwb.current)
          setSavedEvidenceCount((count) => count + 1)
        }
        setCameraStatus("ready")
        setRecordingSeconds(0)
        const resolve = stopResolver.current
        stopResolver.current = null
        resolve?.(videoReadyRef.current)
      }
      mediaRecorder.current = recorder
      recorder.start(1000)
      setCameraStatus("recording")
    } catch {
      setCameraStatus("error")
    }
  }

  // Stops the current recording, if any. Resolves once the video is stored, with whether the current return has one.
  const stopEvidenceRecording = () =>
    new Promise<boolean>((resolve) => {
      const recorder = mediaRecorder.current
      if (!recorder || recorder.state !== "recording") {
        resolve(videoReadyRef.current)
        return
      }
      stopResolver.current = resolve
      recorder.stop()
    })

  const captureEvidenceImage = () => {
    const video = videoElement.current
    if (!video || !video.videoWidth) return
    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext("2d")?.drawImage(video, 0, 0)
    const image = canvas.toDataURL("image/jpeg", 0.86)
    setCapturedImages((images) => [...images, image].slice(-4))
  }

  const bodyFor = (
    target: LookupShipment,
    ready: Record<number, LineForm>,
    key: string,
    scanned: string,
    noteText: string,
  ) => ({
    shipmentId: target.shipmentId,
    clientScanKey: key,
    notes: noteText.trim(),
    scannedTracking: scanned || target.scannedTracking,
    photoCount: videoRecordingEnabled ? capturedImages.length : 0,
    hasVideo: videoRecordingEnabled && (mediaRecorder.current?.state === "recording" || videoReadyRef.current),
    items: target.items.map((item) => {
      const line = ready[item.itemId] ?? { verified: true, received: String(item.expectedQty), issues: [] }
      return {
        itemId: item.itemId,
        receivedQty: Number(line.received),
        verified: line.verified,
        issues: line.issues.map((issue) => ({
          categoryCode: issue.categoryCode,
          subIssueId: issue.subIssueId ? Number(issue.subIssueId) : null,
          qty: Number(issue.qty),
          ticketCode: issue.ticketCode.trim(),
          notes: issue.notes.trim(),
        })),
      }
    }),
  })

  const outcomeOf = (result: ScanReceipt): SessionOutcome =>
    result.issueCount > 0 ? "issue" : (result.ironSendQty ?? 0) > 0 ? "iron" : "clear"

  // Shows the result banner for a saved return and counts it in this session.
  const showSaved = (result: ScanReceipt, target: LookupShipment | null) => {
    const outcome = outcomeOf(result)
    setSessionOutcomes((current) => ({ ...current, [result.scan.id]: outcome }))
    const first = target?.items[0]
    setFeedback({
      tone: outcome === "issue" ? "issue" : outcome === "iron" ? "iron" : "ok",
      title:
        result.replayed
          ? "Already saved — nothing saved twice"
          : outcome === "issue"
            ? `Saved with ${result.issueCount} issue${result.issueCount === 1 ? "" : "s"}`
            : outcome === "iron"
              ? `Saved · ${result.ironSendQty} unit${result.ironSendQty === 1 ? "" : "s"} to Iron Send`
              : "Saved · normal return",
      awb: result.scan.scannedTracking || result.scan.trackingId,
      detail: `${result.scan.marketplace} · order ${result.scan.orderId || "—"} · ${result.itemCount} item${result.itemCount === 1 ? "" : "s"} · ${result.scan.timeLabel}`,
      sku: first ? first.productSku || first.marketplaceSku : "",
      size: first ? sizeFromSku(first.marketplaceSku, first.productSku, first.productName) : "",
      image: first ? catalogImageSrc(first.imageUrl) : "",
      at: Date.now(),
    })
  }

  const showProblem = (tone: FeedbackTone, title: string, awb: string, detail: string) => {
    if (tone === "notfound") setSessionMisses((current) => ({ ...current, notFound: current.notFound + 1 }))
    if (tone === "duplicate") setSessionMisses((current) => ({ ...current, duplicate: current.duplicate + 1 }))
    setFeedback({ tone, title, awb, detail, sku: "", size: "", image: "", at: Date.now() })
  }

  const applyReceipt = (result: ScanReceipt, corrected: boolean) => {
    setReceipt(result)
    setShift(result.shift)
    setClaimsBadge(result.claimsBadge)
    setSavedScanId(result.scan.id)
    setIssueRecorded(corrected)
    if (benchRef.current) benchRef.current.corrected = corrected
  }

  // Saves the matched return as a normal return, then applies an issue tap if one is waiting.
  const autoSave = async (target: LookupShipment, key: string, scanned: string) => {
    transitionTo("SAVING")
    setSaving(true)
    const flight = (async () => {
      try {
        const result = await api<ScanReceipt>("/api/scan/complete", {
          method: "POST",
          body: JSON.stringify(bodyFor(target, normalLines(target), key, scanned, "")),
        })
        benchRef.current = { key, corrected: false }
        applyReceipt(result, false)
        showSaved(result, target)
        const waiting = pendingLines.current
        if (waiting && issueReady(waiting, categoriesRef.current) && benchRef.current) {
          pendingLines.current = null
          const corrected = await api<ScanReceipt>("/api/scan/correct", {
            method: "POST",
            body: JSON.stringify(bodyFor(target, waiting, key, scanned, "")),
          })
          applyReceipt(corrected, true)
          showSaved(corrected, target)
          setNotice("Saved with the issue. Scan the next parcel, or change selection.")
        } else {
          setNotice(
            target.items.length > 1
              ? `Saved. This tracking ID has ${target.items.length} items.`
              : "Saved as a normal return. Scan the next parcel, or tap an issue if this one is not.",
          )
        }
        transitionTo("SAVED")

        if (scanQueueRef.current.length > 0) {
          const [nextBarcode, ...rest] = scanQueueRef.current
          setScanQueue(rest)
          scanQueueRef.current = rest
          setNotice(`Processing queued parcel ${nextBarcode} (${rest.length} remaining in buffer)`)
          void runLookup(nextBarcode, marketplace, null)
        } else {
          transitionTo("READY")
        }
      } catch (err) {
        benchRef.current = null
        setSavedScanId(null)
        if (err instanceof ApiError) {
          setErrorDetails(err.details)
          setError(err.message)
        } else {
          setError(err instanceof Error ? err.message : "Could not save this return")
        }
        if (soundEnabled) playScanChime("error")
        showProblem("error", "Not saved — retry", scanned || target.trackingId, err instanceof Error ? err.message : "Could not save this return")
        transitionTo("SAVE_ERROR")
      } finally {
        setSaving(false)
      }
    })()
    saveFlight.current = flight
    await flight
  }

  const recordIssue = async (target: LookupShipment, ready: Record<number, LineForm>) => {
    pendingLines.current = ready
    const hasAnyIssue = Object.values(ready).some((line) => line.issues.length > 0)
    if (hasAnyIssue && !issueReady(ready, categoriesRef.current)) return
    if (saveFlight.current) await saveFlight.current
    const bench = benchRef.current
    if (!bench) return
    pendingLines.current = null
    transitionTo("SAVING")
    setSaving(true)
    try {
      const corrected = await api<ScanReceipt>("/api/scan/correct", {
        method: "POST",
        body: JSON.stringify(bodyFor(target, ready, bench.key, scannedAwb || target.scannedTracking, notes)),
      })
      applyReceipt(corrected, hasAnyIssue)
      showSaved(corrected, target)
      if (soundEnabled) playScanChime(corrected.issueCount ? "issue" : (corrected.ironSendQty ?? 0) > 0 ? "iron" : "success")
      setIssueRecorded(hasAnyIssue)
      setNotice(
        hasAnyIssue
          ? "Issue saved. You can change selection or scan the next parcel."
          : "Saved as a normal return. Scan the next parcel, or tap an issue if this one is not.",
      )
      transitionTo("SAVED")
      if (scanQueueRef.current.length > 0) {
        const [nextBarcode, ...rest] = scanQueueRef.current
        setScanQueue(rest)
        scanQueueRef.current = rest
        setNotice(`Processing queued parcel ${nextBarcode} (${rest.length} remaining in buffer)`)
        void runLookup(nextBarcode, marketplace, null)
      } else {
        transitionTo("READY")
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorDetails(err.details)
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : "Could not save this issue")
      }
      transitionTo("SAVE_ERROR")
    } finally {
      setSaving(false)
    }
  }

  // Looks up a tracking ID. Single-item returns auto-save immediately with no popup.
  // Multi-SKU or Multi-Quantity returns open the verification modal so staff can inspect all pieces.
  const runLookup = async (value: string, account: string, shipmentId: number | null) => {
    if (saveFlight.current) {
      await saveFlight.current
    }
    transitionTo("LOOKUP")
    setError("")
    setErrorDetails([])
    setNotice("")
    setReceipt(null)
    setSavedScanId(null)
    setIssueRecorded(false)
    setMultiOpen(false)
    setRemoteSaved("")
    benchRef.current = null
    pendingLines.current = null
    const scanned = value.trim().toUpperCase()
    setScannedAwb(scanned)
    try {
      const result = await api<LookupResponse>("/api/scan/lookup", {
        method: "POST",
        body: JSON.stringify({ tracking: value, marketplace: account, shipmentId }),
      })
      setResponse(result)
      if (result.status === "found") {
        const key = crypto.randomUUID()
        const targetShipment = result.shipment
        const totalUnits = targetShipment.items.reduce((sum, item) => sum + item.expectedQty, 0)
        const isMulti = targetShipment.items.length > 1 || totalUnits > 1

        setShipment(targetShipment)
        setClientKey(key)
        setNotes("")
        setActiveItem(0)
        setTracking("")
        if (soundEnabled) playScanChime("success")
        if (videoRecordingEnabled) {
          await stopEvidenceRecording()
          setCapturedImages([])
          videoReadyRef.current = false
          startEvidenceRecording(targetShipment.trackingId)
        }

        if (isMulti) {
          // Multi SKU or Multi Quantity: open verification modal for staff inspection
          const initialLines: Record<number, LineForm> = {}
          for (const item of targetShipment.items) {
            initialLines[item.itemId] = { verified: false, received: String(item.expectedQty), issues: [] }
          }
          setLines(initialLines)
          setVerifyModalOpen(true)
          transitionTo("VERIFYING")
        } else {
          // Single SKU, 1 quantity return: NO popup! Auto-save immediately as normal return.
          const initialLines = normalLines(targetShipment)
          setLines(initialLines)
          setVerifyModalOpen(false)
          void autoSave(targetShipment, key, scanned)
        }
      } else if (result.status === "duplicate") {
        setShipment(null)
        setLines({})
        setClientKey("")
        setVerifyModalOpen(false)
        if (soundEnabled) playScanChime("error")
        showProblem(
          "duplicate",
          "Duplicate — already received",
          result.trackingId,
          `Scanned at ${result.time} by ${result.scannedBy} in ${result.marketplace}. Set the parcel aside.`,
        )
        transitionTo("DUPLICATE")
      } else if (result.status === "choose") {
        setShipment(null)
        setLines({})
        setClientKey("")
        setVerifyModalOpen(false)
        transitionTo("AMBIGUOUS_MATCH")
      } else {
        setShipment(null)
        setLines({})
        setClientKey("")
        setVerifyModalOpen(false)
        if (soundEnabled) playScanChime("error")
        showProblem(
          "notfound",
          "Not found in return data",
          result.trackingId,
          account === "Auto detect" ? "No active return in any account you can use." : `No active return in ${account}.`,
        )
        transitionTo("LOOKUP_ERROR")
      }
    } catch (err) {
      setShipment(null)
      setResponse(null)
      setScannedAwb("")
      setVerifyModalOpen(false)
      if (soundEnabled) playScanChime("error")
      setError(err instanceof Error ? err.message : "Lookup failed")
      showProblem("error", "Lookup failed", scanned, err instanceof Error ? err.message : "Check the connection and scan again.")
      transitionTo("LOOKUP_ERROR")
    }
  }

  const handleBarcodeScan = useCallback(
    (barcode: string) => {
      const cleanBarcode = barcode.trim().toUpperCase()
      if (!cleanBarcode) return

      const currentState = scannerStateRef.current
      if (currentState === "READY" || currentState === "LOOKUP_ERROR" || currentState === "DUPLICATE") {
        setTracking("")
        void runLookup(cleanBarcode, marketplace, null)
      } else {
        // Active parcel in flight (LOOKUP, VERIFYING, SAVING, SAVE_ERROR, AMBIGUOUS_MATCH)
        if (scanQueueRef.current.length >= 10) {
          setError("Scan buffer full (10 parcels max). Please finish verifying current parcel.")
          return
        }
        const updated = [...scanQueueRef.current, cleanBarcode]
        setScanQueue(updated)
        scanQueueRef.current = updated
        setNotice(`Buffered ${cleanBarcode} (${updated.length} parcel(s) queued for processing)`)
        if (soundEnabled) playScanChime("success")
      }
    },
    [marketplace, soundEnabled],
  )

  const submitLookup = (event: FormEvent) => {
    event.preventDefault()
    const value = tracking.trim().toUpperCase()
    if (!value) return
    setTracking("")
    handleBarcodeScan(value)
  }

  // Intercepts rapid scanner hardware inputs outside focused form fields.
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const now = Date.now()
      const target = e.target as HTMLElement | null
      const isTextInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")

      if (isTextInput) {
        scannerBufferRef.current = { text: "", lastTime: 0 }
        return
      }

      if (e.key === "Enter") {
        const buffered = scannerBufferRef.current.text.trim().toUpperCase()
        scannerBufferRef.current = { text: "", lastTime: 0 }
        if (buffered.length >= 4) {
          e.preventDefault()
          e.stopPropagation()
          handleBarcodeScan(buffered)
          return
        }
        return
      }

      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const timeDiff = now - scannerBufferRef.current.lastTime
        if (timeDiff < 80 || scannerBufferRef.current.text === "") {
          scannerBufferRef.current.text += e.key
          scannerBufferRef.current.lastTime = now
        } else {
          scannerBufferRef.current = { text: e.key, lastTime: now }
        }
      }
    }

    window.addEventListener("keydown", handleGlobalKeyDown)
    return () => window.removeEventListener("keydown", handleGlobalKeyDown)
  }, [handleBarcodeScan])

  const resetForNext = () => {
    setVerifyModalOpen(false)
    setResponse(null)
    setShipment(null)
    setLines({})
    setClientKey("")
    setNotes("")
    setTracking("")
    setScannedAwb("")
    setErrorDetails([])
    setMultiOpen(false)
    setSavedScanId(null)
    setIssueRecorded(false)
    benchRef.current = null
    pendingLines.current = null

    if (scanQueueRef.current.length > 0) {
      const [nextBarcode, ...rest] = scanQueueRef.current
      setScanQueue(rest)
      scanQueueRef.current = rest
      setNotice(`Cancelled previous. Processing queued parcel ${nextBarcode}`)
      void runLookup(nextBarcode, marketplace, null)
    } else {
      transitionTo("READY")
    }
  }

  const updateLine = (itemId: number, patch: Partial<LineForm>) => {
    setLines((current) => ({ ...current, [itemId]: { ...current[itemId], ...patch } }))
  }

  // One tap covers the whole expected quantity. The picture and the details are what the scanner checks.
  const chooseReport = (item: LookupItem, category: IssueCategory) => {
    if (!shipment) return
    const qty = String(item.expectedQty)
    const next: Record<number, LineForm> = {}
    for (const lineItem of shipment.items) {
      if (lineItem.itemId !== item.itemId || category.isClear) {
        next[lineItem.itemId] = { verified: true, received: String(lineItem.expectedQty), issues: [] }
        continue
      }
      next[lineItem.itemId] = {
        verified: true,
        received: category.isMissing ? "0" : qty,
        issues: [{ uid: nextUid(), categoryCode: category.code, subIssueId: "", qty, ticketCode: "", notes: "" }],
      }
    }
    setLines(next)
    void recordIssue(shipment, next)
  }

  const chooseSubIssue = (itemId: number, subIssueId: string) => {
    if (!shipment) return
    const line = lines[itemId]
    const issue = line?.issues[0]
    if (!issue) return
    const next = { ...lines, [itemId]: { ...line, issues: [{ ...issue, subIssueId }] } }
    setLines(next)
    void recordIssue(shipment, next)
  }

  const markAllAsExpected = () => {
    if (!shipment) return
    setLines((current) => {
      const next: Record<number, LineForm> = {}
      for (const item of shipment.items) {
        next[item.itemId] = { ...current[item.itemId], verified: true, received: String(item.expectedQty), issues: [] }
      }
      return next
    })
  }

  // Every line's problems, computed the same way the server checks them.
  const plans = shipment
    ? shipment.items.map((item) => ({
        item,
        ...linePlan(item, lines[item.itemId] ?? { verified: false, received: "", issues: [] }, categories),
      }))
    : []
  const problems = plans.flatMap((plan) => plan.problems)
  const canSave = Boolean(shipment && clientKey) && problems.length === 0 && !saving

  const save = async (overrideLines?: Record<number, LineForm>) => {
    if (!shipment) return
    const activeLines = overrideLines || lines
    if (!overrideLines && !canSave) return
    transitionTo("SAVING")
    setSaving(true)
    setError("")
    setErrorDetails([])
    try {
      const hasVideo = videoRecordingEnabled ? await stopEvidenceRecording() : false
      const payload = {
        shipmentId: shipment.shipmentId,
        clientScanKey: clientKey,
        notes: notes.trim(),
        // The AWB that was read. The server records which stored AWB and leg it matched, and keeps this value.
        scannedTracking: scannedAwb || shipment.scannedTracking,
        photoCount: videoRecordingEnabled ? capturedImages.length : 0,
        hasVideo,
        items: shipment.items.map((item) => {
          const line = activeLines[item.itemId] || { verified: true, received: String(item.expectedQty), issues: [] }
          return {
            itemId: item.itemId,
            receivedQty: Number(line.received),
            verified: line.verified,
            issues: line.issues.map((issue) => ({
              categoryCode: issue.categoryCode,
              subIssueId: issue.subIssueId ? Number(issue.subIssueId) : null,
              qty: Number(issue.qty),
              ticketCode: issue.ticketCode.trim(),
              notes: issue.notes.trim(),
            })),
          }
        }),
      }
      const result = await api<ScanReceipt>("/api/scan/complete", { method: "POST", body: JSON.stringify(payload) })
      for (const it of payload.items) {
        for (const iss of it.issues) {
          recordIssueUsage(iss.categoryCode)
        }
      }
      setReceipt(result)
      setShift(result.shift)
      setClaimsBadge(result.claimsBadge)
      showSaved(result, shipment)
      if (soundEnabled) playScanChime(result.issueCount ? "issue" : (result.ironSendQty ?? 0) > 0 ? "iron" : "success")
      setNotice(
        result.replayed
          ? "This return was already saved. The earlier result is shown, and nothing was saved twice."
          : result.issueCount
            ? "Return saved with issues. Ticket IDs are in the register."
            : "Return saved. Every item was verified and recorded.",
      )
      setVerifyModalOpen(false)
      setShipment(null)
      setResponse(null)
      setLines({})
      setClientKey("")
      setTracking("")
      setScannedAwb("")
      setCapturedImages([])
      transitionTo("SAVED")

      if (scanQueueRef.current.length > 0) {
        const [nextBarcode, ...rest] = scanQueueRef.current
        setScanQueue(rest)
        scanQueueRef.current = rest
        setNotice(`Processing queued parcel ${nextBarcode} (${rest.length} remaining in buffer)`)
        void runLookup(nextBarcode, marketplace, null)
      } else {
        transitionTo("READY")
      }
    } catch (err) {
      if (soundEnabled) playScanChime("error")
      transitionTo("SAVE_ERROR")
      if (err instanceof ApiError) {
        setErrorDetails(err.details)
        setError(err.message)
        if (err.status === 409 && err.body.time) {
          setError(
            `${err.message} at ${String(err.body.time)} by ${String(err.body.scannedBy ?? "another scanner")}. No new record was created.`,
          )
        }
      } else {
        setError(err instanceof Error ? err.message : "Could not save this return")
      }
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!verifyModalOpen || saving) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        resetForNext()
        return
      }
      if (e.key === "Enter") {
        const target = e.target as HTMLElement | null
        if (target && target.tagName === "TEXTAREA") return
        e.preventDefault()
        if (canSave) {
          void save()
        } else if (shipment) {
          const hasSelectedIssues = Object.values(lines).some((line) => line.issues.length > 0)
          if (!hasSelectedIssues) {
            const clearLines = normalLines(shipment)
            setLines(clearLines)
            void save(clearLines)
          }
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [verifyModalOpen, saving, canSave, shipment, lines])

  const recordingTime = `${String(Math.floor(recordingSeconds / 60)).padStart(2, "0")}:${String(recordingSeconds % 60).padStart(2, "0")}`

  const closeMulti = () => {
    if (multiTimer.current) {
      window.clearTimeout(multiTimer.current)
      multiTimer.current = null
    }
    setMultiOpen(false)
    scanInput.current?.focus()
  }

  const showMulti = (shipment: LookupShipment) => {
    const units = shipment.items.reduce((sum, line) => sum + line.expectedQty, 0)
    if (shipment.items.length < 2 && units < 2) {
      closeMulti()
      return
    }
    if (multiTimer.current) window.clearTimeout(multiTimer.current)
    setMultiOpen(true)
    multiTimer.current = window.setTimeout(() => {
      multiTimer.current = null
      setMultiOpen(false)
      scanInput.current?.focus()
    }, 2000)
  }

  useEffect(() => {
    return () => {
      if (multiTimer.current) window.clearTimeout(multiTimer.current)
    }
  }, [])

  const item = shipment ? shipment.items[Math.min(activeItem, shipment.items.length - 1)] : undefined
  const previewImage = item && brokenImage !== String(item.itemId) ? catalogImageSrc(item.imageUrl) : ""
  const candidates: LookupCandidate[] = response && response.status === "choose" ? response.candidates : []

  return (
    <div className={shipment ? "page-content scan-page has-result" : "page-content scan-page"}>
      <section className="scan-workspace">
        <div className="scan-primary">
          <div className="scanner-title">
            <span>
              <Icon name="scan" size={24} />
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h2>{shipment ? (savedScanId ? "Saved — scan the next" : saving ? "Saving this return" : "Return on screen") : "Ready to scan"}</h2>
                <span className={`state-badge state-${scannerState.toLowerCase()}`}>
                  {STATE_LABELS[scannerState]}
                </span>
                {scanQueue.length > 0 && (
                  <span className="queue-badge">
                    {scanQueue.length} buffered
                  </span>
                )}
              </div>
              <p>
                {shipment
                  ? "The box stays ready. Tap an issue only if this parcel is not a normal return."
                  : "Scan the label. A match is saved at once as a normal return."}
              </p>
            </div>
            <LiveSyncBadge compact />
          </div>
          {scanQueue.length > 0 && (
            <div className="queue-banner" style={{ margin: "12px 24px 0" }}>
              <Icon name="box" size={16} />
              <span>
                <strong>Buffer Queue ({scanQueue.length}):</strong> Processing will continue automatically. Next: {scanQueue.join(", ")}
              </span>
            </div>
          )}
          <form onSubmit={submitLookup} className="scan-form">
            <div className="scan-form-head">
              <label>TRACKING ID / AWB</label>
              <div className="scan-form-toggles">
                <div
                  className="continuous-mode-toggle"
                  title={
                    continuousMode
                      ? "Continuous scan mode enabled: scanner stays ready for next box"
                      : "Continuous scan mode disabled: scanner pauses on saved card"
                  }
                >
                  <span className="continuous-mode-label">Continuous scan mode</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={continuousMode}
                    className={`modern-toggle-switch ${continuousMode ? "on" : "off"}`}
                    onClick={() => {
                      setContinuousMode((prev) => {
                        const next = !prev
                        localStorage.setItem("scanner_continuous_mode", String(next))
                        return next
                      })
                    }}
                  >
                    <span className="modern-toggle-thumb" />
                  </button>
                </div>
              </div>
            </div>
            <div className="scan-controls-responsive">
              <div className="account-select-wrap">
                <span
                  className="account-status-dot"
                  style={{
                    backgroundColor: marketplace === "Auto detect" ? "#10b981" : accountColorDot(marketplace),
                  }}
                />
                <select
                  aria-label="Marketplace account"
                  value={marketplace}
                  onChange={(event) => {
                    setMarketplace(event.target.value)
                    scanInput.current?.focus()
                  }}
                  className="account-select-field"
                >
                  <option value="Auto detect">Auto detect</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.name}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="scan-input-card">
                <Icon name="scan" size={24} />
                <input
                  ref={scanInput}
                  autoFocus
                  value={tracking}
                  onFocus={() => setIsInputFocused(true)}
                  onBlur={() => setIsInputFocused(false)}
                  onChange={(event) => {
                    setTracking(event.target.value)
                    setError("")
                    setNotice("")
                  }}
                  placeholder="Scan tracking ID or Order ID and press Enter"
                />
                <span className="scan-input-helper">Auto opens on Enter</span>
                <button type="submit" className="scan-submit-btn">
                  Look up <Icon name="arrow" />
                </button>
              </div>

              <button
                type="button"
                onClick={() => setSoundEnabled((v) => !v)}
                className={`scan-audio-pill ${soundEnabled ? "on" : "muted"}`}
                title={soundEnabled ? "Mute audio chime" : "Enable audio chime"}
              >
                <span>{soundEnabled ? "🔊 Sound on" : "🔇 Muted"}</span>
              </button>

              <button
                type="button"
                onClick={() => scanInput.current?.focus()}
                className={`scan-status-pill ${isInputFocused ? "focused" : "unfocused"}`}
                title={
                  isInputFocused
                    ? "Scanner input is focused and listening for barcodes"
                    : "Barcode scanner input is not focused! Tap here to reconnect & focus."
                }
              >
                {isInputFocused ? (
                  <>
                    <span className="live-status-dot" />
                    <span>{scannerState === "READY" ? "Scan input ready" : STATE_LABELS[scannerState]}</span>
                  </>
                ) : (
                  <>
                    <span className="unfocused-warning-icon">⚠️</span>
                    <span>Not listening – tap to reconnect</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={toggleFullscreen}
                className="scan-fullscreen-btn"
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen packing station mode"}
                aria-label="Toggle Fullscreen"
              >
                {isFullscreen ? "🗗" : "⛶"}
              </button>
            </div>
            <div className="scan-hint">
              <span>Scanner stays focused after every saved return · type an AWB or Order ID by hand and press Enter</span>
              <span>Press Enter to search</span>
            </div>
          </form>

          {feedback && (
            <div className={`scan-feedback tone-${feedback.tone}`} role="status" aria-live="assertive" key={feedback.at}>
              <div className="scan-feedback-icon">
                {feedback.image ? <img src={feedback.image} alt="" /> : <Icon name={FEEDBACK_ICON[feedback.tone]} size={30} />}
              </div>
              <div className="scan-feedback-body">
                <strong className="scan-feedback-title">{feedback.title}</strong>
                <span className="scan-feedback-awb">{feedback.awb}</span>
                {feedback.sku && (
                  <span className="scan-feedback-sku">
                    {feedback.sku}
                    {feedback.size && <b className="size-chip">{feedback.size}</b>}
                  </span>
                )}
                <small>{feedback.detail}</small>
              </div>
              <time className="scan-feedback-time">{IST_CLOCK.format(new Date(feedback.at))}</time>
            </div>
          )}
          {remoteSaved && (
            <div className="form-error" style={{ margin: "12px 24px 0" }} role="alert">
              {remoteSaved}
            </div>
          )}

          {error && (
            <div className="form-error" style={{ margin: "16px 24px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                {error}
                {errorDetails.length > 0 && (
                  <ul style={{ margin: "8px 0 0 18px" }}>
                    {errorDetails.map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                )}
              </div>
              {scannerState === "SAVE_ERROR" && shipment && (
                <button
                  type="button"
                  className="btn danger"
                  style={{ marginLeft: 16, whiteSpace: "nowrap" }}
                  onClick={() => void save()}
                  disabled={saving}
                >
                  <Icon name="alert" /> Retry Save
                </button>
              )}
            </div>
          )}
          {notice && (
            <div className="scan-notice">
              <Icon name="check" />
              <div>
                <strong>{notice}</strong>
                {receipt && (
                  <span>
                    {receipt.scan.marketplace} · scanned {receipt.scan.scannedTracking || receipt.scan.trackingId} ·{" "}
                    {receipt.itemCount} item(s) · {receipt.scan.logisticPartner} · saved at {receipt.scan.timeLabel}
                  </span>
                )}
              </div>
              <Badge tone="success">SAVED</Badge>
            </div>
          )}

          {response?.status === "duplicate" && (
            <div className="scan-error duplicate">
              <span>
                <Icon name="alert" size={22} />
              </span>
              <div>
                <Badge tone="danger">DUPLICATE SCAN</Badge>
                <h3>This AWB has already been received</h3>
                <p>
                  <strong>{response.trackingId}</strong> was scanned at {response.time} by {response.scannedBy} in{" "}
                  {response.marketplace}. No new return was created.
                </p>
              </div>
              <button className="btn secondary" onClick={resetForNext}>
                Clear & scan next
              </button>
            </div>
          )}

          {response?.status === "not_found" && (
            <div className="scan-error not-found">
              <span>
                <Icon name="search" size={22} />
              </span>
              <div>
                <Badge tone="warning">AWB NOT FOUND</Badge>
                <h3>No active return found for {response.trackingId}</h3>
                <p>
                  Not found in{" "}
                  {marketplace === "Auto detect" ? "any marketplace data you can see" : `${marketplace} data`}. Check the
                  marketplace account above and retry, or load the latest return file for that account.
                </p>
              </div>
              <button className="btn secondary" onClick={() => openPage("uploads")}>
                Open uploads
              </button>
            </div>
          )}

          {response?.status === "choose" && (
            <section className="panel" style={{ margin: "16px 24px 0", padding: 16 }}>
              <span className="eyebrow">MORE THAN ONE MATCH</span>
              <h3>Choose the account for {response.trackingId}</h3>
              <p>
                The same tracking ID is in more than one account. Choose the one that matches the parcel. Nothing is selected
                for you.
              </p>
              <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
                {candidates.map((candidate) => (
                  <div
                    key={`${candidate.accountId}-${candidate.shipmentId ?? "history"}`}
                    style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" }}
                  >
                    <span>
                      <strong>{candidate.accountName}</strong> · order {candidate.orderId || "—"} · {candidate.itemCount}{" "}
                      item(s)
                    </span>
                    {candidate.alreadyReceived ? (
                      <Badge tone="danger">
                        Already received at {candidate.receivedAt} by {candidate.scannedBy}
                      </Badge>
                    ) : candidate.shipmentId !== null ? (
                      <button
                        className="btn primary"
                        onClick={() => void runLookup(response.trackingId, candidate.accountName, candidate.shipmentId)}
                      >
                        Use {candidate.accountName}
                      </button>
                    ) : (
                      <Badge tone="neutral">Not available</Badge>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {!shipment &&
            response?.status !== "duplicate" &&
            response?.status !== "choose" &&
            response?.status !== "not_found" && (
              <div className="empty-scan">
                <span>
                  <Icon name="box" size={32} />
                </span>
                <h3>Waiting for a return</h3>
                <p>The return and all of its items will appear here once a tracking ID is found.</p>
              </div>
            )}

          {shipment && (
            <div className="shipment-result">
              <div className="shipment-scroll">
              <div className="result-success">
                <Icon name="check" />
                <div>
                  <strong>Return found in {shipment.marketplace}</strong>
                  <span>
                    Scanned {scannedAwb || shipment.scannedTracking} · order {shipment.orderId || "—"} ·{" "}
                    {shipment.courier || "courier not stated"}
                  </span>
                </div>
                <Badge tone="success">{shipment.itemSummary}</Badge>
              </div>
              <div className="shipment-meta">
                {[
                  ["Scanned AWB", scannedAwb || shipment.scannedTracking || "—"],
                  ["Matched", shipment.matchedTrackingField ? (MATCHED_FIELD_LABELS[shipment.matchedTrackingField] ?? "—") : "Not recorded"],
                  ["Matched leg", MATCHED_LEG_LABELS[shipment.matchedLeg] ?? "Not known"],
                  ["Logistic partner", shipment.logisticPartner || "Unknown / Pending Verification"],
                  ["Return type", shipment.returnType || "—"],
                  ["Return type (as file)", shipment.returnTypeRaw || "—"],
                  ["Return reason", shipment.returnReason || "—"],
                  ["Source file", shipment.sourceFile || "—"],
                  ["Order", shipment.orderId || "—"],
                  ["Matched from", shipment.matchedFrom || "—"],
                ].map((entry) => (
                  <div key={entry[0]}>
                    <span>{entry[0]}</span>
                    {entry[0] === "Logistic partner" ? (
                      <PartnerBadge name={entry[1]} />
                    ) : (
                      <strong title={entry[1]}>{entry[1]}</strong>
                    )}
                  </div>
                ))}
              </div>
              {(shipment.forwardTrackingId || shipment.urlTrackingId || shipment.csvTrackingId !== shipment.trackingId) && (
                <p className="scan-tracking">
                  {shipment.csvTrackingId && shipment.csvTrackingId !== shipment.trackingId && (
                    <>
                      File AWB <strong>{shipment.csvTrackingId}</strong> · lookup AWB <strong>{shipment.trackingId}</strong>{" "}
                      ·{" "}
                    </>
                  )}
                  {shipment.forwardTrackingId && (
                    <>
                      Forward AWB <strong>{shipment.forwardTrackingId}</strong> ·{" "}
                    </>
                  )}
                  {shipment.urlTrackingId && (
                    <>
                      Link AWB <strong>{shipment.urlTrackingId}</strong> ·{" "}
                    </>
                  )}
                  Tracking source {TRACKING_SOURCE_LABELS[shipment.trackingSource] ?? shipment.trackingSource}
                </p>
              )}

              <div className="item-switcher">
                {shipment.items.map((line, index) => (
                  <button
                    key={line.itemId}
                    className={index === activeItem ? "btn primary" : "btn secondary"}
                    onClick={() => setActiveItem(index)}
                  >
                    Item {index + 1} of {shipment.items.length}
                  </button>
                ))}
              </div>

              {item && (
                <section className="product-verification">
                  <div className="catalog-preview">
                    {previewImage ? (
                      <button
                        type="button"
                        className="catalog-image-wrap"
                        onClick={() => setPreviewOpen(true)}
                        aria-label="Enlarge catalog image"
                      >
                        <img
                          src={previewImage}
                          alt={`Catalog image for ${item.productName}`}
                          onError={() => setBrokenImage(String(item.itemId))}
                        />
                      </button>
                    ) : (
                      <div className="catalog-image-wrap">
                        <div style={{ display: "grid", placeItems: "center", minHeight: 200, gap: 8 }}>
                          <Icon name="box" size={32} />
                          <span>No catalog image for this SKU</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="verification-details">
                    <div className="verification-heading">
                      <div>
                        <span className="eyebrow">EXPECTED ITEM</span>
                        <h3>{item.productName || item.marketplaceSku || "Item"}</h3>
                        {item.orderItemId && (
                          <p className="verification-order-subline">
                            {item.displayIdentifierKind === "ajio_return_order_number" ? "Return order" : item.displayIdentifierKind === "amazon_shipment_id" ? "Shipment" : "Order item"}{" "}
                            <strong>{item.orderItemId}</strong>
                          </p>
                        )}
                      </div>
                      <Badge tone="neutral">Expected {item.expectedQty}</Badge>
                    </div>

                    {/* Dedicated High-Visibility SKU Banner (Enlarged on desktop for 2-2.5 ft viewing) */}
                    <div className="desktop-sku-banner" aria-label="SKU Information">
                      <div className="desktop-sku-card primary-sku">
                        <span className="desktop-sku-label">MARKETPLACE SKU</span>
                        <strong className="desktop-sku-value" title={item.marketplaceSku || ""}>
                          {item.marketplaceSku || "—"}
                        </strong>
                      </div>
                      {sizeFromSku(item.marketplaceSku, item.productSku, item.productName) && (
                        <div className="desktop-sku-card size-card" aria-label="Size">
                          <span className="desktop-sku-label">SIZE</span>
                          <strong className="desktop-sku-value size-value">
                            {sizeFromSku(item.marketplaceSku, item.productSku, item.productName)}
                          </strong>
                        </div>
                      )}
                      {item.productSku && item.productSku !== item.marketplaceSku && (
                        <div className="desktop-sku-card secondary-sku">
                          <span className="desktop-sku-label">MASTER / PRODUCT SKU</span>
                          <strong className="desktop-sku-value master" title={item.productSku}>
                            {item.productSku}
                          </strong>
                        </div>
                      )}
                    </div>

                    <div className="visual-checks">
                      <div>
                        <p>
                          <small>PRODUCT SKU</small>
                          <strong className="visual-sku-val">{item.productSku || "Not resolved"}</strong>
                        </p>
                      </div>
                      <div>
                        <p>
                          <small>MARKETPLACE SKU ID</small>
                          <strong className="visual-sku-val">{item.marketplaceSkuIdentifier || "Not in the file"}</strong>
                        </p>
                      </div>
                      <div>
                        <p>
                          <small>COLOR</small>
                          <strong>{item.colorName || "—"}</strong>
                        </p>
                      </div>
                    </div>
                  </div>

                    {(() => {
                      const line = lines[item.itemId] ?? { verified: false, received: "", issues: [] }
                      const plan = linePlan(item, line, categories)
                      const chosen = line.issues[0]
                      const chosenCategory = categories.find((entry) => entry.code === chosen?.categoryCode)
                      const choices = subIssues.filter(
                        (sub) => chosenCategory && chosenCategory.allowsSubIssue && sub.categoryCode === chosenCategory.code,
                      )
                      const normalSelected =
                        line.issues.length === 0 && line.verified && line.received === String(item.expectedQty)
                      return (
                        <div className="issue-report">
                          <div className="issue-chips" role="group" aria-label="Issue report">
                            {orderedCategories(categories).map((category) => {
                              const pressed = category.isClear ? normalSelected : chosen?.categoryCode === category.code
                              const theme = getCategoryTheme(category.code)
                              return (
                                <button
                                  key={category.code}
                                  type="button"
                                  className={`chip-${category.code} ${category.isClear ? "clear" : ""}`}
                                  aria-pressed={pressed}
                                  style={{
                                    border: `1.5px solid ${pressed ? theme.primary : theme.border}`,
                                    background: pressed ? theme.bgSelected : theme.bgLight,
                                    color: pressed ? theme.textSelected : theme.textLight,
                                    boxShadow: pressed ? `0 2px 4px ${theme.primary}33` : "none",
                                    transition: "all 0.15s ease",
                                  }}
                                  onClick={() => {
                                    recordIssueUsage(category.code)
                                    chooseReport(item, category)
                                  }}
                                  title={category.label}
                                >
                                  {chipLabel(category)}
                                </button>
                              )
                            })}
                          </div>
                          {categories.length === 0 && (
                            <p className="issue-hint">Issue choices have not loaded. Save stays off until they do.</p>
                          )}
                          {chosenCategory?.allowsSubIssue && (
                            <div className="issue-sub">
                              <span>{chipLabel(chosenCategory)}</span>
                              <div className="issue-chips" role="group" aria-label={chipLabel(chosenCategory)}>
                                {choices.map((sub) => (
                                  <button
                                    key={sub.id}
                                    type="button"
                                    aria-pressed={chosen?.subIssueId === String(sub.id)}
                                    onClick={() => chooseSubIssue(item.itemId, String(sub.id))}
                                  >
                                    {sub.label}
                                  </button>
                                ))}
                              </div>
                              {choices.length === 0 && <p className="issue-hint">No missing-item choices are active.</p>}
                            </div>
                          )}
                          {chosenCategory?.requiresTicket && chosen && (
                            <label className="issue-ticket-line">
                              <span>Ticket ID</span>
                              <input
                                aria-label="Ticket ID"
                                value={chosen.ticketCode}
                                maxLength={60}
                                placeholder="From the claim system"
                                onChange={(event) =>
                                  setLines((current) => {
                                    const currentLine = current[item.itemId]
                                    const issue = currentLine.issues[0]
                                    if (!issue) return current
                                    return {
                                      ...current,
                                      [item.itemId]: { ...currentLine, issues: [{ ...issue, ticketCode: event.target.value }] },
                                    }
                                  })
                                }
                              />
                            </label>
                          )}
                          {plan.problems.length > 0 && line.received !== "" && (
                            <ul className="issue-problems">
                              {plan.problems.map((problem) => (
                                <li key={problem}>{problem}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )
                    })()}
                </section>
              )}

              </div>
              <div className="inspection-actions">
                <label className="claim-note">
                  <span>Notes for the claim team</span>
                  <input
                    value={notes}
                    maxLength={500}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Optional"
                    aria-label="Notes for the claim team"
                  />
                </label>
                <p>
                  {savedScanId
                    ? issueRecorded
                      ? "Issue saved. Scan the next parcel."
                      : "Saved. Scan the next parcel, or tap an issue if this one is not normal."
                    : saving
                      ? "Saving this return…"
                      : problems.length
                        ? `Complete ${problems.length} check(s) before saving.`
                        : "Every item is verified."}
                </p>
                <div className="scan-actions">
                  {scannerState === "SAVE_ERROR" && (
                    <button
                      type="button"
                      className="btn danger"
                      onClick={() => void save()}
                      disabled={saving}
                      title="Retry saving with preserved barcode, item details, and idempotency key"
                    >
                      <Icon name="alert" /> Retry Save (Enter)
                    </button>
                  )}
                  {!savedScanId && (
                    <button type="button" className="btn secondary" onClick={markAllAsExpected} disabled={saving}>
                      <Icon name="check" /> Received as expected
                    </button>
                  )}
                  {!savedScanId && (
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={resetForNext}
                      disabled={saving}
                      title="Clear this lookup. Nothing is saved"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn success"
                    onClick={() => void save()}
                    disabled={!canSave || Boolean(savedScanId)}
                    title={
                      savedScanId
                        ? "This return is already saved"
                        : canSave
                          ? "Save this return"
                          : saving
                            ? "Saving this return"
                            : problems[0] || "Complete the checks before saving"
                    }
                  >
                    <Icon name="check" /> {saving ? "Saving…" : savedScanId ? "Saved" : "Save return"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="scan-side">
          <div className="shift-card">
            <span>TODAY’S SHIFT</span>
            <strong>{shift?.scanned || "—"}</strong>
            <p>returns scanned</p>
            <div>
              <i style={{ width: `${shift?.progress || 0}%` }} />
            </div>
            <small>{shift?.targetLabel || "Loading shift…"}</small>
          </div>
          <div className="session-card">
            <h3>Today, all benches</h3>
            <div>
              <span>
                Correct returns <b>{shift?.correct || "—"}</b>
              </span>
              <span>
                Issue returns <b className="orange-text">{shift?.issues || "—"}</b>
              </span>
              <span>
                Iron Send units <b className="iron-text">{shift?.ironSend ?? "—"}</b>
              </span>
              <span>
                Clear rate <b>{shift?.accuracy || "—"}</b>
              </span>
            </div>
          </div>
          <div className="session-card bench-counters">
            <h3>This workstation</h3>
            <div className="bench-counter-grid">
              <span className="c-total">
                <b>{Object.keys(sessionOutcomes).length}</b>
                <small>Saved</small>
              </span>
              <span className="c-ok">
                <b>{Object.values(sessionOutcomes).filter((o) => o === "clear").length}</b>
                <small>Normal</small>
              </span>
              <span className="c-issue">
                <b>{Object.values(sessionOutcomes).filter((o) => o === "issue").length}</b>
                <small>Issues</small>
              </span>
              <span className="c-iron">
                <b>{Object.values(sessionOutcomes).filter((o) => o === "iron").length}</b>
                <small>Iron Send</small>
              </span>
              <span className="c-miss">
                <b>{sessionMisses.notFound}</b>
                <small>Not found</small>
              </span>
              <span className="c-dup">
                <b>{sessionMisses.duplicate}</b>
                <small>Duplicates</small>
              </span>
            </div>
          </div>
          <div className={`camera-card ${videoRecordingEnabled ? "camera-enabled" : "camera-disabled"}`}>
            <div className="camera-head">
              <div>
                <h3>Unboxing evidence</h3>
                <p>Recorded on this workstation only</p>
              </div>
              <div className="camera-head-controls">
                <Badge tone={videoRecordingEnabled ? (cameraStatus === "recording" ? "danger" : cameraStatus === "ready" ? "success" : "neutral") : "neutral"}>
                  {videoRecordingEnabled
                    ? cameraStatus === "recording"
                      ? `REC ${recordingTime}`
                      : cameraStatus === "ready"
                        ? "CAMERA READY"
                        : cameraStatus === "connecting"
                          ? "CONNECTING"
                          : "OFFLINE"
                    : "DISABLED"}
                </Badge>
                <label className="camera-toggle-switch" title="Toggle unboxing video recording on or off">
                  <input
                    type="checkbox"
                    checked={videoRecordingEnabled}
                    onChange={(e) => {
                      const enabled = e.target.checked
                      setVideoRecordingEnabled(enabled)
                      localStorage.setItem("scanner_video_recording_enabled", String(enabled))
                      if (!enabled) {
                        void stopEvidenceRecording()
                        void disconnectCamera()
                      }
                    }}
                  />
                  <span className="camera-toggle-slider" />
                </label>
              </div>
            </div>

            {!videoRecordingEnabled ? (
              <div className="camera-disabled-panel">
                <div className="camera-disabled-icon">
                  <Icon name="video" size={26} />
                </div>
                <strong>Real-time recording is turned off</strong>
                <p>
                  Workstation video recording is currently disabled. Toggle on above whenever parcel unboxing evidence or photo capture is required.
                </p>
              </div>
            ) : (
              <>
                <div className={`camera-preview ${cameraStatus}`}>
                  <video ref={videoElement} muted playsInline />
                  {(cameraStatus === "idle" || cameraStatus === "error") && (
                    <div className="camera-placeholder">
                      <Icon name="scan" size={25} />
                      <strong>
                        {cameraStatus === "error" ? "Camera permission blocked" : "Connect this workstation’s webcam"}
                      </strong>
                      <span>Recording starts automatically after a valid AWB scan</span>
                    </div>
                  )}
                  {cameraStatus === "connecting" && (
                    <div className="camera-placeholder">
                      <span className="camera-loader" />
                      <strong>Connecting webcam…</strong>
                    </div>
                  )}
                  {cameraStatus === "recording" && (
                    <span className="recording-indicator">
                      <i /> Recording {activeEvidenceAwb.current}
                    </span>
                  )}
                </div>
                {cameraStatus === "idle" || cameraStatus === "error" || cameraStatus === "connecting" ? (
                  <button
                    className="btn primary wide camera-connect"
                    onClick={connectCamera}
                    disabled={cameraStatus === "connecting"}
                  >
                    <Icon name="scan" /> Connect webcam
                  </button>
                ) : (
                  <div className="camera-actions">
                    <button
                      className="btn secondary"
                      onClick={captureEvidenceImage}
                      disabled={cameraStatus !== "recording"}
                    >
                      <Icon name="file" /> Capture photo
                    </button>
                    {cameraStatus === "recording" && (
                      <button
                        className="stop-recording"
                        onClick={() => void stopEvidenceRecording()}
                        aria-label="Stop recording"
                      >
                        <span />
                      </button>
                    )}
                    {cameraStatus === "ready" && (
                      <button className="btn secondary" onClick={() => void disconnectCamera()}>
                        Disconnect camera
                      </button>
                    )}
                  </div>
                )}
                {capturedImages.length > 0 && (
                  <div className="capture-strip">
                    {capturedImages.map((image, index) => (
                      <img src={image} alt={`Evidence capture ${index + 1}`} key={`${index}-${image.slice(-12)}`} />
                    ))}
                    <span>{capturedImages.length} photos</span>
                  </div>
                )}
                <div className="evidence-status">
                  <Icon name="check" size={15} />
                  <span>
                    <strong>{savedEvidenceCount} recordings made this session</strong>
                    <small>
                      {lastVideoUrl
                        ? `${lastEvidenceAwb} recorded on this workstation. Not uploaded, and not linked to the return yet.`
                        : "Only the number of photos and whether a video exists are saved with the return."}
                    </small>
                  </span>
                </div>
              </>
            )}
          </div>
        </aside>
      </section>
      {verifyModalOpen && shipment && (
        <Modal wide onClose={() => {
          if (confirm("Close verification modal? Scanned return will not be saved.")) {
            resetForNext()
          }
        }}>
          <div className="verification-modal-wrap" style={{ maxHeight: "85vh", overflowY: "auto", padding: "6px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "1px solid var(--line)", paddingBottom: 12, marginBottom: 14 }}>
              <div>
                <span className="eyebrow" style={{ color: "#92400e", background: "#fef3c7", padding: "3px 8px", borderRadius: 4, fontWeight: 700, fontSize: 11, textTransform: "uppercase" }}>
                  Multi-Item / Multi-Quantity Return ({shipment.items.length} SKUs · {shipment.items.reduce((s, it) => s + it.expectedQty, 0)} Total Pieces)
                </span>
                <h2 style={{ margin: "4px 0 4px", fontSize: 20 }}>
                  AWB: {scannedAwb || shipment.trackingId}
                </h2>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 12, color: "#4f5f59" }}>
                  <span>Account: <strong>{shipment.marketplace}</strong></span>
                  <span>·</span>
                  <span>Order ID: <strong>{shipment.orderId || "—"}</strong></span>
                  <span>·</span>
                  <span>Carrier: <strong>{shipment.courier || shipment.logisticPartner}</strong></span>
                  <span>·</span>
                  <span>Type: <strong>{shipment.returnType}</strong></span>
                  {shipment.returnReason && (
                    <>
                      <span>·</span>
                      <span>Reason: <em>{shipment.returnReason}</em></span>
                    </>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="btn secondary"
                  style={{ height: 32, fontSize: 12 }}
                  onClick={() => {
                    setLines(normalLines(shipment))
                  }}
                  title="Verify all items as intact normal returns"
                >
                  <Icon name="check" size={13} /> Verify & Clear All
                </button>
                <button
                  type="button"
                  className="modal-close"
                  onClick={() => {
                    resetForNext()
                  }}
                  aria-label="Close"
                >
                  <Icon name="close" />
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gap: 12 }}>
              {shipment.items.map((item, idx) => {
                const line = lines[item.itemId] ?? { verified: false, received: String(item.expectedQty), issues: [] }
                const currentIssue = line.issues[0]
                const isClear = line.verified && line.issues.length === 0 && Number(line.received) === item.expectedQty
                const hasIssue = line.issues.length > 0
                const currentTheme = currentIssue ? getCategoryTheme(currentIssue.categoryCode) : null
                return (
                  <div
                    key={item.itemId}
                    style={{
                      border: `1.5px solid ${
                        line.verified
                          ? hasIssue
                            ? currentTheme?.border ?? "#e3976c"
                            : "#9ed3c0"
                          : "#d4ded9"
                      }`,
                      borderRadius: 10,
                      padding: 13,
                      background: line.verified
                        ? hasIssue
                          ? currentTheme?.bgLight ?? "#fff8f3"
                          : "#f5fbf8"
                        : "#ffffff",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "grid", gridTemplateColumns: "70px 1fr auto", gap: 14, alignItems: "center" }}>
                      <div
                        style={{
                          width: 70,
                          height: 70,
                          borderRadius: 8,
                          border: "1px solid var(--line)",
                          overflow: "hidden",
                          display: "grid",
                          placeItems: "center",
                          background: "#f9faf9",
                        }}
                      >
                        {catalogImageSrc(item.imageUrl) ? (
                          <img
                            src={catalogImageSrc(item.imageUrl)}
                            alt=""
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        ) : (
                          <Icon name="box" size={28} />
                        )}
                      </div>

                      <div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 3 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#6a7672" }}>
                            Item {idx + 1} of {shipment.items.length}
                          </span>
                          {item.orderItemId && (
                            <Badge tone="neutral">Order Line: {item.orderItemId}</Badge>
                          )}
                          {item.shipmentId && (
                            <Badge tone="neutral">Shipment: {item.shipmentId}</Badge>
                          )}
                        </div>
                        <h4 style={{ margin: "0 0 3px", fontSize: 14, fontWeight: 700 }}>
                          {item.productName || item.marketplaceSku}
                        </h4>
                        <div className="multi-order-sku-block">
                          <div className="multi-order-sku-pill primary">
                            <span className="multi-order-sku-label">SKU:</span>
                            <strong className="multi-order-sku-text">{item.marketplaceSku}</strong>
                          </div>
                          {item.productSku && item.productSku !== item.marketplaceSku && (
                            <div className="multi-order-sku-pill secondary">
                              <span className="multi-order-sku-label">Master:</span>
                              <strong className="multi-order-sku-text">{item.productSku}</strong>
                            </div>
                          )}
                          {item.colorName && item.colorName !== "—" && (
                            <span className="multi-order-color">Color: <strong>{item.colorName}</strong></span>
                          )}
                        </div>
                      </div>

                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 11, color: "#66736f", marginBottom: 2 }}>
                          Expected: <strong>{item.expectedQty}</strong>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <label style={{ fontSize: 11, fontWeight: 600 }}>Received:</label>
                          <input
                            type="number"
                            min="0"
                            max={item.expectedQty}
                            value={line.received}
                            onChange={(e) => updateLine(item.itemId, { received: e.target.value })}
                            style={{
                              width: 52,
                              height: 32,
                              textAlign: "center",
                              borderRadius: 6,
                              border: "1px solid var(--line)",
                              fontWeight: 700,
                              fontSize: 14,
                            }}
                          />
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        marginTop: 10,
                        paddingTop: 10,
                        borderTop: "1px solid #edf1ef",
                        display: "flex",
                        flexWrap: "wrap",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                        <input
                          type="checkbox"
                          checked={line.verified}
                          onChange={(e) => updateLine(item.itemId, { verified: e.target.checked })}
                          style={{ width: 17, height: 17, accentColor: "var(--green)" }}
                        />
                        <span>Physical condition inspected & verified</span>
                      </label>

                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                        {orderedCategories(categories).map((category) => {
                          const isCategoryClear = category.isClear
                          const isSelected = isCategoryClear
                            ? isClear
                            : currentIssue?.categoryCode === category.code
                          const theme = getCategoryTheme(category.code)
                          return (
                            <button
                              key={category.code}
                              type="button"
                              className={`verification-issue-btn verification-issue-${category.code} ${isSelected ? "selected" : ""}`}
                              style={{
                                height: 30,
                                padding: "0 10px",
                                fontSize: 11,
                                fontWeight: 700,
                                borderRadius: 6,
                                cursor: "pointer",
                                border: `1.5px solid ${isSelected ? theme.primary : theme.border}`,
                                background: isSelected ? theme.bgSelected : theme.bgLight,
                                color: isSelected ? theme.textSelected : theme.textLight,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                boxShadow: isSelected ? `0 2px 4px ${theme.primary}33` : "none",
                                transition: "all 0.15s ease",
                              }}
                              onClick={() => {
                                recordIssueUsage(category.code)
                                if (isCategoryClear) {
                                  updateLine(item.itemId, {
                                    verified: true,
                                    received: String(item.expectedQty),
                                    issues: [],
                                  })
                                } else if (category.isMissing) {
                                  updateLine(item.itemId, {
                                    verified: true,
                                    received: "0",
                                    issues: [
                                      {
                                        uid: nextUid(),
                                        categoryCode: category.code,
                                        subIssueId: "",
                                        qty: String(item.expectedQty),
                                        ticketCode: "",
                                        notes: "",
                                      },
                                    ],
                                  })
                                } else {
                                  // Iron Send, Damaged, Wrong, SKU Change, Size Change, Other, etc.
                                  const receivedQty =
                                    line.received === "0" ? String(item.expectedQty) : line.received || String(item.expectedQty)
                                  updateLine(item.itemId, {
                                    verified: true,
                                    received: receivedQty,
                                    issues: [
                                      {
                                        uid: nextUid(),
                                        categoryCode: category.code,
                                        subIssueId: "",
                                        qty: String(item.expectedQty),
                                        ticketCode: "",
                                        notes: "",
                                      },
                                    ],
                                  })
                                }
                              }}
                              title={category.label}
                            >
                              {isCategoryClear && <Icon name="check" size={11} />}
                              {chipLabel(category)}
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    {hasIssue && currentIssue && (
                      <div
                        style={{
                          marginTop: 8,
                          padding: "8px 10px",
                          background: currentTheme?.bgLight ?? "#fef5ef",
                          border: `1px solid ${currentTheme?.border ?? "#dec6b6"}`,
                          borderRadius: 7,
                          fontSize: 11,
                        }}
                      >
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span style={{ fontWeight: 700, color: currentTheme?.primary ?? "#9a4f23" }}>
                            Issue: {chipLabel(categories.find((c) => c.code === currentIssue.categoryCode) ?? { code: currentIssue.categoryCode, label: currentIssue.categoryCode.replace(/_/g, " "), isClear: false, isMissing: false, requiresTicket: false, allowsSubIssue: false, requiresSubIssue: false })}
                          </span>
                          {subIssues.filter((s) => s.categoryCode === currentIssue.categoryCode).length > 0 && (
                            <select
                              value={currentIssue.subIssueId || ""}
                              onChange={(e) => {
                                const subId = e.target.value
                                updateLine(item.itemId, {
                                  issues: [{ ...currentIssue, subIssueId: subId }],
                                })
                              }}
                              style={{ height: 26, fontSize: 11 }}
                            >
                              <option value="">Select sub-issue…</option>
                              {subIssues
                                .filter((s) => s.categoryCode === currentIssue.categoryCode)
                                .map((s) => (
                                  <option key={s.id} value={String(s.id)}>
                                    {s.label}
                                  </option>
                                ))}
                            </select>
                          )}
                          <input
                            type="text"
                            placeholder={currentIssue.categoryCode === "iron_send" ? "Optional iron/pressing note" : "Optional issue notes"}
                            value={currentIssue.notes || ""}
                            onChange={(e) => {
                              updateLine(item.itemId, {
                                issues: [{ ...currentIssue, notes: e.target.value }],
                              })
                            }}
                            style={{
                              flex: 1,
                              minWidth: 160,
                              height: 26,
                              padding: "0 7px",
                              fontSize: 11,
                              borderRadius: 5,
                              border: `1px solid ${currentTheme?.border ?? "#dec6b6"}`,
                              background: "#ffffff",
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div
              style={{
                marginTop: 16,
                paddingTop: 12,
                borderTop: "1px solid var(--line)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                {!canSave && (
                  <span style={{ color: "var(--red)", fontSize: 12, fontWeight: 600 }}>
                    {problems[0] || "Tick the physical check for every item before saving"}
                  </span>
                )}
                {canSave && (
                  <span style={{ color: "var(--green)", fontSize: 12, fontWeight: 600 }}>
                    Physical verification complete. Ready to save to PostgreSQL register.
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={resetForNext}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn success"
                  style={{ minWidth: 150, height: 38, fontSize: 13, fontWeight: 700 }}
                  onClick={() => void save()}
                  disabled={!canSave || saving}
                >
                  <Icon name="check" size={15} /> {saving ? "Saving…" : "Save Return (Enter)"}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
      {previewOpen && previewImage && (
        <Modal wide onClose={() => setPreviewOpen(false)}>
          <button className="modal-close" onClick={() => setPreviewOpen(false)} aria-label="Close">
            <Icon name="close" />
          </button>
          <div className="full-product-preview">
            <img src={previewImage} alt={`Large catalog reference of ${item?.productName || "the item"}`} />
          </div>
        </Modal>
      )}
    </div>
  )
}
