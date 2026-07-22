import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { fetchAllSupabasePages } from "@/lib/supabase-pagination";

const WRITE_CHUNK_SIZE = 500;

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
