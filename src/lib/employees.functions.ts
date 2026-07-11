import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// Bootstrap: promote the first authenticated user to admin if no admin exists.
// Safe because it only grants admin when the user_roles table has no admin yet.
export const bootstrapAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: existingAdmins, error: e1 } = await supabaseAdmin
      .from("user_roles")
      .select("id")
      .eq("role", "admin")
      .limit(1);
    if (e1) throw new Error(e1.message);
    if ((existingAdmins ?? []).length > 0) {
      return { promoted: false };
    }
    const { error: e2 } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: context.userId, role: "admin" });
    if (e2) throw new Error(e2.message);
    return { promoted: true };
  });

const usernameRe = /^[a-z0-9_]{3,32}$/;
const pinRe = /^[0-9]{6}$/;

export const createEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        username: z.string().regex(usernameRe, "اسم المستخدم: أحرف صغيرة وأرقام فقط، 3-32 حرف"),
        display_name: z.string().min(2).max(80),
        pin: z.string().regex(pinRe, "الرقم السري: 6 أرقام"),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const email = `${data.username.trim().toLowerCase()}@stockcount.local`;
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: data.pin,
      email_confirm: true,
      user_metadata: { username: data.username, display_name: data.display_name },
    });
    if (error || !created.user) throw new Error(error?.message || "Failed to create user");
    const uid = created.user.id;
    const { error: pErr } = await supabaseAdmin.from("profiles").insert({
      id: uid,
      username: data.username,
      display_name: data.display_name,
      pin: data.pin,
      created_by: context.userId,
    });
    if (pErr) throw new Error(pErr.message);
    const { error: rErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: uid, role: "employee" });
    if (rErr) throw new Error(rErr.message);
    return { id: uid, username: data.username, display_name: data.display_name };
  });

export const resetEmployeePin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ user_id: z.string().uuid(), pin: z.string().regex(pinRe) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
      password: data.pin,
    });
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("profiles").update({ pin: data.pin }).eq("id", data.user_id);
    return { ok: true };
  });

export const listEmployees = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden");
    const { data: roleRows, error: rErr } = await context.supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "employee");
    if (rErr) throw new Error(rErr.message);
    const ids = (roleRows ?? []).map((r) => r.user_id);
    if (ids.length === 0) return [];
    const { data, error } = await context.supabase
      .from("profiles")
      .select("id, username, display_name, pin, created_at")
      .in("id", ids)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const profiles = data ?? [];

    // Performance: counts + approved counts + sessions participated per user
    const { data: countRows } = await context.supabase
      .from("inventory_counts")
      .select("counted_by, status, is_current, session_id")
      .in("counted_by", ids)
      .eq("is_current", true);
    const stats = new Map<
      string,
      { counted: number; approved: number; sessions: Set<string> }
    >();
    for (const id of ids) stats.set(id, { counted: 0, approved: 0, sessions: new Set() });
    for (const r of countRows ?? []) {
      const s = stats.get(r.counted_by as string);
      if (!s) continue;
      s.counted += 1;
      if (r.status === "approved") s.approved += 1;
      if (r.session_id) s.sessions.add(r.session_id as string);
    }
    return profiles.map((p) => {
      const s = stats.get(p.id)!;
      return {
        ...p,
        counted: s.counted,
        approved: s.approved,
        sessions: s.sessions.size,
      };
    });
  });