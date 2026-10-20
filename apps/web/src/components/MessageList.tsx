import { Link } from "react-router-dom"
import { SignalPill } from "./ui"
import { relativeTime, sendLabel } from "../labels"
import type { MessageSummary } from "../types"

export function MessageList({ items }: { items: MessageSummary[] }) {
  return (
    <div className="list">
      {items.map((item) => {
        const lead = item.recipients_preview[0]
        return (
          <Link key={item.id} className="msg-row" to={`/app/mail/${item.id}`}>
            <div>
              <div className="subject">{item.subject}</div>
              <div className="meta">
                {lead ? lead.name || lead.email : "No recipients"}
                {item.recipient_count > 1 ? ` +${item.recipient_count - 1}` : ""}
                {item.is_sample ? " · Sample" : ""}
              </div>
            </div>
            <div className="pills">{lead ? <SignalPill signal={lead.signal} /> : null}</div>
            <div>
              <span
                className={`pill ${item.send_status === "failed" || item.send_status === "needs_review" ? "bad" : item.send_status === "sent" ? "good" : ""}`}
              >
                {sendLabel(item.send_status, item.demo)}
              </span>
            </div>
            <div className="meta">{relativeTime(item.sent_at || item.created_at)}</div>
          </Link>
        )
      })}
    </div>
  )
}
