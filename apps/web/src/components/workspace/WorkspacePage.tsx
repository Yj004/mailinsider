import type { ReactNode } from "react"

/** Enterprise workspace shell: title, purpose, actions, optional toolbar, content. */
export function WorkspacePage({
  title,
  subtitle,
  kicker = "Workspace",
  actions,
  toolbar,
  children,
}: {
  title: string
  subtitle: string
  kicker?: string
  actions?: ReactNode
  toolbar?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="ws-page">
      <header className="ws-page-head">
        <div className="ws-page-copy">
          <p className="ws-kicker">{kicker}</p>
          <h1>{title}</h1>
          <p className="ws-sub">{subtitle}</p>
        </div>
        {actions ? <div className="ws-page-actions">{actions}</div> : null}
      </header>
      {toolbar ? <div className="ws-toolbar">{toolbar}</div> : null}
      <div className="ws-page-body">{children}</div>
    </div>
  )
}

export function WsEmpty({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="ws-empty">
      <h2>{title}</h2>
      <p>{body}</p>
      {action ? <div className="ws-empty-actions">{action}</div> : null}
    </div>
  )
}

export function WsCard({
  title,
  meta,
  children,
  footer,
}: {
  title?: string
  meta?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section className="ws-card">
      {title ? (
        <div className="ws-card-head">
          <h2>{title}</h2>
          {meta ? <div className="ws-card-meta">{meta}</div> : null}
        </div>
      ) : null}
      <div className="ws-card-body">{children}</div>
      {footer ? <div className="ws-card-foot">{footer}</div> : null}
    </section>
  )
}
