import { FormEvent, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { EngagementTags } from "../components/EngagementTags"
import { Dialog, SignalPill } from "../components/ui"
import { EVENT_LABEL, SOURCE_LABEL, relativeTime, sendLabel } from "../labels"
import type { ConnectionsResponse, ConversationTurn, MessageDetail, MessageReply, TrackingEvent } from "../types"
import { canSend } from "../types"

const AUTO_SYNC_MS = 45_000

export function MessageDetailPage() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const { workspaceId, membership, toast } = useAuth()
  const [message, setMessage] = useState<MessageDetail | null>(null)
  const [events, setEvents] = useState<TrackingEvent[]>([])
  const [error, setError] = useState("")
  const [syncing, setSyncing] = useState(false)
  const [showActivity, setShowActivity] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [previewHtml, setPreviewHtml] = useState("")
  const [confirmRetry, setConfirmRetry] = useState(false)
  const [connectionId, setConnectionId] = useState("")
  const [replyBody, setReplyBody] = useState("")
  const [replySubject, setReplySubject] = useState("")
  const [sending, setSending] = useState(false)
  const lastNewToast = useRef(0)
  const syncingRef = useRef(false)

  function applyDetail(next: MessageDetail, timelineEvents: TrackingEvent[]) {
    setMessage(next)
    setEvents(timelineEvents)
    localStorage.setItem("mi_opened_timeline", "1")
    const turns = next.conversation?.length ? next.conversation : []
    const open: Record<string, boolean> = {}
    turns.forEach((turn, index) => {
      open[turn.id] = index === turns.length - 1
    })
    setExpanded(open)
    const subject = next.subject || ""
    setReplySubject(subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`)
  }

  function load(detail?: MessageDetail) {
    if (detail) {
      api<{ events: TrackingEvent[] }>(`/api/v1/messages/${id}/events`)
        .then((timeline) => applyDetail(detail, timeline.events))
        .catch(() => applyDetail(detail, []))
      return
    }
    Promise.all([
      api<MessageDetail>(`/api/v1/messages/${id}`),
      api<{ events: TrackingEvent[] }>(`/api/v1/messages/${id}/events`),
    ])
      .then(([next, timeline]) => applyDetail(next, timeline.events))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load this message."))
  }

  function syncReplies(opts?: { quiet?: boolean }) {
    const quiet = Boolean(opts?.quiet)
    const rootId = message?.thread_root_id || message?.id || id
    if (!rootId || syncingRef.current) return
    const status = message?.send_status
    if (status && status !== "sent" && status !== "partial") return
    syncingRef.current = true
    setSyncing(true)
    api<MessageDetail & { sync?: { synced: number; new: number; note?: string; demo?: boolean } }>(
      `/api/v1/messages/${rootId}/sync-replies`,
      { method: "POST" },
    )
      .then((detail) => {
        const n = detail.sync?.new ?? 0
        if (!quiet) {
          if (detail.sync?.note) toast(detail.sync.note)
          else if (n > 0) toast(`Synced ${n} new repl${n === 1 ? "y" : "ies"} from Gmail.`)
          else toast("No new recipient replies yet.")
        } else if (n > 0 && Date.now() - lastNewToast.current > 8_000) {
          lastNewToast.current = Date.now()
          toast(`${n} new repl${n === 1 ? "y" : "ies"} synced.`)
        }
        applyDetail(detail, events)
        api<{ events: TrackingEvent[] }>(`/api/v1/messages/${id}/events`)
          .then((timeline) => setEvents(timeline.events))
          .catch(() => undefined)
      })
      .catch((err) => {
        if (quiet) return
        toast(err instanceof ApiError ? err.message : "Could not sync replies.", "bad")
        if (err instanceof ApiError && (err.code === "needs_reauth" || err.code === "scope_required")) {
          window.location.href = "/app/integrations"
        }
      })
      .finally(() => {
        syncingRef.current = false
        setSyncing(false)
      })
  }

  useEffect(() => {
    load()
  }, [id, workspaceId])

  useEffect(() => {
    if (!message) return
    // Stay in the same Gmail thread: send only from the original mailbox.
    if (message.gmail_connection_id) {
      setConnectionId(message.gmail_connection_id)
      return
    }
    api<ConnectionsResponse>("/api/v1/integrations/gmail/connections")
      .then((data) => {
        const active = data.connections.find(
          (item) => item.status === "connected" && item.google_account_email === message.from_email,
        )
        if (active) setConnectionId(active.id)
        else setConnectionId("")
      })
      .catch(() => undefined)
  }, [workspaceId, message?.from_email, message?.gmail_connection_id, message])

  useEffect(() => {
    if (!message) return
    if (message.send_status !== "sent" && message.send_status !== "partial") return
    if (["ended", "dead"].includes(message.conversation_status || "")) return
    const t = window.setTimeout(() => syncReplies({ quiet: true }), 400)
    const interval = window.setInterval(() => syncReplies({ quiet: true }), AUTO_SYNC_MS)
    return () => {
      window.clearTimeout(t)
      window.clearInterval(interval)
    }
    // Intentional: re-arm when conversation identity changes, not on every sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, workspaceId, message?.thread_root_id, message?.send_status, message?.conversation_status])

  const groups = useMemo(() => groupEvents(events), [events])
  const turns = useMemo(() => {
    if (!message) return [] as ConversationTurn[]
    if (message.conversation?.length) return message.conversation
    return buildFallbackTurns(message)
  }, [message])

  if (error) {
    return (
      <div className="gmail-conv">
        <div className="banner bad">{error}</div>
      </div>
    )
  }
  if (!message) return <div className="gmail-conv gmail-conv-loading">Loading conversation…</div>

  const senders = canSend(membership?.role)
  const retryable = message.send_status === "failed" || message.send_status === "needs_review" || message.send_status === "partial"
  const closed = ["ended", "dead"].includes(message.conversation_status || "")
  const toRecipients = message.recipients.filter((r) => r.type === "to")
  const replyCount = message.reply_count ?? message.replies?.length ?? 0
  const canReplyInline = senders && !closed && (message.send_status === "sent" || message.send_status === "partial")
  const toLabel = toRecipients.map((r) => r.name || r.email).join(", ")

  async function sendReply(event: FormEvent) {
    event.preventDefault()
    if (!replyBody.trim()) {
      toast("Write a reply first.", "bad")
      return
    }
    if (!connectionId) {
      toast("Connect Gmail under Integrations before sending.", "bad")
      return
    }
    setSending(true)
    try {
      const created = await api<MessageDetail>("/api/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          to: toRecipients.map((r) => ({ email: r.email, name: r.name || undefined })),
          subject: replySubject,
          body_text: replyBody,
          send: true,
          gmail_connection_id: message!.gmail_connection_id || connectionId,
          parent_message_id: message!.thread_root_id || message!.id,
          tracking: {
            open_pixel: message!.open_tracking,
            link_clicks: message!.link_tracking,
          },
        }),
      })
      toast(created.demo ? "Marked sent in demo." : "Reply sent.")
      setReplyBody("")
      const root = created.thread_root_id || message!.thread_root_id || message!.id
      if (root !== id) navigate(`/app/mail/${root}`, { replace: true })
      else load()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not send reply.", "bad")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="gmail-conv">
      <div className="gmail-conv-toolbar">
        <div className="gmail-conv-toolbar-left">
          <Link className="gmail-icon-btn" to="/app/mail" title="Back to Mail" aria-label="Back to Mail">
            ←
          </Link>
          <button type="button" className="btn small ghost" onClick={() => setShowActivity((v) => !v)}>
            {showActivity ? "Hide activity" : "Activity"}
          </button>
          {senders ? (
            <button
              type="button"
              className="btn small ghost"
              onClick={() => {
                api(`/api/v1/messages/${message.id}/tracking`, { method: "DELETE" })
                  .then(() => {
                    toast("Tracking links for this message are revoked.")
                    load()
                  })
                  .catch((err) => toast(err instanceof ApiError ? err.message : "Could not revoke.", "bad"))
              }}
            >
              Revoke tracking
            </button>
          ) : null}
        </div>
        <div className="gmail-conv-toolbar-right">
          {senders ? (
            <>
              <span className="gmail-conv-sync-status">{syncing ? "Syncing replies…" : "Replies auto-sync"}</span>
              {retryable ? (
                <button className="btn small" onClick={() => (message.send_status === "needs_review" ? setConfirmRetry(true) : retry(false))}>
                  Retry
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      <header className="gmail-conv-head">
        <h1 className="gmail-conv-subject">{message.subject || "(no subject)"}</h1>
        <div className="gmail-conv-meta-row">
          <EngagementTags item={message} />
          <span className="gmail-conv-meta-text">
            {sendLabel(message.send_status, message.demo)}
            {message.from_email ? ` · ${message.from_email}` : ""}
            {replyCount ? ` · ${replyCount} repl${replyCount === 1 ? "y" : "ies"}` : ""}
            {message.follow_up_count ? ` · ${message.follow_up_count} follow-up${message.follow_up_count === 1 ? "" : "s"}` : ""}
          </span>
        </div>
      </header>

      {message.error_message ? <div className="banner bad">{message.error_message}</div> : null}

      {(message.send_status === "sent" || message.send_status === "partial") && !closed ? (
        <section className="gmail-conv-follow">
          <div className="gmail-conv-follow-main">
            <strong>Follow-up</strong>
            <span>
              Every {message.follow_up_cadence_days || 3} days until reply · sent {message.follow_up_count || 0}
              {message.next_follow_up_at
                ? ` · next ${relativeTime(message.next_follow_up_at)}${message.follow_up_overdue ? " (overdue)" : ""}`
                : ""}
              {message.conversation_status ? ` · ${message.conversation_status.replaceAll("_", " ")}` : ""}
            </span>
          </div>
          {senders ? (
            <div className="gmail-conv-follow-actions">
              {(
                [
                  ["continue_3", "Reply → +3d"],
                  ["wait_7", "Reply → +7d"],
                  ["end", "End"],
                  ["dead", "Dead"],
                ] as const
              ).map(([action, label]) => (
                <button
                  key={action}
                  type="button"
                  className={action === "dead" ? "btn small ghost" : "btn small"}
                  onClick={() => classify(action)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {closed ? (
        <div className="gmail-conv-follow is-closed">
          Conversation {message.conversation_status === "dead" ? "marked dead mail" : "ended"}.
        </div>
      ) : null}

      <div className="gmail-conv-body">
        <div className="gmail-conv-thread">
          {turns.map((turn) => {
            const open = expanded[turn.id] ?? false
            const initial = initials(turn.from_name || turn.from_email || "?")
            const inbound = turn.kind === "inbound"
            return (
              <article key={turn.id} className={`gmail-msg ${inbound ? "is-inbound" : "is-outbound"} ${open ? "is-open" : ""}`}>
                <button type="button" className="gmail-msg-summary" onClick={() => setExpanded((prev) => ({ ...prev, [turn.id]: !open }))}>
                  <span className={`gmail-msg-avatar ${inbound ? "tone-in" : "tone-out"}`}>{initial}</span>
                  <span className="gmail-msg-who">
                    <strong>{turn.from_name || turn.from_email}</strong>
                    {turn.follow_up_index ? <span className="gmail-msg-chip">Follow-up #{turn.follow_up_index}</span> : null}
                    {inbound ? <span className="gmail-msg-chip is-reply">Reply</span> : null}
                  </span>
                  <span className="gmail-msg-snippet">{open ? `to ${turn.to_label}` : turn.snippet || " "}</span>
                  <span className="gmail-msg-time">{relativeTime(turn.occurred_at)}</span>
                </button>
                {open ? (
                  <div className="gmail-msg-body">
                    <div className="gmail-msg-headers">
                      <div>
                        <span className="muted">From</span> {turn.from_name || turn.from_email}
                        {turn.from_email && turn.from_name ? ` <${turn.from_email}>` : ""}
                      </div>
                      <div>
                        <span className="muted">To</span> {turn.to_label}
                      </div>
                    </div>
                    {turn.body_html ? (
                      <div className="gmail-msg-html" dangerouslySetInnerHTML={{ __html: turn.body_html }} />
                    ) : (
                      <pre className="gmail-msg-text">{turn.body_text || turn.snippet || "(empty)"}</pre>
                    )}
                  </div>
                ) : null}
              </article>
            )
          })}

          {!turns.length ? <p className="quiet">No messages in this conversation yet.</p> : null}

          {canReplyInline ? (
            <form className="gmail-inline-reply" onSubmit={sendReply}>
              <div className="gmail-inline-reply-head">
                <span className="gmail-msg-avatar tone-out">{initials(message.from_email || "You")}</span>
                <div>
                  <strong>Reply</strong>
                  <div className="meta">
                    To {toLabel || "recipient"}
                    {message.from_email ? ` · from ${message.from_email}` : ""}
                  </div>
                </div>
              </div>
              <label className="gmail-inline-field">
                <span>Subject</span>
                <input value={replySubject} readOnly title="Kept as Re: original so Gmail stays in the same thread" />
              </label>
              <textarea
                className="gmail-inline-body"
                rows={6}
                placeholder="Write your reply…"
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
              />
              <div className="gmail-inline-actions">
                <button className="btn primary" type="submit" disabled={sending || !connectionId}>
                  {sending ? "Sending…" : "Send"}
                </button>
                {!connectionId ? (
                  <Link className="btn ghost" to="/app/integrations">
                    Connect Gmail
                  </Link>
                ) : null}
              </div>
            </form>
          ) : null}
        </div>

        <aside className={`gmail-conv-side ${showActivity ? "is-open" : ""}`}>
          <div className="gmail-conv-side-section">
            <h2>People</h2>
            <ul className="gmail-conv-people">
              {toRecipients.map((recipient) => (
                <li key={recipient.id}>
                  <div className="gmail-conv-person">
                    <span className="gmail-msg-avatar tone-in">{initials(recipient.name || recipient.email)}</span>
                    <div>
                      <strong>{recipient.name || recipient.email}</strong>
                      <div className="meta">{recipient.email}</div>
                      <SignalPill signal={recipient.signal} />
                    </div>
                  </div>
                  {message.send_status !== "draft" ? (
                    <button
                      type="button"
                      className="btn small ghost"
                      onClick={() => {
                        api<{ html: string }>(`/api/v1/messages/${message.id}/recipients/${recipient.id}/preview`)
                          .then((data) => setPreviewHtml(data.html))
                          .catch((err) => toast(err instanceof ApiError ? err.message : "No preview yet.", "bad"))
                      }}
                    >
                      Preview
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
          <div className="gmail-conv-side-section">
            <div className="row-between">
              <h2>Activity</h2>
              <button type="button" className="btn small ghost" onClick={() => setShowActivity(false)}>
                Hide
              </button>
            </div>
            <ol className="timeline compact">
              {groups.map((event) => (
                <li className="tl-item" key={event.id}>
                  <div className="tl-rail">
                    <span className={`dot ${dotClass(event.event_type, event.possible_automated)}`} />
                    <span className="stem" />
                  </div>
                  <div className="tl-body">
                    <strong>
                      {EVENT_LABEL[event.event_type] || event.event_type}
                      {event.count > 1 ? ` · ${event.count}` : ""}
                    </strong>
                    <div className="meta">
                      {relativeTime(event.occurred_at)} · {SOURCE_LABEL[event.source] || event.source}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            {!events.length ? <p className="quiet">No tracking activity yet.</p> : null}
          </div>
        </aside>
      </div>

      {previewHtml ? (
        <Dialog title="Recipient preview" onClose={() => setPreviewHtml("")}>
          <p className="quiet">Opening this can record an open.</p>
          <iframe className="preview-frame" title="Recipient preview" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={previewHtml} />
          <button className="btn" onClick={() => setPreviewHtml("")}>
            Close
          </button>
        </Dialog>
      ) : null}
      {confirmRetry ? (
        <Dialog title="Retry may send a duplicate" onClose={() => setConfirmRetry(false)}>
          <p>Gmail may already have accepted this send. Continue only if you checked that it was not delivered.</p>
          <div className="row-between">
            <button className="btn ghost" onClick={() => setConfirmRetry(false)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => retry(true)}>
              Retry anyway
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )

  function classify(action: "continue_3" | "wait_7" | "end" | "dead") {
    api(`/api/v1/messages/${message!.thread_root_id || message!.id}/conversation`, {
      method: "POST",
      body: JSON.stringify({ action }),
    })
      .then(() => {
        toast(
          action === "dead"
            ? "Marked dead mail."
            : action === "end"
              ? "Conversation ended."
              : "Follow-up rescheduled after reply.",
        )
        load()
      })
      .catch((err) => toast(err instanceof ApiError ? err.message : "Could not update.", "bad"))
  }

  function retry(confirm: boolean) {
    api(`/api/v1/messages/${id}/retry`, { method: "POST", body: JSON.stringify({ confirm_duplicate: confirm }) })
      .then(() => {
        toast("Retry queued.")
        setConfirmRetry(false)
        load()
      })
      .catch((err) => {
        if (err instanceof ApiError && err.code === "confirm_duplicate") setConfirmRetry(true)
        else toast(err instanceof ApiError ? err.message : "Could not retry.", "bad")
      })
  }
}

function initials(value: string) {
  const parts = value.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean)
  const letters = (parts[0]?.[0] || "?") + (parts[1]?.[0] || "")
  return letters.toUpperCase()
}

function buildFallbackTurns(message: MessageDetail): ConversationTurn[] {
  const toLabel = message.recipients
    .filter((r) => r.type === "to")
    .map((r) => r.name || r.email)
    .join(", ")
  const outbound: ConversationTurn = {
    id: message.id,
    kind: "outbound",
    message_id: message.id,
    from_name: "You",
    from_email: message.from_email,
    to_label: toLabel || "recipient",
    subject: message.subject,
    snippet: message.preview,
    body_text: message.body_text,
    body_html: message.body_html ?? null,
    occurred_at: message.sent_at || message.created_at,
    follow_up_index: message.follow_up_index || 0,
  }
  const replies: ConversationTurn[] = (message.replies || []).map((reply: MessageReply) => ({
    id: reply.id,
    kind: "inbound" as const,
    message_id: message.id,
    from_name: reply.from_name || reply.from_email,
    from_email: reply.from_email,
    to_label: reply.to_email || message.from_email || "you",
    subject: reply.subject,
    snippet: reply.snippet || "",
    body_text: reply.body_text,
    body_html: reply.body_html,
    occurred_at: reply.occurred_at,
    follow_up_index: null,
  }))
  return [outbound, ...replies].sort((a, b) => (a.occurred_at || "").localeCompare(b.occurred_at || ""))
}

function dotClass(type: string, automated: boolean) {
  if (automated) return "amber"
  if (type.includes("failed") || type.includes("denied")) return "bad"
  if (type.includes("queued") || type.includes("started")) return "muted"
  return ""
}

function groupEvents(events: TrackingEvent[]) {
  const groups: (TrackingEvent & { count: number })[] = []
  for (const event of events) {
    const last = groups[groups.length - 1]
    if (
      last &&
      last.event_type === event.event_type &&
      last.recipient_id === event.recipient_id &&
      last.possible_automated === event.possible_automated
    ) {
      last.count += 1
    } else {
      groups.push({ ...event, count: 1 })
    }
  }
  return groups
}
