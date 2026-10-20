import { Link } from "react-router-dom"

export function UnavailablePage({ title, body, to, action }: { title: string; body: string; to?: string; action?: string }) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="sub">{body}</p>
        </div>
      </div>
      {to && action ? (
        <Link className="btn primary" to={to}>
          {action}
        </Link>
      ) : null}
    </div>
  )
}
