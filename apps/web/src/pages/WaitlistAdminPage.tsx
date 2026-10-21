import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../api"
import { useAuth } from "../auth"
import { WorkspacePage, WsCard } from "../components/workspace/WorkspacePage"
import { relativeTime } from "../labels"

type Signup = {
  id: string
  name: string
  company_name: string | null
  email: string
  monthly_sends: number
  willing_to_pay: string
  created_at: string
}

export function WaitlistAdminPage() {
  const { workspaceId } = useAuth()
  const query = useQuery({
    queryKey: ["waitlist", workspaceId],
    queryFn: () => api<{ signups: Signup[] }>("/api/v1/waitlist"),
  })

  useEffect(() => {
    document.title = "Waitlist — MailInsider"
  }, [])

  const rows = query.data?.signups || []

  return (
    <WorkspacePage
      title="Waitlist"
      subtitle="People who asked for access — volume includes follow-ups, plus what they’d pay."
    >
      <WsCard title={`${rows.length} request${rows.length === 1 ? "" : "s"}`}>
        {query.isLoading ? <p className="quiet">Loading waitlist…</p> : null}
        {query.isError ? <p className="error-text">Could not load the waitlist.</p> : null}
        {!query.isLoading && rows.length === 0 ? <p className="quiet">No waitlist requests yet.</p> : null}
        {rows.length ? (
          <div className="stack" style={{ gap: 12 }}>
            {rows.map((row) => (
              <div key={row.id} className="row-between" style={{ alignItems: "flex-start" }}>
                <div>
                  <strong>{row.name}</strong>
                  {row.company_name ? <span className="quiet"> · {row.company_name}</span> : null}
                  <div className="meta">{row.email}</div>
                  <div className="meta">
                    {row.monthly_sends.toLocaleString()} emails / month · would pay {row.willing_to_pay}
                  </div>
                </div>
                <div className="meta">{relativeTime(row.created_at)}</div>
              </div>
            ))}
          </div>
        ) : null}
      </WsCard>
    </WorkspacePage>
  )
}
