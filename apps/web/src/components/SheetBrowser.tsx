import { useEffect, useState } from "react"
import { FileSpreadsheet, Link2, RefreshCw, Search } from "lucide-react"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { relativeTime } from "../labels"
import type { SheetConnection } from "../types"
import { canSend } from "../types"

type BrowseFile = {
  id: string
  name: string
  modified_at: string | null
  owner: string
  url: string
  shared: boolean
}

type BrowseResponse = {
  connection_id: string
  google_account_email: string
  attached_spreadsheet_id: string | null
  files: BrowseFile[]
  next_page_token?: string | null
}

type PreviewResponse = {
  spreadsheet_id: string
  spreadsheet_title: string
  tabs: string[]
  tab: string
  headers: string[]
  preview_rows: string[][]
  url: string
}

export function SheetBrowser({
  connection,
  onAttached,
}: {
  connection: SheetConnection
  onAttached: () => void
}) {
  const { toast, membership } = useAuth()
  const canPick = canSend(membership?.role)
  const [q, setQ] = useState("")
  const [query, setQuery] = useState("")
  const [files, setFiles] = useState<BrowseFile[]>([])
  const [nextToken, setNextToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(
    connection.sheet_attached ? connection.spreadsheet_id || null : null,
  )
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [tab, setTab] = useState("")
  const [busy, setBusy] = useState(false)

  function loadBrowse(pageToken?: string | null, append = false) {
    setLoading(true)
    if (!append) setListError("")
    const params = new URLSearchParams()
    if (query) params.set("q", query)
    if (pageToken) params.set("page_token", pageToken)
    api<BrowseResponse>(`/api/v1/integrations/sheets/browse?${params}`)
      .then((data) => {
        setFiles((current) => (append ? [...current, ...data.files] : data.files))
        setNextToken(data.next_page_token || null)
        if (!selectedId && data.attached_spreadsheet_id) setSelectedId(data.attached_spreadsheet_id)
      })
      .catch((err) => {
        const message = err instanceof ApiError ? err.message : "Could not list spreadsheets."
        setListError(message)
        toast(message, "bad")
        if (err instanceof ApiError && err.code === "needs_reauth") {
          window.location.href = "/app/integrations"
        }
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadBrowse()
  }, [query, connection.id])

  useEffect(() => {
    if (!selectedId) {
      setPreview(null)
      return
    }
    const params = new URLSearchParams()
    if (tab) params.set("tab", tab)
    api<PreviewResponse>(`/api/v1/integrations/sheets/browse/${selectedId}/preview?${params}`)
      .then((data) => {
        setPreview(data)
        if (!tab) setTab(data.tab)
      })
      .catch((err) => {
        setPreview(null)
        toast(err instanceof ApiError ? err.message : "Could not preview sheet.", "bad")
      })
  }, [selectedId, tab])

  async function attach() {
    if (!selectedId || !canPick) return
    setBusy(true)
    try {
      await api("/api/v1/integrations/sheets/attach", {
        method: "POST",
        body: JSON.stringify({ spreadsheet_id: selectedId, sheet_tab: tab || undefined }),
      })
      toast("Spreadsheet attached.")
      onAttached()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not attach spreadsheet.", "bad")
      if (err instanceof ApiError && err.code === "needs_reauth") {
        window.location.href = "/app/integrations"
      }
    } finally {
      setBusy(false)
    }
  }

  async function createLog() {
    if (!canPick) return
    setBusy(true)
    try {
      await api("/api/v1/integrations/sheets/create-log", { method: "POST" })
      toast("Created a private MailInsider send-log sheet.")
      onAttached()
      loadBrowse()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not create sheet.", "bad")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-browser">
      <p className="sheet-browser-lead">
        Pick a spreadsheet from your Google account below. Preview opens inside MailInsider — nothing leaves this page until you attach.
      </p>
      <div className="sheet-browser-toolbar">
        <form
          className="sheet-search"
          onSubmit={(event) => {
            event.preventDefault()
            setQuery(q.trim())
          }}
        >
          <Search size={16} aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search spreadsheets by name"
            aria-label="Search spreadsheets"
          />
          <button type="submit" className="btn small">
            Search
          </button>
        </form>
        <div className="actions" style={{ marginTop: 0 }}>
          <button type="button" className="btn small ghost" onClick={() => loadBrowse()} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
          {canPick ? (
            <button type="button" className="btn small" onClick={() => void createLog()} disabled={busy}>
              Create send-log sheet
            </button>
          ) : null}
        </div>
      </div>

      {listError ? <div className="banner bad">{listError}</div> : null}
      {loading && files.length === 0 ? <p className="quiet">Loading your Google spreadsheets…</p> : null}

      <div className="sheet-browser-grid">
        <div className="sheet-file-list" role="list">
          {files.length === 0 && !loading && !listError ? (
            <p className="quiet">No spreadsheets found. Try another search or create a send-log sheet.</p>
          ) : null}
          {files.map((file) => {
            const active = selectedId === file.id
            const attached = connection.spreadsheet_id === file.id
            return (
              <button
                key={file.id}
                type="button"
                role="listitem"
                className={`sheet-file ${active ? "is-active" : ""}`}
                onClick={() => {
                  setSelectedId(file.id)
                  setTab("")
                }}
              >
                <FileSpreadsheet size={18} aria-hidden />
                <span className="sheet-file-copy">
                  <strong>{file.name}</strong>
                  <span className="meta">
                    {file.owner || "Google Sheet"}
                    {file.modified_at ? ` · ${relativeTime(file.modified_at)}` : ""}
                    {attached ? " · Attached" : ""}
                    {file.shared ? " · Shared" : ""}
                  </span>
                </span>
              </button>
            )
          })}
          {nextToken ? (
            <button type="button" className="btn small" disabled={loading} onClick={() => loadBrowse(nextToken, true)}>
              Load more
            </button>
          ) : null}
        </div>

        <div className="sheet-preview-pane">
          {!preview ? (
            <p className="quiet">Select a spreadsheet to preview tabs and sample rows.</p>
          ) : (
            <>
              <div className="row-between">
                <div>
                  <strong>{preview.spreadsheet_title}</strong>
                  <div className="meta">In-app preview · select a worksheet, then attach</div>
                </div>
                {canPick ? (
                  <button type="button" className="btn primary small" disabled={busy} onClick={() => void attach()}>
                    <Link2 size={14} /> Use this sheet
                  </button>
                ) : null}
              </div>
              <label className="sheet-tab-pick">
                Worksheet
                <select value={tab || preview.tab} onChange={(e) => setTab(e.target.value)}>
                  {preview.tabs.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              {preview.headers.length ? (
                <div className="sheet-table-wrap">
                  <table className="sheet-table">
                    <thead>
                      <tr>
                        {preview.headers.map((header) => (
                          <th key={header}>{header || "—"}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.preview_rows.map((row, index) => (
                        <tr key={index}>
                          {preview.headers.map((_, col) => (
                            <td key={col}>{row[col] || ""}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="quiet">This worksheet looks empty.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
