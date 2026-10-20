import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { MoreHorizontal } from "lucide-react"
import { api, ApiError } from "../../api"
import { useAuth } from "../../auth"
import { Dialog } from "../../components/ui"
import { sendLabel } from "../../labels"
import type { MessageSummary } from "../../types"
import { canSend } from "../../types"

const PAGE_SIZE = 5

function statusTone(status: MessageSummary["send_status"]) {
  if (status === "sent") return "bg-emerald-50 text-emerald-700"
  if (status === "failed" || status === "needs_review") return "bg-red-50 text-red-700"
  if (status === "partial") return "bg-amber-50 text-amber-800"
  return "bg-slate-100 text-slate-600"
}

function csvCell(value: string | number) {
  const text = String(value)
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

function downloadCsv(items: MessageSummary[]) {
  const header = ["Subject", "Recipients", "Sent at", "Status", "Opens", "Link clicks", "Document views"]
  const rows = items.map((item) => [
    item.subject,
    item.recipients_preview.map((person) => person.email).join("; "),
    item.sent_at || item.created_at,
    sendLabel(item.send_status, item.demo),
    item.engagement.estimated_opens,
    item.engagement.link_clicks,
    item.engagement.document_views,
  ])
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = "mailinsider-emails.csv"
  link.click()
  URL.revokeObjectURL(url)
}

export function RecentEmailsTable({ from, to }: { from: string; to: string }) {
  const { workspaceId, membership, toast } = useAuth()
  const queryClient = useQueryClient()
  const send = canSend(membership?.role)
  const [q, setQ] = useState("")
  const [debounced, setDebounced] = useState("")
  const [status, setStatus] = useState("")
  const [sort, setSort] = useState("sent_at")
  const [order, setOrder] = useState<"asc" | "desc">("desc")
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [menu, setMenu] = useState<string | null>(null)
  const [pending, setPending] = useState<{ id: string; action: "delete" | "retry" } | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(q), 250)
    return () => window.clearTimeout(timer)
  }, [q])

  useEffect(() => {
    setPage(0)
    setSelected([])
  }, [debounced, status, sort, order, from, to, workspaceId])

  const query = useQuery({
    queryKey: ["messages", workspaceId, debounced, status, sort, order, page, from, to],
    queryFn: () => {
      const search = new URLSearchParams()
      if (debounced) search.set("q", debounced)
      if (status) search.set("status", status)
      search.set("sort", sort)
      search.set("order", order)
      search.set("limit", String(PAGE_SIZE))
      search.set("offset", String(page * PAGE_SIZE))
      search.set("from", from)
      search.set("to", to)
      return api<{ items: MessageSummary[]; total: number }>(`/api/v1/messages?${search.toString()}`)
    },
  })

  const mutation = useMutation({
    mutationFn: async (action: { id: string; kind: "delete" | "retry" }) => {
      if (action.kind === "delete") {
        await api(`/api/v1/messages/${action.id}`, { method: "DELETE" })
        return
      }
      await api(`/api/v1/messages/${action.id}/retry`, {
        method: "POST",
        body: JSON.stringify({ confirm_duplicate: true }),
      })
    },
    onSuccess: (_data, action) => {
      toast(action.kind === "delete" ? "Deleted." : "Retry queued.")
      setPending(null)
      setMenu(null)
      queryClient.invalidateQueries({ queryKey: ["messages", workspaceId] })
      queryClient.invalidateQueries({ queryKey: ["performance", workspaceId] })
      queryClient.invalidateQueries({ queryKey: ["activity", workspaceId] })
    },
    onError: (err) => {
      toast(err instanceof ApiError ? err.message : "That action did not complete.", "bad")
      setPending(null)
    },
  })

  const items = query.data?.items || []
  const total = query.data?.total || 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const allChecked = items.length > 0 && items.every((item) => selected.includes(item.id))
  const error = query.error instanceof ApiError ? query.error.message : query.error ? "Could not load emails." : ""

  function toggleAll() {
    setSelected(allChecked ? [] : items.map((item) => item.id))
  }

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  function exportRows() {
    const chosen = selected.length ? items.filter((item) => selected.includes(item.id)) : items
    if (chosen.length === 0) {
      toast("Nothing on this page to export.", "bad")
      return
    }
    downloadCsv(chosen)
  }

  return (
    <section className="rounded-2xl border border-line bg-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4">
        <div>
          <h2 className="m-0 text-base font-semibold text-ink">Recent emails</h2>
          <p className="m-0 mt-1 text-sm text-slate-500">Latest sent emails and their engagement. Counts are unique recipients.</p>
        </div>
        <Link to="/app/messages" className="text-sm font-medium text-brand no-underline">
          View all
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search subject or recipient"
          aria-label="Search emails"
          className="!w-auto min-w-[180px] flex-1"
        />
        <select aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value)} className="!w-auto">
          <option value="">All statuses</option>
          <option value="sent">Accepted</option>
          <option value="failed">Failed</option>
          <option value="needs_review">Needs review</option>
          <option value="partial">Partly sent</option>
          <option value="draft">Drafts</option>
        </select>
        <select
          aria-label="Sort"
          className="!w-auto"
          value={`${sort}:${order}`}
          onChange={(event) => {
            const [nextSort, nextOrder] = event.target.value.split(":")
            setSort(nextSort)
            setOrder(nextOrder === "asc" ? "asc" : "desc")
          }}
        >
          <option value="sent_at:desc">Newest sent</option>
          <option value="sent_at:asc">Oldest sent</option>
          <option value="subject:asc">Subject A–Z</option>
          <option value="status:asc">Status</option>
        </select>
        <button type="button" className="btn small" onClick={exportRows}>
          Export CSV
        </button>
      </div>
      {error ? <div className="banner bad mx-4">{error}</div> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-slate-400">
              <th className="w-10 px-4 py-2">
                <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select emails on this page" />
              </th>
              <th className="px-2 py-2 font-medium">Subject</th>
              <th className="px-2 py-2 font-medium">Recipients</th>
              <th className="px-2 py-2 font-medium">Sent at</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium">Opens</th>
              <th className="px-2 py-2 font-medium">Link clicks</th>
              <th className="px-2 py-2 font-medium">Document views</th>
              <th className="w-12 px-2 py-2 font-medium">
                <span className="sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-slate-400">
                  Loading emails…
                </td>
              </tr>
            ) : null}
            {!query.isLoading && items.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-slate-500">
                  No emails match this range. Compose a message or widen the dates.
                </td>
              </tr>
            ) : null}
            {items.map((item) => {
              const when = item.sent_at || item.created_at
              const retryable = item.send_status === "failed" || item.send_status === "needs_review" || item.send_status === "partial"
              return (
                <tr key={item.id} className="border-t border-line align-top">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.includes(item.id)}
                      onChange={() => toggle(item.id)}
                      aria-label={`Select ${item.subject}`}
                    />
                  </td>
                  <td className="px-2 py-3">
                    <Link to={`/app/messages/${item.id}`} className="font-semibold text-ink no-underline">
                      {item.subject}
                    </Link>
                    {item.preview ? <div className="mt-0.5 max-w-xs truncate text-xs text-slate-400">{item.preview}</div> : null}
                    {item.is_sample ? <div className="text-xs text-slate-400">Sample</div> : null}
                  </td>
                  <td className="px-2 py-3 tabular-nums text-slate-600">{item.recipient_count}</td>
                  <td className="whitespace-nowrap px-2 py-3 text-slate-600">
                    {new Date(when).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </td>
                  <td className="px-2 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${statusTone(item.send_status)}`}>
                      {sendLabel(item.send_status, item.demo)}
                    </span>
                  </td>
                  <td className="px-2 py-3">
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                      {item.engagement.estimated_opens}
                    </span>
                  </td>
                  <td className="px-2 py-3 font-medium text-violet-700">{item.engagement.link_clicks}</td>
                  <td className="px-2 py-3 font-medium text-orange-600">{item.engagement.document_views}</td>
                  <td className="relative px-2 py-3">
                    <button type="button" className="btn small ghost" aria-label={`Actions for ${item.subject}`} onClick={() => setMenu(menu === item.id ? null : item.id)}>
                      <MoreHorizontal size={16} />
                    </button>
                    {menu === item.id ? (
                      <div className="absolute right-2 z-10 mt-1 grid w-44 rounded-xl border border-line bg-white p-1 shadow-card">
                        <Link className="rounded-lg px-2 py-1.5 text-left text-sm text-ink no-underline hover:bg-slate-50" to={`/app/messages/${item.id}`}>
                          Open details
                        </Link>
                        {send && retryable ? (
                          <button type="button" className="rounded-lg border-0 bg-transparent px-2 py-1.5 text-left text-sm" onClick={() => setPending({ id: item.id, action: "retry" })}>
                            Retry send
                          </button>
                        ) : null}
                        {send ? (
                          <button type="button" className="rounded-lg border-0 bg-transparent px-2 py-1.5 text-left text-sm text-red-700" onClick={() => setPending({ id: item.id, action: "delete" })}>
                            Delete
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-slate-500">
        <span>
          {total === 0 ? "0 emails" : `${page * PAGE_SIZE + 1}–${Math.min(total, (page + 1) * PAGE_SIZE)} of ${total}`}
        </span>
        <div className="flex gap-2">
          <button type="button" className="btn small" disabled={page === 0} onClick={() => setPage((current) => current - 1)}>
            Previous
          </button>
          <button type="button" className="btn small" disabled={page + 1 >= pages} onClick={() => setPage((current) => current + 1)}>
            Next
          </button>
        </div>
      </div>
      {pending ? (
        <Dialog title={pending.action === "delete" ? "Delete this conversation?" : "Retry this send?"} onClose={() => setPending(null)}>
          <p className="quiet">
            {pending.action === "delete"
              ? "Removes it from MailInsider. This does not unsend from Gmail."
              : "Retry only recipients that failed or need review. If Gmail may already have accepted the send, confirm you checked that it was not delivered."}
          </p>
          <div className="actions" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={`btn ${pending.action === "delete" ? "danger" : "primary"}`}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ id: pending.id, kind: pending.action })}
            >
              {pending.action === "delete" ? "Delete" : "Retry"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  )
}
