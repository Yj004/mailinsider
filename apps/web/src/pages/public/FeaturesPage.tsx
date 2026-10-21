import { Link } from "react-router-dom"
import { useEffect } from "react"

export function FeaturesPage() {
  useEffect(() => {
    document.title = "Features — MailInsider"
  }, [])

  const sections = [
    {
      title: "Compose like email, track like a product",
      body: "Write To / Cc / Bcc, attach PDFs, and toggle open and link tracking per send. Ordinary one-to-one mail stays free of newsletter footers.",
    },
    {
      title: "Sent folder with live engagement",
      body: "Each sent message shows opens, link requests, and document views on the conversation.",
    },
    {
      title: "Insights without leaving the client",
      body: "A dedicated Insights view aggregates sends, unique opens, clicks, and document views over selectable date ranges.",
    },
    {
      title: "CRM when you need it",
      body: "Contacts, pipeline status, follow-ups, templates, and campaigns stay available for job-search and sales workflows.",
    },
  ]

  return (
    <div className="bg-[#f5f5f7] px-5 py-16">
      <div className="mx-auto max-w-6xl">
        <p className="text-sm font-semibold uppercase tracking-wider text-[#1a73e8]/70">Features</p>
        <h1 className="font-display mt-2 text-4xl font-semibold text-ink">What MailInsider actually does</h1>
        <p className="mt-3 max-w-2xl text-slate-600">
          MailInsider is an outbound email client with engagement intelligence. Recipient replies sync from the Gmail
          thread into the conversation view — not a full inbox mirror.
        </p>
        <div className="mt-12 grid gap-6 md:grid-cols-2">
          {sections.map((s) => (
            <article key={s.title} className="rounded-2xl border border-line bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-ink">{s.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.body}</p>
            </article>
          ))}
        </div>
        <div className="mt-12">
          <Link className="mi-btn mi-btn-primary" to="/waitlist">
            Join the waitlist
          </Link>
        </div>
      </div>
    </div>
  )
}
