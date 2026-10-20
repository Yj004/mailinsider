import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileSpreadsheet,
  Mail,
  Megaphone,
  Plus,
  Rocket,
  Search,
  Users,
  XCircle,
} from "lucide-react"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { SheetBrowser } from "../components/SheetBrowser"
import { WorkspacePage, WsEmpty } from "../components/workspace/WorkspacePage"
import { relativeTime } from "../labels"
import type { ConnectionsResponse, SheetsResponse } from "../types"
import { canSend } from "../types"

type CampaignCounts = {
  total: number
  pending: number
  skipped: number
  queued?: number
  sent: number
  failed: number
}

type Campaign = {
  id: string
  name: string
  subject: string
  body_text: string
  status: string
  message_id: string | null
  counts: CampaignCounts
  variables: string[]
  created_at: string | null
  launched_at?: string | null
  error_message?: string | null
  gmail_connection_id?: string | null
}

type CampaignRecipient = {
  id: string
  email: string
  name: string | null
  status: string
  skip_reason: string | null
  custom_fields: Record<string, string>
}

type CampaignDetail = Campaign & { recipients: CampaignRecipient[] }

type ContactRow = {
  id: string
  email: string
  name?: string | null
  display_name?: string | null
  company?: string | null
}

type Template = { id: string; name: string; subject: string; body_text: string }

const STATUS_FILTERS = [
  { id: "", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "queued", label: "Queued" },
  { id: "sending", label: "Sending" },
  { id: "completed", label: "Completed" },
  { id: "paused", label: "Paused" },
  { id: "cancelled", label: "Cancelled" },
] as const

const DEFAULT_SUBJECT = "Hello {{first_name}}"
const DEFAULT_BODY = "Hi {{first_name}},\n\nThanks for your time at {{company}}.\n"

function statusClass(status: string) {
  if (status === "completed" || status === "sent") return "is-hot"
  if (status === "sending" || status === "queued") return "is-warm"
  if (status === "cancelled" || status === "failed") return "is-cool"
  if (status === "paused") return "is-warm"
  return "is-neutral"
}

function progressPct(counts: CampaignCounts) {
  if (!counts.total) return 0
  const done = counts.sent + counts.failed + counts.skipped
  return Math.min(100, Math.round((done / counts.total) * 100))
}

