// An error from the API. `message` is the server's `error` text. `details` lists the rule problems the server found,
// when there are several. `body` is the whole response, so a caller can read fields such as `time` or `scannedBy`.
export class ApiError extends Error {
  status: number
  details: string[]
  body: Record<string, unknown>
  constructor(message: string, status: number, details: string[] = [], body: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.details = details
    this.body = body
  }
}

// Purge any legacy token from localStorage to satisfy zero-localStorage security requirement
try {
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.removeItem("return_token")
  }
} catch {
  // Ignore in non-browser contexts
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (!(options.body instanceof FormData) && !headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json")
  }
  // Pure HttpOnly cookie session via credentials: "include"
  const response = await fetch(path, { credentials: "include", ...options, headers })
  const isJson = response.headers.get("content-type")?.includes("application/json")
  const data = isJson ? await response.json().catch(() => null) : null
  if (!response.ok) {
    const details = Array.isArray(data?.details) ? (data.details as unknown[]).map(String) : []
    throw new ApiError(data?.error || `Request failed (${response.status})`, response.status, details, data ?? {})
  }
  return data as T
}

export async function downloadFile(path: string, filename: string) {
  const response = await fetch(path, {
    credentials: "include",
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new ApiError(data?.error || "Download failed", response.status)
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
