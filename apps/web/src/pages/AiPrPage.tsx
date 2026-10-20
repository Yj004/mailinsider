import { FormEvent, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  BookOpen,
  Briefcase,
  CheckCircle2,
  Circle,
  FileText,
  FileUp,
  Linkedin,
  Loader2,
  MapPin,
  Save,
  Search,
  Shield,
  Sparkles,
  Target,
  Trash2,
} from "lucide-react"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { useCompose } from "../compose"
import { WorkspacePage } from "../components/workspace/WorkspacePage"

type Profile = {
  display_name: string
  headline: string
  summary: string
  skills: string
  looking_for: string
  target_roles: string
  target_companies: string
  location_pref: string
  regulations: string
  tone_rules: string
  do_not_claim: string
  email_signature: string
  updated_at?: string | null
}

type KnowledgeDoc = {
  id: string
  title: string
  content_text: string
  source: string
  chunk_count: number
  updated_at?: string | null
}

type RagPassage = {
  score: number
  embedding_score?: number
  lexical_score?: number
  phrase_boost?: number
  title: string
  source: string
  content: string
}

type RagPreview = {
  prompt_block: string
  method: string
  query?: string
  prefer_sources?: string[]
  passages: RagPassage[]
  profile?: Record<string, string>
  stats?: { chunks_scanned?: number; with_embedding?: number; returned?: number }
}

type TabId = "knowledge" | "parameters" | "regulations" | "lab"

const LAB_EXAMPLES = [
  "Apply for Software Engineer - Gen AI",
  "AVA International FastAPI",
  "Longway India GCP",
  "Claude OpenAI LLM workflows",
]

const PDF_SLOTS: {
  id: "linkedin" | "resume" | "chatgpt_summary"
  label: string
  hint: string
  detail: string
  Icon: typeof FileText
}[] = [
  {
    id: "linkedin",
    label: "LinkedIn profile",
    hint: "Save to PDF from LinkedIn",
    detail: "Experience, headlines, and accomplishments the model can cite accurately.",
    Icon: Linkedin,
  },
  {
    id: "resume",
    label: "Resume",
    hint: "Current résumé PDF",
    detail: "Roles, skills, and metrics for outreach that matches your track record.",
    Icon: Briefcase,
  },
  {
    id: "chatgpt_summary",
    label: "ChatGPT summary",
    hint: "Career summary export",
    detail: "Your distilled narrative — how you want to be described in cold email.",
    Icon: Sparkles,
  },
]

const emptyProfile: Profile = {
  display_name: "",
  headline: "",
  summary: "",
  skills: "",
  looking_for: "",
  target_roles: "",
  target_companies: "",
  location_pref: "",
  regulations: "",
  tone_rules: "",
  do_not_claim: "",
  email_signature: "",
}

function profileCompleteness(profile: Profile) {
  const keys: (keyof Profile)[] = [
    "display_name",
    "headline",
    "summary",
    "skills",
    "looking_for",
    "target_roles",
    "regulations",
    "tone_rules",
    "do_not_claim",
    "email_signature",
  ]
  const filled = keys.filter((key) => String(profile[key] || "").trim().length > 0).length
  return Math.round((filled / keys.length) * 100)
}

