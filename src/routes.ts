import type { Page } from "./types"

// Each workspace tab has its own address. A refresh stays on that tab.
export const PAGE_PATH: Record<Page, string> = {
  dashboard: "/",
  scan: "/scan",
  reports: "/register",
  claims: "/claims",
  uploads: "/uploads",
  admin: "/admin",
}

export function pageFromPath(pathname: string): Page {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
  const found = (Object.keys(PAGE_PATH) as Page[]).find((page) => PAGE_PATH[page] === path)
  return found ?? "dashboard"
}
