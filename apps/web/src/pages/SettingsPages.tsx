import { FormEvent, useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { SheetBrowser } from "../components/SheetBrowser"
import { WorkspacePage, WsCard } from "../components/workspace/WorkspacePage"
import { relativeTime } from "../labels"
import type { ConnectionsResponse, Membership, SheetsResponse } from "../types"
import { canAdmin, canSend } from "../types"

export function IntegrationsPage() {
  const { workspaceId, membership, toast } = useAuth()
  const [params] = useSearchParams()
  const [data, setData] = useState<ConnectionsResponse | null>(null)
  const [sheets, setSheets] = useState<SheetsResponse | null>(null)

  function load() {
    api<ConnectionsResponse>("/api/v1/integrations/gmail/connections")
      .then(setData)
      .catch((err) => toast(err instanceof ApiError ? err.message : "Could not load Gmail.", "bad"))
    api<SheetsResponse>("/api/v1/integrations/sheets/connections")
      .then(setSheets)
      .catch((err) => toast(err instanceof ApiError ? err.message : "Could not load Google Sheets.", "bad"))
  }

  function startGmailConnect() {
    api<{ authorization_url: string }>("/api/v1/integrations/gmail/connect")
      .then((result) => {
        window.location.href = result.authorization_url
      })
      .catch((err) => toast(err instanceof ApiError ? err.message : "Could not start Google sign-in.", "bad"))
  }

  useEffect(() => {
    load()
    const flag = params.get("gmail")
    const sheetFlag = params.get("sheets")
    if (flag === "connected") toast("Gmail connected. Reply sync is enabled.")
    else if (flag === "scope_missing")
      toast("Gmail connected, but mailbox read was not granted. Click Reconnect and allow See and download your mail.", "bad")
    else if (flag === "denied") toast("Google did not grant access. Nothing was connected.", "bad")
    else if (flag === "missing_refresh")
      toast(
        "Google did not return a refresh token. Remove MailInsider from https://myaccount.google.com/permissions then connect again.",
        "bad",
      )
    else if (flag === "failed") toast("Google signed in, but the account email could not be saved. Try Connect Gmail again.", "bad")
    else if (flag === "expired") toast("The Google sign-in link expired. Click Connect Gmail again.", "bad")
    else if (flag) toast("Gmail was not connected.", "bad")
    else if (sheetFlag === "pick") toast("Google account connected. Browse and attach any spreadsheet below.")
    else if (sheetFlag === "connected") toast("Google Sheets connected.")
    else if (sheetFlag === "no_access") toast("That account cannot open the sheet. Share the sheet, then connect again.", "bad")
    else if (sheetFlag) toast("Google Sheets was not connected.", "bad")
    // workspaceId reloads the connection list when the team switches workspaces.
  }, [workspaceId])

  const needsReconnect = Boolean(data?.needs_reconnect)
  const activeSheet = (sheets?.connections || []).find((item) => item.status === "connected")

  return (
    <WorkspacePage
      title="Integrations"
      subtitle="Connect Gmail for sending and replies, then attach any Google Sheet for logging and contact import."
    >
      {needsReconnect && canAdmin(membership?.role) ? (
        <div className="banner" style={{ marginBottom: 16 }}>
          <strong>Reconnect Gmail for replies.</strong> Your current connection can send mail but cannot read the
          thread. Click Reconnect, then allow <em>See and download your mail</em> (and send).
          <div className="actions" style={{ marginTop: 10, justifyContent: "flex-start" }}>
            <button className="btn primary" type="button" onClick={startGmailConnect}>
              Reconnect Gmail
            </button>
          </div>
        </div>
      ) : null}
      <WsCard title="Gmail" meta={data?.scope_reason}>
        <div className="stack">
        {(data?.connections || []).map((item) => (
          <div key={item.id} className="row-between">
            <div>
              <strong>{item.google_account_email}</strong>
              <div className="meta">
                {item.status}
                {item.is_demo ? " · Demo (no real Gmail send)" : ""}
                {item.status === "connected" && !item.is_demo
                  ? item.can_sync_replies
                    ? " · Reply sync on"
                    : " · Reply sync needs reconnect"
                  : ""}{" "}
                · {relativeTime(item.updated_at)}
              </div>
            </div>
            {item.status === "connected" && canAdmin(membership?.role) ? (
              <div className="actions" style={{ marginTop: 0 }}>
                {item.needs_reconnect && data?.oauth_configured ? (
                  <button className="btn primary small" type="button" onClick={startGmailConnect}>
                    Reconnect
                  </button>
                ) : null}
                <button
                  className="btn danger small"
                  onClick={() => {
                    api(`/api/v1/integrations/gmail/connections/${item.id}`, { method: "DELETE" })
                      .then(() => {
                        toast("Disconnected. Sending is blocked until you connect again.")
                        load()
                      })
                      .catch((err) => toast(err instanceof ApiError ? err.message : "Could not disconnect.", "bad"))
                  }}
                >
                  Disconnect
                </button>
              </div>
            ) : null}
          </div>
        ))}
        {data?.connections.length === 0 ? <p className="quiet">No Gmail account connected.</p> : null}
        {canAdmin(membership?.role) ? (
          <div className="stack">
            {!data?.oauth_configured ? (
              <p className="quiet">Connect Gmail uses the Gmail API after GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.</p>
            ) : null}
          <div className="actions" style={{ justifyContent: "flex-start" }}>
            {data?.oauth_configured ? (
              <button className="btn primary" type="button" onClick={startGmailConnect}>
                {needsReconnect ? "Reconnect Gmail" : "Connect Gmail"}
              </button>
            ) : null}
            {data?.demo_allowed ? (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  api("/api/v1/integrations/gmail/demo", { method: "POST" })
                    .then(() => {
                      toast("Demo Gmail is connected. Sends are marked as demo.")
                      load()
                    })
                    .catch((err) => toast(err instanceof ApiError ? err.message : "Could not start demo.", "bad"))
                }}
              >
                Use demo Gmail
              </button>
            ) : null}
          </div>
          </div>
        ) : (
          <p className="quiet">Owners and admins connect Gmail. Members can send through a connection that already exists.</p>
        )}
        </div>
      </WsCard>
      <WsCard
        title="Google Sheets"
        meta={sheets?.scope_reason}
        footer={
          sheets?.recent_rows?.length ? (
            <div>
              <h3>Recent send-log rows</h3>
              {sheets.recent_rows.map((item) => (
                <p className="meta" key={item.id}>
                  {(item.row || []).join(" · ")}
                  {item.demo ? " · demo" : ""}
                </p>
              ))}
            </div>
          ) : null
        }
      >
        {activeSheet ? (
          <div className="stack gap-4">
            <div className="row-between">
              <div>
                <strong>{activeSheet.google_account_email}</strong>
                <div className="meta">
                  {activeSheet.sheet_attached
                    ? `Attached · ${activeSheet.spreadsheet_title} · tab ${activeSheet.sheet_tab}`
                    : "Account connected · pick a spreadsheet below"}
                  {activeSheet.is_demo ? " · Local demo log" : ""} · {relativeTime(activeSheet.updated_at)}
                </div>
                {activeSheet.spreadsheet_url ? (
                  <div className="meta">
                    <a href={activeSheet.spreadsheet_url} target="_blank" rel="noreferrer">
                      Open attached sheet
                    </a>
                  </div>
                ) : null}
              </div>
              {canAdmin(membership?.role) ? (
                <button
                  className="btn danger small"
                  type="button"
                  onClick={() => {
                    api(`/api/v1/integrations/sheets/connections/${activeSheet.id}`, { method: "DELETE" })
                      .then(() => {
                        toast("Google Sheets disconnected.")
                        load()
                      })
                      .catch((err) => toast(err instanceof ApiError ? err.message : "Could not disconnect.", "bad"))
                  }}
                >
                  Disconnect
                </button>
              ) : null}
            </div>
            {!activeSheet.is_demo ? <SheetBrowser connection={activeSheet} onAttached={load} /> : null}
          </div>
        ) : (
          <div className="stack">
            <p className="quiet">No Google account connected for Sheets in this workspace.</p>
            {canAdmin(membership?.role) ? (
              <div className="actions" style={{ justifyContent: "flex-start" }}>
                {!sheets?.oauth_configured ? (
                  <p className="quiet">Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, enable Sheets + Drive APIs, then connect.</p>
                ) : (
                  <button
                    className="btn primary"
                    type="button"
                    onClick={() => {
                      api<{ authorization_url: string }>("/api/v1/integrations/sheets/connect", { method: "POST" })
                        .then((result) => {
                          window.location.href = result.authorization_url
                        })
                        .catch((err) => toast(err instanceof ApiError ? err.message : "Could not start Google sign-in.", "bad"))
                    }}
                  >
                    Connect Google account
                  </button>
                )}
                {sheets?.demo_allowed ? (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      api("/api/v1/integrations/sheets/demo", { method: "POST" })
                        .then(() => {
                          toast("Demo sheet log is on for this workspace.")
                          load()
                        })
                        .catch((err) => toast(err instanceof ApiError ? err.message : "Could not start the demo log.", "bad"))
                    }}
                  >
                    Use demo sheet log
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="quiet">Owners and admins connect Sheets for this workspace.</p>
            )}
          </div>
        )}
      </WsCard>
    </WorkspacePage>
  )
}

