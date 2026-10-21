import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import {
  Bold,
  ChevronDown,
  Link2,
  Maximize2,
  Minimize2,
  MoreVertical,
  Paperclip,
  Trash2,
  X,
} from "lucide-react"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { ComposeAiPanel } from "../components/ComposeAiPanel"
import { composeDraftFromSearch, useCompose, type ComposeDraft } from "../compose"
import { Dialog } from "../components/ui"
import type { ConnectionsResponse, DocumentItem, MessageDetail, Overview, SheetsResponse } from "../types"

type Person = { email: string; name?: string }

/** Route entry: open overlay on the previous screen and leave compose route. */
export function ComposePage() {
  const { openCompose } = useCompose()
  const [params] = useSearchParams()
  const navigate = useNavigate()

  useEffect(() => {
    openCompose(composeDraftFromSearch(params.toString()))
    // Stay on the previous screen; Shell keeps the compose overlay open.
    if (window.history.length > 1) navigate(-1)
    else navigate("/app/mail", { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="loading">Opening compose…</div>
}

export function ComposeModal({ draft, onClose }: { draft: ComposeDraft | null; onClose: () => void }) {
  const { membership, workspaceId, toast } = useAuth()
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [connections, setConnections] = useState<ConnectionsResponse | null>(null)
  const [documents, setDocuments] = useState<DocumentItem[]>([])
  const [quota, setQuota] = useState<Overview["quota"] | null>(null)
  const [to, setTo] = useState<Person[]>([])
  const [cc, setCc] = useState<Person[]>([])
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [connectionId, setConnectionId] = useState("")
  const [documentId, setDocumentId] = useState("")
  const [sheets, setSheets] = useState<SheetsResponse | null>(null)
  const [attachPdf, setAttachPdf] = useState(false)
  const [includeSheet, setIncludeSheet] = useState(false)
  const [openTracking, setOpenTracking] = useState(membership?.open_tracking_default ?? true)
  const [linkTracking, setLinkTracking] = useState(membership?.link_tracking_default ?? true)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [includeSignature, setIncludeSignature] = useState(true)
  const [signatureText, setSignatureText] = useState(DEFAULT_SIGNATURE)
  const [savingSignature, setSavingSignature] = useState(false)
  const followup = draft?.followup || null
  const draftKey = `${draft?.followup || ""}|${draft?.to || ""}|${draft?.subject || ""}|${draft?.body || ""}`

  useEffect(() => {
    setTo([])
    setCc([])
    setShowCc(false)
    setSubject(draft?.subject || "")
    setBody(draft?.body || "")
    setDocumentId("")
    setAttachPdf(false)
    setConfirming(false)
    setShowMore(false)
    setExpanded(false)
    setIncludeSignature(true)

    const toParam = draft?.to
    if (toParam) {
      const emails = toParam
        .split(/[,;\n]+/)
        .map((item) => item.trim().toLowerCase())
        .filter((email) => email.includes("@"))
        .slice(0, 50)
      setTo(emails.map((email) => ({ email })))
    }
  }, [draftKey])

  useEffect(() => {
    api<ConnectionsResponse>("/api/v1/integrations/gmail/connections").then((data) => {
      setConnections(data)
      const active = data.connections.find((item) => item.status === "connected")
      if (active) setConnectionId(active.id)
    })
    api<{ documents: DocumentItem[] }>("/api/v1/documents").then((data) => setDocuments(data.documents))
    api<SheetsResponse>("/api/v1/integrations/sheets/connections").then((data) => {
      setSheets(data)
      setIncludeSheet(data.connections.some((item) => item.status === "connected" && (item.sheet_attached || item.is_demo)))
    })
    api<Overview>("/api/v1/analytics/overview").then((data) => setQuota(data.quota))
    api<{ profile?: { email_signature?: string } }>("/api/v1/ai/pr")
      .then((data) => {
        const next = (data.profile?.email_signature || "").trim()
        if (next) setSignatureText(next)
      })
      .catch(() => undefined)
  }, [workspaceId])

  useEffect(() => {
    if (!followup) return
    api<MessageDetail>(`/api/v1/messages/${followup}`).then((message) => {
      const n = (message.follow_up_count || 0) + 1
      setSubject(message.subject.startsWith("Re:") ? message.subject : `Re: ${message.subject}`)
      setTo(message.recipients.filter((item) => item.type === "to").map((item) => ({ email: item.email, name: item.name || undefined })))
      setBody(`Hi — following up (${n}) on my note below.\n\n`)
      if (message.gmail_connection_id) setConnectionId(message.gmail_connection_id)
    })
  }, [followup])

  const active = connections?.connections.find((item) => item.id === connectionId && item.status === "connected")
  const selectedDocument = documents.find((item) => item.id === documentId)
  const pdfSelected = selectedDocument?.content_type === "application/pdf"
  const connectedSheet = sheets?.connections.find(
    (item) => item.status === "connected" && (item.sheet_attached || item.is_demo),
  )
  const multipleTo = to.length > 1
  const preview = useMemo(
    () =>
      renderPreview(body, {
        documentName: selectedDocument?.filename,
        openTracking,
        linkTracking,
        includeSignature,
        signatureText,
      }),
    [body, selectedDocument?.filename, openTracking, linkTracking, includeSignature, signatureText],
  )

  async function uploadDocument(file: File | undefined) {
    if (!file) return
    setUploading(true)
    const form = new FormData()
    form.append("file", file)
    try {
      const created = await api<DocumentItem>("/api/v1/documents", { method: "POST", body: form })
      setDocuments((current) => [created, ...current.filter((item) => item.id !== created.id)])
      setDocumentId(created.id)
      setAttachPdf(created.content_type === "application/pdf")
      toast("Document uploaded. A tracked viewer link is added when you send.")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Upload failed.", "bad")
    } finally {
      setUploading(false)
    }
  }

  async function save(send: boolean) {
    setBusy(true)
    try {
      const created = await api<MessageDetail>("/api/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          to,
          cc: multipleTo ? [] : cc,
          subject,
          body_text: body,
          send,
          gmail_connection_id: connectionId || null,
          document_id: documentId || null,
          attach_pdf: attachPdf,
          include_sheet_link: includeSheet,
          include_signature: includeSignature,
          signature_text: includeSignature ? signatureText : "",
          tracking: { open_pixel: openTracking, link_clicks: linkTracking },
          parent_message_id: followup || null,
        }),
      })
      toast(send ? (created.demo ? "Marked sent in demo." : "Gmail accepted the send.") : "Draft saved.")
      onClose()
      navigate(`/app/mail/${created.id}`)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not save the message.", "bad")
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  function discard() {
    if (subject.trim() || body.trim() || to.length) {
      if (!window.confirm("Discard this draft?")) return
    }
    onClose()
  }

  function applyAi(next: { subject?: string; body?: string }) {
    if (typeof next.subject === "string") setSubject(next.subject)
    if (typeof next.body === "string") setBody(stripTrailingSignOff(next.body))
  }

  async function saveSignatureDefault() {
    if (savingSignature) return
    setSavingSignature(true)
    try {
      await api("/api/v1/ai/pr/profile/signature", {
        method: "PATCH",
        body: JSON.stringify({ email_signature: signatureText }),
      })
      toast("Default signature saved.")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not save signature.", "bad")
    } finally {
      setSavingSignature(false)
    }
  }

  return (
    <div className={`gm-compose-overlay${expanded ? " is-expanded" : ""}`} role="presentation">
      {!active ? (
        <div className="gm-compose-banner banner warn">
          <span>Connect Gmail before sending. You can still save a draft.</span>
          <Link to="/app/integrations">Open Gmail settings</Link>
        </div>
      ) : null}

      <ComposeAiPanel
        subject={subject}
        body={body}
        recipientEmail={to[0]?.email}
        fromEmail={active?.google_account_email}
        hasAttachment={Boolean(documentId)}
        attachmentName={selectedDocument?.filename}
        includeSignature={includeSignature}
        signatureText={signatureText}
        onApply={applyAi}
      >
        {({ pill, toolbar, check }) => (
          <div className="gm-compose" role="dialog" aria-label="New Message">
            <header className="gm-compose-head">
              <h1>{followup ? "Follow up" : "New Message"}</h1>
              <div className="gm-compose-head-actions">
                <button type="button" className="gm-tool-btn" aria-label={expanded ? "Shrink" : "Expand"} onClick={() => setExpanded((v) => !v)}>
                  {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
                <button type="button" className="gm-tool-btn" aria-label="Close" onClick={discard}>
                  <X size={16} />
                </button>
              </div>
            </header>

            <div className="gm-compose-fields">
              <div className="gm-compose-from">
                <span className="gm-compose-label">From</span>
                <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)} aria-label="From account">
                  <option value="">Choose a connected account</option>
                  {connections?.connections
                    .filter((item) => item.status === "connected")
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.google_account_email}
                        {item.is_demo ? " (demo)" : ""}
                      </option>
                    ))}
                </select>
              </div>

              <div className="gm-compose-row">
                <span className="gm-compose-label">To</span>
                <div className="gm-compose-row-main">
                  <RecipientField label="To" people={to} onChange={setTo} bare />
                </div>
                {!multipleTo ? (
                  <button type="button" className="gm-compose-cc" onClick={() => setShowCc((v) => !v)}>
                    Cc Bcc
                  </button>
                ) : null}
              </div>

              {multipleTo ? (
                <p className="gm-compose-hint">
                  {to.length} recipients — each gets their own copy. Cc is hidden for bulk.
                  {quota ? ` ${quota.used}/${quota.limit} sends today.` : ""}
                </p>
              ) : null}

              {showCc && !multipleTo ? (
                <div className="gm-compose-row">
                  <span className="gm-compose-label">Cc</span>
                  <div className="gm-compose-row-main">
                    <RecipientField label="Cc" people={cc} onChange={setCc} bare />
                  </div>
                </div>
              ) : null}

              <div className="gm-compose-row">
                <span className="gm-compose-label">Subject</span>
                <input
                  className="gm-compose-subject"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  maxLength={200}
                  placeholder="Subject"
                  aria-label="Subject"
                />
              </div>
            </div>

            <div className="gm-compose-body-wrap">
              <textarea
                id="composer-body"
                className="gm-compose-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder=""
                aria-label="Message body"
              />
              <div className="gm-compose-ai-slot">{pill}</div>
            </div>

            {check}

            <div className="gm-compose-sig">
              <label className="check">
                <input
                  type="checkbox"
                  checked={includeSignature}
                  onChange={(event) => setIncludeSignature(event.target.checked)}
                />
                <span>Include signature</span>
              </label>
              {includeSignature ? (
                <>
                  <textarea
                    className="gm-compose-sig-text"
                    value={signatureText}
                    onChange={(event) => setSignatureText(event.target.value)}
                    rows={5}
                    aria-label="Signature"
                    placeholder={DEFAULT_SIGNATURE}
                  />
                  <div className="gm-compose-sig-actions">
                    <button
                      type="button"
                      className="btn small ghost"
                      disabled={busy || savingSignature || !signatureText.trim()}
                      onClick={() => void saveSignatureDefault()}
                    >
                      {savingSignature ? "Saving…" : "Save as default"}
                    </button>
                    <span className="hint">Edit for this email, or save for future sends.</span>
                  </div>
                </>
              ) : (
                <p className="hint">This send will go out without a signature.</p>
              )}
            </div>

            <footer className="gm-compose-toolbar">
              <div className="gm-compose-toolbar-left">
                <div className="gm-send-group">
                  <button type="button" className="gm-send" disabled={busy || !active} onClick={() => setConfirming(true)}>
                    {busy ? "Sending…" : "Send"}
                  </button>
                  <button
                    type="button"
                    className="gm-send-caret"
                    disabled={busy || !active}
                    aria-label="Save draft"
                    onClick={() => void save(false)}
                    title="Save draft"
                  >
                    <ChevronDown size={16} />
                  </button>
                </div>

                {toolbar}

                <button
                  type="button"
                  className="gm-tool-btn"
                  title="Bold selection"
                  aria-label="Bold"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setBody((value) => wrapSelection(value))}
                >
                  <Bold size={18} />
                </button>
                <button
                  type="button"
                  className="gm-tool-btn"
                  title="Attach file"
                  aria-label="Attach"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip size={18} />
                </button>
                <button
                  type="button"
                  className="gm-tool-btn"
                  title="More options"
                  aria-label="More options"
                  aria-expanded={showMore}
                  onClick={() => setShowMore((v) => !v)}
                >
                  <MoreVertical size={18} />
                </button>
                <button
                  type="button"
                  className="gm-tool-btn"
                  title="Links"
                  aria-label="Links"
                  onClick={() => toast("Paste an https:// link in the body — tracked when link requests are on.")}
                >
                  <Link2 size={18} />
                </button>
              </div>
              <button type="button" className="gm-tool-btn gm-discard" aria-label="Discard" title="Discard" onClick={discard}>
                <Trash2 size={18} />
              </button>
            </footer>

            <input
              ref={fileRef}
              className="sr"
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,application/pdf,image/png,image/jpeg,image/webp,text/plain"
              disabled={uploading}
              onChange={(event) => {
                void uploadDocument(event.target.files?.[0])
                event.currentTarget.value = ""
              }}
            />

            {documentId || uploading ? (
              <div className="gm-compose-attach">
                {uploading ? "Uploading…" : null}
                {selectedDocument ? (
                  <span>
                    {selectedDocument.filename}
                    <button
                      type="button"
                      onClick={() => {
                        setDocumentId("")
                        setAttachPdf(false)
                      }}
                      aria-label="Remove attachment"
                    >
                      ×
                    </button>
                  </span>
                ) : null}
              </div>
            ) : null}

            {showMore ? (
              <div className="gm-compose-more">
                <label className="field">
                  <span>Document library</span>
                  <select
                    value={documentId}
                    onChange={(event) => {
                      const next = event.target.value
                      setDocumentId(next)
                      const chosen = documents.find((item) => item.id === next)
                      setAttachPdf(chosen?.content_type === "application/pdf")
                    }}
                  >
                    <option value="">No document</option>
                    {documents.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.filename}
                      </option>
                    ))}
                  </select>
                </label>
                {pdfSelected ? (
                  <label className="check">
                    <input type="checkbox" checked={attachPdf} onChange={(event) => setAttachPdf(event.target.checked)} />
                    <span>Attach the PDF to the email</span>
                  </label>
                ) : null}
                {connectedSheet ? (
                  <label className="check">
                    <input type="checkbox" checked={includeSheet} onChange={(event) => setIncludeSheet(event.target.checked)} />
                    <span>
                      {connectedSheet.is_demo
                        ? "Record this send on the workspace log"
                        : `Include the private sheet link (${connectedSheet.spreadsheet_title})`}
                    </span>
                  </label>
                ) : null}
                <div className="switch">
                  <div>
                    <strong>Open tracking</strong>
                    <div className="hint">Record when the message is opened.</div>
                  </div>
                  <input type="checkbox" checked={openTracking} onChange={(event) => setOpenTracking(event.target.checked)} aria-label="Open tracking" />
                </div>
                <div className="switch">
                  <div>
                    <strong>Link requests</strong>
                    <div className="hint">Rewrites https links through MailInsider.</div>
                  </div>
                  <input type="checkbox" checked={linkTracking} onChange={(event) => setLinkTracking(event.target.checked)} aria-label="Link requests" />
                </div>
                <details>
                  <summary>Preview</summary>
                  <div className="card" style={{ marginTop: 8 }} dangerouslySetInnerHTML={{ __html: preview }} />
                </details>
                <div className="row-between">
                  <button className="btn" type="button" disabled={busy} onClick={() => save(false)}>
                    Save draft
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </ComposeAiPanel>

      {confirming ? (
        <Dialog title="Send this message?" onClose={() => setConfirming(false)}>
          <p>
            From {active?.google_account_email}
            {active?.is_demo ? " in demo mode. Nothing leaves this computer." : "."} To {to.map((item) => item.email).join(", ") || "nobody"}.
          </p>
          <p className="quiet">
            {openTracking ? "Open tracking is on. " : "Open tracking is off. "}
            {linkTracking ? "Link tracking is on. " : "Link tracking is off. "}
            {documentId ? "A document viewer link is included. " : ""}
            {includeSignature ? "Your signature will be appended." : "No signature will be added."}
            {attachPdf ? " The PDF is attached." : ""}
            {includeSheet ? " The workspace sheet link is included." : ""}
          </p>
          <div className="row-between">
            <button className="btn ghost" type="button" onClick={() => setConfirming(false)}>
              Keep editing
            </button>
            <button className="btn primary" type="button" disabled={busy} onClick={() => save(true)}>
              {busy ? "Sending" : "Send"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

function RecipientField({
  label,
  people,
  onChange,
  bare,
}: {
  label: string
  people: Person[]
  onChange: (next: Person[]) => void
  bare?: boolean
}) {
  const [draft, setDraft] = useState("")
  const [suggestions, setSuggestions] = useState<{ email: string; name: string | null }[]>([])

  useEffect(() => {
    if (draft.trim().length < 2) {
      setSuggestions([])
      return
    }
    const handle = window.setTimeout(() => {
      api<{ contacts: { email: string; name: string | null }[] }>(`/api/v1/contacts?q=${encodeURIComponent(draft)}`)
        .then((data) => setSuggestions(data.contacts))
        .catch(() => setSuggestions([]))
    }, 180)
    return () => window.clearTimeout(handle)
  }, [draft])

  function add(email: string, name?: string | null) {
    const cleaned = email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleaned)) return
    if (people.some((item) => item.email === cleaned)) {
      setDraft("")
      return
    }
    onChange([...people, { email: cleaned, name: name || undefined }])
    setDraft("")
    setSuggestions([])
  }

  const inner = (
    <>
      <div className={bare ? "gm-chips" : "chips"}>
        {people.map((person) => (
          <span className="chip" key={person.email}>
            {person.name ? `${person.name} ` : ""}
            {person.email}
            <button type="button" aria-label={`Remove ${person.email}`} onClick={() => onChange(people.filter((item) => item.email !== person.email))}>
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          aria-label={label}
          placeholder=""
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault()
              add(draft)
            }
            if (event.key === "Backspace" && !draft && people.length) onChange(people.slice(0, -1))
          }}
          onBlur={() => {
            if (draft.includes("@")) add(draft)
          }}
        />
      </div>
      {suggestions.length ? (
        <div className="suggest">
          {suggestions.map((item) => (
            <button key={item.email} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => add(item.email, item.name)}>
              {item.name ? `${item.name} · ` : ""}
              {item.email}
            </button>
          ))}
        </div>
      ) : null}
    </>
  )

  if (bare) return <div className="gm-recipient">{inner}</div>
  return (
    <div className="field">
      <span>{label}</span>
      {inner}
    </div>
  )
}

const DEFAULT_SIGNATURE = `Yashjeet Singh
Portfolio: https://yashjeet.space
GitHub: https://github.com/yj004
LinkedIn: https://www.linkedin.com/in/yashjeet-singh/
Mob: 9729840783`

function stripTrailingSignOff(text: string) {
  return text.replace(/\n*(?:best regards|regards|best|thanks|thank you|sincerely),?\s*\n+[\s\S]*$/i, "").trimEnd()
}

function signatureStartIndex(value: string) {
  const markers = ["Portfolio: https://yashjeet.space", "GitHub: https://github.com/yj004", "yashjeet.space"]
  let best = -1
  for (const marker of markers) {
    const at = value.indexOf(marker)
    if (at >= 0) best = best < 0 ? at : Math.min(best, at)
  }
  if (best < 0) return value.length
  // Include the "Best regards," / name lines just above the portfolio line.
  const before = value.slice(0, best)
  const regards = before.search(/\n(?:Best regards|Regards|Best),?\s*\n[^\n]*$/i)
  return regards >= 0 ? regards + 1 : before.lastIndexOf("\n\n") >= 0 ? before.lastIndexOf("\n\n") + 2 : best
}

function wrapSelection(value: string) {
  const field = document.getElementById("composer-body") as HTMLTextAreaElement | null
  if (!field) return value
  const start = field.selectionStart
  const end = field.selectionEnd
  if (start === end) return value
  const sigAt = signatureStartIndex(value)
  // Never bold the signature block — it must stay multi-line and normal weight.
  const safeEnd = Math.min(end, sigAt)
  if (start >= sigAt || safeEnd <= start) return value
  const selected = value.slice(start, safeEnd)
  // Bold each line separately so send-time HTML keeps <br> between lines.
  const wrapped = selected
    .split("\n")
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (trimmed.startsWith("**") && trimmed.endsWith("**")) return line
      const lead = line.match(/^\s*/)?.[0] ?? ""
      const trail = line.match(/\s*$/)?.[0] ?? ""
      return `${lead}**${line.trim()}**${trail}`
    })
    .join("\n")
  return `${value.slice(0, start)}${wrapped}${value.slice(safeEnd)}`
}

function renderPreview(
  text: string,
  options: {
    documentName?: string
    openTracking: boolean
    linkTracking: boolean
    includeSignature?: boolean
    signatureText?: string
  },
) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  // Line-local bold only (same rule as the API plain_to_html).
  const withBold = escaped.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
  const withLinks = withBold.replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
  const body = withLinks
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, "<br>")}</p>`)
    .join("")
  const document = options.documentName
    ? `<p><a href="#">View document: ${options.documentName.replace(/</g, "&lt;")}</a></p>`
    : ""
  const signature =
    options.includeSignature && options.signatureText?.trim()
      ? `<p>—</p><p>${options.signatureText
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .split("\n")
          .map((line) =>
            line.replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>'),
          )
          .join("<br>")}</p>`
      : ""
  const notes = `<p class="hint" style="font-size:12px;color:#666">Tracking on send: ${
    options.openTracking ? "opens" : "opens off"
  } · ${options.linkTracking ? "link tracking" : "link tracking off"}${
    options.documentName ? " · document views" : ""
  }</p>`
  return `${body}${document}${signature}${notes}`
}
