import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { fetchAllSupabasePages } from "@/lib/supabase-pagination";
import { diffStatus, normalizePackSize, qtyToRaw, rawToQty, formatQtyArabic } from "@/lib/quantity-parser";

const WRITE_CHUNK_SIZE = 500;
const SNAPSHOT_REFRESH_CONCURRENCY = 8;
const FUNCTIONS_BASE = `${process.env.SUPABASE_URL ?? ""}/functions/v1/teryaq-stockcount-proxy`;

const importedRowSchema = z.object({
  row_index: z.number().int().min(1),
  item_name_raw: z.string().min(1),
  barcode: z.string().nullable(),
  selling_price: z.number().nullable(),
  expiry_date: z.string().nullable(),
  system_quantity_raw: z.string(),
  parsed: z.object({
    boxes: z.number().int().min(0),
    strips: z.number().int().min(0),
    units: z.number().int().min(0),
    status: z.enum(["parsed", "partial", "unrecognized", "empty"]),
  }),
});

async function requireAdmin(context: { supabase: any; userId: string }) {
  const { data: isAdmin } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (!isAdmin) throw new Error("Forbidden: admin only");
}

function getBearer(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getRequestHeader } = require("@tanstack/react-start/server") as {
    getRequestHeader: (n: string) => string | undefined;
  };
  const h = getRequestHeader("authorization") ?? "";
  return h.replace(/^Bearer\s+/i, "");
}

type LiveSnapshot = {
  systemBoxes: number;
  systemUnits: number;
  rawQuantity: number | null;
  formattedQuantity: string | null;
  packSize: number | null;
  readAt: string | null;
};

type SnapshotRefreshItem = {
  id: string;
  session_id: string;
  external_item_id: string | null;
  pack_size: number | null;
  system_boxes: number;
  system_units: number;
  system_quantity_raw: string | null;
  raw_quantity_snapshot: number | null;
  system_boxes_snapshot: number | null;
  system_units_snapshot: number | null;
};

type SnapshotRefreshCount = {
  id: string;
  item_id: string;
  phys_boxes: number;
  phys_units: number;
  difference_raw: number | null;
  difference_boxes: number | null;
  difference_units: number | null;
  diff_status: string | null;
};

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIntegerOrNull(value: unknown): number | null {
  const n = toNumberOrNull(value);
  return n != null && Number.isInteger(n) ? n : null;
}

function normalizeLiveSnapshot(body: unknown): LiveSnapshot | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const src = (b.data && typeof b.data === "object" ? b.data : b) as Record<string, unknown>;
  const systemBoxes = toIntegerOrNull(src.systemBoxes);
  const systemUnits = toIntegerOrNull(src.systemUnits);
  if (systemBoxes == null || systemUnits == null) return null;
  return {
    systemBoxes,
    systemUnits,
    rawQuantity: toNumberOrNull(src.rawQuantity),
    formattedQuantity: (src.formattedQuantity as string | null) ?? null,
    packSize: toIntegerOrNull(src.packSize),
    readAt: (src.readAt as string | null) ?? null,
  };
}

async function fetchLiveSnapshot(externalItemId: string, inventoryItemId: string): Promise<LiveSnapshot | null> {
  if (!FUNCTIONS_BASE) throw new Error("Supabase function URL is not configured");
  const jwt = getBearer();
  const url = new URL(`${FUNCTIONS_BASE}/items/${encodeURIComponent(externalItemId)}/stock`);
  url.searchParams.set("inventoryItemId", inventoryItemId);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok || typeof body === "string") return null;
  return normalizeLiveSnapshot(body);
}

