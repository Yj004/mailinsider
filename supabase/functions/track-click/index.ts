import { createClient } from "@supabase/supabase-js";

const UNAVAILABLE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unavailable</title></head>
<body style="font-family:system-ui,sans-serif;padding:48px;background:#f8f9fa;color:#202124"><p>This link is unavailable.</p></body></html>`;

function parseToken(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || "";
  if (!last || last === "track-click") return null;
  return last;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isSafeHttps(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (!parsed.hostname || parsed.username) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return false;
    return true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const token = parseToken(new URL(req.url).pathname);
  if (!token) {
    return new Response(UNAVAILABLE, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return new Response(UNAVAILABLE, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const tokenHash = await sha256Hex(token);
  const { data: resolved, error } = await db.rpc("record_tracked_click", {
    p_token_hash: tokenHash,
  });

  const destination = resolved && resolved.ok === true ? String(resolved.destination_url || "") : "";
  if (error || !destination || !isSafeHttps(destination)) {
    return new Response(UNAVAILABLE, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: destination,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
});
