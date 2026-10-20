import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from "react"

export type ComposeDraft = {
  to?: string
  subject?: string
  body?: string
  followup?: string
}

type ComposeContextValue = {
  open: boolean
  draft: ComposeDraft | null
  openCompose: (draft?: ComposeDraft) => void
  closeCompose: () => void
}

const ComposeContext = createContext<ComposeContextValue | null>(null)

export function ComposeProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ComposeDraft | null>(null)

  const openCompose = useCallback((next?: ComposeDraft) => {
    setDraft(next || {})
    setOpen(true)
  }, [])

  const closeCompose = useCallback(() => {
    setOpen(false)
    setDraft(null)
  }, [])

  const value = useMemo(
    () => ({ open, draft, openCompose, closeCompose }),
    [open, draft, openCompose, closeCompose],
  )

  return <ComposeContext.Provider value={value}>{children}</ComposeContext.Provider>
}

export function useCompose() {
  const ctx = useContext(ComposeContext)
  if (!ctx) throw new Error("useCompose must be used within ComposeProvider")
  return ctx
}

/** Parse `/app/compose?...` style paths into a draft. */
export function composeDraftFromSearch(search: string): ComposeDraft {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`)
  return {
    to: params.get("to") || undefined,
    subject: params.get("subject") || undefined,
    body: params.get("body") || undefined,
    followup: params.get("followup") || undefined,
  }
}
