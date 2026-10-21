import { Link } from "react-router-dom"
import { Check } from "lucide-react"
import { useEffect } from "react"

const PLANS = [
  {
    name: "Starter",
    price: "Free",
    interval: "while you evaluate",
    cta: "Join waitlist",
    to: "/waitlist",
    highlight: false,
    features: [
      "Gmail send connection",
      "Compose with PDF attachments",
      "Open & link tracking",
      "Document viewer tracking",
      "Daily send quota (workspace default)",
      "Contacts & follow-up reminders",
    ],
  },
  {
    name: "Pro",
    price: "Custom",
    interval: "talk to us for volume",
    cta: "Contact sales",
    to: "/contact?subject=Pro%20plan",
    highlight: true,
    features: [
      "Everything in Starter",
      "Higher daily send limits",
      "Campaigns & templates",
      "Google Sheets logging",
      "Team workspaces & roles",
      "Priority support",
    ],
  },
]

export function PricingPage() {
  useEffect(() => {
    document.title = "Pricing — MailInsider"
  }, [])

  return (
    <div className="bg-[#f5f5f7] px-5 py-16">
      <div className="mx-auto max-w-6xl">
        <p className="text-sm font-semibold uppercase tracking-wider text-[#1a73e8]/70">Pricing</p>
        <h1 className="font-display mt-2 text-4xl font-semibold text-ink">Straightforward plans</h1>
        <p className="mt-3 max-w-2xl text-slate-600">
          Public sign-up is closed. Join the waitlist with monthly volume (including follow-ups) and what you’d pay.
          We’ll open a workspace when you’re approved.
        </p>
        <div className="mt-12 grid gap-6 md:grid-cols-2">
          {PLANS.map((plan) => (
            <article
              key={plan.name}
              className={`rounded-3xl border bg-white p-8 shadow-sm ${
                plan.highlight ? "border-[#0b57d0] ring-2 ring-[#0b57d0]/20" : "border-line"
              }`}
            >
              <div className="text-sm font-semibold text-[#0b57d0]">{plan.name}</div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="font-display text-4xl font-semibold text-ink">{plan.price}</span>
                <span className="text-sm text-slate-500">{plan.interval}</span>
              </div>
              <ul className="mt-8 grid gap-3">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2 text-sm text-slate-700">
                    <Check className="mt-0.5 shrink-0 text-[#0b57d0]" size={16} aria-hidden />
                    {f}
                  </li>
                ))}
              </ul>
              <Link className={`mi-btn mt-8 w-full justify-center ${plan.highlight ? "mi-btn-primary" : "mi-btn-secondary"}`} to={plan.to}>
                {plan.cta}
              </Link>
            </article>
          ))}
        </div>
        <p className="mt-10 text-center text-sm text-slate-500">
          Gmail acceptance is not the same as inbox delivery.
        </p>
      </div>
    </div>
  )
}
