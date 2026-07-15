import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const FUNCTIONS_BASE = `${process.env.SUPABASE_URL ?? ""}/functions/v1/teryaq-stockcount-proxy`;

async function callProxy(jwt: string, path: string, query?: Record<string, string>) {
  const url = new URL(FUNCTIONS_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const started = Date.now();
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body, latencyMs: Date.now() - started };
}

function getBearer(): string {
  // The auth-middleware doesn't expose the raw token, so read it from the request.
  // We rely on the client attaching Authorization: Bearer <jwt>.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getRequestHeader } = require("@tanstack/react-start/server") as {
    getRequestHeader: (n: string) => string | undefined;
  };
  const h = getRequestHeader("authorization") ?? "";
  return h.replace(/^Bearer\s+/i, "");
}

// Admin-only: ping Teryaq /health via the proxy, record result.
export const pingTeryaqHealth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden");

    const jwt = getBearer();
    let ok = false;
    let latencyMs = 0;
    let errorMsg: string | null = null;
    try {
      const r = await callProxy(jwt, "/health");
      ok = r.ok;
      latencyMs = r.latencyMs;
      if (!ok) errorMsg = `HTTP ${r.status}: ${typeof r.body === "string" ? r.body : JSON.stringify(r.body)}`;
    } catch (e) {
      errorMsg = (e as Error).message;
    }

    await context.supabase.from("teryaq_health_pings").insert({
      ok,
      latency_ms: latencyMs,
      error: errorMsg,
      checked_by: context.userId,
    });

    return { ok, latency_ms: latencyMs, error: errorMsg };
  });

// Admin-only: read latest health ping (for dashboard badge).
export const getLatestHealthPing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden");
    const { data } = await context.supabase
      .from("teryaq_health_pings")
      .select("ok, latency_ms, error, checked_at")
      .order("checked_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data;
  });

