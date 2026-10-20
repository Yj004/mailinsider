import { createClient } from "@supabase/supabase-js";

// Same 1x1 GIF as services/api/app/api/public_routes.py (and tracking_pixel_assets seed).
const DEFAULT_GIF = Uint8Array.from(
  "47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b"
    .match(/.{1,2}/g)!
    .map((byte) => parseInt(byte, 16)),
);

function gifResponse(bytes: Uint8Array): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, private",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function parseToken(pathname: string): string | null {
  // /functions/v1/open-pixel/{token}.gif or /open-pixel/{token}
  const parts = pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || "";
  if (!last || last === "open-pixel") return null;
  return last.endsWith(".gif") ? last.slice(0, -4) : last;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || null;
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip");
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const token = parseToken(url.pathname);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  let pixelBytes = DEFAULT_GIF;

  if (supabaseUrl && serviceKey) {
    const db = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    try {
      const { data: b64 } = await db.rpc("read_tracking_pixel_base64");
      if (typeof b64 === "string" && b64.length > 0) {
        pixelBytes = fromBase64(b64);
      }
    } catch {
      /* keep DEFAULT_GIF */
    }

    // HEAD is used by scanners — serve GIF but do not record an open.
    if (token && req.method === "GET") {
      try {
        const tokenHash = await sha256Hex(token);
        await db.rpc("record_open_pixel", {
          p_token_hash: tokenHash,
          p_user_agent: req.headers.get("user-agent") ?? "",
          p_client_ip: clientIp(req) ?? "",
        });
      } catch {
        /* Always return a GIF; never leak errors to the mail client. */
      }
    }
  }

  if (req.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "image/gif",
        "Cache-Control": "no-store, private",
        "X-Robots-Tag": "noindex, nofollow",
        "Content-Length": String(pixelBytes.byteLength),
      },
    });
  }

  return gifResponse(pixelBytes);
});
