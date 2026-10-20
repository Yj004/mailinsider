import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { EmptyState } from "../components/ui"
import { MessageList } from "../components/MessageList"
import type { MessageSummary } from "../types"
import { canSend } from "../types"

const FILTERS = [
  { id: "", label: "All" },
  { id: "attention", label: "Needs a look" },
  { id: "sent", label: "Sent" },
  { id: "failed", label: "Failed" },
  { id: "needs_review", label: "Needs review" },
  { id: "draft", label: "Drafts" },
]

export function MessagesPage() {
  const { workspaceId, membership } = useAuth()
  const [params, setParams] = useSearchParams()
  const [items, setItems] = useState<MessageSummary[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState("")
  const q = params.get("q") || ""
  const filter = params.get("attention") === "1" ? "attention" : params.get("status") || ""

  useEffect(() => {
    document.title = "Messages — MailInsider"
  }, [])

  useEffect(() => {
    const search = new URLSearchParams()
    if (q) search.set("q", q)
    if (filter === "attention") search.set("attention", "true")
    else if (filter) search.set("status", filter)
    search.set("limit", "30")
    api<{ items: MessageSummary[]; total: number }>(`/api/v1/messages?${search.toString()}`)
      .then((data) => {
        setItems(data.items)
        setTotal(data.total)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load messages."))
  }, [workspaceId, q, filter])

  function setFilter(next: string) {
    const updated = new URLSearchParams(params)
    updated.delete("status")
    updated.delete("attention")
    if (next === "attention") updated.set("attention", "1")
    else if (next) updated.set("status", next)
    setParams(updated)
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Messages</h1>
          <p className="sub">{total} sent or drafted messages in this view. This is not a received-mail inbox.</p>
        </div>
        {canSend(membership?.role) ? (
          <Link className="btn primary" to="/app/compose">
            Compose
          </Link>
        ) : null}
      </div>
      <div className="filters" role="tablist" aria-label="Message filters">
        {FILTERS.map((item) => (
          <button key={item.id || "all"} className={filter === item.id ? "on" : ""} onClick={() => setFilter(item.id)} type="button">
            {item.label}
          </button>
        ))}
      </div>
      {error ? <div className="banner bad">{error}</div> : null}
      {items.length === 0 && !error ? (
        <EmptyState title="Nothing matches." body="Try another filter, or write the next message.">
          {canSend(membership?.role) ? (
            <Link className="btn primary" to="/app/compose">
              Compose
            </Link>
          ) : null}
        </EmptyState>
      ) : (
        <MessageList items={items} />
      )}
    </div>
  )
}
