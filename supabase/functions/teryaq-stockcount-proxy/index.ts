// Teryaq StockCount API — secure proxy.
// Only whitelisted GET paths are forwarded. API key is server-side only.
// JWT + role checks are performed here (avoids per-function config).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TERYAQ_BASE_URL = Deno.env.get("TERYAQ_STOCKCOUNT_BASE_URL") ?? "";
const TERYAQ_API_KEY = Deno.env.get("TERYAQ_STOCKCOUNT_API_KEY") ?? "";

const ITEM_ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;

function assertPublicHttpsUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "https:") {
    throw new Error("TERYAQ_STOCKCOUNT_BASE_URL must be https");
  }
  const host = u.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  if (blocked) throw new Error("TERYAQ base URL must be a public HTTPS host");
  return u;
}

type Role = "admin" | "employee";

async function authenticate(req: Request): Promise<
  | { ok: true; userId: string; role: Role; jwt: string }
  | { ok: false; response: Response }
> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return { ok: false, response: json({ error: "missing token" }, 401) };

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userRes, error: uErr } = await admin.auth.getUser(jwt);
  if (uErr || !userRes?.user) {
    return { ok: false, response: json({ error: "invalid token" }, 401) };
  }
  const userId = userRes.user.id;
  const { data: roles, error: rErr } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (rErr) return { ok: false, response: json({ error: rErr.message }, 500) };
  const roleList = (roles ?? []).map((r) => r.role as Role);
  const role: Role | null = roleList.includes("admin")
    ? "admin"
    : roleList.includes("employee")
      ? "employee"
      : null;
  if (!role) return { ok: false, response: json({ error: "no role" }, 403) };
  return { ok: true, userId, role, jwt };
}

async function employeeMayReadItem(
  admin: ReturnType<typeof createClient>,
  userId: string,
  externalItemId: string,
): Promise<boolean> {
  // Employee may read stock for an item only if it belongs to an OPEN session
  // and is assigned to them.
  const { data, error } = await admin
    .from("inventory_items")
    .select("id, assigned_to, session_id, inventory_sessions!inner(status)")
    .eq("external_item_id", externalItemId)
    .eq("assigned_to", userId)
    .limit(1);
  if (error || !data || data.length === 0) return false;
  // deno-lint-ignore no-explicit-any
  const status = (data[0] as any).inventory_sessions?.status;
  return status === "open";
}

async function forwardGet(
  path: string,
  query?: URLSearchParams,
): Promise<Response> {
  let base: URL;
  try {
    base = assertPublicHttpsUrl(TERYAQ_BASE_URL);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
  if (!TERYAQ_API_KEY) return json({ error: "TERYAQ_STOCKCOUNT_API_KEY not set" }, 500);

  const target = new URL(
    (base.pathname.replace(/\/$/, "") + path),
    `${base.protocol}//${base.host}`,
  );
  if (query) {
    for (const [k, v] of query.entries()) target.searchParams.set(k, v);
  }

  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: "GET",
      headers: {
        "X-StockCount-Key": TERYAQ_API_KEY,
        Accept: "application/json",
      },
    });
  } catch (e) {
    return json({ error: `upstream fetch failed: ${(e as Error).message}` }, 502);
  }
  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": contentType,
      "x-upstream-latency-ms": String(Date.now() - startedAt),
      ...CORS,
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const url = new URL(req.url);
  // Function is mounted at /teryaq-stockcount-proxy; strip that prefix.
  const path = url.pathname.replace(/^\/teryaq-stockcount-proxy/, "") || "/";

  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  // /health — admin only
  if (path === "/health") {
    if (auth.role !== "admin") return json({ error: "admin only" }, 403);
    return await forwardGet("/api/v1/stockcount/health");
  }

  // /items — admin only (used for sync)
  if (path === "/items") {
    if (auth.role !== "admin") return json({ error: "admin only" }, 403);
    return await forwardGet("/api/v1/stockcount/items", url.searchParams);
  }

  // /items/:id  and  /items/:id/stock — admin OR assigned employee (open session)
  const detailMatch = path.match(/^\/items\/([^/]+)(\/stock)?$/);
  if (detailMatch) {
    const externalItemId = detailMatch[1];
    const isStock = Boolean(detailMatch[2]);
    if (!ITEM_ID_RE.test(externalItemId)) {
      return json({ error: "invalid item id" }, 400);
    }
    if (auth.role === "employee") {
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const allowed = await employeeMayReadItem(admin, auth.userId, externalItemId);
      if (!allowed) return json({ error: "forbidden" }, 403);
    }
    return await forwardGet(
      `/api/v1/stockcount/items/${encodeURIComponent(externalItemId)}${isStock ? "/stock" : ""}`,
    );
  }

  return json({ error: "not found" }, 404);
});