async function mapWithConcurrency<T, R>(
  rows: T[],
  limit: number,
  mapper: (row: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(rows.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (index < rows.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(rows[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

export const createSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ name: z.string().min(2).max(120) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const { data: s, error } = await context.supabase
      .from("inventory_sessions")
      .insert({ name: data.name, created_by: context.userId, exported_at: new Date().toISOString() })
      .select("id, name, status, created_at")
      .single();
    if (error) throw new Error(error.message);
    return s;
  });

export const importItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        session_id: z.string().uuid(),
        rows: z.array(importedRowSchema).min(1).max(20000),
        replace: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    if (data.replace) {
      await context.supabase.from("inventory_items").delete().eq("session_id", data.session_id);
    }
    const chunkSize = 500;
    let inserted = 0;
    for (let i = 0; i < data.rows.length; i += chunkSize) {
      const chunk = data.rows.slice(i, i + chunkSize).map((r) => ({
        session_id: data.session_id,
        row_index: r.row_index,
        item_name_raw: r.item_name_raw,
        barcode: r.barcode,
        selling_price: r.selling_price,
        expiry_date: r.expiry_date,
        system_quantity_raw: r.system_quantity_raw,
        system_boxes: r.parsed.boxes,
        system_strips: r.parsed.strips,
        system_units: r.parsed.units,
        quantity_parse_status: r.parsed.status,
      }));
      const { error } = await context.supabase.from("inventory_items").insert(chunk);
      if (error) throw new Error(error.message);
      inserted += chunk.length;
    }
    await context.supabase
      .from("inventory_sessions")
      .update({ exported_at: new Date().toISOString() })
      .eq("id", data.session_id);
    return { inserted };
  });

export const listSessions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("inventory_sessions")
      .select("id, name, status, created_at, closed_at, exported_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getSession = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: s, error } = await context.supabase
      .from("inventory_sessions")
      .select("id, name, status, created_at, closed_at, exported_at")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return s;
  });

export const closeSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const { error } = await context.supabase
      .from("inventory_sessions")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

async function getCompletedItemIds(supabase: any, sessionId: string): Promise<Set<string>> {
  const data = await fetchAllSupabasePages<{ item_id: string }>(() =>
    supabase
      .from("inventory_counts")
      .select("item_id")
      .eq("session_id", sessionId)
      .eq("status", "approved")
      .eq("is_current", true)
      .order("item_id", { ascending: true }),
  );
  return new Set(data.map((row) => row.item_id));
}

async function getUncountedItemIds(
  supabase: any,
  sessionId: string,
  filters: { assignedTo?: string | null },
): Promise<string[]> {
  const completed = await getCompletedItemIds(supabase, sessionId);
  const data = await fetchAllSupabasePages<{ id: string }>(() => {
    let query = supabase
      .from("inventory_items")
      .select("id, row_index")
      .eq("session_id", sessionId)
      .order("row_index", { ascending: true })
      .order("id", { ascending: true });
    if (filters.assignedTo === null) {
      query = query.is("assigned_to", null);
    } else if (filters.assignedTo) {
      query = query.eq("assigned_to", filters.assignedTo);
    }
    return query;
  });
  return data
    .map((row: { id: string }) => row.id)
    .filter((itemId: string) => !completed.has(itemId));
}

async function updateAssignedToInChunks(
  supabase: any,
  ids: string[],
  assignedTo: string | null,
  guard: { assignedTo?: string | null } = {},
) {
  for (let i = 0; i < ids.length; i += WRITE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + WRITE_CHUNK_SIZE);
    let query = supabase.from("inventory_items").update({ assigned_to: assignedTo }).in("id", chunk);
    if (guard.assignedTo === null) {
      query = query.is("assigned_to", null);
    } else if (guard.assignedTo) {
      query = query.eq("assigned_to", guard.assignedTo);
    }
    const { error } = await query;
    if (error) throw new Error(error.message);
  }
}

export const assignItemsBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        session_id: z.string().uuid(),
        employee_id: z.string().uuid(),
        quantity: z.number().int().positive(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const availableIds = await getUncountedItemIds(context.supabase, data.session_id, {
      assignedTo: null,
    });
    if (data.quantity > availableIds.length) {
      throw new Error("العدد المطلوب أكبر من الأصناف غير المسندة");
    }
    const ids = availableIds.slice(0, data.quantity);
    if (ids.length === 0) return { assigned: 0 };
    await updateAssignedToInChunks(context.supabase, ids, data.employee_id, { assignedTo: null });
    return { assigned: ids.length };
  });

export const returnUncountedItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ session_id: z.string().uuid(), employee_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const ids = await getUncountedItemIds(context.supabase, data.session_id, {
      assignedTo: data.employee_id,
    });
    if (ids.length === 0) return { returned: 0 };
    await updateAssignedToInChunks(context.supabase, ids, null, { assignedTo: data.employee_id });
    return { returned: ids.length };
  });

