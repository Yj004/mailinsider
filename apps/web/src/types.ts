export type Role = "owner" | "admin" | "member" | "viewer"

export type Membership = {
  workspace_id: string
  name: string
  role: Role
  open_tracking_default: boolean
  link_tracking_default: boolean
  retention_days: number
}

export type User = { id: string; email: string; display_name: string }

export type SessionResponse = {
  access_token: string
  user: User
  memberships: Membership[]
}

export type Signal = "open_detected" | "link_clicked" | "document_viewed" | "possible_automated" | "no_activity"

export type SendStatus = "draft" | "queued" | "sending" | "sent" | "failed" | "partial" | "needs_review"

export type ConversationStatus = "active" | "awaiting_reply" | "replied" | "ended" | "dead"

export type MessageSummary = {
  id: string
  subject: string
  send_status: SendStatus
  is_sample: boolean
  demo: boolean
  from_email: string | null
  created_at: string
  sent_at: string | null
  error_code: string | null
  error_message: string | null
  recipient_count: number
  recipients_preview: { email: string; name: string | null; signal: Signal }[]
  signals: Record<Signal, number>
  preview: string
  engagement: { estimated_opens: number; link_clicks: number; document_views: number }
  parent_message_id?: string | null
  follow_up_count?: number
  follow_up_index?: number
  next_follow_up_at?: string | null
  conversation_status?: ConversationStatus
  follow_up_overdue?: boolean
  follow_up_cadence_days?: number
  thread_root_id?: string
  gmail_connection_id?: string | null
  hidden?: boolean
}

export type Recipient = {
  id: string
  email: string
  name: string | null
  type: "to" | "cc" | "bcc"
  send_status: string
  gmail_message_id: string | null
  error_code: string | null
  error_message: string | null
  signal: Signal
  open_count: number
  click_count: number
  document_views: number
  possible_automated: boolean
}

export type MessageReply = {
  id: string
  gmail_message_id: string
  gmail_thread_id: string | null
  direction: "inbound" | "outbound"
  from_email: string
  from_name: string | null
  to_email: string | null
  subject: string | null
  snippet: string | null
  body_text: string | null
  body_html: string | null
  occurred_at: string | null
}

export type ConversationTurn = {
  id: string
  kind: "outbound" | "inbound"
  message_id: string
  from_name: string | null
  from_email: string | null
  to_label: string
  subject: string | null
  snippet: string | null
  body_text: string | null
  body_html: string | null
  occurred_at: string | null
  follow_up_index: number | null
}

export type MessageDetail = MessageSummary & {
  body_text: string
  body_html?: string | null
  open_tracking: boolean
  link_tracking: boolean
  attach_pdf: boolean
  include_sheet_link: boolean
  document: { id: string; filename: string } | null
  recipients: Recipient[]
  multi_to_note: boolean
  gmail_connection_id?: string | null
  gmail_thread_id?: string | null
  replies?: MessageReply[]
  reply_count?: number
  conversation?: ConversationTurn[]
}

export type SheetConnection = {
  id: string
  google_account_email: string
  spreadsheet_id?: string | null
  spreadsheet_title?: string | null
  spreadsheet_url?: string | null
  sheet_tab?: string | null
  status: string
  is_demo: boolean
  sheet_attached?: boolean
  created_at: string
  updated_at: string
}

export type SheetsResponse = {
  connections: SheetConnection[]
  recent_rows: { id: string; message_id: string; created_at: string; demo: boolean; row: string[] }[]
  oauth_configured: boolean
  demo_allowed: boolean
  scope_reason: string
}

export type TrackingEvent = {
  id: string
  event_type: string
  source: string
  occurred_at: string
  recipient_id: string | null
  recipient_email: string | null
  possible_automated: boolean
  counts_toward_metric: boolean
  metadata: {
    page?: number
    error_code?: string
    demo?: boolean
    destination_host?: string
    destination_url?: string
    confidence?: string
  }
}

export type ContactRecord = {
  id: string
  email: string
  name: string | null
  display_name: string | null
  company: string | null
  job_title: string | null
  linkedin_url: string | null
  company_website: string | null
  job_posting_url: string | null
  target_role: string | null
  pipeline_status: string
  notes: string | null
  tags: string[]
  last_contacted_at: string | null
  next_follow_up_at: string | null
  custom_fields: Record<string, string>
  source: string | null
  created_at: string | null
  updated_at: string | null
  follow_up_overdue: boolean
}

export type PerformancePoint = {
  date: string
  emails_sent: number
  estimated_opens: number
  link_clicks: number
  document_views: number
}

export type PerformanceMetrics = {
  emails_sent: number
  estimated_opens: number
  link_clicks: number
  document_views: number
  open_rate: number | null
  click_rate: number | null
  document_rate: number | null
}

export type PerformanceResponse = {
  from: string
  to: string
  grain: "daily" | "weekly"
  definitions: Record<string, string>
  current: PerformanceMetrics
  previous: PerformanceMetrics
  comparison: {
    emails_sent: number | null
    estimated_opens: number | null
    link_clicks: number | null
    document_views: number | null
  }
  series: PerformancePoint[]
}

export type ActivityItem = {
  id: string
  kind: "email_sent" | "send_failed" | "estimated_open" | "link_click" | "document_view" | "gmail_reauth"
  actor: string | null
  subject: string | null
  message_id: string | null
  occurred_at: string | null
  possible_automated: boolean
  counts_toward_metric: boolean
}

export type Overview = {
  from: string
  to: string
  messages: number
  sent_recipients: number
  failed_recipients: number
  unique_opens_estimated: number
  unique_clickers: number
  document_views: number
  no_activity: number
  since_yesterday: { opens: number; clicks: number; document_views: number }
  quota: { used: number; limit: number }
}

export type GmailConnection = {
  id: string
  google_account_email: string
  status: string
  is_demo: boolean
  granted_scopes: string[]
  can_sync_replies?: boolean
  needs_reconnect?: boolean
  created_at: string
  updated_at: string
}

export type ConnectionsResponse = {
  connections: GmailConnection[]
  oauth_configured: boolean
  demo_allowed: boolean
  scope: string
  scope_reason: string
  needs_reconnect?: boolean
}

export type DocumentLink = {
  id: string
  expires_at: string | null
  revoked_at: string | null
  created_at: string
  recipient_email?: string | null
  active: boolean
}

export type DocumentItem = {
  id: string
  filename: string
  content_type: string
  size_bytes: number
  is_sample: boolean
  created_at: string
  links: DocumentLink[]
}

export function canSend(role: Role | undefined) {
  return role === "owner" || role === "admin" || role === "member"
}

export function canAdmin(role: Role | undefined) {
  return role === "owner" || role === "admin"
}
