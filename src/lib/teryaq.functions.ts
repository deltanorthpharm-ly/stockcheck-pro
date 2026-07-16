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

type TeryaqItem = Record<string, unknown>;

function normalizeItemsPayload(body: unknown): {
  items: TeryaqItem[];
  totalItems: number | null;
  hasNextPage: boolean;
} {
  if (Array.isArray(body)) {
    return { items: body as TeryaqItem[], totalItems: body.length, hasNextPage: false };
  }
  if (!body || typeof body !== "object") {
    return { items: [], totalItems: null, hasNextPage: false };
  }
  const payload = body as {
    data?: unknown;
    items?: unknown;
    pagination?: { totalItems?: unknown; hasNextPage?: unknown };
  };
  const items = Array.isArray(payload.data)
    ? (payload.data as TeryaqItem[])
    : Array.isArray((payload.data as { data?: unknown } | undefined)?.data)
      ? ((payload.data as { data: TeryaqItem[] }).data)
      : Array.isArray(payload.items)
        ? (payload.items as TeryaqItem[])
        : [];
  const totalItemsRaw = payload.pagination?.totalItems;
  const totalItems = typeof totalItemsRaw === "number" ? totalItemsRaw : null;
  return {
    items,
    totalItems,
    hasNextPage: payload.pagination?.hasNextPage === true,
  };
}

function mapTeryaqItemsToInventoryRows(
  sessionId: string,
  items: TeryaqItem[],
  startIndex: number,
) {
  const integerOrNull = (value: number | null) =>
    value != null && Number.isInteger(value) ? value : null;
  const integerOrZero = (value: number | null) =>
    value != null && Number.isInteger(value) ? value : 0;

  return items.map((it, idx) => {
    const external = it["itemId"] != null ? String(it["itemId"]) : "";
    const name = (it["itemName"] as string | undefined) ?? external;
    const boxesSnap = it["systemBoxes"] == null ? null : Number(it["systemBoxes"]);
    const unitsSnap = it["systemUnits"] == null ? null : Number(it["systemUnits"]);
    const convStatus = (it["conversionStatus"] as string | null) ?? null;
    const formatted = (it["formattedQuantity"] as string | null) ?? null;
    const rawQty = it["rawQuantity"] == null ? null : Number(it["rawQuantity"]);
    const hasFractionalQuantity =
      (boxesSnap != null && !Number.isInteger(boxesSnap)) ||
      (unitsSnap != null && !Number.isInteger(unitsSnap));

    if (hasFractionalQuantity) {
      console.warn("[teryaq-sync] invalid fractional quantity from Teryaq", {
        itemId: external,
        systemBoxes: boxesSnap,
        systemUnits: unitsSnap,
        rawQuantity: rawQty,
        formattedQuantity: formatted,
      });
    }

    return {
      session_id: sessionId,
      row_index: startIndex + idx,
      external_item_id: external,
      item_name_raw: name,
      barcode: (it["barcode"] as string | null) ?? null,
      selling_price: it["sellingPrice"] == null ? 0 : Number(it["sellingPrice"]),
      expiry_date: (it["expiryDate"] as string | null) ?? null,
      system_quantity_raw: formatted ?? String(rawQty ?? 0),
      system_boxes: hasFractionalQuantity ? 0 : integerOrZero(boxesSnap),
      system_strips: 0,
      system_units: hasFractionalQuantity ? 0 : integerOrZero(unitsSnap),
      quantity_parse_status: hasFractionalQuantity || convStatus !== "ok" ? "partial" : "parsed",
      pack_size: integerOrNull(it["packSize"] == null ? null : Number(it["packSize"])),
      raw_quantity_snapshot: rawQty,
      system_boxes_snapshot: hasFractionalQuantity ? null : integerOrNull(boxesSnap),
      system_units_snapshot: hasFractionalQuantity ? null : integerOrNull(unitsSnap),
      formatted_quantity_snapshot: formatted,
      conversion_status: hasFractionalQuantity ? "unavailable" : convStatus,
      source_read_at: (it["readAt"] as string | null) ?? new Date().toISOString(),
    };
  }).filter((r) => r.external_item_id);
}

type InventoryRow = ReturnType<typeof mapTeryaqItemsToInventoryRows>[number];

function getPostgresErrorBody(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}) {
  return {
    code: error.code ?? null,
    message: error.message ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
  };
}

