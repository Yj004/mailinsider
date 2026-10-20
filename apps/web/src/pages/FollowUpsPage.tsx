import { Link } from "react-router-dom"
import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { Ban, Clock, PenLine } from "lucide-react"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { useCompose } from "../compose"
import { PIPELINE_LABEL, relativeTime } from "../labels"
import type { ContactRecord } from "../types"

type ThreadItem = {
  id: string
  subject: string
  follow_up_count: number
  next_follow_up_at: string | null
  conversation_status: string
  sent_at: string | null
}

export function FollowUpsPage() {
  const { workspaceId } = useAuth()
  const query = useQuery({
    queryKey: ["follow-ups", workspaceId],
    queryFn: () =>
      api<{
        due: ContactRecord[]
        upcoming: ContactRecord[]
        due_count: number
        threads_due: ThreadItem[]
        threads_upcoming: ThreadItem[]
        threads_dead: ThreadItem[]
        threads_due_count: number
        definitions: Record<string, string>
      }>("/api/v1/contacts/follow-ups"),
  })
  const error = query.error instanceof ApiError ? query.error.message : query.error ? "Could not load follow-ups." : ""

  useEffect(() => {
    document.title = "Follow-ups — MailInsider"
  }, [])

  return (
    <div className="page" style={{ background: "#f6f8fc", minHeight: "calc(100vh - 64px)" }}>
      <div className="page-head">
        <div>
          <p className="kicker" style={{ color: "#5f6368" }}>
            3-day cadence
          </p>
          <h1 style={{ fontWeight: 400 }}>Follow-ups</h1>
          <p className="sub">
            {query.data?.threads_due_count ?? 0} threads due · {query.data?.due_count ?? 0} contacts overdue. After each
            send we schedule +3 days. When they reply, classify: continue in 3 days, wait 7 days, end, or dead mail.
          </p>
        </div>
        <Link className="btn" to="/app/mail">
          Back to mail
        </Link>
      </div>
      {error ? <div className="banner bad">{error}</div> : null}
      {query.data?.definitions?.reply_detection ? <p className="quiet mb-4">{query.data.definitions.reply_detection}</p> : null}

      <div className="followup-board">
        <section className="followup-column">
          <div className="followup-column-head">
            <h2>
              <span className="mi-tag mi-tag-follow" style={{ marginRight: 8 }}>
                <Clock size={11} aria-hidden />
                Threads due
              </span>
            </h2>
            <span className="text-xs text-[#5f6368]">{(query.data?.threads_due || []).length}</span>
          </div>
          {(query.data?.threads_due || []).length === 0 ? (
            <p className="quiet px-4 py-6">No threads due for a follow-up.</p>
          ) : (
            (query.data?.threads_due || []).map((thread) => <ThreadRow key={thread.id} thread={thread} overdue />)
          )}
        </section>

        <section className="followup-column">
          <div className="followup-column-head">
            <h2>
              <span className="mi-tag mi-tag-link" style={{ marginRight: 8 }}>
                Upcoming threads
              </span>
            </h2>
            <span className="text-xs text-[#5f6368]">{(query.data?.threads_upcoming || []).length}</span>
          </div>
          {(query.data?.threads_upcoming || []).length === 0 ? (
            <p className="quiet px-4 py-6">Nothing scheduled yet.</p>
          ) : (
            (query.data?.threads_upcoming || []).map((thread) => <ThreadRow key={thread.id} thread={thread} />)
          )}
        </section>
      </div>

      <div className="followup-board" style={{ marginTop: 16 }}>
        <section className="followup-column">
          <div className="followup-column-head">
            <h2>Contacts due</h2>
            <span className="text-xs text-[#5f6368]">{(query.data?.due || []).length}</span>
          </div>
          {(query.data?.due || []).length === 0 ? (
            <p className="quiet px-4 py-6">No contact reminders overdue.</p>
          ) : (
            (query.data?.due || []).map((contact) => <ContactRow key={contact.id} contact={contact} overdue />)
          )}
        </section>
        <section className="followup-column">
          <div className="followup-column-head">
            <h2>
              <span className="mi-tag mi-tag-dead" style={{ marginRight: 8 }}>
                <Ban size={11} aria-hidden />
                Dead mail
              </span>
            </h2>
            <span className="text-xs text-[#5f6368]">{(query.data?.threads_dead || []).length}</span>
          </div>
          {(query.data?.threads_dead || []).length === 0 ? (
            <p className="quiet px-4 py-6">No dead threads.</p>
          ) : (
            (query.data?.threads_dead || []).map((thread) => <ThreadRow key={thread.id} thread={thread} dead />)
          )}
        </section>
      </div>
    </div>
  )
}

function ThreadRow({ thread, overdue, dead }: { thread: ThreadItem; overdue?: boolean; dead?: boolean }) {
  return (
    <div className="followup-item">
      <div className="min-w-0">
        <Link className="font-medium text-[#202124] no-underline hover:underline" to={`/app/mail/${thread.id}`}>
          {thread.subject || "(no subject)"}
        </Link>
        <div className="mt-0.5 text-xs text-[#5f6368]">
          FU ×{thread.follow_up_count} · {thread.conversation_status.replaceAll("_", " ")}
        </div>
        {!dead ? (
          <div className={`mt-1 text-xs font-medium ${overdue ? "text-[#c5221f]" : "text-[#5f6368]"}`}>
            {thread.next_follow_up_at ? relativeTime(thread.next_follow_up_at) : "No date"}
          </div>
        ) : null}
      </div>
      {!dead ? (
        <FollowUpComposeButton followup={thread.id} label="Follow up" />
      ) : (
        <Link className="btn ghost" to={`/app/mail/${thread.id}`}>
          Open
        </Link>
      )}
    </div>
  )
}

function FollowUpComposeButton({ followup, to, label }: { followup?: string; to?: string; label: string }) {
  const { openCompose } = useCompose()
  return (
    <button
      type="button"
      className="gmail-compose"
      style={{ minHeight: 36, padding: "0 14px", fontSize: 13, minWidth: 0 }}
      onClick={() => openCompose(followup ? { followup } : { to })}
    >
      <PenLine size={14} aria-hidden />
      {label}
    </button>
  )
}

function ContactRow({ contact, overdue }: { contact: ContactRecord; overdue?: boolean }) {
  return (
    <div className="followup-item">
      <div className="min-w-0">
        <div className="font-medium">{contact.display_name || contact.email}</div>
        <div className="mt-0.5 text-xs text-[#5f6368]">
          {contact.email}
          {contact.pipeline_status ? ` · ${PIPELINE_LABEL[contact.pipeline_status] || contact.pipeline_status}` : ""}
        </div>
        <div className={`mt-1 text-xs font-medium ${overdue ? "text-[#c5221f]" : "text-[#5f6368]"}`}>
          {contact.next_follow_up_at ? relativeTime(contact.next_follow_up_at) : "No date"}
        </div>
      </div>
      <FollowUpComposeButton to={contact.email} label="Write" />
    </div>
  )
}
