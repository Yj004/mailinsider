import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { SignalGuide } from "../components/ui"
import { WorkspacePage, WsEmpty } from "../components/workspace/WorkspacePage"
import { EmailPerformanceChart } from "../features/dashboard/EmailPerformanceChart"
import type { Overview, PerformanceResponse } from "../types"

const RANGES = [
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
]

export function InsightsPage() {
  const { workspaceId } = useAuth()
  const [range, setRange] = useState("30")
  const [data, setData] = useState<Overview | null>(null)
  const [perf, setPerf] = useState<PerformanceResponse | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    document.title = "Insights — MailInsider"
  }, [])

  useEffect(() => {
    const end = new Date()
    const start = new Date(end.getTime() - Number(range) * 24 * 60 * 60 * 1000)
    const from = start.toISOString()
    const to = end.toISOString()
    setError("")
    Promise.all([
      api<Overview>(`/api/v1/analytics/overview?from=${from}&to=${to}`),
      api<PerformanceResponse>(`/api/v1/analytics/performance?from=${from}&to=${to}`),
    ])
      .then(([overview, performance]) => {
        setData(overview)
        setPerf(performance)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load insights."))
  }, [range, workspaceId])

  const current = perf?.current
  const empty = (current?.emails_sent || 0) === 0

  return (
    <WorkspacePage
      title="Insights"
      subtitle="Unique recipient counts for opens, links, and document views across your sent mail."
      actions={
        <Link className="btn" to="/app/mail">
          Open mail
        </Link>
      }
      toolbar={
        <div className="filters" style={{ margin: 0 }}>
          {RANGES.map((item) => (
            <button key={item.id} className={range === item.id ? "on" : ""} type="button" onClick={() => setRange(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      }
    >
      {error ? <div className="banner bad">{error}</div> : null}
      {empty && !error ? (
        <WsEmpty
          title="No sends in this range"
          body="Compose and send a message to populate opens, clicks, and document views for this window."
          action={
            <Link className="btn primary" to="/app/compose">
              Compose
            </Link>
          }
        />
      ) : null}
      <section className="metrics">
        <article className="metric">
          <span>Emails sent</span>
          <b>{current?.emails_sent ?? data?.messages ?? "–"}</b>
          <span>Messages with at least one sent recipient</span>
        </article>
        <article className="metric">
          <span>Unique opens</span>
          <b>{current?.estimated_opens ?? data?.unique_opens_estimated ?? "–"}</b>
          <span>
            {current?.open_rate != null ? `${Math.round(current.open_rate * 100)}% open rate` : "Distinct recipients"}
          </span>
        </article>
        <article className="metric">
          <span>Unique link clicks</span>
          <b>{current?.link_clicks ?? data?.unique_clickers ?? "–"}</b>
          <span>
            {current?.click_rate != null ? `${Math.round(current.click_rate * 100)}% click rate` : "Counted link requests"}
          </span>
        </article>
        <article className="metric">
          <span>Document views</span>
          <b>{current?.document_views ?? data?.document_views ?? "–"}</b>
          <span>
            {current?.document_rate != null
              ? `${Math.round(current.document_rate * 100)}% view rate`
              : "Viewer loaded"}
          </span>
        </article>
      </section>
      <section className="metrics">
        <article className="metric">
          <span>Sent recipients</span>
          <b>{data?.sent_recipients ?? "–"}</b>
          <span>{data?.failed_recipients || 0} failed</span>
        </article>
        <article className="metric">
          <span>No activity</span>
          <b>{data?.no_activity ?? "–"}</b>
          <span>Sent, nothing observed</span>
        </article>
        <article className="metric">
          <span>Quota today</span>
          <b>
            {data?.quota.used ?? "–"}
            <span style={{ fontSize: 16 }}>/{data?.quota.limit ?? "–"}</span>
          </b>
          <span>Recipient sends</span>
        </article>
        <article className="metric">
          <span>vs prior window</span>
          <b>
            {perf?.comparison.estimated_opens != null
              ? `${perf.comparison.estimated_opens > 0 ? "+" : ""}${perf.comparison.estimated_opens}`
              : "–"}
          </b>
          <span>Change in unique opens</span>
        </article>
      </section>
      {perf ? (
        <div className="mt-6">
          <EmailPerformanceChart
            series={perf.series}
            grain={perf.grain}
            loading={false}
            error=""
            onGrain={() => undefined}
          />
        </div>
      ) : null}
      {perf?.definitions ? (
        <details className="guide card mt-4">
          <summary>Metric definitions</summary>
          <dl>
            {Object.entries(perf.definitions).map(([key, value]) => (
              <div key={key}>
                <dt>{key.replaceAll("_", " ")}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <SignalGuide />
    </WorkspacePage>
  )
}
