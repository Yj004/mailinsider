import { FormEvent, ReactNode, useEffect, useRef, useState } from "react"
import {
  Check,
  Loader2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Wand2,
  X,
} from "lucide-react"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"

type Finding = {
  code: string
  severity: string
  message: string
  evidence?: string
  suggestion: string
}

type Analysis = {
  score: number
  band: string
  spam_risk: string
  deliverability_check?: string
  summary: string
  dimensions: {
    writing_quality: number
    personalization: number
    subject_relevance: number
    spam_risk_indicators: number
    technical_deliverability: number
  }
  findings: Finding[]
  tips: string[]
  authentication?: {
    domain: string | null
    spf: { status: string; detail: string }
    dkim: { status: string; detail: string }
    dmarc: { status: string; detail: string }
    overall: string
  }
  ai_available: boolean
  disclaimer: string
}

type ComposeResult = {
  subject: string
  body_text: string
  subject_suggestions?: string[]
  notes: string[]
  engine: string
  analysis?: Analysis
}

const TONES = [
  { id: "professional", label: "Professional" },
  { id: "friendly", label: "Friendly" },
  { id: "casual", label: "Casual" },
  { id: "confident", label: "Confident" },
  { id: "concise", label: "Concise" },
  { id: "persuasive", label: "Persuasive" },
  { id: "follow-up", label: "Follow-up" },
]

const QUICK = [
  { action: "improve", label: "Improve writing" },
  { action: "shorten", label: "Make shorter" },
  { action: "tone", label: "Change tone" },
  { action: "subject", label: "Suggest subject" },
  { action: "personalize", label: "Personalize" },
  { action: "grammar", label: "Fix grammar" },
  { action: "deliverability", label: "Improve for inbox" },
]

type Slots = {
  pill: ReactNode
  toolbar: ReactNode
  check: ReactNode
}

