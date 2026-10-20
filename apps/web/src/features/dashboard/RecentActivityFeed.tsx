import { Eye, FileText, Mail, MousePointerClick, ShieldAlert } from "lucide-react"
import { Link } from "react-router-dom"
import { relativeTime } from "../../labels"
import type { ActivityItem } from "../../types"

const COPY: Record<ActivityItem["kind"], { label: string; icon: typeof Mail; tone: string }> = {
  email_sent: { label: "Accepted by Gmail", icon: Mail, tone: "bg-blue-50 text-blue-600" },
  send_failed: { label: "Send failed", icon: ShieldAlert, tone: "bg-red-50 text-red-600" },
  estimated_open: { label: "Open", icon: Eye, tone: "bg-emerald-50 text-emerald-600" },
  link_click: { label: "Clicked a link", icon: MousePointerClick, tone: "bg-violet-50 text-violet-600" },
  document_view: { label: "Viewed document", icon: FileText, tone: "bg-orange-50 text-orange-600" },
  gmail_reauth: { label: "Gmail authorization expired", icon: ShieldAlert, tone: "bg-amber-50 text-amber-700" },
}

export function RecentActivityFeed({ items, loading, error }: { items: ActivityItem[]; loading: boolean; error: string }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-4 shadow-card">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="m-0 text-base font-semibold text-ink">Recent activity</h2>
        <Link to="/app/analytics" className="text-sm font-medium text-brand no-underline">
          View all
        </Link>
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      {loading ? <p className="m-0 text-sm text-slate-400">Loading activity…</p> : null}
      {!loading && items.length === 0 ? (
        <p className="m-0 text-sm text-slate-500">No send or engagement events yet. Activity appears after a message is accepted or a tracking request arrives.</p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {items.map((item) => {
            const meta = COPY[item.kind]
            const Icon = meta.icon
            const body = (
              <span className="flex min-w-0 items-start gap-3">
                <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${meta.tone}`}>
                  <Icon size={15} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">{item.actor || item.subject || "Workspace"}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {meta.label}
                    {item.subject ? ` · ${item.subject}` : ""}
                    {item.possible_automated ? " · Possible automated request" : ""}
                  </span>
                </span>
              </span>
            )
            return (
              <li key={item.id} className="flex items-start justify-between gap-3">
                {item.message_id ? (
                  <Link to={`/app/messages/${item.message_id}`} className="min-w-0 flex-1 text-inherit no-underline">
                    {body}
                  </Link>
                ) : (
                  <div className="min-w-0 flex-1">{body}</div>
                )}
                <time className="shrink-0 text-xs text-slate-400" dateTime={item.occurred_at || undefined}>
                  {relativeTime(item.occurred_at)}
                </time>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
