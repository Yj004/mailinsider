import type { LucideIcon } from "lucide-react"
import { Minus, TrendingDown, TrendingUp } from "lucide-react"

export function MetricCard({
  label,
  value,
  rate,
  change,
  periodLabel,
  icon: Icon,
  tone,
  loading,
}: {
  label: string
  value: number | null
  rate: number | null
  change: number | null
  periodLabel: string
  icon: LucideIcon
  tone: "blue" | "green" | "purple" | "orange"
  loading: boolean
}) {
  const toneClass = {
    blue: "bg-blue-50 text-blue-600",
    green: "bg-emerald-50 text-emerald-600",
    purple: "bg-violet-50 text-violet-600",
    orange: "bg-orange-50 text-orange-600",
  }[tone]
  const rising = change !== null && change > 0
  const falling = change !== null && change < 0
  const Trend = rising ? TrendingUp : falling ? TrendingDown : Minus
  const trendClass = rising ? "text-emerald-600" : falling ? "text-red-600" : "text-slate-400"

  return (
    <article className="rounded-2xl border border-line bg-white p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <span className={`grid h-9 w-9 place-items-center rounded-xl ${toneClass}`}>
          <Icon size={18} aria-hidden="true" />
        </span>
        {rate !== null ? (
          <span className="rounded-full bg-slate-50 px-2 py-0.5 text-xs font-semibold text-slate-500">{rate.toFixed(1)}%</span>
        ) : null}
      </div>
      <div className="mt-4 text-[28px] font-semibold leading-none tracking-tight text-ink tabular-nums">
        {loading || value === null ? "–" : value.toLocaleString()}
      </div>
      <div className="mt-2 text-sm font-medium text-slate-500">{label}</div>
      <div className={`mt-3 flex items-center gap-1 text-xs font-medium ${trendClass}`}>
        <Trend size={14} aria-hidden="true" />
        <span>
          {change === null ? (
            "Not enough history to compare"
          ) : (
            <>
              {`${Math.abs(change).toFixed(0)}%`}
              <span className="font-normal text-slate-400"> {periodLabel}</span>
            </>
          )}
        </span>
      </div>
    </article>
  )
}
