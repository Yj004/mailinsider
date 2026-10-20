import { FormEvent, useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { api, ApiError } from "../../api"

export function ContactPage() {
  const [params] = useSearchParams()
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle")
  const [error, setError] = useState("")

  useEffect(() => {
    document.title = "Contact — MailInsider"
  }, [])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatus("loading")
    setError("")
    const data = new FormData(event.currentTarget)
    try {
      await api<{ ok: boolean }>("/api/v1/public/contact", {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          email: data.get("email"),
          subject: data.get("subject"),
          message: data.get("message"),
          website: data.get("website"),
        }),
      })
      setStatus("ok")
      event.currentTarget.reset()
    } catch (err) {
      setStatus("error")
      setError(err instanceof ApiError ? err.message : "Could not send your message. Try again.")
    }
  }

  return (
    <div className="bg-[#f6f8fc] px-5 py-16">
      <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-[#1a73e8]/70">Contact</p>
          <h1 className="font-display mt-2 text-4xl font-semibold text-ink">Talk to us</h1>
          <p className="mt-3 text-slate-600">
            Questions about Gmail limits, Pro volume, or how tracking works — send a note. We store inquiries in
            MailInsider; this is not a fake success toast.
          </p>
        </div>
        <form className="rounded-3xl border border-line bg-white p-6 shadow-sm sm:p-8" onSubmit={onSubmit}>
          <label className="field">
            <span>Name</span>
            <input name="name" required maxLength={200} autoComplete="name" />
          </label>
          <label className="field">
            <span>Email</span>
            <input name="email" type="email" required maxLength={320} autoComplete="email" />
          </label>
          <label className="field">
            <span>Subject</span>
            <input name="subject" required maxLength={300} defaultValue={params.get("subject") || ""} />
          </label>
          <label className="field">
            <span>Message</span>
            <textarea name="message" required rows={6} maxLength={5000} />
          </label>
          {/* Honeypot */}
          <label className="sr" aria-hidden="true">
            Website
            <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
          {status === "ok" ? <p className="banner good">Message received. We’ll get back to you by email.</p> : null}
          {status === "error" ? <p className="banner bad">{error}</p> : null}
          <button className="mi-btn mi-btn-primary mt-2" type="submit" disabled={status === "loading"}>
            {status === "loading" ? "Sending…" : "Send message"}
          </button>
        </form>
      </div>
    </div>
  )
}
