import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Calendar, Eye, FileText, Mail, MousePointerClick } from "lucide-react"
import { api, ApiError } from "../../api"
import { useAuth } from "../../auth"
import { greeting } from "../../labels"
import type { ActivityItem, PerformanceResponse } from "../../types"
import { PageContainer } from "../../components/layout/PageContainer"
import { EmailPerformanceChart } from "./EmailPerformanceChart"
import { MetricCard } from "./MetricCard"
import { QuickActions } from "./QuickActions"
import { RecentActivityFeed } from "./RecentActivityFeed"
import { RecentEmailsTable } from "./RecentEmailsTable"

const RANGES = [
  { id: 7, label: "Last 7 days" },
  { id: 14, label: "Last 14 days" },
  { id: 30, label: "Last 30 days" },
  { id: 90, label: "Last 90 days" },
]

function rangeFor(days: number) {
  const end = new Date()
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
  return { from: start.toISOString(), to: end.toISOString(), start, end }
}

function formatRange(start: Date, end: Date) {
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }
  return `${start.toLocaleDateString(undefined, options)} – ${end.toLocaleDateString(undefined, options)}`
}

export function DashboardPage() {
  const { user, workspaceId } = useAuth()
  const [days, setDays] = useState(14)
  const [grain, setGrain] = useState<"daily" | "weekly">("daily")
  const range = useMemo(() => rangeFor(days), [days])

  const performance = useQuery({
    queryKey: ["performance", workspaceId, range.from, range.to, grain],
    queryFn: () =>
      api<PerformanceResponse>(
        `/api/v1/analytics/performance?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&grain=${grain}`,
      ),
  })
  const activity = useQuery({
    queryKey: ["activity", workspaceId],
    queryFn: () => api<{ items: ActivityItem[] }>("/api/v1/analytics/activity?limit=8"),
  })

  const current = performance.data?.current
  const comparison = performance.data?.comparison
  const periodLabel = `vs previous ${days} days`
  const performanceError = performance.error instanceof ApiError ? performance.error.message : performance.error ? "Could not load performance." : ""
  const activityError = activity.error instanceof ApiError ? activity.error.message : activity.error ? "Could not load activity." : ""

  return (
    <PageContainer>
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
      <div className="grid min-w-0 gap-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="m-0 text-[28px] font-semibold tracking-tight text-ink">{greeting(user?.display_name || "there")}</h1>
            <p className="m-0 mt-1 text-sm text-slate-500">Here&apos;s how your emails are performing.</p>
          </div>
          <label className="inline-flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-2 text-sm text-slate-600 shadow-card">
            <Calendar size={16} aria-hidden="true" />
            <span className="sr">Date range</span>
            <select className="!w-auto border-0 bg-transparent p-0" value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {RANGES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <span className="hidden text-slate-400 sm:inline">{formatRange(range.start, range.end)}</span>
          </label>
        </div>
        {performanceError ? <div className="banner bad">{performanceError}</div> : null}
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Email metrics">
          <MetricCard
            label="Emails sent"
            value={current?.emails_sent ?? null}
            rate={null}
            change={comparison?.emails_sent ?? null}
            periodLabel={periodLabel}
            icon={Mail}
            tone="blue"
            loading={performance.isLoading}
          />
          <MetricCard
            label="Opens"
            value={current?.estimated_opens ?? null}
            rate={current?.open_rate ?? null}
            change={comparison?.estimated_opens ?? null}
            periodLabel={periodLabel}
            icon={Eye}
            tone="green"
            loading={performance.isLoading}
          />
          <MetricCard
            label="Link clicks"
            value={current?.link_clicks ?? null}
            rate={current?.click_rate ?? null}
            change={comparison?.link_clicks ?? null}
            periodLabel={periodLabel}
            icon={MousePointerClick}
            tone="purple"
            loading={performance.isLoading}
          />
          <MetricCard
            label="Document views"
            value={current?.document_views ?? null}
            rate={current?.document_rate ?? null}
            change={comparison?.document_views ?? null}
            periodLabel={periodLabel}
            icon={FileText}
            tone="orange"
            loading={performance.isLoading}
          />
        </section>
        <EmailPerformanceChart
          series={performance.data?.series || []}
          grain={grain}
          loading={performance.isLoading}
          error=""
          onGrain={setGrain}
        />
        <RecentEmailsTable from={range.from} to={range.to} />
      </div>
      <div className="grid gap-4">
        <QuickActions />
        <RecentActivityFeed items={activity.data?.items || []} loading={activity.isLoading} error={activityError} />
      </div>
    </div>
    </PageContainer>
  )
}
