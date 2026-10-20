import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Copy, Plus, Trash2 } from "lucide-react"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { WorkspacePage, WsCard, WsEmpty } from "../components/workspace/WorkspacePage"
import { relativeTime } from "../labels"
import { canSend } from "../types"

type Template = {
  id: string
  name: string
  subject: string
  body_text: string
  body_html: string | null
  updated_at: string | null
}

const EMPTY = { name: "", subject: "", body: "Hi {{first_name}},\n\n" }

export function TemplatesPage() {
  const { workspaceId, membership, toast } = useAuth()
  const [templates, setTemplates] = useState<Template[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)

  async function load() {
    const data = await api<{ templates: Template[] }>("/api/v1/templates")
    setTemplates(data.templates)
    if (!selectedId && !creating && data.templates[0]) setSelectedId(data.templates[0].id)
  }

  useEffect(() => {
    load().catch((err) => toast(err instanceof ApiError ? err.message : "Could not load templates.", "bad"))
  }, [workspaceId])

  const selected = templates.find((item) => item.id === selectedId) || null

  useEffect(() => {
    if (creating) {
      setForm(EMPTY)
      return
    }
    if (!selected) return
    setForm({ name: selected.name, subject: selected.subject || "", body: selected.body_text || "" })
  }, [selected?.id, selected?.updated_at, creating])

  async function save() {
    if (!canSend(membership?.role)) return
    setBusy(true)
    try {
      if (creating) {
        const created = await api<Template>("/api/v1/templates", {
          method: "POST",
          body: JSON.stringify({ name: form.name, subject: form.subject, body_text: form.body }),
        })
        setCreating(false)
        setSelectedId(created.id)
        toast("Template saved.")
      } else if (selectedId) {
        await api(`/api/v1/templates/${selectedId}`, {
          method: "PATCH",
          body: JSON.stringify({ name: form.name, subject: form.subject, body_text: form.body }),
        })
        toast("Template updated.")
      }
      await load()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not save template.", "bad")
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/v1/templates/${id}`, { method: "DELETE" })
      toast("Template deleted.")
      if (selectedId === id) setSelectedId(null)
      await load()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not delete template.", "bad")
    }
  }

  return (
    <WorkspacePage
      title="Templates"
      subtitle="Reusable subjects and bodies for Compose and Campaigns. Merge fields like {{first_name}} and {{company}} fill from contacts or Sheets."
      actions={
        canSend(membership?.role) ? (
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              setCreating(true)
              setSelectedId(null)
              setForm(EMPTY)
            }}
          >
            <Plus size={16} /> New template
          </button>
        ) : null
      }
    >
      {templates.length === 0 && !creating ? (
        <WsEmpty
          title="No templates yet"
          body="Save your best intros once, then reuse them from Compose or Campaigns without rewriting every send."
          action={
            canSend(membership?.role) ? (
              <button className="btn primary" type="button" onClick={() => setCreating(true)}>
                Create first template
              </button>
            ) : null
          }
        />
      ) : (
        <div className="docs">
          <div className="list">
            {templates.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`msg-row${selectedId === item.id && !creating ? " on" : ""}`}
                style={{
                  width: "100%",
                  textAlign: "left",
                  border: 0,
                  background: selectedId === item.id && !creating ? "#eff6ff" : "transparent",
                  cursor: "pointer",
                }}
                onClick={() => {
                  setCreating(false)
                  setSelectedId(item.id)
                }}
              >
                <div>
                  <div className="subject">{item.name}</div>
                  <div className="meta">{item.subject || "No subject"} · {relativeTime(item.updated_at) || "—"}</div>
                </div>
              </button>
            ))}
          </div>
          <WsCard title={creating ? "New template" : selected?.name || "Template"}>
            {creating || selected ? (
              <div className="stack">
                <label className="field">
                  <span>Name</span>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Outbound intro"
                    disabled={!canSend(membership?.role)}
                  />
                </label>
                <label className="field">
                  <span>Subject</span>
                  <input
                    value={form.subject}
                    onChange={(e) => setForm({ ...form, subject: e.target.value })}
                    placeholder="Quick note for {{first_name}}"
                    disabled={!canSend(membership?.role)}
                  />
                </label>
                <label className="field">
                  <span>Body</span>
                  <textarea
                    rows={10}
                    value={form.body}
                    onChange={(e) => setForm({ ...form, body: e.target.value })}
                    disabled={!canSend(membership?.role)}
                  />
                </label>
                <p className="hint">Common fields: {"{{first_name}}"}, {"{{last_name}}"}, {"{{company}}"}, {"{{email}}"}</p>
                {canSend(membership?.role) ? (
                  <div className="actions" style={{ justifyContent: "flex-start" }}>
                    <button className="btn primary" type="button" disabled={busy || !form.name.trim()} onClick={() => void save()}>
                      {creating ? "Save template" : "Save changes"}
                    </button>
                    {!creating && selected ? (
                      <>
                        <Link
                          className="btn"
                          to={`/app/compose?subject=${encodeURIComponent(form.subject)}&body=${encodeURIComponent(form.body)}`}
                        >
                          <Copy size={14} /> Use in Compose
                        </Link>
                        <button className="btn ghost danger" type="button" onClick={() => void remove(selected.id)}>
                          <Trash2 size={14} /> Delete
                        </button>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="quiet">Select a template to edit.</p>
            )}
          </WsCard>
        </div>
      )}
    </WorkspacePage>
  )
}
