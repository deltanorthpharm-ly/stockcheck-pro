import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

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

// Assign items by splitting Excel row order evenly across selected employees.
// Stores explicit item IDs (via assigned_to) so future re-imports do not
// reassign items — assignments live on inventory_items.assigned_to.
export const autoAssignByRange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        session_id: z.string().uuid(),
        employee_ids: z.array(z.string().uuid()).min(1),
        only_unassigned: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    let query = context.supabase
      .from("inventory_items")
      .select("id")
      .eq("session_id", data.session_id)
      .order("row_index", { ascending: true });
    if (data.only_unassigned) query = query.is("assigned_to", null);
    const { data: items, error } = await query;
    if (error) throw new Error(error.message);
    const list = items ?? [];
    if (list.length === 0) return { assigned: 0 };
    const perEmp = Math.ceil(list.length / data.employee_ids.length);
    const updates: Promise<unknown>[] = [];
    for (let i = 0; i < list.length; i++) {
      const empIdx = Math.min(Math.floor(i / perEmp), data.employee_ids.length - 1);
      const emp = data.employee_ids[empIdx];
      const p = context.supabase
          .from("inventory_items")
          .update({ assigned_to: emp })
          .eq("id", list[i].id);
      // Cast the builder-thenable to a Promise for parallel awaiting.
      updates.push(p as unknown as Promise<unknown>);
      // Batch to avoid too many parallel HTTP calls
      if (updates.length >= 25) {
        await Promise.all(updates.splice(0, updates.length));
      }
    }
    if (updates.length) await Promise.all(updates);
    return { assigned: list.length };
  });

export const clearAssignments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ session_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const { error } = await context.supabase
      .from("inventory_items")
      .update({ assigned_to: null })
      .eq("session_id", data.session_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Progress stats for admin dashboard.
export const getSessionStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ session_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { count: total } = await context.supabase
      .from("inventory_items")
      .select("id", { count: "exact", head: true })
      .eq("session_id", data.session_id);
    const { count: assigned } = await context.supabase
      .from("inventory_items")
      .select("id", { count: "exact", head: true })
      .eq("session_id", data.session_id)
      .not("assigned_to", "is", null);
    const { count: counted } = await context.supabase
      .from("inventory_counts")
      .select("id", { count: "exact", head: true })
      .eq("session_id", data.session_id)
      .eq("status", "approved")
      .eq("is_current", true);
    return {
      total: total ?? 0,
      assigned: assigned ?? 0,
      counted: counted ?? 0,
      remaining: (total ?? 0) - (counted ?? 0),
    };
  });