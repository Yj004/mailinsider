import { FormEvent, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { api, ApiError } from "../../api"

export function WaitlistPage() {
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle")
  const [error, setError] = useState("")

  useEffect(() => {
    document.title = "Waitlist — MailInsider"
  }, [])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatus("loading")
    setError("")
    const data = new FormData(event.currentTarget)
    try {
      await api<{ ok: boolean }>("/api/v1/public/waitlist", {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          company_name: data.get("company_name"),
          email: data.get("email"),
          monthly_sends: Number(data.get("monthly_sends")),
          willing_to_pay: data.get("willing_to_pay"),
          website: data.get("website"),
        }),
      })
      setStatus("ok")
      event.currentTarget.reset()
    } catch (err) {
      setStatus("error")
      setError(err instanceof ApiError ? err.message : "Could not join the waitlist. Try again.")
    }
  }

  return (
    <div className="bg-[#f5f5f7] px-5 py-16">
      <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[0.95fr_1.05fr]">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-[#1a73e8]/70">Private preview</p>
          <h1 className="font-display mt-2 text-4xl font-semibold text-ink">Join the waitlist</h1>
          <p className="mt-3 text-slate-600">
            MailInsider is invite-only while we finish production. Tell us how you send, including follow-ups, and what
            you’d pay for a Gmail-native client with opens, links, docs, and AI grounded in your own files.
          </p>
          <ul className="mt-6 grid gap-2 text-sm text-slate-600">
            <li>No public sign-up — we review each request.</li>
            <li>Monthly volume should include follow-ups, not only first-touch sends.</li>
            <li>
              Already approved?{" "}
              <Link className="text-[#0b57d0] no-underline hover:underline" to="/login">
                Sign in
              </Link>
              .
            </li>
          </ul>
        </div>
        <form className="rounded-3xl border border-line bg-white p-6 shadow-sm sm:p-8" onSubmit={onSubmit}>
          <label className="field">
            <span>Name</span>
            <input name="name" required maxLength={200} autoComplete="name" />
          </label>
          <label className="field">
            <span>Company name (optional)</span>
            <input name="company_name" maxLength={200} autoComplete="organization" />
          </label>
          <label className="field">
            <span>Work or company email</span>
            <input name="email" type="email" required maxLength={320} autoComplete="email" />
          </label>
          <label className="field">
            <span>Monthly emails (including follow-ups)</span>
            <input name="monthly_sends" type="number" required min={1} max={10000000} placeholder="1000" />
            <span className="hint">Example: 1,000 messages a month across first sends and follow-ups.</span>
          </label>
          <label className="field">
            <span>What would you pay?</span>
            <input name="willing_to_pay" required maxLength={80} placeholder="$29 / month" />
            <span className="hint">A number you’re comfortable with for this product.</span>
          </label>
          <label className="sr" aria-hidden="true">
            Website
            <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
          {status === "ok" ? (
            <p className="banner good">You’re on the list. We’ll email you when a workspace is ready.</p>
          ) : null}
          {status === "error" ? <p className="banner bad">{error}</p> : null}
          <button className="mi-btn mi-btn-primary mt-2" type="submit" disabled={status === "loading"}>
            {status === "loading" ? "Joining…" : "Join waitlist"}
          </button>
        </form>
      </div>
    </div>
  )
}