export function AiPrPage() {
  const { workspaceId, toast } = useAuth()
  const { openCompose } = useCompose()
  const [tab, setTab] = useState<TabId>("knowledge")
  const [profile, setProfile] = useState<Profile>(emptyProfile)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploadingKind, setUploadingKind] = useState<string | null>(null)
  const [previewQuery, setPreviewQuery] = useState("Apply for Software Engineer - Gen AI")
  const [previewResult, setPreviewResult] = useState<RagPreview | null>(null)
  const [showPromptBlock, setShowPromptBlock] = useState(false)
  const [matchCompose, setMatchCompose] = useState(true)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null)
  const dragKind = useRef<string | null>(null)

  const byKind = useMemo(() => {
    const map: Record<string, KnowledgeDoc | undefined> = {}
    for (const doc of docs) map[doc.source] = doc
    return map
  }, [docs])

  const pdfReady = PDF_SLOTS.filter((slot) => byKind[slot.id]).length
  const completeness = profileCompleteness(profile)
  const dirty = JSON.stringify(profile) !== savedSnapshot
  const totalChunks = docs.reduce((sum, doc) => sum + (doc.chunk_count || 0), 0)
  const readyScore = Math.round((pdfReady / 3) * 55 + (completeness / 100) * 45)

  useEffect(() => {
    document.title = "AI P&R — MailInsider"
  }, [])

  useEffect(() => {
    setLoading(true)
    api<{ profile: Profile; documents: KnowledgeDoc[] }>("/api/v1/ai/pr")
      .then((data) => {
        const next = { ...emptyProfile, ...data.profile }
        setProfile(next)
        setSavedSnapshot(JSON.stringify(next))
        setDocs(data.documents || [])
      })
      .catch((err) => toast(err instanceof ApiError ? err.message : "Could not load AI P&R.", "bad"))
      .finally(() => setLoading(false))
  }, [workspaceId, toast])

  async function saveProfile(event?: FormEvent) {
    event?.preventDefault()
    setSaving(true)
    try {
      const data = await api<{ profile: Profile }>("/api/v1/ai/pr/profile", {
        method: "PUT",
        body: JSON.stringify(profile),
      })
      const next = { ...emptyProfile, ...data.profile }
      setProfile(next)
      setSavedSnapshot(JSON.stringify(next))
      toast("AI P&R profile saved.")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not save profile.", "bad")
    } finally {
      setSaving(false)
    }
  }

  async function uploadPdf(kind: string, file: File | undefined) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      toast("Upload a PDF file.", "bad")
      return
    }
    setUploadingKind(kind)
    try {
      const form = new FormData()
      form.append("kind", kind)
      form.append("file", file)
      const data = await api<{ document: KnowledgeDoc; chunks_indexed: number; chars_extracted: number }>(
        "/api/v1/ai/pr/documents/pdf",
        { method: "POST", body: form },
      )
      setDocs((current) => [data.document, ...current.filter((item) => item.source !== kind && item.id !== data.document.id)])
      toast(`${file.name} indexed · ${data.chunks_indexed} chunks · ${data.chars_extracted.toLocaleString()} characters`)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not index PDF.", "bad")
    } finally {
      setUploadingKind(null)
    }
  }

  async function removeDoc(id: string) {
    if (!window.confirm("Remove this PDF from the knowledge base?")) return
    try {
      await api(`/api/v1/ai/pr/documents/${id}`, { method: "DELETE" })
      setDocs((current) => current.filter((item) => item.id !== id))
      if (expandedDoc === id) setExpandedDoc(null)
      toast("Document removed from RAG.")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not delete.", "bad")
    }
  }

  async function runPreview(overrideQuery?: string) {
    const q = (overrideQuery ?? previewQuery).trim() || profile.looking_for || profile.skills || profile.target_roles
    if (!q.trim()) {
      toast("Enter a retrieval query first.", "bad")
      return
    }
    if (overrideQuery != null) setPreviewQuery(overrideQuery)
    setPreviewBusy(true)
    try {
      const data = await api<RagPreview>("/api/v1/ai/pr/retrieve", {
        method: "POST",
        body: JSON.stringify({ query: q, limit: 5, match_compose: matchCompose }),
      })
      setPreviewResult({
        ...data,
        passages: data.passages || [],
        prompt_block: data.prompt_block || "",
        method: data.method || "",
      })
      if (!(data.passages || []).length && !Object.keys(data.profile || {}).length) {
        toast("No RAG context — upload PDFs or fill parameters first.", "bad")
      }
    } catch (err) {
      setPreviewResult(null)
      toast(err instanceof ApiError ? err.message : "Retrieve failed.", "bad")
    } finally {
      setPreviewBusy(false)
    }
  }

  function sourceLabel(source: string) {
    if (source === "resume") return "Resume"
    if (source === "linkedin") return "LinkedIn"
    if (source === "chatgpt_summary") return "ChatGPT"
    return source || "Knowledge"
  }

  function setField<K extends keyof Profile>(key: K, value: Profile[K]) {
    setProfile((current) => ({ ...current, [key]: value }))
  }

  const tabs: { id: TabId; label: string; badge?: string }[] = [
    { id: "knowledge", label: "Knowledge", badge: `${pdfReady}/3` },
    { id: "parameters", label: "Parameters" },
    { id: "regulations", label: "Regulations" },
    { id: "lab", label: "RAG lab" },
  ]

  return (
    <WorkspacePage
      title="AI P&R"
      subtitle="Parameters, regulations, and career PDFs that ground Compose AI. Upload LinkedIn, resume, and ChatGPT summary — drafts stay faithful to your story."
      actions={
        <>
          <button type="button" className="btn" onClick={() => openCompose()}>
            <Sparkles size={15} /> Test in Compose
          </button>
          <button type="button" className="btn primary" disabled={saving || !dirty} onClick={() => void saveProfile()}>
            {saving ? <Loader2 size={15} className="gm-spin" /> : <Save size={15} />}
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
        </>
      }
      toolbar={
        loading ? null : (
          <div className="aipr-ready">
            <div className="aipr-ready-score">
              <div className="aipr-ring" style={{ ["--p" as string]: `${readyScore}%` }}>
                <span>{readyScore}</span>
              </div>
              <div>
                <strong>Grounding readiness</strong>
                <p className="meta">
                  {pdfReady === 3 && completeness >= 70
                    ? "Ready for grounded outreach."
                    : "Upload all three PDFs and fill looking-for + regulations."}
                </p>
              </div>
            </div>
            <div className="aipr-ready-stats">
              <div>
                <span className="meta">PDFs indexed</span>
                <strong>
                  {pdfReady}
                  <em>/3</em>
                </strong>
              </div>
              <div>
                <span className="meta">Profile fields</span>
                <strong>
                  {completeness}
                  <em>%</em>
                </strong>
              </div>
              <div>
                <span className="meta">RAG chunks</span>
                <strong>{totalChunks}</strong>
              </div>
              <div>
                <span className="meta">Status</span>
                <strong className={dirty ? "is-warn" : "is-ok"}>{dirty ? "Unsaved" : "In sync"}</strong>
              </div>
            </div>
          </div>
        )
      }
    >
      {loading ? (
        <div className="aipr-loading">
          <Loader2 size={22} className="gm-spin" />
          <span>Loading AI P&R workspace…</span>
        </div>
      ) : (
        <>
          <nav className="aipr-tabs" role="tablist" aria-label="AI P&R sections">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={tab === item.id ? "is-on" : ""}
                onClick={() => setTab(item.id)}
              >
                {item.label}
                {item.badge ? <span className="aipr-tab-badge">{item.badge}</span> : null}
              </button>
            ))}
          </nav>

          {tab === "knowledge" ? (
            <section className="aipr-panel">
              <header className="aipr-panel-head">
                <div>
                  <h2>Career knowledge base</h2>
                  <p>Three source PDFs. Text is extracted, chunked, and embedded for retrieval when you write with AI.</p>
                </div>
                <ol className="aipr-steps">
                  <li className={pdfReady >= 1 ? "is-done" : ""}>Upload LinkedIn</li>
                  <li className={pdfReady >= 2 ? "is-done" : ""}>Upload resume</li>
                  <li className={pdfReady >= 3 ? "is-done" : ""}>Upload ChatGPT summary</li>
                </ol>
              </header>

              <div className="aipr-pdf-grid">
                {PDF_SLOTS.map((slot, index) => {
                  const existing = byKind[slot.id]
                  const busy = uploadingKind === slot.id
                  const Icon = slot.Icon
                  return (
                    <article
                      key={slot.id}
                      className={`aipr-pdf-card${existing ? " is-ready" : ""}${busy ? " is-busy" : ""}`}
                      onDragOver={(event) => {
                        event.preventDefault()
                        dragKind.current = slot.id
                      }}
                      onDrop={(event) => {
                        event.preventDefault()
                        const file = event.dataTransfer.files?.[0]
                        void uploadPdf(slot.id, file)
                      }}
                    >
                      <div className="aipr-pdf-card-top">
                        <span className="aipr-pdf-index">{index + 1}</span>
                        <span className={`aipr-status${existing ? " is-ready" : ""}`}>
                          {existing ? (
                            <>
                              <CheckCircle2 size={14} /> Indexed
                            </>
                          ) : (
                            <>
                              <Circle size={14} /> Waiting
                            </>
                          )}
                        </span>
                      </div>
                      <div className="aipr-pdf-icon">
                        <Icon size={22} strokeWidth={1.75} />
                      </div>
                      <h3>{slot.label}</h3>
                      <p>{slot.detail}</p>
                      <p className="meta">{slot.hint}</p>

                      {existing ? (
                        <div className="aipr-pdf-meta">
                          <span>{existing.chunk_count} chunks</span>
                          <span>{existing.content_text.length.toLocaleString()} chars</span>
                          {existing.updated_at ? <span>{new Date(existing.updated_at).toLocaleDateString()}</span> : null}
                        </div>
                      ) : (
                        <div className="aipr-drop">
                          {busy ? "Extracting & indexing…" : "Drop PDF here or choose a file"}
                        </div>
                      )}

                      <div className="aipr-pdf-actions">
                        <label className={`btn small primary${busy ? " is-disabled" : ""}`}>
                          {busy ? <Loader2 size={14} className="gm-spin" /> : <FileUp size={14} />}
                          {busy ? "Indexing…" : existing ? "Replace PDF" : "Upload PDF"}
                          <input
                            className="sr"
                            type="file"
                            accept="application/pdf,.pdf"
                            disabled={busy || uploadingKind !== null}
                            onChange={(event) => {
                              void uploadPdf(slot.id, event.target.files?.[0])
                              event.currentTarget.value = ""
                            }}
                          />
                        </label>
                        {existing ? (
                          <>
                            <button
                              type="button"
                              className="btn small"
                              onClick={() => setExpandedDoc(expandedDoc === existing.id ? null : existing.id)}
                            >
                              <FileText size={14} /> {expandedDoc === existing.id ? "Hide text" : "Preview"}
                            </button>
                            <button type="button" className="btn small ghost" onClick={() => void removeDoc(existing.id)}>
                              <Trash2 size={14} />
                            </button>
                          </>
                        ) : null}
                      </div>

                      {existing && expandedDoc === existing.id ? (
                        <pre className="aipr-excerpt">{existing.content_text.slice(0, 2400)}{existing.content_text.length > 2400 ? "…" : ""}</pre>
                      ) : null}
                    </article>
                  )
                })}
              </div>

              <aside className="aipr-callout">
                <AlertTriangle size={16} />
                <div>
                  <strong>Text-based PDFs only</strong>
                  <p>
                    Use LinkedIn “Save to PDF”, and export resume/summary from Docs or Word. Scanned image PDFs cannot be
                    OCR’d yet — Compose will not see that content.
                  </p>
                </div>
              </aside>
            </section>
          ) : null}

          {tab === "parameters" ? (
            <section className="aipr-panel">
              <header className="aipr-panel-head">
                <div>
                  <h2>Parameters</h2>
                  <p>Who you are and what you want. Injected into every AI draft alongside retrieved PDF passages.</p>
                </div>
              </header>
              <form className="aipr-form-grid" onSubmit={(e) => void saveProfile(e)}>
                <div className="aipr-form-section">
                  <h3>
                    <BookOpen size={16} /> Identity
                  </h3>
                  <div className="aipr-two">
                    <label className="field">
                      <span>Display name</span>
                      <input value={profile.display_name} onChange={(e) => setField("display_name", e.target.value)} placeholder="Yashjeet" />
                    </label>
                    <label className="field">
                      <span>Headline</span>
                      <input
                        value={profile.headline}
                        onChange={(e) => setField("headline", e.target.value)}
                        placeholder="Backend engineer · Python / distributed systems"
                      />
                    </label>
                  </div>
                  <label className="field">
                    <span>Professional summary</span>
                    <textarea rows={5} value={profile.summary} onChange={(e) => setField("summary", e.target.value)} placeholder="2–4 sentences the model can paraphrase — not invent." />
                  </label>
                  <label className="field">
                    <span>Skills</span>
                    <textarea rows={3} value={profile.skills} onChange={(e) => setField("skills", e.target.value)} placeholder="Python, FastAPI, Postgres, Gmail APIs…" />
                  </label>
                </div>

                <div className="aipr-form-section">
                  <h3>
                    <Target size={16} /> Targeting
                  </h3>
                  <label className="field">
                    <span>Looking for</span>
                    <textarea
                      rows={4}
                      value={profile.looking_for}
                      onChange={(e) => setField("looking_for", e.target.value)}
                      placeholder="Roles, industries, company stage, remote/hybrid, compensation band…"
                    />
                  </label>
                  <div className="aipr-two">
                    <label className="field">
                      <span>Target roles</span>
                      <input value={profile.target_roles} onChange={(e) => setField("target_roles", e.target.value)} placeholder="SDE II, Backend Engineer…" />
                    </label>
                    <label className="field">
                      <span>Target companies</span>
                      <input value={profile.target_companies} onChange={(e) => setField("target_companies", e.target.value)} placeholder="Product-led startups, fintech…" />
                    </label>
                  </div>
                  <label className="field">
                    <span>
                      <MapPin size={12} /> Location preference
                    </span>
                    <input value={profile.location_pref} onChange={(e) => setField("location_pref", e.target.value)} placeholder="Bengaluru / remote IST overlap" />
                  </label>
                  <label className="field">
                    <span>Email signature</span>
                    <textarea
                      rows={6}
                      value={profile.email_signature}
                      onChange={(e) => setField("email_signature", e.target.value)}
                      placeholder={"Yashjeet Singh\nPortfolio: https://yashjeet.space\nGitHub: https://github.com/yj004\nLinkedIn: https://www.linkedin.com/in/yashjeet-singh/\nMob: 9729840783"}
                    />
                    <span className="meta">Appended to AI drafts and outbound sends.</span>
                  </label>
                </div>

                <div className="aipr-form-foot">
                  <p className="meta">{dirty ? "You have unsaved parameter changes." : "All parameters are saved."}</p>
                  <button className="btn primary" type="submit" disabled={saving || !dirty}>
                    {saving ? "Saving…" : "Save parameters"}
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          {tab === "regulations" ? (
            <section className="aipr-panel">
              <header className="aipr-panel-head">
                <div>
                  <h2>Regulations</h2>
                  <p>Hard constraints the model must obey. Prefer explicit “never / always” rules over vague guidance.</p>
                </div>
              </header>
              <form className="aipr-form-grid" onSubmit={(e) => void saveProfile(e)}>
                <div className="aipr-form-section">
                  <h3>
                    <Shield size={16} /> Compliance & claims
                  </h3>
                  <label className="field">
                    <span>Regulations / constraints</span>
                    <textarea
                      rows={6}
                      value={profile.regulations}
                      onChange={(e) => setField("regulations", e.target.value)}
                      placeholder={"Examples:\n• Never claim visa sponsorship\n• No salary numbers in first touch\n• Cold emails under 120 words\n• Always offer a clear, low-friction ask"}
                    />
                  </label>
                  <label className="field">
                    <span>Do not claim</span>
                    <textarea
                      rows={4}
                      value={profile.do_not_claim}
                      onChange={(e) => setField("do_not_claim", e.target.value)}
                      placeholder="Degrees, employers, metrics, or projects that must never be invented."
                    />
                  </label>
                </div>
                <div className="aipr-form-section">
                  <h3>
                    <Sparkles size={16} /> Voice
                  </h3>
                  <label className="field">
                    <span>Tone rules</span>
                    <textarea
                      rows={5}
                      value={profile.tone_rules}
                      onChange={(e) => setField("tone_rules", e.target.value)}
                      placeholder="Warm but direct. No corporate buzzwords. No fake familiarity."
                    />
                  </label>
                </div>
                <div className="aipr-form-foot">
                  <p className="meta">Regulations override style when they conflict.</p>
                  <button className="btn primary" type="submit" disabled={saving || !dirty}>
                    {saving ? "Saving…" : "Save regulations"}
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          {tab === "lab" ? (
            <section className="aipr-panel">
              <header className="aipr-panel-head">
                <div>
                  <h2>RAG lab</h2>
                  <p>
                    Ranked passages Compose AI will ground on — hybrid embedding + exact-name matching. Verify employers,
                    metrics, and role facts before you draft.
                  </p>
                </div>
              </header>
              <div className="aipr-lab">
                <div className="aipr-lab-controls">
                  <label className="field">
                    <span>Retrieval query</span>
                    <div className="aipr-lab-search">
                      <Search size={16} />
                      <input
                        value={previewQuery}
                        onChange={(e) => setPreviewQuery(e.target.value)}
                        placeholder="e.g. Apply for Software Engineer - Gen AI"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void runPreview()
                        }}
                      />
                    </div>
                  </label>
                  <button type="button" className="btn primary" disabled={previewBusy} onClick={() => void runPreview()}>
                    {previewBusy ? <Loader2 size={15} className="gm-spin" /> : <Search size={15} />}
                    {previewBusy ? "Retrieving…" : "Retrieve context"}
                  </button>
                </div>
                <div className="aipr-lab-chips">
                  {LAB_EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      className="aipr-chip"
                      disabled={previewBusy}
                      onClick={() => void runPreview(example)}
                    >
                      {example}
                    </button>
                  ))}
                </div>
                <label className="aipr-lab-toggle">
                  <input
                    type="checkbox"
                    checked={matchCompose}
                    onChange={(e) => setMatchCompose(e.target.checked)}
                  />
                  <span>Match Compose (prefer resume → LinkedIn → ChatGPT for job queries)</span>
                </label>
                {previewResult ? (
                  <>
                    <div className="aipr-lab-meta">
                      <span>
                        Method: <strong>{previewResult.method || "—"}</strong>
                      </span>
                      <span>
                        Query: <strong>{previewResult.query || previewQuery}</strong>
                      </span>
                      {previewResult.stats ? (
                        <span>
                          Scanned {previewResult.stats.chunks_scanned ?? 0} chunks ·{" "}
                          {previewResult.stats.with_embedding ?? 0} embedded · returned{" "}
                          {previewResult.passages.length}
                        </span>
                      ) : null}
                      {previewResult.prefer_sources?.length ? (
                        <span>Prefer: {previewResult.prefer_sources.join(", ")}</span>
                      ) : null}
                    </div>
                    {previewResult.passages.length ? (
                      <ol className="aipr-passage-list">
                        {previewResult.passages.map((passage, index) => (
                          <li key={`${passage.source}-${index}`} className="aipr-passage">
                            <div className="aipr-passage-head">
                              <span className="aipr-passage-rank">#{index + 1}</span>
                              <span className={`aipr-src aipr-src-${passage.source || "other"}`}>
                                {sourceLabel(passage.source)}
                              </span>
                              <strong className="aipr-passage-score">{passage.score.toFixed(3)}</strong>
                              <span className="meta aipr-passage-breakdown">
                                emb {(passage.embedding_score ?? 0).toFixed(2)} · lex{" "}
                                {(passage.lexical_score ?? 0).toFixed(2)}
                                {(passage.phrase_boost ?? 0) > 0
                                  ? ` · +phrase ${(passage.phrase_boost ?? 0).toFixed(2)}`
                                  : ""}
                              </span>
                            </div>
                            <div className="aipr-passage-title">{passage.title}</div>
                            <p className="aipr-passage-body">{passage.content}</p>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <div className="aipr-lab-empty">
                        <AlertTriangle size={28} strokeWidth={1.5} />
                        <h3>No passages matched</h3>
                        <p>Upload or re-index PDFs, or try a query with employer / stack keywords from your resume.</p>
                      </div>
                    )}
                    <div className="aipr-lab-prompt">
                      <button type="button" className="btn" onClick={() => setShowPromptBlock((v) => !v)}>
                        {showPromptBlock ? "Hide" : "Show"} prompt block sent to Compose
                      </button>
                      {showPromptBlock ? <pre className="aipr-preview">{previewResult.prompt_block || "(empty)"}</pre> : null}
                    </div>
                  </>
                ) : (
                  <div className="aipr-lab-empty">
                    <Shield size={28} strokeWidth={1.5} />
                    <h3>No preview yet</h3>
                    <p>Run a retrieval after uploading PDFs to verify grounding quality.</p>
                  </div>
                )}
              </div>
            </section>
          ) : null}
        </>
      )}
    </WorkspacePage>
  )
}
