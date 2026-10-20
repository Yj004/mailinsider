import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { WorkspacePage, WsEmpty } from "../components/workspace/WorkspacePage"
import { fileSize, relativeTime } from "../labels"
import type { DocumentItem } from "../types"
import { canSend } from "../types"

export function DocumentsPage() {
  const { workspaceId, membership, toast } = useAuth()
  const [documents, setDocuments] = useState<DocumentItem[]>([])
  const [selected, setSelected] = useState<string>("")
  const [freshUrl, setFreshUrl] = useState("")
  const [events, setEvents] = useState<{ id: string; event_type: string; occurred_at: string; metadata: { page?: number } }[]>([])
  const current = documents.find((item) => item.id === selected) || documents[0]

  function load() {
    api<{ documents: DocumentItem[] }>("/api/v1/documents")
      .then((data) => {
        setDocuments(data.documents)
        if (!selected && data.documents[0]) setSelected(data.documents[0].id)
      })
      .catch((err) => toast(err instanceof ApiError ? err.message : "Could not load documents.", "bad"))
  }

  useEffect(() => {
    load()
  }, [workspaceId])

  useEffect(() => {
    if (!current) return
    api<{ events: typeof events }>(`/api/v1/documents/${current.id}/events`)
      .then((data) => setEvents(data.events))
      .catch(() => setEvents([]))
  }, [current?.id, workspaceId])

  async function upload(file: File | undefined) {
    if (!file) return
    const body = new FormData()
    body.append("file", file)
    try {
      const created = await api<DocumentItem>("/api/v1/documents", { method: "POST", body })
      toast("Document stored privately.")
      setSelected(created.id)
      load()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Upload failed.", "bad")
    }
  }

  return (
    <WorkspacePage
      title="Documents"
      subtitle="Files stay private in Supabase Storage. Share only via tracked links you can revoke."
      actions={
        <Link className="btn" to="/app/compose">
          Attach in compose
        </Link>
      }
    >
      <div className="docs">
        <div>
          {canSend(membership?.role) ? (
            <label className="drop">
              <input
                className="sr"
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,application/pdf,image/png,image/jpeg,image/webp,text/plain"
                onChange={(event) => upload(event.target.files?.[0])}
              />
              Drop a PDF, image, or text file, or click to choose. 15 MB max.
            </label>
          ) : null}
          <div className="doc-list" style={{ marginTop: 12 }}>
            {documents.map((item) => (
              <button key={item.id} className={current?.id === item.id ? "on" : ""} onClick={() => setSelected(item.id)} type="button">
                <strong>{item.filename}</strong>
                <div className="meta">
                  {fileSize(item.size_bytes)} · {relativeTime(item.created_at)}
                  {item.is_sample ? " · Sample" : ""}
                </div>
              </button>
            ))}
            {documents.length === 0 ? (
              <WsEmpty
                title="No documents yet"
                body="Upload a PDF or image once. Share only via tracked links you can revoke — files stay private in Storage."
              />
            ) : null}
          </div>
        </div>
        {current ? (
          <section className="panel">
            <h2>{current.filename}</h2>
            <p className="meta">{current.content_type}</p>
            {canSend(membership?.role) ? (
              <button
                className="btn"
                onClick={() => {
                  api<{ url: string; notice: string }>(`/api/v1/documents/${current.id}/links`, {
                    method: "POST",
                    body: JSON.stringify({ expires_in_days: 30 }),
                  })
                    .then((data) => {
                      setFreshUrl(data.url)
                      toast(data.notice)
                      load()
                    })
                    .catch((err) => toast(err instanceof ApiError ? err.message : "Could not create a link.", "bad"))
                }}
              >
                Create a 30-day link
              </button>
            ) : null}
            {freshUrl ? (
              <div className="link-callout">
                <strong>Copy this link now. It will not be shown again.</strong>
                <div className="mono">{freshUrl}</div>
                <button
                  className="btn small"
                  onClick={() => {
                    navigator.clipboard.writeText(freshUrl)
                    toast("Link copied.")
                  }}
                >
                  Copy
                </button>
              </div>
            ) : null}
            <h3>Links</h3>
            {current.links.length === 0 ? <p className="quiet">No links yet.</p> : null}
            <ul>
              {current.links.map((link) => (
                <li key={link.id}>
                  {link.active ? "Active" : "Inactive"} · created {relativeTime(link.created_at)}
                  {link.expires_at ? ` · expires ${relativeTime(link.expires_at)}` : ""}
                  {link.recipient_email ? ` · ${link.recipient_email}` : ""}
                  {link.active && canSend(membership?.role) ? (
                    <button
                      className="btn small ghost"
                      onClick={() => {
                        api(`/api/v1/documents/${current.id}/revoke`, {
                          method: "POST",
                          body: JSON.stringify({ token_id: link.id }),
                        })
                          .then(() => {
                            toast("Link revoked.")
                            load()
                          })
                          .catch((err) => toast(err instanceof ApiError ? err.message : "Could not revoke.", "bad"))
                      }}
                    >
                      Revoke
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <h3>Activity</h3>
            <ol className="timeline">
              {events.map((event) => (
                <li key={event.id} className="tl-item">
                  <div className="tl-rail">
                    <span className="dot" />
                    <span className="stem" />
                  </div>
                  <div className="tl-body">
                    <strong>{event.event_type.replaceAll("_", " ")}</strong>
                    <div className="meta">
                      {relativeTime(event.occurred_at)}
                      {event.metadata.page ? ` · page ${event.metadata.page}` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            <p className="hint">The sender sees that the viewer loaded and which pages were displayed. That is not a claim that the page was read.</p>
          </section>
        ) : null}
      </div>
    </WorkspacePage>
  )
}
