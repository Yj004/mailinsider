import { createClient } from "@supabase/supabase-js";

const UNAVAILABLE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unavailable</title></head>
<body style="font-family:system-ui,sans-serif;padding:48px;background:#f8f9fa;color:#202124"><p>This document link is unavailable.</p></body></html>`;

function parseToken(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || "";
  if (!last || last === "view-document") return null;
  return last;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function unavailableHtml(): Response {
  return new Response(UNAVAILABLE, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function fileResponse(blob: Blob, contentType: string, filename: string, method: string): Response {
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
    "Content-Disposition": `inline; filename="${filename}"`,
  };
  if (method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(blob, { status: 200, headers });
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const token = parseToken(new URL(req.url).pathname);
  if (!token) return unavailableHtml();

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) return unavailableHtml();

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const tokenHash = await sha256Hex(token);
  const { data: resolved, error } = await db.rpc("resolve_document_token", {
    p_token_hash: tokenHash,
  });
  if (error || !resolved || resolved.ok !== true) return unavailableHtml();

  const storagePath = String(resolved.storage_path || "");
  const contentType = String(resolved.content_type || "application/octet-stream");
  const filename = String(resolved.filename || "document").replace(/"/g, "");
  if (!storagePath.startsWith("documents/")) return unavailableHtml();

  if (req.method === "GET") {
    try {
      await db.rpc("record_document_access", {
        p_token_hash: tokenHash,
        p_event_type: "document_view_started",
      });
    } catch {
      /* still serve */
    }
  }

  const bucket = Deno.env.get("DOCUMENTS_BUCKET") || "documents";
  // Object keys are stored as documents/{workspace}/{file} inside the documents bucket.
  const { data: fileData, error: downloadError } = await db.storage.from(bucket).download(storagePath);
  if (downloadError || !fileData) return unavailableHtml();
  return fileResponse(fileData, contentType, filename, req.method);
});
