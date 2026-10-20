export const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8765"

export class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  const token = localStorage.getItem("mi_token")
  const workspace = localStorage.getItem("mi_workspace")
  const isForm = options.body instanceof FormData
  if (!isForm && options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }
  if (token) headers.set("Authorization", `Bearer ${token}`)
  if (workspace) headers.set("X-Workspace-Id", workspace)
  const response = await fetch(`${API_URL}${path}`, { ...options, headers })
  const text = await response.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      if (!response.ok) {
        throw new ApiError(response.status, "error", "Something went wrong. Try again.")
      }
      throw new ApiError(500, "invalid_response", "The server returned an unexpected response.")
    }
  }
  if (!response.ok) {
    const err = data as { error?: { message?: string; code?: string } } | null
    const message = err?.error?.message || "Something went wrong. Try again."
    const code = err?.error?.code || "error"
    // Only clear session for real auth failures — not Gmail/Sheets reconnect (needs_reauth).
    const sessionCodes = new Set(["unauthorized", "invalid_login", "invalid_token"])
    if (
      response.status === 401 &&
      token &&
      sessionCodes.has(code) &&
      !path.startsWith("/api/v1/auth/")
    ) {
      localStorage.removeItem("mi_token")
      localStorage.removeItem("mi_workspace")
      window.location.assign("/login")
    }
    throw new ApiError(response.status, code, message)
  }
  return data as T
}
