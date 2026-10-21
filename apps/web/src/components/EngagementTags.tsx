import { Eye, FileText, Link2, Send, AlertCircle, FileEdit, Clock, Ban, MessageCircleReply } from "lucide-react"
import type { MessageSummary } from "../types"

type Tag = {
  key: string
  label: string
  tone: "open" | "link" | "file" | "sent" | "fail" | "draft" | "queue" | "follow" | "dead" | "ended" | "replied"
  icon: typeof Eye
}

export function engagementTags(item: MessageSummary, short = false): Tag[] {
  if (item.send_status === "draft") {
    return [{ key: "draft", label: "Draft", tone: "draft", icon: FileEdit }]
  }
  if (item.send_status === "failed" || item.send_status === "needs_review") {
    return [{ key: "fail", label: item.send_status === "failed" ? "Failed" : short ? "Review" : "Needs review", tone: "fail", icon: AlertCircle }]
  }
  if (item.send_status === "queued" || item.send_status === "sending") {
    return [{ key: "queue", label: item.send_status === "sending" ? "Sending" : "Queued", tone: "queue", icon: Send }]
  }

  const tags: Tag[] = []
  const e = item.engagement
  if (e.estimated_opens > 0) {
    tags.push({
      key: "open",
      label: e.estimated_opens > 1 ? `Opened ×${e.estimated_opens}` : "Opened",
      tone: "open",
      icon: Eye,
    })
  }
  if (e.link_clicks > 0) {
    tags.push({
      key: "link",
      label: e.link_clicks > 1 ? `Link ×${e.link_clicks}` : short ? "Link" : "Link viewed",
      tone: "link",
      icon: Link2,
    })
  }
  if (e.document_views > 0) {
    tags.push({
      key: "file",
      label: e.document_views > 1 ? `File ×${e.document_views}` : short ? "File" : "File viewed",
      tone: "file",
      icon: FileText,
    })
  }
  if (tags.length === 0 && !short) {
    tags.push({ key: "sent", label: "Sent", tone: "sent", icon: Send })
  }

  const status = item.conversation_status || "active"
  const fu = item.follow_up_count || 0
  const fuIndex = item.follow_up_index || 0
  if (status === "dead") {
    tags.push({ key: "dead", label: "Dead mail", tone: "dead", icon: Ban })
  } else if (status === "ended") {
    tags.push({ key: "ended", label: "Ended", tone: "ended", icon: Ban })
  } else if (status === "replied") {
    tags.push({ key: "replied", label: "Replied", tone: "replied", icon: MessageCircleReply })
  }
  if (item.parent_message_id && fuIndex > 0) {
    tags.push({ key: "fu-n", label: `Follow-up #${fuIndex}`, tone: "follow", icon: Clock })
  } else if (fu > 0 && status !== "dead" && status !== "ended") {
    tags.push({
      key: "fu",
      label: item.follow_up_overdue ? `FU ×${fu} due` : `FU ×${fu}`,
      tone: "follow",
      icon: Clock,
    })
  } else if (item.follow_up_overdue && status !== "dead" && status !== "ended") {
    tags.push({ key: "fu-due", label: "Follow-up due", tone: "follow", icon: Clock })
  }
  return tags
}

const TONE: Record<Tag["tone"], string> = {
  open: "mi-tag mi-tag-open",
  link: "mi-tag mi-tag-link",
  file: "mi-tag mi-tag-file",
  sent: "mi-tag mi-tag-sent",
  fail: "mi-tag mi-tag-fail",
  draft: "mi-tag mi-tag-draft",
  queue: "mi-tag mi-tag-queue",
  follow: "mi-tag mi-tag-follow",
  dead: "mi-tag mi-tag-dead",
  ended: "mi-tag mi-tag-ended",
  replied: "mi-tag mi-tag-replied",
}

export function EngagementTags({ item, dense = false }: { item: MessageSummary; dense?: boolean }) {
  const tags = engagementTags(item, dense)
  if (!tags.length) return null
  return (
    <span className={`mi-tag-row ${dense ? "mi-tag-row-dense" : ""}`}>
      {tags.map((tag) => {
        const Icon = tag.icon
        return (
          <span key={tag.key} className={TONE[tag.tone]} title={tag.label}>
            <i className="mi-tag-mark" aria-hidden />
            <Icon size={dense ? 10 : 12} aria-hidden />
            {tag.label}
          </span>
        )
      })}
    </span>
  )
}
