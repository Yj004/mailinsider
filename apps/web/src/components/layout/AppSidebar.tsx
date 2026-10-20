import { NavLink, Link, useSearchParams, useLocation } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import {
  AlertCircle,
  BookOpen,
  ChevronDown,
  Clock,
  FileEdit,
  FileText,
  Files,
  Inbox,
  LineChart,
  Mail,
  Megaphone,
  PenLine,
  Send,
  Settings,
  Tags,
  Unplug,
  Users,
} from "lucide-react"
import { api } from "../../api"
import { useAuth } from "../../auth"
import { useCompose } from "../../compose"
import type { ContactRecord, Overview } from "../../types"
import { canSend } from "../../types"

type FolderId = "sent" | "drafts" | "attention" | "failed" | "all"

const FOLDERS: { id: FolderId; label: string; icon: typeof Inbox }[] = [
  { id: "sent", label: "Sent", icon: Send },
  { id: "drafts", label: "Drafts", icon: FileEdit },
  { id: "attention", label: "Unopened", icon: Inbox },
  { id: "failed", label: "Failed", icon: AlertCircle },
  { id: "all", label: "All mail", icon: Mail },
]

export function AppSidebar({
  collapsed,
  onToggle,
  onNavigate,
}: {
  collapsed: boolean
  onToggle: () => void
  onNavigate?: () => void
}) {
  const { membership, memberships, setWorkspace, workspaceId } = useAuth()
  const { openCompose } = useCompose()
  const [params] = useSearchParams()
  const location = useLocation()
  const folder = (params.get("folder") as FolderId) || "sent"
  const onMail = location.pathname.startsWith("/app/mail")

  const followUps = useQuery({
    queryKey: ["follow-ups", workspaceId],
    queryFn: () => api<{ due_count: number; due: ContactRecord[] }>("/api/v1/contacts/follow-ups"),
  })
  const quota = useQuery({
    queryKey: ["quota", workspaceId],
    queryFn: () => api<Overview>("/api/v1/analytics/overview"),
  })
  const dueCount = followUps.data?.due_count ?? 0

  return (
    <aside className={`gmail-rail ${collapsed ? "is-collapsed" : ""}`}>
      {canSend(membership?.role) ? (
        <div className={`gmail-rail-compose ${collapsed ? "is-collapsed" : ""}`}>
          <button
            type="button"
            className={`gmail-compose ${collapsed ? "is-icon" : ""}`}
            title="Compose"
            onClick={() => {
              openCompose()
              onNavigate?.()
            }}
          >
            <PenLine size={20} strokeWidth={1.75} aria-hidden />
            {collapsed ? null : <span>Compose</span>}
          </button>
        </div>
      ) : null}

      {memberships.length > 1 && !collapsed ? (
        <label className="mx-3 mb-2 block">
          <span className="sr">Workspace</span>
          <select className="gmail-select" value={membership?.workspace_id} onChange={(e) => setWorkspace(e.target.value)}>
            {memberships.map((item) => (
              <option key={item.workspace_id} value={item.workspace_id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <nav aria-label="Mailbox" className="gmail-rail-nav">
        {FOLDERS.map((item) => {
          const Icon = item.icon
          const active = onMail && folder === item.id
          return (
            <Link
              key={item.id}
              to={`/app/mail?folder=${item.id}`}
              title={item.label}
              onClick={onNavigate}
              className={`gmail-rail-item ${active ? "is-active" : ""} ${collapsed ? "is-collapsed" : ""}`}
            >
              <Icon size={20} strokeWidth={1.75} aria-hidden />
              {collapsed ? null : <span className="flex-1">{item.label}</span>}
              {!collapsed && item.id === "sent" && quota.data?.messages != null ? (
                <span className="gmail-rail-count">{quota.data.messages}</span>
              ) : null}
            </Link>
          )
        })}

        <Link
          to="/app/follow-ups"
          title="Follow-ups"
          onClick={onNavigate}
          className={`gmail-rail-item ${location.pathname.startsWith("/app/follow-ups") ? "is-active" : ""} ${collapsed ? "is-collapsed" : ""}`}
        >
          <Clock size={20} strokeWidth={1.75} aria-hidden />
          {collapsed ? null : (
            <>
              <span className="flex-1">Follow-ups</span>
              {dueCount > 0 ? <span className="gmail-count">{dueCount}</span> : null}
            </>
          )}
        </Link>

        {!collapsed ? (
          <details className="gmail-more">
            <summary>
              <ChevronDown size={16} aria-hidden />
              More
            </summary>
            <p className="gmail-more-note">Starred, Snoozed, Archive, Spam, and Trash need Gmail inbox sync (not enabled).</p>
          </details>
        ) : null}
      </nav>

      {!collapsed ? (
        <>
          <div className="gmail-rail-label-head">
            <span>Workspace</span>
          </div>
          <nav aria-label="Workspace" className="gmail-rail-nav">
            <NavLink to="/app/labels" className={({ isActive }) => `gmail-rail-item ${isActive ? "is-active" : ""}`} onClick={onNavigate}>
              <Tags size={20} strokeWidth={1.75} aria-hidden />
              <span className="flex-1">Labels</span>
            </NavLink>
            <NavLink to="/app/contacts" className={({ isActive }) => `gmail-rail-item ${isActive ? "is-active" : ""}`} onClick={onNavigate}>
              <Users size={20} strokeWidth={1.75} aria-hidden />
              <span className="flex-1">Contacts</span>
            </NavLink>
            <NavLink to="/app/campaigns" className={({ isActive }) => `gmail-rail-item ${isActive ? "is-active" : ""}`} onClick={onNavigate}>
              <Megaphone size={20} strokeWidth={1.75} aria-hidden />
              <span className="flex-1">Campaigns</span>
            </NavLink>
            <NavLink to="/app/templates" className={({ isActive }) => `gmail-rail-item ${isActive ? "is-active" : ""}`} onClick={onNavigate}>
              <FileText size={20} strokeWidth={1.75} aria-hidden />
              <span className="flex-1">Templates</span>
            </NavLink>
            <NavLink to="/app/documents" className={({ isActive }) => `gmail-rail-item ${isActive ? "is-active" : ""}`} onClick={onNavigate}>
              <Files size={20} strokeWidth={1.75} aria-hidden />
              <span className="flex-1">Documents</span>
            </NavLink>
            <NavLink to="/app/ai-pr" className={({ isActive }) => `gmail-rail-item ${isActive ? "is-active" : ""}`} onClick={onNavigate}>
              <BookOpen size={20} strokeWidth={1.75} aria-hidden />
              <span className="flex-1">AI P&amp;R</span>
            </NavLink>
            <NavLink to="/app/insights" className={({ isActive }) => `gmail-rail-item ${isActive ? "is-active" : ""}`} onClick={onNavigate}>
              <LineChart size={20} strokeWidth={1.75} aria-hidden />
              <span className="flex-1">Insights</span>
            </NavLink>
            <NavLink to="/app/integrations" className={({ isActive }) => `gmail-rail-item ${isActive ? "is-active" : ""}`} onClick={onNavigate}>
              <Unplug size={20} strokeWidth={1.75} aria-hidden />
              <span className="flex-1">Integrations</span>
            </NavLink>
            <NavLink to="/app/settings" className={({ isActive }) => `gmail-rail-item ${isActive ? "is-active" : ""}`} onClick={onNavigate}>
              <Settings size={20} strokeWidth={1.75} aria-hidden />
              <span className="flex-1">Settings</span>
            </NavLink>
          </nav>
        </>
      ) : null}

      {collapsed ? (
        <button type="button" className="gmail-icon-btn mx-auto mt-auto mb-3" onClick={onToggle} aria-label="Expand sidebar">
          <ChevronDown size={18} className="-rotate-90" />
        </button>
      ) : null}
    </aside>
  )
}
