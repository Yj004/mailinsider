import { Link } from "react-router-dom"
import { Clock, Eye, FileText, Link2, MailOpen, Users } from "lucide-react"
import { WorkspacePage, WsCard } from "../components/workspace/WorkspacePage"
import { PIPELINE_LABEL, PIPELINE_STATUSES } from "../labels"

const MAIL_LABELS = [
  {
    id: "opened",
    title: "Opened",
    body: "Recipients with at least one counted open on a sent message.",
    to: "/app/mail?folder=sent&tab=opened",
    icon: Eye,
  },
  {
    id: "links",
    title: "Clicked a link",
    body: "Someone followed a tracked link from your email.",
    to: "/app/mail?folder=sent&tab=links",
    icon: Link2,
  },
  {
    id: "files",
    title: "Viewed a file",
    body: "Document viewer opened from a tracked file link.",
    to: "/app/mail?folder=sent&tab=files",
    icon: FileText,
  },
  {
    id: "quiet",
    title: "Quiet",
    body: "Sent with no open, link, or document activity yet.",
    to: "/app/mail?folder=sent&tab=quiet",
    icon: MailOpen,
  },
  {
    id: "attention",
    title: "Unopened",
    body: "Sent messages still waiting for engagement.",
    to: "/app/mail?folder=attention",
    icon: Clock,
  },
]

export function LabelsPage() {
  return (
    <WorkspacePage
      title="Labels"
      subtitle="Saved views for outreach. Jump straight into mail or CRM segments your team already uses."
      actions={
        <Link className="btn" to="/app/contacts">
          <Users size={16} /> Open contacts
        </Link>
      }
    >
      <div className="ws-split">
        <WsCard title="Engagement labels">
          <div className="ws-label-grid">
            {MAIL_LABELS.map((item) => {
              const Icon = item.icon
              return (
                <Link key={item.id} className="ws-label-tile" to={item.to}>
                  <Icon size={18} aria-hidden />
                  <span>
                    <strong>{item.title}</strong>
                    <span className="meta">{item.body}</span>
                  </span>
                </Link>
              )
            })}
          </div>
        </WsCard>
        <WsCard title="Pipeline labels" meta="Used on Contacts CRM">
          <div className="ws-label-grid">
            {PIPELINE_STATUSES.map((status) => (
              <Link key={status} className="ws-label-tile" to={`/app/contacts?status=${status}`}>
                <span className="ws-pill">{PIPELINE_LABEL[status] || status}</span>
                <span className="meta">Filter the contact list by this stage.</span>
              </Link>
            ))}
          </div>
        </WsCard>
      </div>
    </WorkspacePage>
  )
}
