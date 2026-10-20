import { useEffect, useMemo, useState, type MouseEvent } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  FileText,
  Link2,
  MailOpen,
  MoreVertical,
  RefreshCw,
  Star,
  Trash2,
} from "lucide-react"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { useCompose } from "../compose"
import { EngagementTags } from "../components/EngagementTags"
import { EmptyState } from "../components/ui"
import { relativeTime } from "../labels"
import type { MessageSummary } from "../types"
import { canSend } from "../types"

type FolderId = "sent" | "drafts" | "attention" | "failed" | "all"
type TabId = "all" | "opened" | "links" | "files" | "quiet"

const FOLDER_TITLE: Record<FolderId, string> = {
  sent: "Sent",
  drafts: "Drafts",
  attention: "Unopened",
  failed: "Failed",
  all: "All mail",
}

const TABS: { id: TabId; label: string; icon: typeof Eye; tone?: string }[] = [
  { id: "all", label: "Primary", icon: MailOpen },
  { id: "opened", label: "Opened", icon: Eye, tone: "open" },
  { id: "links", label: "Links", icon: Link2, tone: "link" },
  { id: "files", label: "Files", icon: FileText, tone: "file" },
  { id: "quiet", label: "Quiet", icon: Clock, tone: "quiet" },
]

function loadStars(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("mi_stars") || "[]") as string[])
  } catch {
    return new Set()
  }
}

function saveStars(stars: Set<string>) {
  localStorage.setItem("mi_stars", JSON.stringify([...stars]))
}

function matchesTab(item: MessageSummary, tab: TabId) {
  const e = item.engagement
  if (tab === "all") return true
  if (tab === "opened") return e.estimated_opens > 0
  if (tab === "links") return e.link_clicks > 0
  if (tab === "files") return e.document_views > 0
  return item.send_status === "sent" && e.estimated_opens === 0 && e.link_clicks === 0 && e.document_views === 0
}

