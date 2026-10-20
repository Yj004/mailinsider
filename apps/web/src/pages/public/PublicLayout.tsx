import { Link, NavLink, Outlet } from "react-router-dom"
import { Mail } from "lucide-react"
import { useAuth } from "../../auth"

const NAV = [
  { to: "/features", label: "Features" },
  { to: "/product-video", label: "Product film" },
  { to: "/pricing", label: "Pricing" },
  { to: "/contact", label: "Contact" },
]

export function PublicLayout() {
  const { user } = useAuth()
  return (
    <div className="mi-public min-h-screen text-ink">
      <header className="mi-public-nav sticky top-0 z-40 border-b border-[#e0e3e7] bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
          <Link to="/" className="flex items-center gap-2.5 text-[#202124] no-underline">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-[#c2e7ff] text-[#001d35]">
              <Mail size={18} aria-hidden />
            </span>
            <span className="font-display text-lg font-semibold tracking-tight">
              Mail<span className="text-[#ea4335]">I</span>
              <span className="text-[#fbbc04]">n</span>
              <span className="text-[#34a853]">s</span>
              <span className="text-[#4285f4]">ider</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-6 md:flex" aria-label="Marketing">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `text-sm no-underline transition ${isActive ? "font-semibold text-[#0b57d0]" : "text-[#5f6368] hover:text-[#202124]"}`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {user ? (
              <Link className="mi-btn mi-btn-primary" to="/app/mail">
                Open mail
              </Link>
            ) : (
              <>
                <Link className="hidden text-sm text-[#5f6368] no-underline hover:text-[#0b57d0] sm:inline" to="/login">
                  Sign in
                </Link>
                <Link className="mi-btn mi-btn-compose" to="/signup">
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </header>
      <Outlet />
      <footer className="border-t border-[#e0e3e7] bg-white text-[#5f6368]">
        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <div className="font-display text-lg font-semibold text-[#202124]">MailInsider</div>
            <p className="mt-2 max-w-sm text-sm leading-relaxed">
              A Gmail-native outreach client with engagement intelligence — send, track, and reply in one place.
            </p>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-[#80868b]">Product</div>
            <div className="mt-3 grid gap-2 text-sm">
              <Link className="text-[#5f6368] no-underline hover:text-[#0b57d0]" to="/features">
                Features
              </Link>
              <Link className="text-[#5f6368] no-underline hover:text-[#0b57d0]" to="/pricing">
                Pricing
              </Link>
              <Link className="text-[#5f6368] no-underline hover:text-[#0b57d0]" to="/signup">
                Create workspace
              </Link>
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-[#80868b]">Company</div>
            <div className="mt-3 grid gap-2 text-sm">
              <Link className="text-[#5f6368] no-underline hover:text-[#0b57d0]" to="/contact">
                Contact
              </Link>
              <a className="text-[#5f6368] no-underline hover:text-[#0b57d0]" href="https://yashjeet.com" rel="noreferrer">
                yashjeet.com
              </a>
            </div>
          </div>
        </div>
        <div className="border-t border-[#e0e3e7] px-5 py-4 text-center text-xs text-[#80868b]">
          © {new Date().getFullYear()} MailInsider.
        </div>
      </footer>
    </div>
  )
}
