import { createContext, useContext } from "react"
import type { Page, SessionUser } from "./types"

// Shared state for the signed-in workspace: the user, the claims badge, the header date,
// and navigation. Pages read it through useWorkspace().
export type WorkspaceValue = {
  user: SessionUser
  claimsBadge: string
  headerDate: string
  openPage: (page: Page) => void
  setClaimsBadge: (value: string) => void
}

export const WorkspaceContext = createContext<WorkspaceValue | null>(null)

export function useWorkspace() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error("Workspace missing")
  return value
}
