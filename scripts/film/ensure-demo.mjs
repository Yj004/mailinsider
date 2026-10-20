#!/usr/bin/env node
/** Create/reset the MailInsider demo film account with demo Gmail + sample mail. */
const API = process.env.PRODUCT_API_URL || "http://127.0.0.1:8765"
const EMAIL = "demo@mailinsider.app"
const PASSWORD = "DemoFilm2026!"

async function req(path, { method = "GET", token, workspace, body } = {}) {
  const headers = { "Content-Type": "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`
  if (workspace) headers["X-Workspace-Id"] = workspace
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const err = new Error(data?.error?.message || res.statusText)
    err.code = data?.error?.code
    err.status = res.status
    throw err
  }
  return data
}

let session
try {
  session = await req("/api/v1/auth/login", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  })
  console.log("Logged in existing demo account")
} catch {
  session = await req("/api/v1/auth/register", {
    method: "POST",
    body: {
      email: EMAIL,
      password: PASSWORD,
      display_name: "Demo Operator",
      workspace_name: "MailInsider Demo",
      open_tracking_default: true,
      link_tracking_default: true,
    },
  })
  console.log("Registered demo account")
}

const token = session.access_token
const workspace = session.memberships[0].workspace_id

try {
  await req("/api/v1/integrations/gmail/demo", { method: "POST", token, workspace })
  console.log("Demo Gmail connected")
} catch (err) {
  console.log("Demo Gmail:", err.message)
}

try {
  await req("/api/v1/workspaces/current/sample", { method: "POST", token, workspace })
  console.log("Sample conversations loaded")
} catch (err) {
  console.log("Sample:", err.message)
}

console.log(
  JSON.stringify(
    {
      email: EMAIL,
      password: PASSWORD,
      workspace_id: workspace,
      api: API,
    },
    null,
    2,
  ),
)