function formatListTime(value: string | null) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function MailPage() {
  const { openCompose } = useCompose()
  const { workspaceId, membership, toast } = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [items, setItems] = useState<MessageSummary[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [stars, setStars] = useState<Set<string>>(() => loadStars())
  const [page, setPage] = useState(0)
  const pageSize = 50
  const q = params.get("q") || ""
  const folder = (params.get("folder") as FolderId) || "sent"
  const tab = (params.get("tab") as TabId) || "all"
  const canManage = canSend(membership?.role)

  useEffect(() => {
    document.title = `${FOLDER_TITLE[folder] || "Mail"} - MailInsider`
  }, [folder])

  function reload() {
    setLoading(true)
    setError("")
    const search = new URLSearchParams()
    if (q) search.set("q", q)
    if (folder === "attention") search.set("attention", "true")
    else if (folder === "sent") search.set("status", "sent")
    else if (folder === "drafts") search.set("status", "draft")
    else if (folder === "failed") search.set("status", "failed")
    search.set("limit", String(pageSize))
    search.set("offset", String(page * pageSize))
    search.set("sort", folder === "drafts" ? "created_at" : "sent_at")
    search.set("order", "desc")
    api<{ items: MessageSummary[]; total: number }>(`/api/v1/messages?${search.toString()}`)
      .then((data) => {
        setItems(data.items)
        setTotal(data.total)
        setSelected(new Set())
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load mail."))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    setPage(0)
  }, [workspaceId, q, folder])

  useEffect(() => {
    reload()
  }, [workspaceId, q, folder, page])

  const visible = useMemo(() => items.filter((item) => matchesTab(item, tab)), [items, tab])

  const tabCounts = useMemo(() => {
    const counts: Record<TabId, number> = { all: items.length, opened: 0, links: 0, files: 0, quiet: 0 }
    for (const item of items) {
      if (item.engagement.estimated_opens > 0) counts.opened += 1
      if (item.engagement.link_clicks > 0) counts.links += 1
      if (item.engagement.document_views > 0) counts.files += 1
      if (
        item.send_status === "sent" &&
        item.engagement.estimated_opens === 0 &&
        item.engagement.link_clicks === 0 &&
        item.engagement.document_views === 0
      ) {
        counts.quiet += 1
      }
    }
    return counts
  }, [items])

  function setTab(next: TabId) {
    const updated = new URLSearchParams(params)
    if (next === "all") updated.delete("tab")
    else updated.set("tab", next)
    setParams(updated)
  }

  function toggleStar(id: string, event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    setStars((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveStars(next)
      return next
    })
  }

  function toggleSelect(id: string, event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selected.size === visible.length) setSelected(new Set())
    else setSelected(new Set(visible.map((item) => item.id)))
  }

  async function deleteMessages(ids: string[]) {
    if (!canManage || !ids.length || deleting) return
    const label = ids.length === 1 ? "this conversation" : `${ids.length} conversations`
    if (!window.confirm(`Delete ${label} from MailInsider? This does not unsend from Gmail.`)) return
    setDeleting(true)
    try {
      for (const id of ids) {
        await api(`/api/v1/messages/${id}`, { method: "DELETE" })
      }
      toast(ids.length === 1 ? "Deleted." : `Deleted ${ids.length} conversations.`)
      setStars((current) => {
        const next = new Set(current)
        for (const id of ids) next.delete(id)
        saveStars(next)
        return next
      })
      reload()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not delete.", "bad")
    } finally {
      setDeleting(false)
    }
  }

  const rangeStart = total === 0 ? 0 : page * pageSize + 1
  const rangeEnd = Math.min(total, (page + 1) * pageSize)

  return (
    <div className="gmail-inbox">
      <div className="gmail-tabs" role="tablist" aria-label="Categories">
        {TABS.map((item) => {
          const Icon = item.icon
          const active = tab === item.id
          const count = tabCounts[item.id]
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`gmail-tab ${active ? "is-active" : ""} ${item.tone ? `tone-${item.tone}` : ""}`}
              onClick={() => setTab(item.id)}
            >
              <Icon size={18} aria-hidden />
              <span>{item.label}</span>
              {count > 0 && item.id !== "all" ? <span className="gmail-tab-badge">{count}</span> : null}
            </button>
          )
        })}
      </div>

      <div className="gmail-toolbar">
        <div className="gmail-toolbar-left">
          <label className="gmail-check">
            <input
              type="checkbox"
              checked={visible.length > 0 && selected.size === visible.length}
              onChange={toggleSelectAll}
              aria-label="Select all"
            />
          </label>
          <button type="button" className="gmail-icon-btn" aria-label="Refresh" onClick={reload}>
            <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
          </button>
          {selected.size > 0 && canManage ? (
            <button
              type="button"
              className="gmail-icon-btn"
              aria-label="Delete selected"
              title="Delete selected"
              disabled={deleting}
              onClick={() => void deleteMessages([...selected])}
            >
              <Trash2 size={18} />
            </button>
          ) : null}
          <button type="button" className="gmail-icon-btn" aria-label="More">
            <MoreVertical size={18} />
          </button>
          {selected.size > 0 ? (
            <span className="text-sm text-[#5f6368]">{selected.size} selected</span>
          ) : null}
        </div>
        <div className="gmail-toolbar-right">
          <span className="text-xs text-[#5f6368]">
            {loading ? "Loading…" : `${rangeStart}–${rangeEnd} of ${total}`}
          </span>
          <button
            type="button"
            className="gmail-icon-btn"
            aria-label="Newer"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            className="gmail-icon-btn"
            aria-label="Older"
            disabled={rangeEnd >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {error ? <div className="banner bad m-3">{error}</div> : null}

      {!loading && visible.length === 0 && !error ? (
        <div className="p-12">
          <EmptyState
            title="No conversations in this view"
            body="Try another tab or folder. Tracking tags appear after opens, link views, or file views."
          >
            {canSend(membership?.role) ? (
              <button type="button" className="gmail-compose" onClick={() => openCompose()}>
                Compose
              </button>
            ) : null}
          </EmptyState>
        </div>
      ) : (
        <div className="gmail-thread-list" role="list">
          {visible.map((item) => {
            const lead = item.recipients_preview[0]
            const quiet =
              item.send_status === "sent" &&
              item.engagement.estimated_opens === 0 &&
              item.engagement.link_clicks === 0 &&
              item.engagement.document_views === 0
            const starred = stars.has(item.id)
            const isSelected = selected.has(item.id)
            const who = lead ? lead.name || lead.email : "No recipients"
            const extra = item.recipient_count > 1 ? ` +${item.recipient_count - 1}` : ""

            return (
              <div
                key={item.id}
                role="listitem"
                className={`gmail-thread ${quiet ? "is-unread" : ""} ${isSelected ? "is-selected" : ""}`}
                onClick={() => navigate(`/app/mail/${item.id}`)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") navigate(`/app/mail/${item.id}`)
                }}
                tabIndex={0}
              >
                <button
                  type="button"
                  className="gmail-check"
                  aria-label="Select"
                  onClick={(event) => toggleSelect(item.id, event)}
                >
                  <input type="checkbox" checked={isSelected} readOnly tabIndex={-1} />
                </button>
                <button
                  type="button"
                  className={`gmail-star ${starred ? "is-on" : ""}`}
                  aria-label={starred ? "Unstar" : "Star"}
                  onClick={(event) => toggleStar(item.id, event)}
                >
                  <Star size={18} fill={starred ? "currentColor" : "none"} />
                </button>
                <div className={`gmail-thread-who ${quiet ? "is-strong" : ""}`}>
                  {who}
                  {extra}
                </div>
                <div className="gmail-thread-main min-w-0">
                  <div className="gmail-thread-line">
                    <span className={`gmail-thread-subject ${quiet ? "is-strong" : ""}`}>
                      {item.subject || "(no subject)"}
                    </span>
                    <span className="gmail-thread-dash"> — </span>
                    <span className="gmail-thread-snippet">{item.preview || ""}</span>
                  </div>
                  <div className="gmail-thread-chips">
                    <EngagementTags item={item} dense />
                  </div>
                </div>
                <div className="gmail-thread-meta">
                  <span className="gmail-thread-time">{formatListTime(item.sent_at || item.created_at)}</span>
                  <div className="gmail-thread-actions">
                    <button
                      type="button"
                      className="gmail-icon-btn"
                      aria-label="Archive"
                      title="Archive is not available yet"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Archive size={18} />
                    </button>
                    <button
                      type="button"
                      className="gmail-icon-btn"
                      aria-label="Delete"
                      title={canManage ? "Delete" : "Viewers cannot delete"}
                      disabled={!canManage || deleting}
                      onClick={(event) => {
                        event.stopPropagation()
                        void deleteMessages([item.id])
                      }}
                    >
                      <Trash2 size={18} />
                    </button>
                    <button
                      type="button"
                      className="gmail-icon-btn"
                      aria-label="Mark"
                      onClick={(event) => {
                        event.stopPropagation()
                        navigate(`/app/mail/${item.id}`)
                      }}
                    >
                      <MailOpen size={18} />
                    </button>
                    <button
                      type="button"
                      className="gmail-icon-btn"
                      aria-label="Snooze"
                      title="Use Follow-ups for reminders"
                      onClick={(event) => {
                        event.stopPropagation()
                        navigate("/app/follow-ups")
                      }}
                    >
                      <Clock size={18} />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="gmail-list-foot">
        <span className="text-xs text-[#80868b]">
          Last refreshed {relativeTime(new Date().toISOString()) === "just now" ? "just now" : "recently"}
        </span>
      </div>
    </div>
  )
}