// Admin-only: sync a batch of items from Teryaq into a session.
// Phase 1: limit=10 by default for the smoke test.
export const syncSessionFromTeryaq = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      session_id: z.string().uuid(),
      limit: z.number().int().min(1).max(500).optional(),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden");

    // Release stale running runs for this session (older than 10 minutes).
    const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await context.supabase
      .from("teryaq_sync_runs")
      .update({
        status: "failed",
        error: "Stale sync run exceeded 10 minutes and was released.",
        finished_at: new Date().toISOString(),
      })
      .eq("session_id", data.session_id)
      .eq("status", "running")
      .lt("started_at", staleCutoff);

    // Try to open a sync run. Partial unique index enforces "one running per session".
    const { data: run, error: runErr } = await context.supabase
      .from("teryaq_sync_runs")
      .insert({
        session_id: data.session_id,
        started_by: context.userId,
        status: "running",
        page_cursor: 0,
        items_synced: 0,
      })
      .select("id")
      .single();
    if (runErr) {
      throw new Error(
        runErr.code === "23505"
          ? "مزامنة جارية بالفعل لهذه الجلسة"
          : runErr.message,
      );
    }

    const limit = data.limit ?? 10;
    const jwt = getBearer();
    let itemsSynced = 0;
    let receivedFromTeryaq = 0;
    let mappedRows = 0;
    let errorMsg: string | null = null;

    try {
      const r = await callProxy(jwt, "/items", {
        page: "1",
        pageSize: String(limit),
      });
      const bodyIsString = typeof r.body === "string";
      const topKeys =
        r.body && typeof r.body === "object" && !Array.isArray(r.body)
          ? Object.keys(r.body as Record<string, unknown>)
          : Array.isArray(r.body) ? ["<array>"] : [`<${typeof r.body}>`];
      console.log("[teryaq-sync] upstream_status=", r.status, "top_keys=", topKeys, "latency_ms=", r.latencyMs);
      if (!r.ok) {
        const safeSnippet = bodyIsString
          ? (r.body as string).slice(0, 200)
          : JSON.stringify(r.body).slice(0, 200);
        throw new Error(`Teryaq /items failed: HTTP ${r.status} ${safeSnippet}`);
      }
      if (bodyIsString) {
        throw new Error(
          "Teryaq /items returned a non-JSON body (likely Cloudflare Access interstitial). Configure CF-Access-Client-Id / CF-Access-Client-Secret.",
        );
      }
      // Safe normalization across possible shapes.
      const payload = r.body as Record<string, unknown> | Array<Record<string, unknown>>;
      const items: Array<Record<string, unknown>> = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { data?: unknown })?.data)
          ? ((payload as { data: Array<Record<string, unknown>> }).data)
          : Array.isArray(((payload as { data?: { data?: unknown } })?.data as { data?: unknown } | undefined)?.data)
            ? ((payload as { data: { data: Array<Record<string, unknown>> } }).data.data)
            : Array.isArray((payload as { items?: unknown })?.items)
              ? ((payload as { items: Array<Record<string, unknown>> }).items)
              : [];
      receivedFromTeryaq = items.length;
      const firstKeys = items[0] ? Object.keys(items[0]) : [];
      console.log("[teryaq-sync] received_from_teryaq=", receivedFromTeryaq, "first_item_keys=", firstKeys);
      if (receivedFromTeryaq === 0) {
        throw new Error(
          `Teryaq /items returned zero rows. Top keys: ${topKeys.join(",")}. Check upstream response shape.`,
        );
      }

      const rows = items.slice(0, limit).map((it, idx) => {
        const external = it["itemId"] != null ? String(it["itemId"]) : "";
        const name = (it["itemName"] as string | undefined) ?? external;
        const boxesSnap = it["systemBoxes"] == null ? null : Number(it["systemBoxes"]);
        const unitsSnap = it["systemUnits"] == null ? null : Number(it["systemUnits"]);
        const convStatus = (it["conversionStatus"] as string | null) ?? null;
        const formatted = (it["formattedQuantity"] as string | null) ?? null;
        const rawQty = it["rawQuantity"] == null ? null : Number(it["rawQuantity"]);
        return {
          session_id: data.session_id,
          row_index: idx + 1,
          external_item_id: external,
          item_name_raw: name,
          barcode: (it["barcode"] as string | null) ?? null,
          selling_price: it["sellingPrice"] == null ? 0 : Number(it["sellingPrice"]),
          expiry_date: (it["expiryDate"] as string | null) ?? null,
          system_quantity_raw: formatted ?? String(rawQty ?? 0),
          system_boxes: boxesSnap ?? 0,
          system_strips: 0,
          system_units: unitsSnap ?? 0,
          quantity_parse_status: convStatus === "ok" ? "parsed" : "partial",
          pack_size: it["packSize"] == null ? null : Number(it["packSize"]),
          raw_quantity_snapshot: rawQty,
          system_boxes_snapshot: boxesSnap,
          system_units_snapshot: unitsSnap,
          formatted_quantity_snapshot: formatted,
          conversion_status: convStatus,
          source_read_at: (it["readAt"] as string | null) ?? new Date().toISOString(),
        };
      }).filter((r) => r.external_item_id);
      mappedRows = rows.length;
      console.log("[teryaq-sync] mapped_rows=", mappedRows);

      if (rows.length > 0) {
        // Upsert on (session_id, external_item_id) and verify via follow-up count.
        const { error: upErr } = await context.supabase
          .from("inventory_items")
          .upsert(rows, { onConflict: "session_id,external_item_id" });
        if (upErr) {
          console.error("[teryaq-sync] upsert failed:", upErr.code, upErr.message);
          throw new Error(`فشل الحفظ في قاعدة البيانات (${upErr.code ?? "?"}): ${upErr.message}`);
        }
        const externalIds = rows.map((r) => r.external_item_id);
        const { count, error: cntErr } = await context.supabase
          .from("inventory_items")
          .select("id", { count: "exact", head: true })
          .eq("session_id", data.session_id)
          .in("external_item_id", externalIds);
        if (cntErr) {
          console.error("[teryaq-sync] verify-count failed:", cntErr.code, cntErr.message);
          throw new Error(`تعذر التحقق من الحفظ (${cntErr.code ?? "?"})`);
        }
        itemsSynced = count ?? 0;
        console.log("[teryaq-sync] verified_saved_rows=", itemsSynced);
        if (itemsSynced === 0) {
          throw new Error("Upsert succeeded but no rows are visible for this session (RLS or filter issue).");
        }
      } else {
        throw new Error("No rows mapped from Teryaq response — check itemId field.");
      }

      // Mark session as live_api on first successful sync (only when we actually saved rows).
      if (itemsSynced > 0) {
        await context.supabase
          .from("inventory_sessions")
          .update({ source_type: "live_api" })
          .eq("id", data.session_id);
      }
    } catch (e) {
      errorMsg = (e as Error).message;
      console.error("[teryaq-sync] error:", errorMsg);
    } finally {
      await context.supabase
        .from("teryaq_sync_runs")
        .update({
          status: errorMsg ? "failed" : "succeeded",
          items_synced: itemsSynced,
          page_cursor: itemsSynced,
          error: errorMsg,
          finished_at: new Date().toISOString(),
        })
        .eq("id", run.id);
    }

    if (errorMsg) throw new Error(errorMsg);
    return {
      run_id: run.id,
      items_synced: itemsSynced,
      received_from_teryaq: receivedFromTeryaq,
      mapped_rows: mappedRows,
      saved_rows: itemsSynced,
    };
  });