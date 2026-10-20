import { useEffect, useState } from "react"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { SignalGuide } from "../components/ui"
import type { Overview } from "../types"

const RANGES = [
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
]

export function AnalyticsPage() {
  const { workspaceId } = useAuth()
  const [range, setRange] = useState("7")
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    const end = new Date()
    const start = new Date(end.getTime() - Number(range) * 24 * 60 * 60 * 1000)
    api<Overview>(`/api/v1/analytics/overview?from=${start.toISOString()}&to=${end.toISOString()}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load analytics."))
  }, [range, workspaceId])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="sub">Unique counts skip bursts of three requests inside 15 seconds. Raw events stay on each message timeline.</p>
        </div>
      </div>
      <div className="filters">
        {RANGES.map((item) => (
          <button key={item.id} className={range === item.id ? "on" : ""} type="button" onClick={() => setRange(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {error ? <div className="banner bad">{error}</div> : null}
      <section className="metrics">
        <article className="metric">
          <span>Messages</span>
          <b>{data?.messages ?? "–"}</b>
          <span>Excluding drafts</span>
        </article>
        <article className="metric">
          <span>Sent recipients</span>
          <b>{data?.sent_recipients ?? "–"}</b>
          <span>{data?.failed_recipients || 0} failed</span>
        </article>
        <article className="metric">
          <span>Opens</span>
          <b>{data?.unique_opens_estimated ?? "–"}</b>
          <span>Distinct recipients</span>
        </article>
        <article className="metric">
          <span>No activity</span>
          <b>{data?.no_activity ?? "–"}</b>
          <span>Sent, nothing observed</span>
        </article>
      </section>
      <section className="metrics">
        <article className="metric">
          <span>Unique clickers</span>
          <b>{data?.unique_clickers ?? "–"}</b>
          <span>Counted link requests</span>
        </article>
        <article className="metric">
          <span>Document views</span>
          <b>{data?.document_views ?? "–"}</b>
          <span>Viewer loaded</span>
        </article>
        <article className="metric">
          <span>Quota today</span>
          <b>
            {data?.quota.used ?? "–"}
            <span style={{ fontSize: 16 }}>/{data?.quota.limit ?? "–"}</span>
          </b>
          <span>Recipient sends, not a Gmail bypass</span>
        </article>
        <article className="metric">
          <span>Since yesterday</span>
          <b>{(data?.since_yesterday.opens || 0) + (data?.since_yesterday.clicks || 0) + (data?.since_yesterday.document_views || 0)}</b>
          <span>Counted signals in 24 hours</span>
        </article>
      </section>
      <SignalGuide />
    </div>
  )
}
