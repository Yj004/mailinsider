import { FormEvent, useState } from "react"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import type { SessionResponse } from "../types"

export function LoginPage() {
  const { user, setSession } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState("")
  if (user) return <Navigate to="/app/mail" replace />
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    const data = new FormData(event.currentTarget)
    try {
      const session = await api<SessionResponse>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
      })
      setSession(session)
      navigate("/app/mail")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in.")
    }
  }
  return (
    <AuthFrame>
      <h2>Sign in</h2>
      <p className="quiet">Pick up the messages you are waiting on.</p>
      <div className="banner" style={{ textAlign: "left" }}>
        <strong>Demo film account</strong>
        <div className="meta" style={{ marginTop: 4 }}>
          demo@mailinsider.app · DemoFilm2026!
        </div>
      </div>
      <form className="stack" onSubmit={onSubmit}>
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="username" defaultValue="demo@mailinsider.app" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input name="password" type="password" autoComplete="current-password" defaultValue="DemoFilm2026!" required />
        </label>
        {error ? <p className="error-text">{error}</p> : null}
        <button className="btn primary full" type="submit">
          Sign in
        </button>
        <div className="inline-links">
          <Link to="/signup">Create a workspace</Link>
          <Link to="/forgot">Forgot password</Link>
        </div>
      </form>
    </AuthFrame>
  )
}

export function SignupPage() {
  const { user, setSession } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState("")
  if (user) return <Navigate to="/app/mail" replace />
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    const data = new FormData(event.currentTarget)
    try {
      const session = await api<SessionResponse>("/api/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({
          display_name: data.get("display_name"),
          email: data.get("email"),
          password: data.get("password"),
          workspace_name: data.get("workspace_name"),
          open_tracking_default: data.get("tracking") === "on",
          link_tracking_default: data.get("tracking") === "on",
        }),
      })
      setSession(session)
      navigate("/app/mail")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the workspace.")
    }
  }
  return (
    <AuthFrame>
      <h2>Create your workspace</h2>
      <p className="quiet">For the team that sends the emails that matter. Not a blast tool.</p>
      <form className="stack" onSubmit={onSubmit}>
        <label className="field">
          <span>Your name</span>
          <input name="display_name" required maxLength={120} />
        </label>
        <label className="field">
          <span>Work email</span>
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input name="password" type="password" autoComplete="new-password" minLength={10} required />
          <span className="hint">At least 10 characters.</span>
        </label>
        <label className="field">
          <span>Workspace name</span>
          <input name="workspace_name" required minLength={2} maxLength={80} placeholder="Northwind success" />
        </label>
        <label className="check">
          <input name="tracking" type="checkbox" defaultChecked />
          <span>
            Enable engagement signals by default
            <span className="hint"> Opens and link requests. You can turn them off on any message.</span>
          </span>
        </label>
        {error ? <p className="error-text">{error}</p> : null}
        <button className="btn primary full" type="submit">
          Create workspace
        </button>
        <Link to="/login">I already have an account</Link>
      </form>
    </AuthFrame>
  )
}

export function ForgotPage() {
  const [message, setMessage] = useState("")
  const [token, setToken] = useState("")
  const [error, setError] = useState("")
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    const data = new FormData(event.currentTarget)
    try {
      const result = await api<{ message: string; reset_token?: string }>("/api/v1/auth/forgot", {
        method: "POST",
        body: JSON.stringify({ email: data.get("email") }),
      })
      setMessage(result.message)
      setToken(result.reset_token || "")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start a reset.")
    }
  }
  return (
    <AuthFrame>
      <h2>Reset password</h2>
      <p className="quiet">We will prepare a one-hour reset code for that email.</p>
      <form className="stack" onSubmit={onSubmit}>
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" required />
        </label>
        {error ? <p className="error-text">{error}</p> : null}
        {message ? <p>{message}</p> : null}
        {token ? (
          <p>
            Local reset code: <span className="mono">{token}</span>
          </p>
        ) : null}
        <button className="btn primary" type="submit">
          Send reset code
        </button>
        {token ? <Link to={`/reset?token=${encodeURIComponent(token)}`}>Choose a new password</Link> : <Link to="/login">Back to sign in</Link>}
      </form>
    </AuthFrame>
  )
}

export function ResetPage() {
  const [params] = useSearchParams()
  const { setSession } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState("")
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      const session = await api<SessionResponse>("/api/v1/auth/reset", {
        method: "POST",
        body: JSON.stringify({ token: data.get("token"), password: data.get("password") }),
      })
      setSession(session)
      navigate("/app/mail")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset the password.")
    }
  }
  return (
    <AuthFrame>
      <h2>Choose a new password</h2>
      <form className="stack" onSubmit={onSubmit}>
        <label className="field">
          <span>Reset code</span>
          <input name="token" defaultValue={params.get("token") || ""} required />
        </label>
        <label className="field">
          <span>New password</span>
          <input name="password" type="password" minLength={10} required />
        </label>
        {error ? <p className="error-text">{error}</p> : null}
        <button className="btn primary" type="submit">
          Update password
        </button>
      </form>
    </AuthFrame>
  )
}

function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-split">
      <section className="auth-story">
        <div>
          <div className="brand-lockup">
            <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
              <rect x="4" y="16" width="5" height="12" rx="1" fill="#aecbfa" />
              <rect x="13" y="10" width="5" height="18" rx="1" fill="#669df6" />
              <rect x="22" y="4" width="5" height="24" rx="1" fill="#0b57d0" />
            </svg>
            MailInsider
          </div>
          <h1>Know what happened after send.</h1>
          <p className="lede">Opens, link requests, and document views — on every conversation.</p>
          <ul className="principles">
            <li>
              <span aria-hidden="true">1</span>
              <span>
                <strong>Send from your Gmail</strong>
                The message comes from the account you connect. MailInsider does not read the mailbox.
              </span>
            </li>
            <li>
              <span aria-hidden="true">2</span>
              <span>
                <strong>Engagement on the thread</strong>
                Opens, links, and document views stay with the conversation.
              </span>
            </li>
            <li>
              <span aria-hidden="true">3</span>
              <span>
                <strong>One workspace, one boundary</strong>
                A team only sees the messages and documents that belong to it.
              </span>
            </li>
          </ul>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">{children}</div>
      </section>
    </div>
  )
}
