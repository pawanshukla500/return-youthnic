import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { OperatorProfile } from '../types/engine'
import { isSessionError } from '../services/engineApi'

type SessionContextValue = {
  /** Signed-in operator profile, or null when the gate has not been passed. */
  user: OperatorProfile | null
  /** Called by the login gate after a successful POST /api/operator/login. */
  setUser: (user: OperatorProfile) => void
  /** Clears the signed-in profile (logout, or a 401 from the engine). */
  clearSession: () => void
  /**
   * Feeds a caught engine error to the session: a 401 clears it. Returns true
   * when the error was a session error so callers can avoid double-reporting.
   */
  handleAuthError: (error: unknown) => boolean
  /** Monotonic counter incremented on every session change to guard against race conditions. */
  sessionEpoch: number
}

const SessionContext = createContext<SessionContextValue>({
  user: null,
  setUser: () => undefined,
  clearSession: () => undefined,
  handleAuthError: () => false,
  sessionEpoch: 0,
})

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<OperatorProfile | null>(null)
  const [sessionEpoch, setSessionEpoch] = useState(0)

  const setUser = useCallback((next: OperatorProfile) => {
    setUserState(next)
    setSessionEpoch((e) => e + 1)
  }, [])

  const clearSession = useCallback(() => {
    setUserState(null)
    setSessionEpoch((e) => e + 1)
  }, [])

  const handleAuthError = useCallback(
    (error: unknown) => {
      if (isSessionError(error)) {
        setUserState(null)
        setSessionEpoch((e) => e + 1)
        return true
      }
      return false
    },
    [],
  )

  const value = useMemo(
    () => ({ user, setUser, clearSession, handleAuthError, sessionEpoch }),
    [user, setUser, clearSession, handleAuthError, sessionEpoch],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  return useContext(SessionContext)
}
