import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Bell, HelpCircle, Menu, Search, Settings, SlidersHorizontal } from "lucide-react"
import { Link, useNavigate } from "react-router-dom"
import { BrandLockup } from "../BrandMark"
import { api } from "../../api"
import { useAuth } from "../../auth"
import { relativeTime } from "../../labels"
import type { ActivityItem, ConnectionsResponse } from "../../types"

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { user, logout, workspaceId } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState<"notifications" | "account" | null>(null)
  const connections = useQuery({
    queryKey: ["gmail", workspaceId],
    queryFn: () => api<ConnectionsResponse>("/api/v1/integrations/gmail/connections"),
  })
  const activity = useQuery({
    queryKey: ["activity", workspaceId],
    queryFn: () => api<{ items: ActivityItem[] }>("/api/v1/analytics/activity?limit=6"),
  })
  const connected = connections.data?.connections.filter((item) => item.status === "connected") || []
  const initials = (user?.display_name || user?.email || "?")
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("")

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        document.getElementById("global-search")?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <header className="gmail-header">
      <div className="gmail-header-left">
        <button type="button" className="gmail-icon-btn" onClick={onMenu} aria-label="Main menu">
          <Menu size={20} />
        </button>
        <BrandLockup to="/app/mail" />
      </div>

      <form
        className="gmail-search-wrap"
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          navigate(`/app/mail?folder=all&q=${encodeURIComponent(String(data.get("q") || ""))}`)
        }}
      >
        <div className="gmail-search">
          <Search size={20} className="text-[#5f6368]" aria-hidden />
          <label className="sr" htmlFor="global-search">
            Search mail
          </label>
          <input id="global-search" name="q" type="search" placeholder="Search mail" autoComplete="off" />
          <button type="button" className="gmail-icon-btn" aria-label="Show search options" tabIndex={-1}>
            <SlidersHorizontal size={18} />
          </button>
        </div>
      </form>

      <div className="gmail-header-right">
        <Link to="/pricing" className="gmail-upgrade hidden sm:inline-flex">
          Upgrade
        </Link>
        <button type="button" className="gmail-icon-btn hidden sm:inline-flex" aria-label="Support" onClick={() => navigate("/contact")}>
          <HelpCircle size={20} />
        </button>
        <button type="button" className="gmail-icon-btn" aria-label="Settings" onClick={() => navigate("/app/settings")}>
          <Settings size={20} />
        </button>
        <div className="relative">
          <button type="button" className="gmail-icon-btn" aria-label="Notifications" onClick={() => setOpen(open === "notifications" ? null : "notifications")}>
            <Bell size={20} />
          </button>
          {open === "notifications" ? (
            <div className="gmail-menu">
              <div className="mb-2 px-1 text-sm font-medium">Activity</div>
              {(activity.data?.items || []).length === 0 ? <p className="px-1 text-sm text-[#5f6368]">Nothing yet.</p> : null}
              {(activity.data?.items || []).map((item) => (
                <Link
                  key={item.id}
                  to={item.message_id ? `/app/mail/${item.message_id}` : "/app/mail"}
                  className="gmail-menu-item"
                  onClick={() => setOpen(null)}
                >
                  <div className="font-medium">{item.subject || item.kind}</div>
                  <div className="text-xs text-[#5f6368]">
                    {item.actor || "System"} · {relativeTime(item.occurred_at)}
                  </div>
                </Link>
              ))}
            </div>
          ) : null}
        </div>
        <div className="relative">
          <button type="button" className="gmail-avatar" aria-label="Google Account" onClick={() => setOpen(open === "account" ? null : "account")}>
            {initials}
          </button>
          {open === "account" ? (
            <div className="gmail-menu gmail-menu-account">
              <div className="px-2 py-2 text-center">
                <div className="gmail-avatar mx-auto mb-2 h-14 w-14 text-xl">{initials}</div>
                <div className="font-medium">{user?.display_name}</div>
                <div className="text-xs text-[#5f6368]">{user?.email}</div>
                <div className="mt-1 text-xs text-[#5f6368]">{connected.length ? "Gmail connected" : "Gmail not connected"}</div>
              </div>
              <Link className="gmail-menu-item" to="/app/settings" onClick={() => setOpen(null)}>
                Settings
              </Link>
              <Link className="gmail-menu-item" to="/app/team" onClick={() => setOpen(null)}>
                Team
              </Link>
              <Link className="gmail-menu-item" to="/app/integrations" onClick={() => setOpen(null)}>
                Integrations
              </Link>
              <button type="button" className="gmail-menu-item w-full border-0 bg-transparent text-left" onClick={logout}>
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  )
}
