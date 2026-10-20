import type { ReactNode } from "react"

export function PageContainer({ children }: { children: ReactNode }) {
  return <div className="min-w-0 px-4 py-5 sm:px-6 lg:px-8">{children}</div>
}