export const transferUncountedItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        session_id: z.string().uuid(),
        from_employee_id: z.string().uuid(),
        to_employee_id: z.string().uuid(),
        quantity: z.number().int().positive().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    if (data.from_employee_id === data.to_employee_id) {
      throw new Error("اختر موظفاً مختلفاً للنقل");
    }
    const availableIds = await getUncountedItemIds(context.supabase, data.session_id, {
      assignedTo: data.from_employee_id,
    });
    const transferCount = data.quantity ?? availableIds.length;
    if (transferCount > availableIds.length) {
      throw new Error("العدد المطلوب أكبر من الأصناف المتبقية لدى الموظف");
    }
    const ids = availableIds.slice(0, transferCount);
    if (ids.length === 0) return { transferred: 0 };
    await updateAssignedToInChunks(context.supabase, ids, data.to_employee_id, {
      assignedTo: data.from_employee_id,
    });
    return { transferred: ids.length };
  });

// Progress stats for admin dashboard.
export const getSessionStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ session_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const itemRows = await fetchAllSupabasePages<{ id: string; assigned_to: string | null }>(() =>
      context.supabase
        .from("inventory_items")
        .select("id, assigned_to")
        .eq("session_id", data.session_id)
        .order("row_index", { ascending: true })
        .order("id", { ascending: true }),
    );
    const completed = await getCompletedItemIds(context.supabase, data.session_id);
    const total = itemRows.length;
    const assigned = itemRows.filter((item) => item.assigned_to).length;
    const counted = itemRows.filter((item) => completed.has(item.id)).length;
    const perEmployeeMap = new Map<string, { employee_id: string; assigned: number; completed: number; remaining: number }>();
    for (const item of itemRows) {
      if (!item.assigned_to) continue;
      const current = perEmployeeMap.get(item.assigned_to) ?? {
        employee_id: item.assigned_to,
        assigned: 0,
        completed: 0,
        remaining: 0,
      };
      current.assigned += 1;
      if (completed.has(item.id)) current.completed += 1;
      perEmployeeMap.set(item.assigned_to, current);
    }
    const perEmployee = Array.from(perEmployeeMap.values()).map((employee) => ({
      ...employee,
      remaining: employee.assigned - employee.completed,
    }));
    return {
      total,
      unassigned: total - assigned,
      assigned,
      counted,
      completed: counted,
      remaining: total - counted,
      perEmployee,
    };
  });

