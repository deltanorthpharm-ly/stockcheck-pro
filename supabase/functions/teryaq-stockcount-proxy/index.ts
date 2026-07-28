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

function safeHeaders(headers: Headers): Record<string, string> {
  const allowed = [
    "cache-control",
    "cf-cache-status",
    "cf-ray",
    "content-type",
    "date",
    "expires",
    "location",
    "server",
    "vary",
  ];
  const out: Record<string, string> = {};
  for (const key of allowed) {
    const value = headers.get(key);
    if (value) out[key] = value;
  }
  if (headers.has("set-cookie")) out["set-cookie"] = "[present-redacted]";
  return out;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TERYAQ_BASE_URL = Deno.env.get("TERYAQ_STOCKCOUNT_BASE_URL") ?? "";
const TERYAQ_API_KEY = Deno.env.get("TERYAQ_STOCKCOUNT_API_KEY") ?? "";
const CF_ACCESS_CLIENT_ID = Deno.env.get("CF_ACCESS_CLIENT_ID") ?? "";
const CF_ACCESS_CLIENT_SECRET = Deno.env.get("CF_ACCESS_CLIENT_SECRET") ?? "";

const ITEM_ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIVE_CACHE_TTL_MS = 2 * 60 * 1000;
const liveRefreshLocks = new Map<string, Promise<LiveStockPayload>>();

type LiveStockPayload = {
  systemBoxes: number | null;
  systemUnits: number | null;
  rawQuantity: number | null;
  formattedQuantity: string | null;
  packSize: number | null;
  readAt: string;
  lastLiveRefreshAt: string;
  source: "live" | "cached" | "fallback";
  ageMinutes: number;
};

type InventoryItemRow = {
  id: string;
  session_id: string;
  external_item_id: string | null;
  assigned_to: string | null;
  inventory_sessions?: { status?: string } | null;
};

type LiveCacheRow = {
  inventory_item_id: string;
  session_id: string;
  external_item_id: string;
  raw_quantity: number | null;
  pack_size: number | null;
  system_boxes: number | null;
  system_units: number | null;
  formatted_quantity: string | null;
  source_read_at: string | null;
  last_live_refresh_at: string;
};

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
    const headers: Record<string, string> = {
      "X-StockCount-Key": TERYAQ_API_KEY,
      Accept: "application/json",
    };
    if (CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET) {
      headers["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID;
      headers["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET;
    }
    upstream = await fetch(target.toString(), {
      method: "GET",
      headers,
    });
  } catch (e) {
    return json({ error: `upstream fetch failed: ${(e as Error).message}` }, 502);
  }
  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  // Detect Cloudflare Access interstitial (HTML page returned with 200).
  const looksHtml = /^\s*<(?:!doctype|html)/i.test(text);
  if (looksHtml || contentType.includes("text/html")) {
    return json(
      {
        error:
          "upstream returned an HTML page (likely Cloudflare Access). Missing/invalid CF-Access-Client-Id / CF-Access-Client-Secret.",
        upstream_status: upstream.status,
        upstream_content_type: contentType,
        upstream_headers: safeHeaders(upstream.headers),
      },
      502,
    );
  }
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": contentType,
      "x-upstream-latency-ms": String(Date.now() - startedAt),
      ...CORS,
    },
  });
}

function ageMinutesFrom(iso: string | null | undefined) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - time) / 60000));
}

function snapshotFromCache(row: LiveCacheRow | null, source: "cached" | "fallback"): LiveStockPayload | null {
  if (!row) return null;
  const readAt = row.source_read_at ?? row.last_live_refresh_at;
  const lastLiveRefreshAt = row.last_live_refresh_at ?? row.source_read_at;
  if (!readAt || !lastLiveRefreshAt) return null;
  if (row.raw_quantity == null) return null;
  if (row.system_boxes == null || row.system_units == null) return null;
  return {
    systemBoxes: row.system_boxes,
    systemUnits: row.system_units,
    rawQuantity: Number(row.raw_quantity),
    formattedQuantity: row.formatted_quantity,
    packSize: row.pack_size,
    readAt,
    lastLiveRefreshAt,
    source,
    ageMinutes: ageMinutesFrom(lastLiveRefreshAt),
  };
}

function normalizeLiveStock(body: unknown): Omit<LiveStockPayload, "source" | "ageMinutes" | "lastLiveRefreshAt"> {
  const b = (body ?? {}) as Record<string, unknown>;
  const src = (b.data && typeof b.data === "object" ? b.data : b) as Record<string, unknown>;
  const numOrNull = (v: unknown) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const intOrNull = (v: unknown) => {
    const n = numOrNull(v);
    return n != null && Number.isInteger(n) ? n : null;
  };
  return {
    systemBoxes: intOrNull(src.systemBoxes),
    systemUnits: intOrNull(src.systemUnits),
    rawQuantity: numOrNull(src.rawQuantity),
    formattedQuantity: (src.formattedQuantity as string | null) ?? null,
    packSize: intOrNull(src.packSize),
    readAt: (src.readAt as string | null) ?? new Date().toISOString(),
  };
}