export function ComposeAiPanel({
  subject,
  body,
  recipientEmail,
  fromEmail,
  hasAttachment,
  attachmentName,
  threadSnippet,
  onApply,
  children,
}: {
  subject: string
  body: string
  recipientEmail?: string
  fromEmail?: string
  hasAttachment?: boolean
  attachmentName?: string
  threadSnippet?: string
  onApply: (next: { subject?: string; body?: string }) => void
  children: (slots: Slots) => ReactNode
}) {
  const { toast } = useAuth()
  const [prompt, setPrompt] = useState("")
  const [tone, setTone] = useState("professional")
  const [busy, setBusy] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [checkOpen, setCheckOpen] = useState(false)
  const [subjects, setSubjects] = useState<string[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [providerLabel, setProviderLabel] = useState("")
  const menuRef = useRef<HTMLDivElement | null>(null)
  const promptRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    api<{ configured: boolean; provider?: string | null; ollama_model?: string }>("/api/v1/ai/status")
      .then((data) => {
        setConfigured(data.configured)
        if (data.provider === "ollama") setProviderLabel(`Ollama · ${data.ollama_model || "local"}`)
        else if (data.provider === "openai") setProviderLabel("OpenAI")
        else setProviderLabel("")
      })
      .catch(() => setConfigured(false))
  }, [])

  useEffect(() => {
    function onDoc(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [])

  async function runCompose(action: string, instruction = prompt) {
    if (action === "write" && !instruction.trim()) {
      toast("Describe what the email should say.", "bad")
      promptRef.current?.focus()
      return
    }
    if (action !== "write" && !subject.trim() && !body.trim()) {
      toast("Write a draft first, or describe a new message.", "bad")
      return
    }
    setBusy(action)
    try {
      const data = await api<ComposeResult>("/api/v1/ai/compose", {
        method: "POST",
        body: JSON.stringify({
          action,
          instruction,
          subject,
          body_text: body,
          tone,
          length: "short",
          recipient_email: recipientEmail || null,
          thread_snippet: threadSnippet || "",
        }),
      })
      if (action === "subject") onApply({ subject: data.subject })
      else onApply({ subject: data.subject, body: data.body_text })
      setNotes(data.notes || [])
      setSubjects(data.subject_suggestions || [])
      if (data.analysis) setAnalysis(data.analysis as Analysis)
      setPrompt("")
      setMenuOpen(false)
      toast(action === "write" ? "Draft ready — review before sending." : "Updated — review before sending.")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "AI request failed.", "bad")
    } finally {
      setBusy(null)
    }
  }

  async function runAnalyze() {
    setBusy("analyze")
    setCheckOpen(true)
    setMenuOpen(false)
    try {
      const data = await api<Analysis>("/api/v1/ai/deliverability/analyze", {
        method: "POST",
        body: JSON.stringify({
          subject,
          body_text: body,
          from_email: fromEmail || null,
          has_attachment: Boolean(hasAttachment),
          attachment_name: attachmentName || null,
        }),
      })
      setAnalysis(data)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not analyze draft.", "bad")
    } finally {
      setBusy(null)
    }
  }

  function onDescribe(event: FormEvent) {
    event.preventDefault()
    void runCompose("write", prompt)
  }

  const pill = !body.trim() ? (
    <form className="gm-ai-pill" onSubmit={onDescribe}>
      <Wand2 size={18} className="gm-ai-pill-icon" aria-hidden />
      <input
        ref={promptRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe your message"
        aria-label="Describe your message"
        disabled={busy !== null}
      />
      {busy === "write" ? (
        <Loader2 size={16} className="gm-spin" aria-label="Generating" />
      ) : (
        <button type="submit" className="gm-ai-pill-go" disabled={!prompt.trim()}>
          Create
        </button>
      )}
    </form>
  ) : null

  const toolbar = (
    <div className="gm-ai-menu-wrap" ref={menuRef}>
      <button
        type="button"
        className={`gm-tool-btn gm-ai-tool${menuOpen ? " is-on" : ""}`}
        title="Help me write"
        aria-label="Help me write"
        aria-expanded={menuOpen}
        disabled={busy !== null}
        onClick={() => {
          setMenuOpen((v) => !v)
          setCheckOpen(false)
        }}
      >
        {busy ? <Loader2 size={18} className="gm-spin" /> : <Sparkles size={18} />}
      </button>
      {menuOpen ? (
        <div className="gm-ai-menu" role="menu">
          <div className="gm-ai-menu-head">
            <strong>Help me write</strong>
            {providerLabel ? <span className="meta">{providerLabel}</span> : null}
            {configured === false ? (
              <p className="gm-ai-warn">Start Ollama to use AI. Manual compose still works.</p>
            ) : null}
          </div>
          <form
            className="gm-ai-menu-prompt"
            onSubmit={(e) => {
              e.preventDefault()
              void runCompose(body.trim() ? "refine" : "write", prompt)
            }}
          >
            <Wand2 size={16} aria-hidden />
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={body.trim() ? "e.g. make it shorter, less formal…" : "Describe your message"}
            />
            <button type="submit" className="btn small primary" disabled={busy !== null || !prompt.trim()}>
              {busy ? "…" : body.trim() ? "Apply" : "Create"}
            </button>
          </form>
          <label className="gm-ai-tone">
            <span>Tone</span>
            <select value={tone} onChange={(e) => setTone(e.target.value)}>
              {TONES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <div className="gm-ai-menu-actions">
            {QUICK.map((item) => (
              <button
                key={item.action}
                type="button"
                role="menuitem"
                disabled={busy !== null || (!body.trim() && !subject.trim())}
                onClick={() => void runCompose(item.action)}
              >
                {item.label}
              </button>
            ))}
            {threadSnippet ? (
              <button type="button" role="menuitem" disabled={busy !== null} onClick={() => void runCompose("reply")}>
                Suggest reply
              </button>
            ) : null}
            <button type="button" role="menuitem" disabled={busy !== null} onClick={() => void runAnalyze()}>
              <ShieldCheck size={14} /> Spam &amp; quality check
            </button>
          </div>
          {subjects.length ? (
            <div className="gm-ai-subjects">
              <span className="meta">Subjects</span>
              {subjects.map((item) => (
                <button key={item} type="button" onClick={() => onApply({ subject: item })}>
                  {item}
                </button>
              ))}
            </div>
          ) : null}
          {notes.length ? (
            <ul className="deliv-notes">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
          <p className="hint">AI never sends. Review, then click Send yourself.</p>
        </div>
      ) : null}
    </div>
  )

  const check =
    checkOpen && analysis ? (
      <div className="gm-ai-check">
        <div className="gm-ai-check-head">
          <strong>Pre-send check</strong>
          <button type="button" className="gm-tool-btn" aria-label="Close check" onClick={() => setCheckOpen(false)}>
            <X size={16} />
          </button>
        </div>
        <div
          className={`deliv-score ${
            analysis.spam_risk === "Low" ? "is-good" : analysis.spam_risk === "Medium" ? "is-ok" : "is-risky"
          }`}
        >
          <div className="deliv-score-row">
            <div>
              <span className="meta">Spam risk</span>
              <strong>{analysis.spam_risk}</strong>
            </div>
            <div>
              <span className="meta">Deliverability</span>
              <strong>{analysis.deliverability_check || "—"}</strong>
            </div>
            <div>
              <span className="meta">Quality</span>
              <strong>{analysis.score}/100</strong>
            </div>
          </div>
          <p>{analysis.summary}</p>
          <p className="hint">{analysis.disclaimer}</p>
        </div>
        {analysis.findings?.length ? (
          <ul className="deliv-findings">
            {analysis.findings.slice(0, 6).map((item) => (
              <li key={`${item.code}-${item.message}`} className={`is-${item.severity}`}>
                <TriangleAlert size={14} aria-hidden />
                <div>
                  <strong>{item.message}</strong>
                  <span className="meta">{item.suggestion}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="quiet">
            <Check size={14} /> No major content issues.
          </p>
        )}
        <button
          type="button"
          className="btn small primary"
          disabled={busy !== null}
          onClick={() => void runCompose("deliverability")}
        >
          Apply improved draft
        </button>
      </div>
    ) : null

  return <>{children({ pill, toolbar, check })}</>
}
