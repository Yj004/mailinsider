import { useState } from "react"
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import type { PerformancePoint } from "../../types"

const SERIES = [
  { key: "emails_sent", label: "Emails sent", color: "#2563EB" },
  { key: "estimated_opens", label: "Opens", color: "#10B981" },
  { key: "link_clicks", label: "Link clicks", color: "#7C3AED" },
  { key: "document_views", label: "Document views", color: "#F59E0B" },
] as const

function formatDay(value: string) {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function EmailPerformanceChart({
  series,
  grain,
  loading,
  error,
  onGrain,
}: {
  series: PerformancePoint[]
  grain: "daily" | "weekly"
  loading: boolean
  error: string
  onGrain: (grain: "daily" | "weekly") => void
}) {
  const [hidden, setHidden] = useState<string[]>([])
  const empty = !loading && series.every((point) => SERIES.every((item) => point[item.key] === 0))

  return (
    <section className="rounded-2xl border border-line bg-white p-4 shadow-card sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-base font-semibold text-ink">Email performance</h2>
          <p className="m-0 mt-1 text-sm text-slate-500">Unique recipients per {grain === "daily" ? "day" : "week"}.</p>
        </div>
        <label className="text-sm text-slate-500">
          <span className="sr">Aggregation</span>
          <select
            className="!w-auto rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
            value={grain}
            onChange={(event) => onGrain(event.target.value === "weekly" ? "weekly" : "daily")}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        {SERIES.map((item) => {
          const off = hidden.includes(item.key)
          return (
            <button
              key={item.key}
              type="button"
              className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium ${off ? "border-line text-slate-400" : "border-line bg-slate-50 text-slate-600"}`}
              onClick={() => setHidden((current) => (current.includes(item.key) ? current.filter((key) => key !== item.key) : [...current, item.key]))}
              aria-pressed={!off}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: item.color }} />
              {item.label}
            </button>
          )
        })}
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="h-72">
        {loading ? (
          <div className="grid h-full place-items-center text-sm text-slate-400">Loading performance…</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#eef2f7" vertical={false} />
              <XAxis dataKey="date" tickFormatter={formatDay} tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={24} />
              <YAxis allowDecimals={false} tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={false} tickLine={false} width={32} />
              <Tooltip
                labelFormatter={(label) => formatDay(String(label))}
                formatter={(value, name) => [Number(value).toLocaleString(), SERIES.find((item) => item.key === name)?.label || String(name)]}
                contentStyle={{ borderRadius: 12, borderColor: "#e6eaf2", fontSize: 13 }}
              />
              {SERIES.map((item) =>
                hidden.includes(item.key) ? null : (
                  <Area
                    key={item.key}
                    type="monotone"
                    dataKey={item.key}
                    name={item.key}
                    stroke={item.color}
                    fill={item.color}
                    fillOpacity={0.12}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                ),
              )}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      {empty ? <p className="m-0 text-sm text-slate-500">No sends or engagement in this range. The chart stays at zero until something is recorded.</p> : null}
    </section>
  )
}
