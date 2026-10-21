import { Link } from "react-router-dom"
import { ArrowRight, FileText, Link2, Mail, Paperclip, ShieldCheck, Sparkles } from "lucide-react"
import { useEffect } from "react"
import { BrandLockup } from "../../components/BrandMark"

export function HomePage() {
  useEffect(() => {
    document.title = "MailInsider — Email with engagement intelligence"
  }, [])

  return (
    <>
      <section className="relative overflow-hidden bg-[#f5f5f7]">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 70% 50% at 80% 0%, rgba(26,115,232,0.12), transparent 55%), radial-gradient(ellipse 40% 35% at 10% 90%, rgba(194,231,255,0.5), transparent 50%)",
          }}
        />
        <div className="relative mx-auto grid max-w-6xl gap-12 px-5 pb-20 pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:pb-24 lg:pt-16">
          <div className="mi-fade-up">
            <BrandLockup to="/" size={72} hero />
            <h1 className="mt-5 max-w-xl text-2xl font-medium leading-snug text-[#3c4043] sm:text-3xl">
              Send outreach that still feels human — then see what happened after.
            </h1>
            <p className="mt-4 max-w-lg text-base leading-relaxed text-[#5f6368]">
              Connect Gmail, write personal cold emails with PDFs, and track opens, link clicks, and document views —
              then reply in the same thread.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link className="mi-btn mi-btn-compose mi-btn-lg" to="/waitlist">
                Join the waitlist
                <ArrowRight size={16} aria-hidden />
              </Link>
              <Link className="mi-btn mi-btn-ghost mi-btn-lg" to="/product-video">
                Watch product film
              </Link>
            </div>
          </div>
          <div className="mi-fade-up mi-fade-delay relative">
            <ProductPreview />
          </div>
        </div>
      </section>

      <section className="bg-white px-5 py-20">
        <div className="mx-auto max-w-6xl">
          <p className="text-sm font-semibold uppercase tracking-wider text-[#1a73e8]">Built for outreach</p>
          <h2 className="font-display mt-2 max-w-2xl text-3xl font-semibold text-[#202124]">
            One client for sending, attaching, and reading engagement.
          </h2>
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: Mail,
                title: "Gmail-native sending",
                body: "Send through your connected Google account. Acceptance is recorded honestly — never confused with inbox delivery.",
              },
              {
                icon: Sparkles,
                title: "Open tracking",
                body: "See when your message was opened — alongside link clicks and document views on the same conversation.",
              },
              {
                icon: Link2,
                title: "Link & document views",
                body: "Tracked links and hosted document viewers show who requested what, with timestamps you can trust.",
              },
              {
                icon: Paperclip,
                title: "PDF attachments",
                body: "Attach a PDF to the MIME message and/or share a tracked viewing link in the body.",
              },
              {
                icon: FileText,
                title: "Personal correspondence",
                body: "One-to-one sends stay clean — no forced unsubscribe footers or marketing chrome on ordinary outreach.",
              },
              {
                icon: ShieldCheck,
                title: "Workspace security",
                body: "JWT auth, hashed tracking tokens, encrypted refresh tokens, and tenant isolation on every request.",
              },
            ].map((item) => (
              <article key={item.title} className="rounded-2xl border border-black/5 bg-white/80 p-6 shadow-[0_8px_24px_rgba(0,0,0,0.04)]">
                <item.icon className="text-[#1a73e8]" size={22} aria-hidden />
                <h3 className="mt-4 text-lg font-semibold text-[#202124]">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#5f6368]">{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-[#f5f5f7] px-5 py-20">
        <div className="mx-auto max-w-6xl">
          <p className="text-sm font-semibold uppercase tracking-wider text-[#1a73e8]">How it works</p>
          <h2 className="font-display mt-2 text-3xl font-semibold text-[#202124]">Three steps from draft to signal</h2>
          <ol className="mt-12 grid gap-6 md:grid-cols-3">
            {[
              { n: "01", t: "Connect Gmail", d: "OAuth to send mail and sync replies from the same thread." },
              { n: "02", t: "Compose & send", d: "Write naturally, attach a PDF, toggle open and link tracking." },
              { n: "03", t: "Watch Sent", d: "Opens, clicks, replies, and follow-ups live on the conversation." },
            ].map((step) => (
              <li key={step.n} className="relative rounded-2xl border border-[#e0e3e7] bg-white p-6 shadow-sm">
                <span className="font-display text-sm font-semibold text-[#0b57d0]">{step.n}</span>
                <h3 className="mt-3 text-lg font-semibold text-[#202124]">{step.t}</h3>
                <p className="mt-2 text-sm text-[#5f6368]">{step.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="bg-[#e8f0fe] px-5 py-20">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <div>
            <h2 className="font-display text-3xl font-semibold text-[#041e49]">Simple pricing for serious outreach</h2>
            <p className="mt-3 max-w-xl text-[#174ea6]">
              Start free while you validate the workflow. Upgrade when your daily volume needs a higher send ceiling.
            </p>
          </div>
          <Link className="mi-btn mi-btn-primary mi-btn-lg" to="/pricing">
            View pricing
          </Link>
        </div>
      </section>

      <section className="bg-white px-5 py-20">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-display text-3xl font-semibold text-[#202124]">Ready to see what happens after you hit send?</h2>
          <p className="mt-3 text-[#5f6368]">Join the waitlist — we’ll open workspaces as we review volume and pricing.</p>
          <Link className="mi-btn mi-btn-compose mi-btn-lg mt-8 inline-flex" to="/waitlist">
            Join the waitlist
          </Link>
        </div>
      </section>
    </>
  )
}

function ProductPreview() {
  return (
    <div className="mi-preview overflow-hidden rounded-2xl border border-[#dadce0] bg-white shadow-[0_1px_3px_rgba(60,64,67,.3),0_4px_8px_3px_rgba(60,64,67,.15)]">
      <div className="flex items-center gap-2 border-b border-[#e0e3e7] bg-white px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ea4335]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#fbbc04]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#34a853]" />
        <span className="ml-3 text-xs text-[#5f6368]">Sent · MailInsider</span>
      </div>
      <div className="grid grid-cols-[88px_1fr] sm:grid-cols-[128px_1fr]">
        <aside className="border-r border-[#e0e3e7] bg-[#f6f8fc] p-3 text-[11px] text-[#5f6368]">
          <div className="mb-3 rounded-2xl bg-[#c2e7ff] px-2 py-2 text-center font-semibold text-[#001d35]">Compose</div>
          <div className="space-y-1 px-1">
            <div className="rounded-r-full bg-[#d3e3fd] px-2 py-1 font-semibold text-[#041e49]">Sent</div>
            <div className="px-2 py-1">Drafts</div>
            <div className="px-2 py-1">Insights</div>
          </div>
        </aside>
        <div className="bg-white p-2">
          {[
            { who: "Priya N.", sub: "Product designer intro", st: "Opened · 2h", tone: "text-[#137333] bg-[#e6f4ea]" },
            { who: "Marcus L.", sub: "Resume + case study PDF", st: "Link clicked", tone: "text-[#1967d2] bg-[#e8f0fe]" },
            { who: "Hiring @ Northwind", sub: "Following up on Thursday", st: "Sent", tone: "text-[#5f6368] bg-[#f1f3f4]" },
          ].map((row) => (
            <div key={row.sub} className="flex items-center justify-between gap-3 border-b border-[#f1f3f4] px-2 py-2.5 text-sm hover:bg-[#f2f6fc]">
              <div className="min-w-0">
                <div className="truncate font-medium text-[#202124]">{row.who}</div>
                <div className="truncate text-xs text-[#5f6368]">{row.sub}</div>
              </div>
              <div className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${row.tone}`}>{row.st}</div>
            </div>
          ))}
          <div className="mt-2 rounded-xl border border-[#d3e3fd] bg-[#e8f0fe] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[#174ea6]">Activity</div>
            <p className="mt-1 text-xs text-[#041e49]">Document viewed · brief.pdf · just now</p>
          </div>
        </div>
      </div>
    </div>
  )
}
