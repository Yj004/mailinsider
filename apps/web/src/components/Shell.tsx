import { useEffect, useState } from "react"
import { Outlet } from "react-router-dom"
import { api } from "../api"
import { useAuth } from "../auth"
import { ComposeProvider, useCompose } from "../compose"
import { canSend } from "../types"
import { ComposeModal } from "../pages/ComposePage"
import { AppSidebar } from "./layout/AppSidebar"
import { Topbar } from "./layout/Topbar"

const WORKSPACE_REPLY_SYNC_MS = 120_000

export function Shell() {
  return (
    <ComposeProvider>
      <ShellInner />
    </ComposeProvider>
  )
}

function ShellInner() {
  const { membership, workspaceId } = useAuth()
  const { open, draft, openCompose, closeCompose } = useCompose()
  const send = canSend(membership?.role)
  const [collapsed, setCollapsed] = useState(localStorage.getItem("mi_sidebar") === "1")
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    localStorage.setItem("mi_sidebar", collapsed ? "1" : "0")
  }, [collapsed])

  useEffect(() => {
    if (!send || !workspaceId) return
    let cancelled = false
    let inFlight = false
    function syncAll() {
      if (cancelled || inFlight || document.visibilityState === "hidden") return
      inFlight = true
      api<{ new_replies: number }>("/api/v1/messages/sync-replies-all?limit=10", { method: "POST" })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false
        })
    }
    const kickoff = window.setTimeout(syncAll, 2_500)
    const interval = window.setInterval(syncAll, WORKSPACE_REPLY_SYNC_MS)
    function onVisible() {
      if (document.visibilityState === "visible") syncAll()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      window.clearTimeout(kickoff)
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [send, workspaceId])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      if (event.key === "/" && !typing) {
        event.preventDefault()
        document.getElementById("global-search")?.focus()
      }
      if ((event.key === "c" || event.key === "C") && !typing && !event.metaKey && !event.ctrlKey && send) {
        event.preventDefault()
        openCompose()
      }
      if (event.key === "Escape" && open) {
        event.preventDefault()
        closeCompose()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [openCompose, closeCompose, open, send])

  function toggleSidebar() {
    if (window.matchMedia("(max-width: 1023px)").matches) {
      setMobileOpen((v) => !v)
    } else {
      setCollapsed((v) => !v)
    }
  }

  return (
    <div className="gmail-app">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <Topbar onMenu={toggleSidebar} />
      <div className="gmail-app-body">
        <div className={`gmail-app-side ${collapsed ? "is-collapsed" : ""} hidden lg:block`}>
          <AppSidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
        </div>
        {mobileOpen ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button type="button" className="absolute inset-0 border-0 bg-black/40" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />
            <div className="relative h-full w-[280px] bg-[#f5f5f7]">
              <AppSidebar collapsed={false} onToggle={() => setMobileOpen(false)} onNavigate={() => setMobileOpen(false)} />
            </div>
          </div>
        ) : null}
        <main id="content" className="gmail-app-main">
          <Outlet />
        </main>
      </div>
      {open ? <ComposeModal draft={draft} onClose={closeCompose} /> : null}
    </div>
  )
}
