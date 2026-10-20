import type { ReactNode } from "react"
import type { Signal } from "../types"
import { SIGNAL_LABEL } from "../labels"

export function Pill({ signal, children }: { signal?: Signal | "neutral" | "bad" | "info"; children: ReactNode }) {
  const tone =
    signal === "open_detected" || signal === "possible_automated"
      ? "amber"
      : signal === "link_clicked" || signal === "document_viewed"
        ? "good"
        : signal === "bad"
          ? "bad"
          : signal === "info"
            ? "info"
            : ""
  const mark =
    signal === "possible_automated" ? "?" : signal === "no_activity" ? "–" : signal === "bad" ? "!" : "•"
  return (
    <span className={`pill ${tone}`}>
      <i aria-hidden="true">{mark}</i>
      {children}
    </span>
  )
}

export function SignalPill({ signal }: { signal: Signal }) {
  return <Pill signal={signal}>{SIGNAL_LABEL[signal]}</Pill>
}

export function SignalGuide() {
  return (
    <details className="guide card">
      <summary>How to read a signal</summary>
      <dl>
        <div>
          <dt>Accepted by Gmail</dt>
          <dd>Google accepted the send. That is not the same as reaching the inbox.</dd>
        </div>
        <div>
          <dt>Opened</dt>
          <dd>The message was opened.</dd>
        </div>
        <div>
          <dt>Link requested</dt>
          <dd>A tracked link in the message was opened.</dd>
        </div>
        <div>
          <dt>Document viewed</dt>
          <dd>The attached or linked document was viewed.</dd>
        </div>
        <div>
          <dt>Possible automated request</dt>
          <dd>Burst traffic was filtered out of unique counts.</dd>
        </div>
        <div>
          <dt>No activity detected</dt>
          <dd>No open, link, or document activity yet.</dd>
        </div>
      </dl>
    </details>
  )
}

export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <div className="dialog-back" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  body,
  children,
}: {
  title: string
  body: string
  children?: ReactNode
}) {
  return (
    <div className="empty card">
      <h2>{title}</h2>
      <p className="quiet">{body}</p>
      {children ? <div className="actions">{children}</div> : null}
    </div>
  )
}