function findOffendingInventoryValue(
  rows: InventoryRow[],
  error: { message?: string; details?: string; hint?: string },
) {
  const errorText = [error.message, error.details, error.hint].filter(Boolean).join("\n");
  const match = errorText.match(/invalid input syntax for type ([^:]+):\s*"([^"]*)"/i);
  if (!match) return null;

  const pgType = match[1].trim().toLowerCase();
  const value = match[2];
  const candidateColumns =
    pgType.includes("integer")
      ? [
          "row_index",
          "system_boxes",
          "system_strips",
          "system_units",
          "pack_size",
          "system_boxes_snapshot",
          "system_units_snapshot",
        ]
      : pgType.includes("numeric")
        ? ["selling_price", "raw_quantity_snapshot"]
        : pgType.includes("timestamp")
          ? ["source_read_at"]
          : [];

  for (const row of rows) {
    for (const column of candidateColumns) {
      const rowValue = row[column as keyof InventoryRow];
      if (rowValue != null && String(rowValue) === value) {
        return {
          column,
          expected_postgres_type: pgType,
          offending_value: value,
          first_offending_row: {
            external_item_id: row.external_item_id,
            item_name_raw: row.item_name_raw,
            row_index: row.row_index,
            raw_quantity_snapshot: row.raw_quantity_snapshot,
            formatted_quantity_snapshot: row.formatted_quantity_snapshot,
            conversion_status: row.conversion_status,
          },
        };
      }
    }
  }

  return {
    column: null,
    expected_postgres_type: pgType,
    offending_value: value,
    first_offending_row: null,
  };
}

