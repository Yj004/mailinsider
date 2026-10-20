import { useState } from "react"
import { ShieldCheck, Sparkles, TriangleAlert } from "lucide-react"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"

type Finding = {
  code: string
  severity: string
  message: string
  suggestion: string
}

type Analysis = {
  score: number
  band: "good" | "ok" | "risky" | string
  summary: string
  findings: Finding[]
  tips: string[]
  ai_available: boolean
  disclaimer: string
}

type ImproveResult = {
  subject: string
  body_text: string
  notes: string[]
  engine: string
  analysis: Analysis
}

export function DeliverabilityAssist({
  subject,
  body,
  onApply,
}: {
  subject: string
  body: string
  onApply: (next: { subject: string; body: string }) => void
}) {
  const { toast } = useAuth()
  const [busy, setBusy] = useState<"analyze" | "improve" | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [engine, setEngine] = useState("")
  const [goal, setGoal] = useState("Warm, specific cold outreach — one clear ask")

  async function analyze() {
    setBusy("analyze")
    try {
      const data = await api<Analysis>("/api/v1/ai/deliverability/analyze", {
        method: "POST",
        body: JSON.stringify({ subject, body_text: body }),
      })
      setAnalysis(data)
      setNotes([])
      setEngine("")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not analyze the draft.", "bad")
    } finally {
      setBusy(null)
    }
  }

  async function improve() {
    setBusy("improve")
    try {
      const data = await api<ImproveResult>("/api/v1/ai/deliverability/improve", {
        method: "POST",
        body: JSON.stringify({ subject, body_text: body, goal }),
      })
      setAnalysis(data.analysis)
      setNotes(data.notes || [])
      setEngine(data.engine)
      onApply({ subject: data.subject, body: data.body_text })
      toast(data.engine === "rules" ? "Draft cleaned with deliverability rules." : "Draft improved with AI.")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not improve the draft.", "bad")
    } finally {
      setBusy(null)
    }
  }

  const bandClass =
    analysis?.band === "good" ? "is-good" : analysis?.band === "ok" ? "is-ok" : analysis ? "is-risky" : ""

  return (
    <section className="deliv-assist">
      <div className="deliv-assist-head">
        <div>
          <h2>
            <ShieldCheck size={16} aria-hidden /> Inbox risk check
          </h2>
          <p className="meta">
            Lowers spam-trigger wording before send. Domain reputation and SPF/DKIM/DMARC still matter — nothing guarantees the
            inbox.
          </p>
        </div>
        <div className="deliv-assist-actions">
          <button className="btn small" type="button" disabled={busy !== null} onClick={() => void analyze()}>
            {busy === "analyze" ? "Checking…" : "Check draft"}
          </button>
          <button className="btn primary small" type="button" disabled={busy !== null} onClick={() => void improve()}>
            <Sparkles size={14} /> {busy === "improve" ? "Improving…" : "Improve for inbox"}
          </button>
        </div>
      </div>

      <label className="field">
        <span>Writing goal (optional)</span>
        <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Book a 15-min intro with hiring managers" />
      </label>

      {analysis ? (
        <div className={`deliv-score ${bandClass}`}>
          <div className="deliv-score-main">
            <b>{analysis.score}</b>
            <span>/100 · {analysis.band}</span>
          </div>
          <p>{analysis.summary}</p>
          {engine ? (
            <p className="meta">
              Engine: {engine === "ollama" ? "Local Ollama" : engine === "openai" ? "OpenAI" : "Built-in rules"}
            </p>
          ) : null}
        </div>
      ) : null}

      {notes.length ? (
        <ul className="deliv-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      {analysis?.findings?.length ? (
        <ul className="deliv-findings">
          {analysis.findings.map((item) => (
            <li key={`${item.code}-${item.message}`} className={`is-${item.severity}`}>
              <TriangleAlert size={14} aria-hidden />
              <div>
                <strong>{item.message}</strong>
                <span className="meta">{item.suggestion}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {analysis?.tips?.length ? (
        <details className="deliv-tips">
          <summary>Beyond the copy</summary>
          <ul>
            {analysis.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {analysis?.disclaimer ? <p className="hint">{analysis.disclaimer}</p> : null}
    </section>
  )
}
