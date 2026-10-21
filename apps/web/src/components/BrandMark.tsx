import { useId } from "react"
import { Link } from "react-router-dom"

export function BrandWord() {
  return (
    <span className="mi-brand-word">
      Mail<span className="mi-brand-insider">Insider</span>
    </span>
  )
}

/** Glass squircle, folded envelope, overlapping insight disc. */
export function BrandMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  const uid = useId().replace(/:/g, "")
  const glass = `mi-glass-${uid}`
  const flap = `mi-flap-${uid}`
  const body = `mi-body-${uid}`
  const fold = `mi-fold-${uid}`
  const disc = `mi-disc-${uid}`

  return (
    <svg
      className={className}
      width={size}
      height={Math.round(size * 0.9)}
      viewBox="0 0 40 36"
      aria-hidden
    >
      <defs>
        <linearGradient id={glass} x1="2" y1="2" x2="22" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#e8eef8" />
        </linearGradient>
        <linearGradient id={flap} x1="8" y1="6" x2="26" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#9ae2ff" />
          <stop offset="42%" stopColor="#2ea7ff" />
          <stop offset="100%" stopColor="#0050d4" />
        </linearGradient>
        <linearGradient id={body} x1="8" y1="14" x2="26" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4db8ff" />
          <stop offset="55%" stopColor="#0a7aff" />
          <stop offset="100%" stopColor="#0037b8" />
        </linearGradient>
        <linearGradient id={fold} x1="6" y1="22" x2="20" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#d7f2ff" />
          <stop offset="100%" stopColor="#7ecfff" />
        </linearGradient>
        <linearGradient id={disc} x1="22" y1="20" x2="36" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#5ac8fa" />
          <stop offset="48%" stopColor="#0a84ff" />
          <stop offset="100%" stopColor="#0040c8" />
        </linearGradient>
      </defs>

      <rect x="1.8" y="1.6" width="27.6" height="27.6" rx="7.8" fill={`url(#${glass})`} />

      <path
        fill={`url(#${body})`}
        d="M7.15 13.35 16 20.15 24.85 13.35v9.05c0 1.22-1 2.22-2.22 2.22H9.37c-1.22 0-2.22-1-2.22-2.22Z"
      />
      <path
        fill={`url(#${flap})`}
        d="M7.15 13.2 16 6.55c.52-.38 1.22-.38 1.74 0l8.11 6.65c.48.35.48.98 0 1.33L16.87 19.7c-.52.38-1.22.38-1.74 0L7.15 14.53c-.48-.35-.48-.98 0-1.33Z"
      />
      <path
        fill={`url(#${fold})`}
        fillOpacity=".7"
        d="M7.15 21.9 15.4 15.55 9.05 24.62H9.37c-1.22 0-2.22-1-2.22-2.22Z"
      />

      <path
        fill={`url(#${disc})`}
        fillRule="evenodd"
        d="M29.15 20.05a8.15 8.15 0 1 1 0 16.3 8.15 8.15 0 0 1 0-16.3Zm0 4.85a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6Z"
      />
    </svg>
  )
}

export function BrandLockup({
  to,
  size = 32,
  word = true,
  hero = false,
}: {
  to: string
  size?: number
  word?: boolean
  hero?: boolean
}) {
  return (
    <Link to={to} className={`mi-brand${hero ? " mi-brand-hero" : ""}`} aria-label="MailInsider">
      <BrandMark size={size} />
      {word ? <BrandWord /> : null}
    </Link>
  )
}
