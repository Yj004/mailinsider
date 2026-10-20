import { FormEvent, useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  Building2,
  CalendarClock,
  ExternalLink,
  FileSpreadsheet,
  Mail,
  Megaphone,
  Plus,
  Search,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { useCompose } from "../compose"
import { SheetBrowser } from "../components/SheetBrowser"
import { WorkspacePage, WsEmpty } from "../components/workspace/WorkspacePage"
import { PIPELINE_LABEL, PIPELINE_STATUSES, relativeTime } from "../labels"
import type { ContactRecord, SheetsResponse } from "../types"
import { canSend } from "../types"

const emptyForm = {
  email: "",
  display_name: "",
  company: "",
  job_title: "",
  target_role: "",
  linkedin_url: "",
  job_posting_url: "",
  pipeline_status: "to_contact",
  notes: "",
  next_follow_up_at: "",
}

type DetailPayload = {
  contact: ContactRecord
  messages: { id: string; subject: string; send_status: string; sent_at: string | null; signal: string }[]
  events: { id: string; event_type: string; occurred_at: string | null }[]
}

function initials(name: string | null | undefined, email: string) {
  const source = (name || email || "?").trim()
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

function stageClass(status: string) {
  if (status === "replied" || status === "interview") return "is-hot"
  if (status === "follow_up_due" || status === "open_detected" || status === "link_clicked") return "is-warm"
  if (status === "rejected" || status === "no_response" || status === "closed") return "is-cool"
  return "is-neutral"
}

export function ContactsPage() {
  const { workspaceId, membership, toast } = useAuth()
  const { openCompose } = useCompose()
  const [params, setParams] = useSearchParams()
  const queryClient = useQueryClient()
  const [q, setQ] = useState("")
  const [submitted, setSubmitted] = useState("")
  const [status, setStatus] = useState(params.get("status") || "")
  const [overdueOnly, setOverdueOnly] = useState(params.get("overdue") === "1")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const [deleting, setDeleting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(params.get("import") === "1")
  const [detailTab, setDetailTab] = useState<"profile" | "activity">("profile")
  const [form, setForm] = useState(emptyForm)
  const MAX_BULK = 50
  const [sheets, setSheets] = useState<SheetsResponse | null>(null)
  const [sheetBusy, setSheetBusy] = useState(false)
  const [sheetPreview, setSheetPreview] = useState<{
    headers: string[]
    preview_rows: string[][]
    suggested_mapping: Record<string, string>
    row_count: number
  } | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})

  useEffect(() => {
    setStatus(params.get("status") || "")
    setOverdueOnly(params.get("overdue") === "1")
    setImporting(params.get("import") === "1")
  }, [params])

  const sheetConnection = (sheets?.connections || []).find((item) => item.status === "connected") || null

  async function refreshSheets() {
    const data = await api<SheetsResponse>("/api/v1/integrations/sheets/connections")
    setSheets(data)
    return data
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

  useEffect(() => {
    if (!importing) return
    refreshSheets()
      .then((data) => {
        const active = data.connections.find((item) => item.status === "connected")
        if (active?.sheet_attached || active?.is_demo) void loadSheetPreview({ quiet: true })
      })
      .catch((err) => toast(err instanceof ApiError ? err.message : "Could not load Google Sheets.", "bad"))
  }, [importing, workspaceId])

  const list = useQuery({
    queryKey: ["contacts", workspaceId, submitted],
    queryFn: () => {
      const query = new URLSearchParams()
      if (submitted) query.set("q", submitted)
      query.set("limit", "200")
      return api<{ contacts: ContactRecord[]; total: number }>(`/api/v1/contacts?${query}`)
    },
  })

  const contacts = list.data?.contacts || []

  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = { "": contacts.length }
    for (const item of PIPELINE_STATUSES) counts[item] = 0
    for (const contact of contacts) {
      const key = contact.pipeline_status || "to_contact"
      counts[key] = (counts[key] || 0) + 1
    }
    return counts
  }, [contacts])

  const overdueCount = useMemo(() => contacts.filter((c) => c.follow_up_overdue).length, [contacts])

  const filtered = useMemo(() => {
    let rows = contacts
    if (status) rows = rows.filter((c) => (c.pipeline_status || "to_contact") === status)
    if (overdueOnly) rows = rows.filter((c) => c.follow_up_overdue)
    return rows
  }, [contacts, status, overdueOnly])

  const checkedContacts = useMemo(
    () => filtered.filter((contact) => checkedIds.includes(contact.id)),
    [filtered, checkedIds],
  )
  const allFilteredChecked = filtered.length > 0 && filtered.every((c) => checkedIds.includes(c.id))

  useEffect(() => {
    if (creating) return
    if (selectedId && filtered.some((c) => c.id === selectedId)) return
    setSelectedId(filtered[0]?.id || null)
  }, [filtered, selectedId, creating])

  const detail = useQuery({
    queryKey: ["contact", workspaceId, selectedId],
    enabled: Boolean(selectedId) && !creating,
    queryFn: () => api<DetailPayload>(`/api/v1/contacts/${selectedId}`),
  })

  const save = useMutation({
    mutationFn: async () => {
      if (creating) {
        return api<ContactRecord>("/api/v1/contacts", {
          method: "POST",
          body: JSON.stringify({
            ...form,
            display_name: form.display_name || null,
            company: form.company || null,
            job_title: form.job_title || null,
            target_role: form.target_role || null,
            linkedin_url: form.linkedin_url || null,
            job_posting_url: form.job_posting_url || null,
            notes: form.notes || null,
            next_follow_up_at: form.next_follow_up_at ? new Date(form.next_follow_up_at).toISOString() : null,
          }),
        })
      }
      if (!selectedId) throw new Error("No contact selected")
      return api<ContactRecord>(`/api/v1/contacts/${selectedId}`, {
        method: "PATCH",
        body: JSON.stringify({
          display_name: form.display_name || null,
          company: form.company || null,
          job_title: form.job_title || null,
          target_role: form.target_role || null,
          linkedin_url: form.linkedin_url || null,
          job_posting_url: form.job_posting_url || null,
          pipeline_status: form.pipeline_status,
          notes: form.notes || null,
          next_follow_up_at: form.next_follow_up_at ? new Date(form.next_follow_up_at).toISOString() : null,
          clear_follow_up: !form.next_follow_up_at,
        }),
      })
    },
    onSuccess: (row) => {
      toast(creating ? "Contact saved." : "Contact updated.")
      setCreating(false)
      setSelectedId(row.id)
      setDetailTab("profile")
      queryClient.invalidateQueries({ queryKey: ["contacts", workspaceId] })
      queryClient.invalidateQueries({ queryKey: ["contact", workspaceId, row.id] })
      queryClient.invalidateQueries({ queryKey: ["follow-ups", workspaceId] })
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : "Could not save contact.", "bad"),
  })

  const selected = detail.data?.contact
  useEffect(() => {
    if (creating || !selected) return
    setForm({
      email: selected.email,
      display_name: selected.display_name || "",
      company: selected.company || "",
      job_title: selected.job_title || "",
      target_role: selected.target_role || "",
      linkedin_url: selected.linkedin_url || "",
      job_posting_url: selected.job_posting_url || "",
      pipeline_status: selected.pipeline_status || "to_contact",
      notes: selected.notes || "",
      next_follow_up_at: selected.next_follow_up_at ? selected.next_follow_up_at.slice(0, 16) : "",
    })
  }, [selected?.id, selected?.updated_at, creating])

  function setFilter(nextStatus: string, nextOverdue = overdueOnly) {
    setStatus(nextStatus)
    setOverdueOnly(nextOverdue)
    const updated = new URLSearchParams(params)
    if (nextStatus) updated.set("status", nextStatus)
    else updated.delete("status")
    if (nextOverdue) updated.set("overdue", "1")
    else updated.delete("overdue")
    setParams(updated)
  }

  function onSearch(event: FormEvent) {
    event.preventDefault()
    setSubmitted(q.trim())
  }

  function startCreate() {
    setImporting(false)
    setCreating(true)
    setSelectedId(null)
    setForm(emptyForm)
    setDetailTab("profile")
    const updated = new URLSearchParams(params)
    updated.delete("import")
    setParams(updated)
  }

  function toggleChecked(id: string) {
    setCheckedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id].slice(0, MAX_BULK)))
  }

  function toggleSelectAllFiltered() {
    if (allFilteredChecked) {
      const drop = new Set(filtered.map((c) => c.id))
      setCheckedIds((prev) => prev.filter((id) => !drop.has(id)))
      return
    }
    const merged = new Set(checkedIds)
    for (const contact of filtered) {
      if (merged.size >= MAX_BULK) break
      merged.add(contact.id)
    }
    setCheckedIds([...merged])
    if (filtered.length > MAX_BULK) {
      toast(`Selected the first ${MAX_BULK} contacts in this view (send limit).`)
    }
  }

  function openBulkCompose() {
    const emails = checkedContacts.map((c) => c.email).filter(Boolean)
    if (!emails.length) return
    openCompose({ to: emails.join(",") })
  }

  function bulkCampaignHref() {
    const ids = checkedContacts.map((c) => c.id)
    return `/app/campaigns?contact_ids=${encodeURIComponent(ids.join(","))}`
  }

  async function bulkDelete() {
    const ids = checkedContacts.map((c) => c.id)
    if (!ids.length || !editable) return
    const label = ids.length === 1 ? "this contact" : `these ${ids.length} contacts`
    if (!window.confirm(`Delete ${label} from the CRM? Sent mail history stays; only the contact records are removed.`)) {
      return
    }
    setDeleting(true)
    try {
      const result = await api<{ deleted: number }>("/api/v1/contacts/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ contact_ids: ids }),
      })
      toast(`Deleted ${result.deleted} contact${result.deleted === 1 ? "" : "s"}.`)
      setCheckedIds([])
      if (selectedId && ids.includes(selectedId)) setSelectedId(null)
      queryClient.invalidateQueries({ queryKey: ["contacts", workspaceId] })
      queryClient.invalidateQueries({ queryKey: ["follow-ups", workspaceId] })
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not delete contacts.", "bad")
    } finally {
      setDeleting(false)
    }
  }

  function openSheetImport() {
    setCreating(false)
    setImporting(true)
    const updated = new URLSearchParams(params)
    updated.set("import", "1")
    setParams(updated)
  }

  function closeSheetImport() {
    setImporting(false)
    setSheetPreview(null)
    const updated = new URLSearchParams(params)
    updated.delete("import")
    setParams(updated)
  }

  async function onSheetAttached() {
    try {
      await refreshSheets()
      await loadSheetPreview({ quiet: true })
      toast("Spreadsheet attached. Map columns below to import contacts.")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not refresh Sheets.", "bad")
    }
  }

  async function importSheet() {
    setSheetBusy(true)
    try {
      const result = await api<{ imported_count: number; error_count: number }>("/api/v1/integrations/sheets/import", {
        method: "POST",
        body: JSON.stringify({ mapping, dry_run: false }),
      })
      toast(`Imported ${result.imported_count} contacts (${result.error_count} row errors).`)
      queryClient.invalidateQueries({ queryKey: ["contacts", workspaceId] })
      closeSheetImport()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Import failed.", "bad")
    } finally {
      setSheetBusy(false)
    }
  }

  const error = list.error instanceof ApiError ? list.error.message : list.error ? "Could not load contacts." : ""
  const editable = canSend(membership?.role)
  const showEmptyWorkspace = !list.isLoading && contacts.length === 0 && !creating && !submitted && !importing

  return (
    <WorkspacePage
      title="Contacts"
      subtitle="Your outreach CRM. Track pipeline stage, follow-ups, and every send — opens never move someone backward from Interview or Replied."
      actions={
        <>
          {importing ? (
            <button className="btn" type="button" onClick={closeSheetImport}>
              <ArrowLeft size={16} /> Back to contacts
            </button>
          ) : (
            <button className="btn" type="button" onClick={openSheetImport}>
              <FileSpreadsheet size={16} /> Import from Sheets
            </button>
          )}
          <Link className="btn" to="/app/follow-ups">
            <CalendarClock size={16} /> Follow-up queue
          </Link>
          {editable && !importing ? (
            <button className="btn primary" type="button" onClick={startCreate}>
              <Plus size={16} /> Add contact
            </button>
          ) : null}
        </>
      }
    >
      {error ? <div className="banner bad">{error}</div> : null}

      {importing ? (
        <div className="crm-import">
          <div className="crm-import-head">
            <div>
              <h2>Import from Google Sheets</h2>
              <p className="meta">
                Browse Drive, preview any spreadsheet, attach it, then map columns into Contacts — without leaving this page.
              </p>
            </div>
          </div>

          {!sheetConnection ? (
            <div className="camp-sheets-empty">
              <p className="quiet">
                Google Sheets is not connected for this workspace yet. Connect once under Integrations, then browse sheets here.
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
                    ? `Using ${sheetConnection.spreadsheet_title}${sheetConnection.sheet_tab ? ` · ${sheetConnection.sheet_tab}` : ""}`
                    : "Account connected — pick a spreadsheet below"}
                  {sheetConnection.is_demo ? " · Local demo log" : ""}
                </div>
                {sheetConnection.spreadsheet_url ? (
                  <div className="meta">
                    <a href={sheetConnection.spreadsheet_url} target="_blank" rel="noreferrer">
                      Open in Google Sheets
                    </a>
                  </div>
                ) : null}
              </div>

              {!sheetConnection.is_demo ? (
                <SheetBrowser connection={sheetConnection} onAttached={() => void onSheetAttached()} />
              ) : (
                <p className="quiet">Demo sheet log is local. Use a real Google connection to browse Drive files.</p>
              )}

              <div className="camp-import-block">
                <div className="camp-section-head">
                  <h3>Map columns &amp; import</h3>
                  <button
                    type="button"
                    className="btn small"
                    disabled={!sheetConnection.sheet_attached && !sheetConnection.is_demo}
                    onClick={() => void loadSheetPreview()}
                  >
                    Refresh columns
                  </button>
                </div>
                {sheetPreview ? (
                  <div className="stack">
                    <p className="meta">{sheetPreview.row_count} data rows</p>
                    <div className="camp-map-grid">
                      {(["email", "first_name", "last_name", "company"] as const).map((field) => (
                        <label key={field} className="field">
                          <span>{field}</span>
                          <select
                            value={mapping[field] || ""}
                            onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}
                          >
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
                      disabled={sheetBusy || !mapping.email || !editable}
                      onClick={() => void importSheet()}
                    >
                      {sheetBusy ? "Importing…" : "Import contacts"}
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
                      : "Attach a spreadsheet above to map columns and import."}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      ) : showEmptyWorkspace ? (
        <WsEmpty
          title="Build your contact book"
          body="Add prospects manually, import from Google Sheets, or send once from Compose — recipients land here automatically."
          action={
            <>
              <button className="btn" type="button" onClick={openSheetImport}>
                <FileSpreadsheet size={16} /> Import from Sheets
              </button>
              {editable ? (
                <button className="btn primary" type="button" onClick={startCreate}>
                  <UserPlus size={16} /> Add first contact
                </button>
              ) : null}
            </>
          }
        />
      ) : (
        <div className="crm">
          <div className="crm-toolbar">
            <form className="crm-search" onSubmit={onSearch}>
              <Search size={16} aria-hidden />
              <input
                value={q}
                onChange={(event) => setQ(event.target.value)}
                placeholder="Search name, email, company, or role"
                aria-label="Search contacts"
              />
              <button className="btn small" type="submit">
                Search
              </button>
            </form>
            <button
              type="button"
              className={`crm-overdue-btn${overdueOnly ? " is-on" : ""}`}
              onClick={() => setFilter(status, !overdueOnly)}
            >
              <CalendarClock size={14} />
              Overdue
              <span className="crm-count">{overdueCount}</span>
            </button>
          </div>

          <div className="crm-stages" role="tablist" aria-label="Pipeline stages">
            <button
              type="button"
              role="tab"
              aria-selected={!status}
              className={`crm-stage${!status ? " is-on" : ""}`}
              onClick={() => setFilter("")}
            >
              All <span className="crm-count">{stageCounts[""] || 0}</span>
            </button>
            {PIPELINE_STATUSES.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={status === item}
                className={`crm-stage${status === item ? " is-on" : ""}`}
                onClick={() => setFilter(item)}
              >
                {PIPELINE_LABEL[item]}
                <span className="crm-count">{stageCounts[item] || 0}</span>
              </button>
            ))}
          </div>

          {checkedIds.length > 0 && editable ? (
            <div className="crm-bulk-bar" role="region" aria-label="Bulk actions">
              <span className="crm-bulk-count">
                <strong>{checkedContacts.length}</strong> selected
                {checkedIds.length > checkedContacts.length
                  ? ` (${checkedIds.length - checkedContacts.length} hidden by filter)`
                  : ""}
              </span>
              <div className="crm-bulk-actions">
                <button type="button" className="btn primary" onClick={openBulkCompose}>
                  <Mail size={15} /> Compose to selected
                </button>
                <Link className="btn" to={bulkCampaignHref()}>
                  <Megaphone size={15} /> Start campaign
                </Link>
                <button className="btn danger" type="button" disabled={deleting} onClick={() => void bulkDelete()}>
                  <Trash2 size={15} /> {deleting ? "Deleting…" : "Delete selected"}
                </button>
                <button className="btn ghost" type="button" onClick={() => setCheckedIds([])}>
                  <X size={15} /> Clear
                </button>
              </div>
              <p className="meta crm-bulk-hint">
                Compose sends the same message to each selected address (up to {MAX_BULK}). Campaign is better when you need{" "}
                {"{{first_name}}"} personalization. Delete removes CRM records only — past sends stay.
              </p>
            </div>
          ) : null}

          <div className="crm-shell">
            <aside className="crm-list" aria-label="Contact list">
              <div className="crm-list-head">
                <label className="crm-select-all">
                  <input
                    type="checkbox"
                    checked={allFilteredChecked}
                    disabled={!filtered.length || !editable}
                    onChange={toggleSelectAllFiltered}
                    aria-label="Select all contacts in this view"
                  />
                </label>
                <Users size={14} aria-hidden />
                <span>
                  {filtered.length} contact{filtered.length === 1 ? "" : "s"}
                  {submitted ? ` matching “${submitted}”` : ""}
                </span>
              </div>
              {list.isLoading ? <p className="quiet crm-pad">Loading contacts…</p> : null}
              {!list.isLoading && filtered.length === 0 ? (
                <div className="crm-pad">
                  <p className="quiet">No contacts in this view. Clear filters or add someone new.</p>
                  {editable ? (
                    <button className="btn small" type="button" onClick={startCreate} style={{ marginTop: 10 }}>
                      Add contact
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="crm-list-scroll">
                {filtered.map((contact) => {
                  const active = !creating && selectedId === contact.id
                  const checked = checkedIds.includes(contact.id)
                  const label = contact.display_name || contact.email
                  return (
                    <div key={contact.id} className={`crm-row${active ? " is-on" : ""}${checked ? " is-checked" : ""}`}>
                      <label className="crm-check" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!editable}
                          onChange={() => toggleChecked(contact.id)}
                          aria-label={`Select ${label}`}
                        />
                      </label>
                      <button
                        type="button"
                        className="crm-row-main"
                        onClick={() => {
                          setCreating(false)
                          setSelectedId(contact.id)
                          setDetailTab("profile")
                        }}
                      >
                        <span className="crm-avatar" aria-hidden>
                          {initials(contact.display_name, contact.email)}
                        </span>
                        <span className="crm-row-copy">
                          <strong>{label}</strong>
                          <span className="meta">
                            {contact.company || contact.email}
                            {contact.job_title ? ` · ${contact.job_title}` : ""}
                          </span>
                        </span>
                        <span className="crm-row-meta">
                          {contact.follow_up_overdue ? <span className="crm-flag">Overdue</span> : null}
                          <span className={`crm-pill ${stageClass(contact.pipeline_status)}`}>
                            {PIPELINE_LABEL[contact.pipeline_status] || contact.pipeline_status}
                          </span>
                        </span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </aside>

            <section className="crm-detail" aria-live="polite">
              {creating || selectedId ? (
                <>
                  <header className="crm-detail-head">
                    <div className="crm-detail-identity">
                      <span className="crm-avatar lg" aria-hidden>
                        {creating ? <Plus size={20} /> : initials(form.display_name, form.email || "?")}
                      </span>
                      <div>
                        <h2>{creating ? "New contact" : form.display_name || form.email || "Contact"}</h2>
                        <p className="meta">
                          {!creating && form.email ? form.email : "Fill in the essentials, then compose or schedule a follow-up."}
                          {!creating && form.company ? ` · ${form.company}` : ""}
                        </p>
                        {!creating && selected ? (
                          <p className="meta">
                            Last contacted {relativeTime(selected.last_contacted_at) || "never"}
                            {selected.source ? ` · ${selected.source}` : ""}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="crm-detail-actions">
                      {!creating && form.email ? (
                        <>
                          <button type="button" className="btn primary" onClick={() => openCompose({ to: form.email })}>
                            <Mail size={15} /> Compose
                          </button>
                          <button
                            className="btn"
                            type="button"
                            onClick={() => {
                              if (!selectedId) return
                              toggleChecked(selectedId)
                            }}
                          >
                            {selectedId && checkedIds.includes(selectedId) ? "Selected for bulk" : "Add to bulk"}
                          </button>
                        </>
                      ) : null}
                      {form.linkedin_url ? (
                        <a className="btn" href={form.linkedin_url} target="_blank" rel="noreferrer">
                          <ExternalLink size={15} /> LinkedIn
                        </a>
                      ) : null}
                      {editable ? (
                        <button className="btn" type="button" disabled={save.isPending} onClick={() => save.mutate()}>
                          {creating ? "Create contact" : save.isPending ? "Saving…" : "Save changes"}
                        </button>
                      ) : null}
                      {creating ? (
                        <button
                          className="btn ghost"
                          type="button"
                          onClick={() => {
                            setCreating(false)
                            setSelectedId(filtered[0]?.id || null)
                          }}
                        >
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </header>

                  {!creating ? (
                    <div className="crm-tabs" role="tablist">
                      <button
                        type="button"
                        role="tab"
                        className={detailTab === "profile" ? "is-on" : ""}
                        aria-selected={detailTab === "profile"}
                        onClick={() => setDetailTab("profile")}
                      >
                        Profile
                      </button>
                      <button
                        type="button"
                        role="tab"
                        className={detailTab === "activity" ? "is-on" : ""}
                        aria-selected={detailTab === "activity"}
                        onClick={() => setDetailTab("activity")}
                      >
                        Activity
                      </button>
                    </div>
                  ) : null}

                  {(creating || detailTab === "profile") && (
                    <div className="crm-form">
                      <div className="crm-form-grid">
                        <label className="field">
                          <span>Email</span>
                          <input
                            value={form.email}
                            disabled={!creating}
                            onChange={(event) => setForm({ ...form, email: event.target.value })}
                            required
                            placeholder="alex@company.com"
                          />
                        </label>
                        <label className="field">
                          <span>Full name</span>
                          <input
                            value={form.display_name}
                            onChange={(event) => setForm({ ...form, display_name: event.target.value })}
                            disabled={!editable}
                            placeholder="Alex Rivera"
                          />
                        </label>
                        <label className="field">
                          <span>Company</span>
                          <input
                            value={form.company}
                            onChange={(event) => setForm({ ...form, company: event.target.value })}
                            disabled={!editable}
                            placeholder="Acme Inc."
                          />
                        </label>
                        <label className="field">
                          <span>Job title</span>
                          <input
                            value={form.job_title}
                            onChange={(event) => setForm({ ...form, job_title: event.target.value })}
                            disabled={!editable}
                            placeholder="Head of Growth"
                          />
                        </label>
                        <label className="field">
                          <span>Target role</span>
                          <input
                            value={form.target_role}
                            onChange={(event) => setForm({ ...form, target_role: event.target.value })}
                            disabled={!editable}
                            placeholder="Role you’re pitching"
                          />
                        </label>
                        <label className="field">
                          <span>Pipeline stage</span>
                          <select
                            value={form.pipeline_status}
                            onChange={(event) => setForm({ ...form, pipeline_status: event.target.value })}
                            disabled={!editable}
                          >
                            {PIPELINE_STATUSES.map((item) => (
                              <option key={item} value={item}>
                                {PIPELINE_LABEL[item]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          <span>LinkedIn</span>
                          <input
                            value={form.linkedin_url}
                            onChange={(event) => setForm({ ...form, linkedin_url: event.target.value })}
                            disabled={!editable}
                            placeholder="https://linkedin.com/in/…"
                          />
                        </label>
                        <label className="field">
                          <span>Job posting URL</span>
                          <input
                            value={form.job_posting_url}
                            onChange={(event) => setForm({ ...form, job_posting_url: event.target.value })}
                            disabled={!editable}
                            placeholder="https://…"
                          />
                        </label>
                        <label className="field">
                          <span>Next follow-up</span>
                          <input
                            type="datetime-local"
                            value={form.next_follow_up_at}
                            onChange={(event) => setForm({ ...form, next_follow_up_at: event.target.value })}
                            disabled={!editable}
                          />
                        </label>
                      </div>
                      <label className="field">
                        <span>Notes</span>
                        <textarea
                          rows={4}
                          value={form.notes}
                          onChange={(event) => setForm({ ...form, notes: event.target.value })}
                          disabled={!editable}
                          placeholder="Context for the next conversation…"
                        />
                      </label>
                      {!creating && form.pipeline_status === "follow_up_due" ? (
                        <p className="crm-hint">
                          <CalendarClock size={14} /> This contact is in Follow-up due — use the queue or set a next follow-up date.
                        </p>
                      ) : null}
                    </div>
                  )}

                  {!creating && detailTab === "activity" ? (
                    <div className="crm-activity">
                      <div className="crm-activity-block">
                        <h3>
                          <Mail size={14} /> Messages
                        </h3>
                        {detail.isLoading ? <p className="quiet">Loading…</p> : null}
                        {(detail.data?.messages || []).length === 0 && !detail.isLoading ? (
                          <p className="quiet">No messages yet. Compose to start the thread.</p>
                        ) : null}
                        <ul className="crm-msg-list">
                          {(detail.data?.messages || []).map((item) => (
                            <li key={item.id}>
                              <Link to={`/app/messages/${item.id}`}>{item.subject || "Untitled"}</Link>
                              <div className="meta">
                                {item.send_status} · {relativeTime(item.sent_at) || "—"} · {item.signal}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="crm-activity-block">
                        <h3>
                          <Building2 size={14} /> Recent events
                        </h3>
                        {(detail.data?.events || []).length === 0 ? (
                          <p className="quiet">No tracking events linked to this contact yet.</p>
                        ) : (
                          <ol className="crm-event-list">
                            {(detail.data?.events || []).slice(0, 12).map((event) => (
                              <li key={event.id}>
                                <strong>{event.event_type.replaceAll("_", " ")}</strong>
                                <span className="meta">{relativeTime(event.occurred_at) || "—"}</span>
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="crm-detail-empty">
                  <Users size={28} strokeWidth={1.5} />
                  <h2>Select a contact</h2>
                  <p>Pick someone from the list to edit pipeline, notes, and outreach history.</p>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </WorkspacePage>
  )
}