export function TeamPage() {
  const { workspaceId, membership, toast } = useAuth()
  const [members, setMembers] = useState<{ user_id: string; email: string; display_name: string; role: string }[]>([])
  const [invites, setInvites] = useState<{ id: string; email: string; role: string }[]>([])

  function load() {
    api<{ members: typeof members; invites: typeof invites }>("/api/v1/workspaces/current/members").then((data) => {
      setMembers(data.members)
      setInvites(data.invites)
    })
  }
  useEffect(() => {
    load()
  }, [workspaceId])

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await api("/api/v1/workspaces/current/members", {
        method: "POST",
        body: JSON.stringify({ email: data.get("email"), role: data.get("role") }),
      })
      toast("Invitation saved. If they already have an account, they are in the workspace now.")
      event.currentTarget.reset()
      load()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not invite.", "bad")
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <p className="sub">Viewers can read timelines. Members can send. Owners and admins manage the workspace.</p>
        </div>
      </div>
      <section className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.user_id}>
                <td>
                  {member.display_name}
                  <div className="meta">{member.email}</div>
                </td>
                <td>{member.role}</td>
                <td>
                  {canAdmin(membership?.role) && member.role !== "owner" ? (
                    <button
                      className="btn small ghost"
                      onClick={() => {
                        api(`/api/v1/workspaces/current/members/${member.user_id}`, { method: "DELETE" })
                          .then(load)
                          .catch((err) => toast(err instanceof ApiError ? err.message : "Could not remove.", "bad"))
                      }}
                    >
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {invites.length ? (
          <p className="meta">Waiting to join: {invites.map((item) => `${item.email} (${item.role})`).join(", ")}</p>
        ) : null}
        {canAdmin(membership?.role) ? (
          <form className="stack" onSubmit={invite} style={{ marginTop: 16 }}>
            <label className="field">
              <span>Email</span>
              <input name="email" type="email" required />
            </label>
            <label className="field">
              <span>Role</span>
              <select name="role" defaultValue="member">
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </select>
            </label>
            <button className="btn primary" type="submit">
              Add to workspace
            </button>
          </form>
        ) : null}
      </section>
    </div>
  )
}