export function CampaignsPage() {
  const { workspaceId, membership, toast } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const canEdit = canSend(membership?.role)

  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [connections, setConnections] = useState<ConnectionsResponse | null>(null)
  const [sheets, setSheets] = useState<SheetsResponse | null>(null)
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [detail, setDetail] = useState<CampaignDetail | null>(null)

  const [statusFilter, setStatusFilter] = useState("")
  const [activeId, setActiveId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [browsingSheets, setBrowsingSheets] = useState(false)
  const [tab, setTab] = useState<"overview" | "recipients" | "import">("overview")
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pendingContactIds, setPendingContactIds] = useState<string[]>([])

  const [name, setName] = useState("")
  const [subject, setSubject] = useState(DEFAULT_SUBJECT)
  const [body, setBody] = useState(DEFAULT_BODY)
  const [templateId, setTemplateId] = useState("")
  const [connectionId, setConnectionId] = useState("")

  const [contactQ, setContactQ] = useState("")
  const [picked, setPicked] = useState<string[]>([])
  const [confirmLaunch, setConfirmLaunch] = useState(false)

  const [sheetPreview, setSheetPreview] = useState<{
    headers: string[]
    preview_rows: string[][]
    suggested_mapping: Record<string, string>
    row_count: number
  } | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})

  const filtered = useMemo(() => {
    if (!statusFilter) return campaigns
    return campaigns.filter((item) => item.status === statusFilter)
  }, [campaigns, statusFilter])

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { "": campaigns.length }
    for (const item of STATUS_FILTERS) if (item.id) counts[item.id] = 0
    for (const camp of campaigns) counts[camp.status] = (counts[camp.status] || 0) + 1
    return counts
  }, [campaigns])

  const summary = useMemo(() => {
    return campaigns.reduce(
      (acc, item) => {
        acc.pending += item.counts.pending
        acc.sent += item.counts.sent
        acc.failed += item.counts.failed
        if (item.status === "draft") acc.drafts += 1
        if (item.status === "sending" || item.status === "queued") acc.active += 1
        return acc
      },
      { drafts: 0, active: 0, pending: 0, sent: 0, failed: 0 },
    )
  }, [campaigns])

  const gmailOptions = (connections?.connections || []).filter((item) => item.status === "connected")
  const activeConnection = gmailOptions.find((item) => item.id === connectionId) || gmailOptions[0]
  const sheetConnection = (sheets?.connections || []).find((item) => item.status === "connected") || null

  const contactMatches = useMemo(() => {
    const q = contactQ.trim().toLowerCase()
    if (!q) return contacts
    return contacts.filter((c) => {
      const hay = `${c.display_name || ""} ${c.name || ""} ${c.email} ${c.company || ""}`.toLowerCase()
      return hay.includes(q)
    })
  }, [contacts, contactQ])

  const attachedEmails = useMemo(() => new Set((detail?.recipients || []).map((r) => r.email.toLowerCase())), [detail])

  async function refreshList() {
    const [camp, conn, sheetData, contactData, templateData] = await Promise.all([
      api<{ campaigns: Campaign[] }>("/api/v1/campaigns"),
      api<ConnectionsResponse>("/api/v1/integrations/gmail/connections"),
      api<SheetsResponse>("/api/v1/integrations/sheets/connections").catch(() => null),
      api<{ contacts: ContactRow[] }>("/api/v1/contacts?limit=200"),
      api<{ templates: Template[] }>("/api/v1/templates").catch(() => ({ templates: [] as Template[] })),
    ])
    setCampaigns(camp.campaigns)
    setConnections(conn)
    if (sheetData) setSheets(sheetData)
    setContacts(contactData.contacts || [])
    setTemplates(templateData.templates || [])
    const connected = conn.connections.find((item) => item.status === "connected")
    if (connected && !connectionId) setConnectionId(connected.id)
    return camp.campaigns
  }

  async function refreshSheets() {
    const sheetData = await api<SheetsResponse>("/api/v1/integrations/sheets/connections")
    setSheets(sheetData)
    return sheetData
  }

  async function loadDetail(id: string) {
    const data = await api<CampaignDetail>(`/api/v1/campaigns/${id}`)
    setDetail(data)
    if (data.gmail_connection_id) setConnectionId(data.gmail_connection_id)
    return data
  }

  useEffect(() => {
    const raw = searchParams.get("contact_ids") || ""
    const ids = raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 50)
    if (!ids.length) return
    setPendingContactIds(ids)
    setPicked(ids)
    setCreating(true)
    setBrowsingSheets(false)
    setName((current) => current || `Outreach · ${ids.length} contact${ids.length === 1 ? "" : "s"}`)
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("contact_ids")
        return next
      },
      { replace: true },
    )
    toast(`${ids.length} contact${ids.length === 1 ? "" : "s"} ready — create the campaign draft, then attach on Recipients.`)
  }, [searchParams])

  useEffect(() => {
    setLoading(true)
    refreshList()
      .then((rows) => {
        if (!creating && !activeId && !pendingContactIds.length && rows[0]) setActiveId(rows[0].id)
      })
      .catch((err) => toast(err instanceof ApiError ? err.message : "Could not load campaigns.", "bad"))
      .finally(() => setLoading(false))
  }, [workspaceId])

  useEffect(() => {
    if (!activeId || creating) {
      setDetail(null)
      return
    }
    loadDetail(activeId).catch((err) => toast(err instanceof ApiError ? err.message : "Could not load campaign.", "bad"))
  }, [activeId, creating, workspaceId])

  useEffect(() => {
    if (creating) return
    if (activeId && filtered.some((c) => c.id === activeId)) return
    setActiveId(filtered[0]?.id || null)
  }, [filtered, activeId, creating])

  function startCreate() {
    setBrowsingSheets(false)
    setCreating(true)
    setActiveId(null)
    setDetail(null)
    setTab("overview")
    setName("")
    setSubject(DEFAULT_SUBJECT)
    setBody(DEFAULT_BODY)
    setTemplateId("")
    setPicked([])
    setConfirmLaunch(false)
  }

  function applyTemplate(id: string) {
    setTemplateId(id)
    const tpl = templates.find((item) => item.id === id)
    if (!tpl) return
    setSubject(tpl.subject || DEFAULT_SUBJECT)
    setBody(tpl.body_text || DEFAULT_BODY)
  }

  async function createCampaign() {
    if (!name.trim()) return
    setBusy(true)
    try {
      const created = await api<Campaign>("/api/v1/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          subject,
          body_text: body,
          template_id: templateId || null,
          gmail_connection_id: connectionId || null,
        }),
      })
      const seedIds = pendingContactIds.length ? pendingContactIds : picked
      if (seedIds.length) {
        await api(`/api/v1/campaigns/${created.id}/recipients`, {
          method: "POST",
          body: JSON.stringify({ recipients: [], contact_ids: seedIds }),
        })
        toast(`Draft created with ${seedIds.length} recipient${seedIds.length === 1 ? "" : "s"}.`)
        setPendingContactIds([])
        setPicked([])
      } else {
        toast("Campaign draft created.")
      }
      setCreating(false)
      setActiveId(created.id)
      setTab("recipients")
      await refreshList()
      await loadDetail(created.id)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not create campaign.", "bad")
    } finally {
      setBusy(false)
    }
  }

  async function attachRecipients() {
    if (!activeId || !detail) return
    const editable = detail.status === "draft" || detail.status === "paused"
    if (!editable) {
      toast("Recipients can only change on draft or paused campaigns.", "bad")
      return
    }
    setBusy(true)
    try {
      // Preserve existing recipients; API replaces the full set.
      const existing = (detail.recipients || []).map((item) => ({
        email: item.email,
        name: item.name,
        custom_fields: item.custom_fields || {},
      }))
      await api(`/api/v1/campaigns/${activeId}/recipients`, {
        method: "POST",
        body: JSON.stringify({ recipients: existing, contact_ids: picked }),
      })
      toast(picked.length ? `Added ${picked.length} contact${picked.length === 1 ? "" : "s"}.` : "Recipients saved.")
      setPicked([])
      await refreshList()
      await loadDetail(activeId)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not attach recipients.", "bad")
    } finally {
      setBusy(false)
    }
  }

  async function replaceWithPickedOnly() {
    if (!activeId || !detail) return
    if (!picked.length) {
      toast("Select at least one contact.", "bad")
      return
    }
    setBusy(true)
    try {
      await api(`/api/v1/campaigns/${activeId}/recipients`, {
        method: "POST",
        body: JSON.stringify({ recipients: [], contact_ids: picked }),
      })
      toast("Recipient list replaced.")
      setPicked([])
      await refreshList()
      await loadDetail(activeId)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not update recipients.", "bad")
    } finally {
      setBusy(false)
    }
  }

  async function launch() {
    if (!detail) return
    const connection = activeConnection
    if (!connection) {
      toast("Connect Gmail before launching.", "bad")
      return
    }
    setBusy(true)
    try {
      await api(`/api/v1/campaigns/${detail.id}/launch`, {
        method: "POST",
        body: JSON.stringify({
          confirm_count: detail.counts.pending,
          gmail_connection_id: connection.id,
        }),
      })
      toast(connection.is_demo ? "Campaign queued in demo mode." : "Campaign queued for Gmail.")
      setConfirmLaunch(false)
      await refreshList()
      await loadDetail(detail.id)
      setTab("overview")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not launch campaign.", "bad")
    } finally {
      setBusy(false)
    }
  }

  async function cancelCampaign() {
    if (!detail) return
    setBusy(true)
    try {
      await api(`/api/v1/campaigns/${detail.id}/cancel`, { method: "POST" })
      toast("Campaign cancelled.")
      await refreshList()
      await loadDetail(detail.id)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not cancel.", "bad")
    } finally {
      setBusy(false)
    }
  }

  async function loadSheetPreview(opts?: { quiet?: boolean }) {
    try {
      const data = await api<{
        headers: string[]
        preview_rows: string[][]
        suggested_mapping: Record<string, string>
        row_count: number
      }>("/api/v1/integrations/sheets/preview")
      setSheetPreview(data)
      setMapping(data.suggested_mapping)
    } catch (err) {
      setSheetPreview(null)
      if (!opts?.quiet) {
        toast(err instanceof ApiError ? err.message : "Attach a spreadsheet first, then preview columns.", "bad")
      }
    }
  }

  async function onSheetAttached() {
    try {
      await refreshSheets()
      await loadSheetPreview({ quiet: true })
      toast("Sheet selected. Map columns below to import contacts.")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not refresh Sheets.", "bad")
    }
  }

  function openSheetsPicker() {
    setCreating(false)
    setConfirmLaunch(false)
    setBrowsingSheets(true)
    void refreshSheets()
      .then((data) => {
        const connected = data.connections.find((item) => item.status === "connected")
        if (connected?.sheet_attached || connected?.is_demo) void loadSheetPreview({ quiet: true })
      })
      .catch((err) => toast(err instanceof ApiError ? err.message : "Could not load Google Sheets.", "bad"))
  }

  function closeSheetsPicker() {
    setBrowsingSheets(false)
    if (activeId) setTab("recipients")
  }

  async function importSheet() {
    setBusy(true)
    try {
      const result = await api<{ imported_count: number; error_count: number }>("/api/v1/integrations/sheets/import", {
        method: "POST",
        body: JSON.stringify({ mapping, dry_run: false }),
      })
      toast(`Imported ${result.imported_count} contacts (${result.error_count} row errors).`)
      const contactData = await api<{ contacts: ContactRow[] }>("/api/v1/contacts?limit=200")
      setContacts(contactData.contacts || [])
      setBrowsingSheets(false)
      if (activeId) setTab("recipients")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Import failed.", "bad")
    } finally {
      setBusy(false)
    }
  }

  const showEmpty = !loading && campaigns.length === 0 && !creating && !browsingSheets
  const active = creating || browsingSheets ? null : detail || campaigns.find((c) => c.id === activeId) || null
  const canEditRecipients = active?.status === "draft" || active?.status === "paused"
  const canLaunch = Boolean(active && canEdit && canEditRecipients && (active.counts?.pending || 0) > 0)
  const canCancel = Boolean(
    active && canEdit && ["draft", "queued", "sending", "paused"].includes(active.status),
  )

  const sheetsPicker = (
    <div className="crm-import">
      <div className="crm-import-head">
        <div>
          <h2>Select a Google Sheet</h2>
          <p className="meta">
            Your Drive spreadsheets open here inside MailInsider. Click a file to preview, then use it for this workspace.
          </p>
        </div>
      </div>

      {!sheetConnection ? (
        <div className="camp-sheets-empty">
          <p className="quiet">
            Google Sheets is not connected yet. Connect once under Integrations, then pick sheets here without leaving Campaigns.
          </p>
          <Link className="btn primary" to="/app/integrations">
            Connect Google Sheets
          </Link>
        </div>
      ) : (
        <div className="stack gap-4">
          <div>
            <strong>{sheetConnection.google_account_email}</strong>
            <div className="meta">
              {sheetConnection.sheet_attached
                ? `Currently using ${sheetConnection.spreadsheet_title}${sheetConnection.sheet_tab ? ` · ${sheetConnection.sheet_tab}` : ""}`
                : "Connected — choose any spreadsheet below"}
              {sheetConnection.is_demo ? " · Local demo log" : ""}
            </div>
          </div>

          {!sheetConnection.is_demo ? (
            <SheetBrowser connection={sheetConnection} onAttached={() => void onSheetAttached()} />
          ) : (
            <p className="quiet">Demo sheet log is local. Connect a real Google account to browse Drive files.</p>
          )}

          <div className="camp-import-block">
            <div className="camp-section-head">
              <h3>Import contacts from selected sheet</h3>
              <button
                type="button"
                className="btn small"
                disabled={!sheetConnection.sheet_attached && !sheetConnection.is_demo}
                onClick={() => void loadSheetPreview()}
              >
                Refresh columns
              </button>
            </div>
            <p className="meta" style={{ marginBottom: 12 }}>
              Imports into Contacts. Then add them to a campaign from the Recipients tab.
            </p>
            {sheetPreview ? (
              <div className="stack">
                <p className="meta">{sheetPreview.row_count} data rows</p>
                <div className="camp-map-grid">
                  {(["email", "first_name", "last_name", "company"] as const).map((field) => (
                    <label key={field} className="field">
                      <span>{field}</span>
                      <select value={mapping[field] || ""} onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}>
                        <option value="">—</option>
                        {sheetPreview.headers.map((header) => (
                          <option key={header} value={header}>
                            {header}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy || !mapping.email || !canEdit}
                  onClick={() => void importSheet()}
                >
                  Import contacts
                </button>
                <div className="sheet-table-wrap">
                  <table className="sheet-table">
                    <thead>
                      <tr>
                        {sheetPreview.headers.map((header) => (
                          <th key={header}>{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sheetPreview.preview_rows.map((row, idx) => (
                        <tr key={idx}>
                          {sheetPreview.headers.map((_, col) => (
                            <td key={col}>{row[col] || ""}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <p className="quiet">
                {sheetConnection.sheet_attached || sheetConnection.is_demo
                  ? "Loading column preview…"
                  : "Select and use a spreadsheet above to map columns."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )

  return (
    <WorkspacePage
      title="Campaigns"
      subtitle="Personalized bulk sends through the same durable Gmail queue as Compose. Delivery means provider-accepted — not inbox proof."
      actions={
        <>
          {browsingSheets ? (
            <button className="btn" type="button" onClick={closeSheetsPicker}>
              <ArrowLeft size={16} /> Back to campaigns
            </button>
          ) : (
            <button className="btn" type="button" onClick={openSheetsPicker}>
              <FileSpreadsheet size={16} /> Browse Sheets
            </button>
          )}
          <Link className="btn" to="/app/contacts">
            <Users size={16} /> Contacts
          </Link>
          {canEdit && !browsingSheets ? (
            <button className="btn primary" type="button" onClick={startCreate}>
              <Plus size={16} /> New campaign
            </button>
          ) : null}
        </>
      }
    >
      {browsingSheets ? (
        sheetsPicker
      ) : showEmpty ? (
        <WsEmpty
          title="Launch your first campaign"
          body="Draft a message with merge fields, pull recipients from Contacts or your attached Google Sheet, then launch when the list looks right."
          action={
            <>
              <button className="btn" type="button" onClick={openSheetsPicker}>
                <FileSpreadsheet size={16} /> Browse Sheets
              </button>
              {canEdit ? (
                <button className="btn primary" type="button" onClick={startCreate}>
                  <Megaphone size={16} /> Create campaign
                </button>
              ) : null}
            </>
          }
        />
      ) : (
        <div className="camp">
          <div className="camp-metrics">
            <article>
              <span>Drafts</span>
              <b>{summary.drafts}</b>
            </article>
            <article>
              <span>In flight</span>
              <b>{summary.active}</b>
            </article>
            <article>
              <span>Pending sends</span>
              <b>{summary.pending}</b>
            </article>
            <article>
              <span>Sent</span>
              <b>{summary.sent}</b>
            </article>
            <article>
              <span>Failed</span>
              <b>{summary.failed}</b>
            </article>
          </div>

          <div className="camp-stages" role="tablist" aria-label="Campaign status">
            {STATUS_FILTERS.map((item) => (
              <button
                key={item.id || "all"}
                type="button"
                role="tab"
                aria-selected={statusFilter === item.id}
                className={`camp-stage${statusFilter === item.id ? " is-on" : ""}`}
                onClick={() => setStatusFilter(item.id)}
              >
                {item.label}
                <span className="crm-count">{statusCounts[item.id] || 0}</span>
              </button>
            ))}
          </div>

          <div className="camp-shell">
            <aside className="camp-list" aria-label="Campaign list">
              <div className="camp-list-head">
                <Megaphone size={14} aria-hidden />
                <span>
                  {filtered.length} campaign{filtered.length === 1 ? "" : "s"}
                </span>
              </div>
              {loading ? <p className="quiet camp-pad">Loading…</p> : null}
              {!loading && filtered.length === 0 ? (
                <p className="quiet camp-pad">No campaigns in this status.</p>
              ) : null}
              <div className="camp-list-scroll">
                {filtered.map((item) => {
                  const on = !creating && item.id === activeId
                  const pct = progressPct(item.counts)
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`camp-row${on ? " is-on" : ""}`}
                      onClick={() => {
                        setCreating(false)
                        setConfirmLaunch(false)
                        setActiveId(item.id)
                        setTab("overview")
                      }}
                    >
                      <span className="camp-row-top">
                        <strong>{item.name}</strong>
                        <span className={`crm-pill ${statusClass(item.status)}`}>{item.status}</span>
                      </span>
                      <span className="meta">
                        {item.counts.pending} pending · {item.counts.total} total
                        {item.created_at ? ` · ${relativeTime(item.created_at)}` : ""}
                      </span>
                      {item.counts.total > 0 ? (
                        <span className="camp-progress" aria-hidden>
                          <span style={{ width: `${pct}%` }} />
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </aside>

            <section className="camp-detail">
              {creating ? (
                <div className="camp-create">
                  <header className="camp-detail-head">
                    <div>
                      <h2>New campaign</h2>
                      <p className="meta">
                        Creates a draft only — nothing sends until you launch.
                        {pendingContactIds.length
                          ? ` ${pendingContactIds.length} contact${pendingContactIds.length === 1 ? "" : "s"} from Contacts will be attached when you create.`
                          : ""}
                      </p>
                    </div>
                    <div className="camp-detail-actions">
                      <button className="btn primary" type="button" disabled={busy || !name.trim()} onClick={() => void createCampaign()}>
                        Create draft
                      </button>
                      <button
                        className="btn ghost"
                        type="button"
                        onClick={() => {
                          setCreating(false)
                          setActiveId(filtered[0]?.id || campaigns[0]?.id || null)
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </header>
                  <div className="camp-form">
                    {templates.length ? (
                      <label className="field">
                        <span>Start from template</span>
                        <select value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                          <option value="">Blank</option>
                          {templates.map((tpl) => (
                            <option key={tpl.id} value={tpl.id}>
                              {tpl.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <label className="field">
                      <span>Campaign name</span>
                      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q2 founder outreach" />
                    </label>
                    <label className="field">
                      <span>Subject</span>
                      <input value={subject} onChange={(e) => setSubject(e.target.value)} />
                    </label>
                    <label className="field">
                      <span>Body</span>
                      <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
                    </label>
                    <p className="hint">Merge fields: {"{{first_name}}"}, {"{{last_name}}"}, {"{{company}}"}, {"{{email}}"}</p>
                    {gmailOptions.length ? (
                      <label className="field">
                        <span>Send from</span>
                        <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                          {gmailOptions.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.google_account_email}
                              {item.is_demo ? " (demo)" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <p className="camp-alert">
                        <AlertTriangle size={14} /> Connect Gmail under Integrations before launch.
                      </p>
                    )}
                  </div>
                </div>
              ) : active ? (
                <>
                  <header className="camp-detail-head">
                    <div className="camp-detail-identity">
                      <span className={`crm-pill ${statusClass(active.status)}`}>{active.status}</span>
                      <div>
                        <h2>{active.name}</h2>
                        <p className="meta">
                          {active.subject || "No subject"}
                          {active.launched_at ? ` · Launched ${relativeTime(active.launched_at)}` : ""}
                          {active.created_at && !active.launched_at ? ` · Created ${relativeTime(active.created_at)}` : ""}
                        </p>
                      </div>
                    </div>
                    <div className="camp-detail-actions">
                      {active.message_id ? (
                        <Link className="btn" to={`/app/messages/${active.message_id}`}>
                          <Mail size={15} /> Open message
                        </Link>
                      ) : null}
                      {canCancel && active.status !== "draft" ? (
                        <button className="btn ghost" type="button" disabled={busy} onClick={() => void cancelCampaign()}>
                          <XCircle size={15} /> Cancel
                        </button>
                      ) : null}
                      {canLaunch ? (
                        <button
                          className="btn primary"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setConfirmLaunch(true)
                            setTab("overview")
                          }}
                        >
                          <Rocket size={15} /> Launch ({active.counts.pending})
                        </button>
                      ) : null}
                    </div>
                  </header>

                  <div className="camp-stat-row">
                    <div>
                      <span>Total</span>
                      <b>{active.counts.total}</b>
                    </div>
                    <div>
                      <span>Pending</span>
                      <b>{active.counts.pending}</b>
                    </div>
                    <div>
                      <span>Sent</span>
                      <b>{active.counts.sent}</b>
                    </div>
                    <div>
                      <span>Failed</span>
                      <b>{active.counts.failed}</b>
                    </div>
                    <div>
                      <span>Skipped</span>
                      <b>{active.counts.skipped}</b>
                    </div>
                  </div>

                  {active.counts.total > 0 ? (
                    <div className="camp-progress-bar" aria-label={`${progressPct(active.counts)}% complete`}>
                      <span style={{ width: `${progressPct(active.counts)}%` }} />
                    </div>
                  ) : null}

                  {active.error_message ? (
                    <p className="camp-alert">
                      <AlertTriangle size={14} /> {active.error_message}
                    </p>
                  ) : null}

                  {confirmLaunch ? (
                    <div className="camp-confirm">
                      <div>
                        <strong>Confirm launch</strong>
                        <p className="meta">
                          Queue {active.counts.pending} pending recipient{active.counts.pending === 1 ? "" : "s"} through{" "}
                          {activeConnection?.google_account_email || "Gmail"}.
                          {activeConnection?.is_demo ? " Demo mode — messages stay local." : ""}
                        </p>
                      </div>
                      <div className="camp-detail-actions">
                        <button className="btn primary" type="button" disabled={busy || !activeConnection} onClick={() => void launch()}>
                          <CheckCircle2 size={15} /> Confirm &amp; send
                        </button>
                        <button className="btn ghost" type="button" onClick={() => setConfirmLaunch(false)}>
                          Back
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="crm-tabs" role="tablist">
                    <button type="button" role="tab" className={tab === "overview" ? "is-on" : ""} onClick={() => setTab("overview")}>
                      Overview
                    </button>
                    <button type="button" role="tab" className={tab === "recipients" ? "is-on" : ""} onClick={() => setTab("recipients")}>
                      Recipients
                    </button>
                    <button type="button" role="tab" className={tab === "import" ? "is-on" : ""} onClick={() => openSheetsPicker()}>
                      Sheets
                    </button>
                  </div>

                  {tab === "overview" ? (
                    <div className="camp-panel">
                      <div className="camp-overview-grid">
                        <div className="camp-preview">
                          <h3>Message</h3>
                          <p className="camp-subject">{active.subject || "—"}</p>
                          <pre className="camp-body">{active.body_text || "—"}</pre>
                        </div>
                        <div className="camp-side">
                          <h3>Merge fields</h3>
                          {active.variables?.length ? (
                            <div className="camp-vars">
                              {active.variables.map((v) => (
                                <span key={v} className="ws-pill">
                                  {`{{${v}}}`}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <p className="quiet">No merge fields detected.</p>
                          )}
                          <h3>Send from</h3>
                          {gmailOptions.length ? (
                            <select
                              value={connectionId}
                              onChange={(e) => setConnectionId(e.target.value)}
                              disabled={!canEditRecipients}
                            >
                              {gmailOptions.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.google_account_email}
                                  {item.is_demo ? " (demo)" : ""}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <p className="quiet">
                              <Link to="/app/integrations">Connect Gmail</Link> to launch.
                            </p>
                          )}
                          <h3>Next step</h3>
                          <ol className="ws-steps">
                            <li>Add recipients from Contacts or Import.</li>
                            <li>Review pending count and merge fields.</li>
                            <li>Launch — each send uses the Compose queue.</li>
                          </ol>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {tab === "recipients" ? (
                    <div className="camp-panel camp-recipients">
                      <div className="camp-recip-cols">
                        <div>
                          <div className="camp-section-head">
                            <h3>On this campaign</h3>
                            <span className="meta">{detail?.recipients?.length || 0}</span>
                          </div>
                          {(detail?.recipients || []).length === 0 ? (
                            <p className="quiet">No recipients yet. Add from CRM or import a Sheet.</p>
                          ) : (
                            <ul className="camp-recip-list">
                              {(detail?.recipients || []).map((item) => (
                                <li key={item.id}>
                                  <div>
                                    <strong>{item.name || item.email}</strong>
                                    {item.name ? <div className="meta">{item.email}</div> : null}
                                  </div>
                                  <span className={`crm-pill ${statusClass(item.status)}`}>
                                    {item.status}
                                    {item.skip_reason ? ` · ${item.skip_reason}` : ""}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div>
                          <div className="camp-section-head">
                            <h3>Add from Contacts</h3>
                          </div>
                          {!canEditRecipients ? (
                            <p className="quiet">Recipients are locked after launch.</p>
                          ) : (
                            <>
                              <div className="crm-search" style={{ marginBottom: 10 }}>
                                <Search size={16} aria-hidden />
                                <input
                                  value={contactQ}
                                  onChange={(e) => setContactQ(e.target.value)}
                                  placeholder="Search contacts"
                                  aria-label="Search contacts"
                                />
                              </div>
                              <div className="camp-pick-list">
                                {contactMatches.map((contact) => {
                                  const already = attachedEmails.has(contact.email.toLowerCase())
                                  const checked = picked.includes(contact.id)
                                  return (
                                    <label key={contact.id} className={`camp-pick${already ? " is-attached" : ""}`}>
                                      <input
                                        type="checkbox"
                                        disabled={already}
                                        checked={checked || already}
                                        onChange={() =>
                                          setPicked((prev) =>
                                            checked ? prev.filter((id) => id !== contact.id) : [...prev, contact.id],
                                          )
                                        }
                                      />
                                      <span>
                                        <strong>{contact.display_name || contact.name || contact.email}</strong>
                                        <span className="meta">
                                          {contact.email}
                                          {contact.company ? ` · ${contact.company}` : ""}
                                          {already ? " · already added" : ""}
                                        </span>
                                      </span>
                                    </label>
                                  )
                                })}
                                {contactMatches.length === 0 ? (
                                  <p className="quiet">No contacts match. Import a Sheet or add contacts first.</p>
                                ) : null}
                              </div>
                              <div className="camp-detail-actions" style={{ marginTop: 12 }}>
                                <button
                                  className="btn primary"
                                  type="button"
                                  disabled={busy || picked.length === 0}
                                  onClick={() => void attachRecipients()}
                                >
                                  Add selected ({picked.length})
                                </button>
                                <button
                                  className="btn ghost"
                                  type="button"
                                  disabled={busy || picked.length === 0}
                                  onClick={() => void replaceWithPickedOnly()}
                                >
                                  Replace list with selected
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {tab === "import" ? (
                    <div className="camp-panel">
                      <p className="quiet">Opening your Google Sheets picker…</p>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="crm-detail-empty">
                  <Megaphone size={28} strokeWidth={1.5} />
                  <h2>Select a campaign</h2>
                  <p>Pick a draft from the list, or create a new one to start outreach.</p>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </WorkspacePage>
  )
}
