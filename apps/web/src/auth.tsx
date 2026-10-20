import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { api } from "./api"
import type { Membership, Role, SessionResponse, User } from "./types"

type Toast = { id: number; message: string; tone: "ok" | "bad" }

type AuthValue = {
  ready: boolean
  user: User | null
  memberships: Membership[]
  workspaceId: string
  membership: Membership | undefined
  setSession: (session: SessionResponse) => void
  setWorkspace: (id: string) => void
  refresh: () => Promise<void>
  logout: () => void
  toast: (message: string, tone?: "ok" | "bad") => void
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [workspaceId, setWorkspaceId] = useState(localStorage.getItem("mi_workspace") || "")
  const [toasts, setToasts] = useState<Toast[]>([])

  function toast(message: string, tone: "ok" | "bad" = "ok") {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, message, tone }])
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4200)
  }

  function applyMemberships(next: Membership[], preferred?: string) {
    setMemberships(next)
    const stored = preferred || localStorage.getItem("mi_workspace") || ""
    const valid = next.some((item) => item.workspace_id === stored)
    const chosen = valid ? stored : next[0]?.workspace_id || ""
    localStorage.setItem("mi_workspace", chosen)
    setWorkspaceId(chosen)
  }

  async function refresh() {
    const data = await api<{ user: User; memberships: Membership[] }>("/api/v1/auth/me")
    setUser(data.user)
    applyMemberships(data.memberships)
  }

  useEffect(() => {
    const token = localStorage.getItem("mi_token")
    if (!token) {
      setReady(true)
      return
    }
    refresh()
      .catch(() => {
        localStorage.removeItem("mi_token")
        setUser(null)
      })
      .finally(() => setReady(true))
  }, [])

  function setSession(session: SessionResponse) {
    localStorage.setItem("mi_token", session.access_token)
    setUser(session.user)
    applyMemberships(session.memberships, session.memberships[0]?.workspace_id)
  }

  function setWorkspace(id: string) {
    localStorage.setItem("mi_workspace", id)
    setWorkspaceId(id)
  }

  function logout() {
    localStorage.removeItem("mi_token")
    setUser(null)
    window.location.assign("/login")
  }

  const membership = memberships.find((item) => item.workspace_id === workspaceId)
  const value = useMemo(
    () => ({ ready, user, memberships, workspaceId, membership, setSession, setWorkspace, refresh, logout, toast }),
    [ready, user, memberships, workspaceId, membership],
  )

  return (
    <AuthContext.Provider value={value}>
      {children}
      <div className="toast-wrap" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast ${item.tone === "bad" ? "bad" : ""}`}>
            {item.message}
          </div>
        ))}
      </div>
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error("AuthProvider is missing")
  return value
}

export function useRole(): Role | undefined {
  return useAuth().membership?.role
}