export const refreshSessionSnapshotFromLive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ session_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);

    const items = await fetchAllSupabasePages<SnapshotRefreshItem>(() =>
      context.supabase
        .from("inventory_items")
        .select(
          "id, session_id, external_item_id, pack_size, system_boxes, system_units, system_quantity_raw, raw_quantity_snapshot, system_boxes_snapshot, system_units_snapshot",
        )
        .eq("session_id", data.session_id)
        .order("row_index", { ascending: true })
        .order("id", { ascending: true }),
    );

    const liveResults = await mapWithConcurrency(items, SNAPSHOT_REFRESH_CONCURRENCY, async (item) => {
      if (!item.external_item_id) return { item, live: null };
      try {
        return {
          item,
          live: await fetchLiveSnapshot(item.external_item_id, item.id),
        };
      } catch {
        return { item, live: null };
      }
    });

    const approvedCounts = await fetchAllSupabasePages<SnapshotRefreshCount>(() =>
      context.supabase
        .from("inventory_counts")
        .select(
          "id, item_id, phys_boxes, phys_units, difference_raw, difference_boxes, difference_units, diff_status",
        )
        .eq("session_id", data.session_id)
        .eq("status", "approved")
        .eq("is_current", true)
        .order("item_id", { ascending: true }),
    );
    const countsByItem = new Map(approvedCounts.map((count) => [count.item_id, count]));

    const audits: Array<Record<string, unknown>> = [];
    let updatedItems = 0;
    let missingLiveStock = 0;
    let changedCountResults = 0;

    for (const { item, live } of liveResults) {
      if (!live) {
        missingLiveStock += 1;
        continue;
      }

      const nextPackSize = normalizePackSize(live.packSize) ?? normalizePackSize(item.pack_size);
      if (!nextPackSize) {
        missingLiveStock += 1;
        continue;
      }

      const rawFromLive = live.rawQuantity ?? qtyToRaw(
        { boxes: live.systemBoxes, units: live.systemUnits },
        nextPackSize,
      );
      const nextSystemRaw = rawFromLive == null ? null : Number(rawFromLive);
      const nextFormatted =
        live.formattedQuantity ??
        formatQtyArabic({ boxes: live.systemBoxes, strips: 0, units: live.systemUnits });

      const itemChanged =
        item.system_boxes !== live.systemBoxes ||
        item.system_units !== live.systemUnits ||
        item.pack_size !== nextPackSize ||
        Number(item.raw_quantity_snapshot ?? NaN) !== Number(nextSystemRaw ?? NaN) ||
        item.system_quantity_raw !== nextFormatted;

      if (!itemChanged) continue;

      const { error: itemErr } = await context.supabase
        .from("inventory_items")
        .update({
          system_boxes: live.systemBoxes,
          system_units: live.systemUnits,
          system_quantity_raw: nextFormatted,
          pack_size: nextPackSize,
          raw_quantity_snapshot: nextSystemRaw,
          system_boxes_snapshot: live.systemBoxes,
          system_units_snapshot: live.systemUnits,
          formatted_quantity_snapshot: nextFormatted,
          conversion_status: nextSystemRaw != null && nextSystemRaw < 0 ? "negative_stock" : "ok",
          source_read_at: live.readAt,
        })
        .eq("id", item.id)
        .eq("session_id", data.session_id);
      if (itemErr) throw new Error(itemErr.message);

      audits.push({
        session_id: data.session_id,
        inventory_item_id: item.id,
        old_system_boxes: item.system_boxes,
        old_system_units: item.system_units,
        old_system_quantity_raw: item.system_quantity_raw,
        old_pack_size: item.pack_size,
        old_raw_quantity_snapshot: item.raw_quantity_snapshot,
        new_system_boxes: live.systemBoxes,
        new_system_units: live.systemUnits,
        new_system_quantity_raw: nextFormatted,
        new_pack_size: nextPackSize,
        new_raw_quantity_snapshot: nextSystemRaw,
        executed_by: context.userId,
      });
      updatedItems += 1;

      const count = countsByItem.get(item.id);
      if (!count) continue;

      const physicalRaw = qtyToRaw(
        { boxes: count.phys_boxes, units: count.phys_units },
        nextPackSize,
      );
      const differenceRaw =
        physicalRaw == null || nextSystemRaw == null ? null : physicalRaw - nextSystemRaw;
      const differenceQty =
        differenceRaw == null ? null : rawToQty(differenceRaw, nextPackSize);
      const diffCols =
        differenceRaw == null || !differenceQty
          ? {
              physical_raw_quantity: physicalRaw,
              difference_raw: null,
              difference_boxes: null,
              difference_units: null,
              diff_status: "conversion_unavailable",
            }
          : {
              physical_raw_quantity: physicalRaw,
              difference_raw: differenceRaw,
              difference_boxes: differenceQty.boxes,
              difference_units: differenceQty.units,
              diff_status: diffStatus(differenceQty),
            };

      const countChanged =
        Number(count.difference_raw ?? NaN) !== Number(diffCols.difference_raw ?? NaN) ||
        count.difference_boxes !== diffCols.difference_boxes ||
        count.difference_units !== diffCols.difference_units ||
        count.diff_status !== diffCols.diff_status;

      const { error: countErr } = await context.supabase
        .from("inventory_counts")
        .update(diffCols)
        .eq("id", count.id);
      if (countErr) throw new Error(countErr.message);
      if (countChanged) changedCountResults += 1;
    }

    for (let i = 0; i < audits.length; i += WRITE_CHUNK_SIZE) {
      const chunk = audits.slice(i, i + WRITE_CHUNK_SIZE);
      const { error } = await (context.supabase as any)
        .from("inventory_snapshot_refresh_audit")
        .insert(chunk);
      if (error) throw new Error(error.message);
    }

    return {
      updatedItems,
      missingLiveStock,
      changedCountResults,
    };
  });
