import type { SendStatus, Signal } from "./types"

export const SIGNAL_LABEL: Record<Signal, string> = {
  open_detected: "Opened",
  link_clicked: "Link requested",
  document_viewed: "Document viewed",
  possible_automated: "Possible automated request",
  no_activity: "No activity detected",
}

export const EVENT_LABEL: Record<string, string> = {
  message_queued: "Queued",
  message_send_started: "Send started",
  message_send_succeeded: "Accepted by Gmail",
  message_send_failed: "Send failed",
  open_pixel_requested: "Opened",
  tracked_link_requested: "Link requested",
  document_access_granted: "Document access granted",
  document_view_started: "Document viewed",
  document_page_viewed: "Page displayed",
  document_download_requested: "Download requested",
  document_access_denied: "Document access denied",
  tracking_link_revoked: "Tracking revoked",
  sheet_row_appended: "Logged on the workspace sheet",
  sheet_row_failed: "Sheet row was not added",
  unsubscribe: "Unsubscribed",
  campaign_launched: "Campaign launched",
}

export const PIPELINE_LABEL: Record<string, string> = {
  to_contact: "To contact",
  draft: "Draft",
  sent: "Sent",
  open_detected: "Opened",
  link_clicked: "Link clicked",
  replied: "Replied",
  follow_up_due: "Follow-up due",
  interview: "Interview",
  rejected: "Rejected",
  no_response: "No response",
  closed: "Closed",
}

export const PIPELINE_STATUSES = Object.keys(PIPELINE_LABEL)

export const SOURCE_LABEL: Record<string, string> = {
  gmail_api: "Gmail",
  tracking_pixel: "Open",
  inferred: "Engagement",
  redirect: "Tracked link",
  document_viewer: "Document viewer",
  system: "MailInsider",
}

export function sendLabel(status: SendStatus, demo: boolean) {
  if (status === "sent" && demo) return "Marked sent in demo"
  if (status === "sent") return "Accepted by Gmail"
  if (status === "failed") return "Send failed"
  if (status === "needs_review") return "Needs review"
  if (status === "partial") return "Partly sent"
  if (status === "queued" || status === "sending") return "Sending"
  return "Draft"
}

export function relativeTime(value: string | null | undefined) {
  if (!value) return ""
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return ""
  const minutes = Math.round((Date.now() - then) / 60000)
  const abs = Math.abs(minutes)
  const suffix = minutes >= 0 ? "ago" : "from now"
  if (abs < 1) return "just now"
  if (abs < 60) return `${abs}m ${suffix}`
  const hours = Math.round(abs / 60)
  if (hours < 24) return `${hours}h ${suffix}`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days}d ${suffix}`
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function greeting(name: string) {
  const hour = new Date().getHours()
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
  const first = name.split(" ")[0] || name
  return `${hello}, ${first}`
}
