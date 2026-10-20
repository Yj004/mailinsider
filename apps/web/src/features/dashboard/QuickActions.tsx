import { CalendarClock, FilePlus2, Megaphone, PenLine, UserPlus } from "lucide-react"
import { Link } from "react-router-dom"
import { canSend } from "../../types"
import { useAuth } from "../../auth"

const ACTIONS = [
  { to: "/app/compose", label: "Compose email", icon: PenLine, primary: true, needsSend: true },
  { to: "/app/campaigns", label: "New campaign", icon: Megaphone, primary: false, needsSend: false },
  { to: "/app/contacts", label: "Add contacts", icon: UserPlus, primary: false, needsSend: false },
  { to: "/app/templates", label: "Create template", icon: FilePlus2, primary: false, needsSend: false },
  { to: "/app/follow-ups", label: "Follow-up queue", icon: CalendarClock, primary: false, needsSend: false },
]

export function QuickActions() {
  const { membership } = useAuth()
  const send = canSend(membership?.role)
  return (
    <section className="rounded-2xl border border-line bg-white p-4 shadow-card">
      <h2 className="m-0 mb-3 text-base font-semibold text-ink">Quick actions</h2>
      <div className="grid gap-2">
        {ACTIONS.filter((item) => !item.needsSend || send).map((item) => {
          const Icon = item.icon
          return (
            <Link
              key={item.to}
              to={item.to}
              className={`inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold no-underline ${
                item.primary ? "bg-brand text-white" : "border border-line bg-white text-ink"
              }`}
            >
              <Icon size={16} aria-hidden="true" />
              {item.label}
            </Link>
          )
        })}
      </div>
    </section>
  )
}