async function fetchTeryaqStock(externalItemId: string): Promise<Omit<LiveStockPayload, "source" | "ageMinutes" | "lastLiveRefreshAt">> {
  const response = await forwardGet(`/api/v1/stockcount/items/${encodeURIComponent(externalItemId)}/stock`);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message = typeof body === "string"
      ? body.slice(0, 200)
      : ((body as { error?: string } | null)?.error ?? `HTTP ${response.status}`);
    throw new Error(message);
  }
  if (typeof body === "string") throw new Error("upstream returned non-JSON body");
  return normalizeLiveStock(body);
}

async function readInventoryItem(
  admin: ReturnType<typeof createClient>,
  inventoryItemId: string,
): Promise<{ row: InventoryItemRow | null; error: string | null }> {
  const { data, error } = await admin
    .from("inventory_items")
    .select(
      "id, session_id, external_item_id, assigned_to, inventory_sessions!inner(status)",
    )
    .eq("id", inventoryItemId)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: data as InventoryItemRow | null, error: null };
}

async function readLiveCache(
  admin: ReturnType<typeof createClient>,
  inventoryItemId: string,
): Promise<{ row: LiveCacheRow | null; error: string | null }> {
  const { data, error } = await admin
    .from("inventory_item_live_cache")
    .select(
      "inventory_item_id, session_id, external_item_id, raw_quantity, pack_size, system_boxes, system_units, formatted_quantity, source_read_at, last_live_refresh_at",
    )
    .eq("inventory_item_id", inventoryItemId)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: data as LiveCacheRow | null, error: null };
}

async function refreshSharedLiveStock(
  admin: ReturnType<typeof createClient>,
  row: InventoryItemRow,
): Promise<LiveStockPayload> {
  const lockKey = row.id;
  const existing = liveRefreshLocks.get(lockKey);
  if (existing) return await existing;

  const refreshPromise = (async () => {
    if (!row.external_item_id) throw new Error("missing external item id");
    const fresh = await fetchTeryaqStock(row.external_item_id);
    const refreshedAt = new Date().toISOString();
    const cacheRow = {
      inventory_item_id: row.id,
      session_id: row.session_id,
      external_item_id: row.external_item_id,
      raw_quantity: fresh.rawQuantity,
      pack_size: fresh.packSize,
      system_boxes: fresh.systemBoxes,
      system_units: fresh.systemUnits,
      formatted_quantity: fresh.formattedQuantity,
      source_read_at: fresh.readAt,
      last_live_refresh_at: refreshedAt,
      updated_at: refreshedAt,
    };

    const { error } = await admin
      .from("inventory_item_live_cache")
      .upsert(cacheRow, { onConflict: "inventory_item_id" });
    if (error) throw new Error(`failed to update shared live cache: ${error.message}`);

    return {
      ...fresh,
      lastLiveRefreshAt: refreshedAt,
      source: "live" as const,
      ageMinutes: 0,
    };
  })();

  liveRefreshLocks.set(lockKey, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    liveRefreshLocks.delete(lockKey);
  }
}

async function getSharedLiveStock(
  auth: { userId: string; role: Role },
  inventoryItemId: string,
  externalItemId: string,
): Promise<Response> {
  if (!UUID_RE.test(inventoryItemId)) return json({ error: "invalid inventory item id" }, 400);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { row, error } = await readInventoryItem(admin, inventoryItemId);
  if (error) return json({ error }, 500);
  if (!row) return json({ error: "item not found" }, 404);
  if (row.external_item_id !== externalItemId) return json({ error: "item mismatch" }, 400);

  const status = row.inventory_sessions?.status;
  if (status !== "open") return json({ error: "session is not open" }, 403);
  if (auth.role === "employee" && row.assigned_to !== auth.userId) {
    return json({ error: "forbidden" }, 403);
  }

  const { row: cacheRow, error: cacheError } = await readLiveCache(admin, inventoryItemId);
  if (cacheError) return json({ error: cacheError }, 500);

  const cached = snapshotFromCache(cacheRow, "cached");
  if (cached && (Date.now() - Date.parse(cached.lastLiveRefreshAt)) < LIVE_CACHE_TTL_MS) {
    return json({ success: true, data: cached });
  }

  try {
    const live = await refreshSharedLiveStock(admin, row);
    return json({ success: true, data: live });
  } catch (e) {
    const { row: fallbackRow } = await readLiveCache(admin, inventoryItemId);
    const fallback = snapshotFromCache(fallbackRow ?? cacheRow, "fallback");
    if (fallback) return json({ success: true, data: fallback, warning: (e as Error).message });
    return json({ error: (e as Error).message }, 502);
  }
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
    const inventoryItemId = url.searchParams.get("inventoryItemId");
    if (!ITEM_ID_RE.test(externalItemId)) {
      return json({ error: "invalid item id" }, 400);
    }
    if (isStock && inventoryItemId) {
      return await getSharedLiveStock(auth, inventoryItemId, externalItemId);
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