export function AuditPage() {
  const { workspaceId, membership } = useAuth()
  const [entries, setEntries] = useState<{ id: string; action: string; created_at: string; metadata: Record<string, unknown> }[]>([])
  const [error, setError] = useState("")
  useEffect(() => {
    if (!canAdmin(membership?.role)) {
      setError("Audit history is visible to owners and admins.")
      return
    }
    api<{ entries: typeof entries }>("/api/v1/workspaces/current/audit")
      .then((data) => setEntries(data.entries))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the audit log."))
  }, [workspaceId, membership?.role])
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Audit</h1>
          <p className="sub">Append-only for people using the product. Connect, send, revoke, export, and membership changes land here.</p>
        </div>
      </div>
      {error ? <div className="banner">{error}</div> : null}
      <div className="list">
        {entries.map((entry) => (
          <div key={entry.id} className="msg-row">
            <div>
              <div className="subject">{entry.action.replaceAll("_", " ")}</div>
              <div className="meta">{JSON.stringify(entry.metadata)}</div>
            </div>
            <div />
            <div />
            <div className="meta">{relativeTime(entry.created_at)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function SettingsPage() {
  const { user, membership, refresh, toast, logout } = useAuth()
  const [name, setName] = useState(user?.display_name || "")
  const [workspace, setWorkspace] = useState(membership?.name || "")
  const [openTracking, setOpenTracking] = useState(membership?.open_tracking_default ?? true)
  const [linkTracking, setLinkTracking] = useState(membership?.link_tracking_default ?? true)
  const [retention, setRetention] = useState(membership?.retention_days || 365)

  useEffect(() => {
    setName(user?.display_name || "")
    setWorkspace(membership?.name || "")
    setOpenTracking(membership?.open_tracking_default ?? true)
    setLinkTracking(membership?.link_tracking_default ?? true)
    setRetention(membership?.retention_days || 365)
  }, [user, membership])

  return (
    <WorkspacePage
      title="Settings"
      subtitle="Defaults apply to the next compose. They do not rewrite messages already sent."
      actions={
        <Link className="btn" to="/app/integrations">
          Integrations
        </Link>
      }
    >
      <div className="ws-split">
      <WsCard title="You" meta={user?.email}>
        <div className="stack">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button
          className="btn"
          onClick={() => {
            api("/api/v1/auth/me", { method: "PATCH", body: JSON.stringify({ display_name: name }) })
              .then(() => {
                toast("Name updated.")
                refresh()
              })
              .catch((err) => toast(err instanceof ApiError ? err.message : "Could not update.", "bad"))
          }}
        >
          Save name
        </button>
        <PasswordForm />
        </div>
      </WsCard>
      <WsCard title="Workspace" meta={membership?.name}>
        <div className="stack">
        <label className="field">
          <span>Workspace name</span>
          <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} disabled={!canAdmin(membership?.role)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={openTracking} disabled={!canAdmin(membership?.role)} onChange={(event) => setOpenTracking(event.target.checked)} />
          <span>Open tracking on by default</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={linkTracking} disabled={!canAdmin(membership?.role)} onChange={(event) => setLinkTracking(event.target.checked)} />
          <span>Link requests on by default</span>
        </label>
        <label className="field">
          <span>Keep activity events for</span>
          <select value={retention} disabled={!canAdmin(membership?.role)} onChange={(event) => setRetention(Number(event.target.value))}>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>365 days</option>
            <option value={730}>730 days</option>
          </select>
          <span className="hint">Older tracking events are deleted. Messages you sent stay.</span>
        </label>
        {canAdmin(membership?.role) ? (
          <button
            className="btn"
            onClick={() => {
              api<Membership>("/api/v1/workspaces/current", {
                method: "PATCH",
                body: JSON.stringify({
                  name: workspace,
                  open_tracking_default: openTracking,
                  link_tracking_default: linkTracking,
                  retention_days: retention,
                }),
              })
                .then(() => {
                  toast("Workspace settings saved.")
                  refresh()
                })
                .catch((err) => toast(err instanceof ApiError ? err.message : "Could not save.", "bad"))
            }}
          >
            Save workspace
          </button>
        ) : null}
        <div className="actions" style={{ justifyContent: "flex-start" }}>
          {canAdmin(membership?.role) ? (
            <button
              className="btn"
              onClick={() => {
                api<unknown>("/api/v1/workspaces/current/export").then((data) => {
                  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
                  const url = URL.createObjectURL(blob)
                  const anchor = document.createElement("a")
                  anchor.href = url
                  anchor.download = "mailinsider-export.json"
                  anchor.click()
                  URL.revokeObjectURL(url)
                })
              }}
            >
              Export workspace JSON
            </button>
          ) : null}
          {canSend(membership?.role) ? (
            <>
              <button
                className="btn"
                onClick={() => {
                  api("/api/v1/workspaces/current/sample", { method: "POST" })
                    .then(() => toast("Sample conversations loaded."))
                    .catch((err) => toast(err instanceof ApiError ? err.message : "Could not load samples.", "bad"))
                }}
              >
                Load sample messages
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  api("/api/v1/workspaces/current/sample", { method: "DELETE" })
                    .then(() => toast("Sample messages removed."))
                    .catch((err) => toast(err instanceof ApiError ? err.message : "Could not clear samples.", "bad"))
                }}
              >
                Remove sample messages
              </button>
            </>
          ) : null}
        </div>
        </div>
      </WsCard>
      </div>
      <WsCard title="Delete account" meta="Irreversible if you are the only member.">
        <p className="quiet">If you are the only member, the workspace and its messages go with you. Type DELETE to confirm.</p>
        <DeleteForm onDone={logout} />
      </WsCard>
    </WorkspacePage>
  )
}

function PasswordForm() {
  const { toast } = useAuth()
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await api("/api/v1/auth/password", {
        method: "POST",
        body: JSON.stringify({ current_password: data.get("current"), new_password: data.get("next") }),
      })
      toast("Password updated.")
      event.currentTarget.reset()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not change the password.", "bad")
    }
  }
  return (
    <form className="stack" onSubmit={onSubmit}>
      <label className="field">
        <span>Current password</span>
        <input name="current" type="password" required />
      </label>
      <label className="field">
        <span>New password</span>
        <input name="next" type="password" minLength={10} required />
      </label>
      <button className="btn" type="submit">
        Change password
      </button>
    </form>
  )
}

function DeleteForm({ onDone }: { onDone: () => void }) {
  const { toast } = useAuth()
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await api("/api/v1/auth/delete", {
        method: "POST",
        body: JSON.stringify({ password: data.get("password"), confirm: data.get("confirm") }),
      })
      onDone()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not delete the account.", "bad")
    }
  }
  return (
    <form className="stack" onSubmit={onSubmit}>
      <label className="field">
        <span>Password</span>
        <input name="password" type="password" required />
      </label>
      <label className="field">
        <span>Type DELETE</span>
        <input name="confirm" required />
      </label>
      <button className="btn danger" type="submit">
        Delete account
      </button>
    </form>
  )
}