// Admin-only: sync all Teryaq items into a session using paginated batches.
export const syncSessionFromTeryaq = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      session_id: z.string().uuid(),
      // Kept for compatibility with older callers; full sync always uses pageSize=500.
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
        total_items: 0,
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

    const pageSize = 500;
    const jwt = getBearer();
    const startedAtMs = Date.now();
    let totalAvailableFromTeryaq = 0;
    let receivedFromTeryaq = 0;
    let mappedRows = 0;
    let savedRows = 0;
    let pagesProcessed = 0;
    let currentPage = 0;
    let errorMsg: string | null = null;

    try {
      for (let page = 1, hasNextPage = true; hasNextPage; page += 1) {
        currentPage = page;
        const r = await callProxy(jwt, "/items", {
          page: String(page),
          pageSize: String(pageSize),
        });
        const bodyIsString = typeof r.body === "string";
        const topKeys =
          r.body && typeof r.body === "object" && !Array.isArray(r.body)
            ? Object.keys(r.body as Record<string, unknown>)
            : Array.isArray(r.body) ? ["<array>"] : [`<${typeof r.body}>`];
        console.log("[teryaq-sync] page=", page, "upstream_status=", r.status, "top_keys=", topKeys, "latency_ms=", r.latencyMs);
        if (!r.ok) {
          const safeSnippet = bodyIsString
            ? (r.body as string).slice(0, 200)
            : JSON.stringify(r.body).slice(0, 200);
          throw new Error(`Page ${page}: Teryaq /items failed: HTTP ${r.status} ${safeSnippet}`);
        }
        if (bodyIsString) {
          throw new Error(
            `Page ${page}: Teryaq /items returned a non-JSON body (likely Cloudflare Access interstitial). Configure CF-Access-Client-Id / CF-Access-Client-Secret.`,
          );
        }

        const normalized = normalizeItemsPayload(r.body);
        const items = normalized.items;
        if (page === 1) {
          totalAvailableFromTeryaq = normalized.totalItems ?? items.length;
          if (totalAvailableFromTeryaq === 0) {
            throw new Error(
              `Teryaq /items returned zero rows. Top keys: ${topKeys.join(",")}. Check upstream response shape.`,
            );
          }
        }

        receivedFromTeryaq += items.length;
        hasNextPage = normalized.hasNextPage;
        const rows = mapTeryaqItemsToInventoryRows(
          data.session_id,
          items,
          (page - 1) * pageSize + 1,
        );
        mappedRows += rows.length;
        console.log("[teryaq-sync] page=", page, "received=", items.length, "mapped=", rows.length, "has_next=", hasNextPage);

        if (items.length > 0 && rows.length === 0) {
          throw new Error(`Page ${page}: no rows mapped from Teryaq response - check itemId field.`);
        }

        if (rows.length > 0) {
          const { error: upErr } = await context.supabase
            .from("inventory_items")
            .upsert(rows, { onConflict: "session_id,external_item_id" });
          if (upErr) {
            const postgresError = getPostgresErrorBody(upErr);
            const offendingValue = findOffendingInventoryValue(rows, upErr);
            console.error(
              "[teryaq-sync] page upsert failed:",
              JSON.stringify({
                page,
                postgresError,
                offendingValue,
              }),
            );
            throw new Error(`Page ${page}: failed to save inventory batch (${upErr.code ?? "?"})`);
          }

          const externalIds = rows.map((r) => r.external_item_id);
          const { count, error: cntErr } = await context.supabase
            .from("inventory_items")
            .select("id", { count: "exact", head: true })
            .eq("session_id", data.session_id)
            .in("external_item_id", externalIds);
          if (cntErr) {
            console.error("[teryaq-sync] page verify-count failed:", page, cntErr.code, cntErr.message);
            throw new Error(`Page ${page}: failed to verify saved batch (${cntErr.code ?? "?"})`);
          }
          if ((count ?? 0) !== rows.length) {
            throw new Error(`Page ${page}: saved row count mismatch (${count ?? 0}/${rows.length})`);
          }
          savedRows += count ?? 0;
        }

        pagesProcessed = page;
        const { error: progressErr } = await context.supabase
          .from("teryaq_sync_runs")
          .update({
            status: "running",
            items_synced: savedRows,
            page_cursor: page,
            total_items: totalAvailableFromTeryaq,
          })
          .eq("id", run.id);
        if (progressErr) {
          console.error("[teryaq-sync] progress update failed:", progressErr.code, progressErr.message);
          throw new Error(`Page ${page}: failed to update sync progress (${progressErr.code ?? "?"})`);
        }
      }

      if (savedRows !== totalAvailableFromTeryaq) {
        throw new Error(`Full sync count mismatch (${savedRows}/${totalAvailableFromTeryaq})`);
      }

      const { count: sessionCount, error: sessionCountErr } = await context.supabase
        .from("inventory_items")
        .select("id", { count: "exact", head: true })
        .eq("session_id", data.session_id)
        .not("external_item_id", "is", null);
      if (sessionCountErr) {
        console.error("[teryaq-sync] session count verify failed:", sessionCountErr.code, sessionCountErr.message);
        throw new Error(`Failed to verify final session count (${sessionCountErr.code ?? "?"})`);
      }
      if ((sessionCount ?? 0) !== totalAvailableFromTeryaq) {
        throw new Error(`Session item count mismatch (${sessionCount ?? 0}/${totalAvailableFromTeryaq})`);
      }

      const { error: sessionErr } = await context.supabase
        .from("inventory_sessions")
        .update({ source_type: "live_api" })
        .eq("id", data.session_id);
      if (sessionErr) {
        console.error("[teryaq-sync] session source update failed:", sessionErr.code, sessionErr.message);
        throw new Error(`Failed to mark session as live API (${sessionErr.code ?? "?"})`);
      }
    } catch (e) {
      errorMsg = (e as Error).message;
      console.error("[teryaq-sync] error:", errorMsg);
    } finally {
      const { error: finalErr } = await context.supabase
        .from("teryaq_sync_runs")
        .update({
          status: errorMsg ? "failed" : "succeeded",
          items_synced: savedRows,
          page_cursor: currentPage || pagesProcessed,
          total_items: totalAvailableFromTeryaq,
          error: errorMsg,
          finished_at: new Date().toISOString(),
        })
        .eq("id", run.id);
      if (finalErr) {
        console.error("[teryaq-sync] final status update failed:", finalErr.code, finalErr.message);
      }
    }

    if (errorMsg) throw new Error(errorMsg);
    return {
      run_id: run.id,
      items_synced: savedRows,
      total_available_from_teryaq: totalAvailableFromTeryaq,
      received_from_teryaq: receivedFromTeryaq,
      mapped_rows: mappedRows,
      saved_rows: savedRows,
      pages_processed: pagesProcessed,
      execution_time_ms: Date.now() - startedAtMs,
      final_status: "succeeded",
    };
  });
