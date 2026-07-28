import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { diffStatus, formatQtyArabic, normalizePackSize, rawToQty, qtyToRaw } from "@/lib/quantity-parser";

async function requireAdmin(context: { supabase: any; userId: string }) {
  const { data: isAdmin } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (!isAdmin) throw new Error("Forbidden: admin only");
}

// Save (or approve) a physical count.
// - When status='draft' we upsert the current draft version.
// - When status='approved' we mark previous current row as history and insert a new version.
// - client_operation_id is used for offline idempotency (unique per counter).
export const saveCount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        item_id: z.string().uuid(),
        session_id: z.string().uuid(),
        phys_boxes: z.number().int().min(0),
        phys_strips: z.number().int().min(0),
        phys_units: z.number().int().min(0),
        status: z.enum(["draft", "approved"]),
        client_operation_id: z.string().min(4).max(120),
        open_snapshot: z
          .object({
            raw_quantity: z.number().nullable().optional(),
            pack_size: z.number().int().nullable().optional(),
            system_boxes: z.number().int().nullable().optional(),
            system_units: z.number().int().nullable().optional(),
            source_read_at: z.string().nullable().optional(),
            opened_at: z.string().nullable().optional(),
          })
          .optional(),
        submit_snapshot: z
          .object({
            raw_quantity: z.number().nullable().optional(),
            pack_size: z.number().int().nullable().optional(),
            system_boxes: z.number().int().nullable().optional(),
            system_units: z.number().int().nullable().optional(),
            source_read_at: z.string().nullable().optional(),
            submitted_at: z.string().nullable().optional(),
          })
          .optional(),
        requires_recount: z.boolean().optional(),
        recount_reason: z.enum(["stock_changed", "pack_size_changed"]).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });

    // Idempotency: return existing row if already saved with this operation id.
    const { data: existing } = await context.supabase
      .from("inventory_counts")
      .select("id, status, count_version")
      .eq("counted_by", context.userId)
      .eq("client_operation_id", data.client_operation_id)
      .maybeSingle();
    if (existing) return { id: existing.id, deduped: true };

    // Find current version (if any).
    const { data: current } = await context.supabase
      .from("inventory_counts")
      .select("id, count_version, status")
      .eq("item_id", data.item_id)
      .eq("is_current", true)
      .maybeSingle();

    if (current?.status === "approved" && !isAdmin) {
      throw new Error("تم اعتماد هذا الصنف ولا يمكن تعديله.");
    }

    const { data: itemRow, error: itemErr } = await context.supabase
      .from("inventory_items")
      .select("system_boxes, system_units, pack_size")
      .eq("id", data.item_id)
      .eq("session_id", data.session_id)
      .maybeSingle();
    if (itemErr) throw new Error(itemErr.message);
    if (!itemRow) throw new Error("Inventory item not found");

    // Difference calculations must remain tied to the fixed session snapshot.
    // Live open/submit snapshots are stored for audit/recount only.
    const packSize = normalizePackSize(itemRow.pack_size);
    const systemBoxes = itemRow.system_boxes;
    const systemUnits = itemRow.system_units;
    const physicalRaw = qtyToRaw({ boxes: data.phys_boxes, units: data.phys_units }, packSize);
    const systemRaw = qtyToRaw({ boxes: systemBoxes, units: systemUnits }, packSize);
    const differenceRaw =
      physicalRaw == null || systemRaw == null ? null : physicalRaw - systemRaw;
    const differenceQty =
      differenceRaw == null || !packSize ? null : rawToQty(differenceRaw, packSize);
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

    const openCols = data.open_snapshot
      ? {
          raw_quantity_at_open: data.open_snapshot.raw_quantity ?? null,
          pack_size_at_open: data.open_snapshot.pack_size ?? null,
          system_boxes_at_open: data.open_snapshot.system_boxes ?? null,
          system_units_at_open: data.open_snapshot.system_units ?? null,
          source_read_at_open: data.open_snapshot.source_read_at ?? null,
          opened_at: data.open_snapshot.opened_at ?? null,
        }
      : {};
    const submitCols = data.submit_snapshot
      ? {
          raw_quantity_at_submit: data.submit_snapshot.raw_quantity ?? null,
          pack_size_at_submit: data.submit_snapshot.pack_size ?? null,
          system_boxes_at_submit: data.submit_snapshot.system_boxes ?? null,
          system_units_at_submit: data.submit_snapshot.system_units ?? null,
          source_read_at_submit: data.submit_snapshot.source_read_at ?? null,
          submitted_at: data.submit_snapshot.submitted_at ?? null,
        }
      : {};
    const recountCols =
      data.requires_recount !== undefined
        ? {
            requires_recount: data.requires_recount,
            recount_reason: data.recount_reason ?? null,
          }
        : {};

    if (current && current.status === "draft" && data.status === "draft") {
      // Update the existing draft in place.
      const { error: uErr } = await context.supabase
        .from("inventory_counts")
        .update({
          phys_boxes: data.phys_boxes,
          phys_strips: data.phys_strips,
          phys_units: data.phys_units,
          client_operation_id: data.client_operation_id,
          ...diffCols,
          ...openCols,
          ...submitCols,
          ...recountCols,
        })
        .eq("id", current.id);
      if (uErr) throw new Error(uErr.message);
      return { id: current.id, deduped: false };
    }

    // Retire previous current version (keeps history).
    if (current) {
      const { error: dErr } = await context.supabase
        .from("inventory_counts")
        .update({ is_current: false })
        .eq("id", current.id);
      if (dErr) throw new Error(dErr.message);
    }

    const { data: inserted, error: iErr } = await context.supabase
      .from("inventory_counts")
      .insert({
        item_id: data.item_id,
        session_id: data.session_id,
        counted_by: context.userId,
        phys_boxes: data.phys_boxes,
        phys_strips: data.phys_strips,
        phys_units: data.phys_units,
        status: data.status,
        count_version: (current?.count_version ?? 0) + 1,
        is_current: true,
        client_operation_id: data.client_operation_id,
        ...diffCols,
        ...openCols,
        ...submitCols,
        ...recountCols,
      })
      .select("id")
      .single();
    if (iErr) throw new Error(iErr.message);
    return { id: inserted.id, deduped: false };
  });

export const cancelApprovedCount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        item_id: z.string().uuid(),
        session_id: z.string().uuid(),
        live_snapshot: z
          .object({
            raw_quantity: z.number().nullable().optional(),
            pack_size: z.number().int().nullable().optional(),
            system_boxes: z.number().int().nullable().optional(),
            system_units: z.number().int().nullable().optional(),
            formatted_quantity: z.string().nullable().optional(),
            source_read_at: z.string().nullable().optional(),
          })
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context);

    const { data: current, error: currentErr } = await context.supabase
      .from("inventory_counts")
      .select(
        "id, phys_boxes, phys_strips, phys_units, difference_raw, difference_boxes, difference_units, diff_status",
      )
      .eq("item_id", data.item_id)
      .eq("session_id", data.session_id)
      .eq("status", "approved")
      .eq("is_current", true)
      .maybeSingle();
    if (currentErr) throw new Error(currentErr.message);
    if (!current) throw new Error("لا يوجد عد معتمد لإلغائه.");

    const { data: itemRow, error: itemErr } = await context.supabase
      .from("inventory_items")
      .select(
        "id, session_id, pack_size, system_boxes, system_units, system_quantity_raw, raw_quantity_snapshot",
      )
      .eq("id", data.item_id)
      .eq("session_id", data.session_id)
      .maybeSingle();
    if (itemErr) throw new Error(itemErr.message);
    if (!itemRow) throw new Error("Inventory item not found");

    const live = data.live_snapshot;
    const nextPackSize =
      normalizePackSize(live?.pack_size) ?? normalizePackSize(itemRow.pack_size);
    const hasUsableLive =
      live &&
      live.system_boxes != null &&
      live.system_units != null &&
      nextPackSize != null;

    if (hasUsableLive) {
      const nextRaw =
        live.raw_quantity ??
        qtyToRaw(
          { boxes: live.system_boxes ?? 0, units: live.system_units ?? 0 },
          nextPackSize,
        );
      const nextFormatted =
        live.formatted_quantity ??
        formatQtyArabic({
          boxes: live.system_boxes ?? 0,
          strips: 0,
          units: live.system_units ?? 0,
        });

      const { error: updateItemErr } = await context.supabase
        .from("inventory_items")
        .update({
          system_boxes: live.system_boxes,
          system_units: live.system_units,
          system_quantity_raw: nextFormatted,
          pack_size: nextPackSize,
          raw_quantity_snapshot: nextRaw,
          system_boxes_snapshot: live.system_boxes,
          system_units_snapshot: live.system_units,
          formatted_quantity_snapshot: nextFormatted,
          conversion_status: nextRaw != null && nextRaw < 0 ? "negative_stock" : "ok",
          source_read_at: live.source_read_at ?? new Date().toISOString(),
        })
        .eq("id", data.item_id)
        .eq("session_id", data.session_id);
      if (updateItemErr) throw new Error(updateItemErr.message);
    }

    const { error: retireErr } = await context.supabase
      .from("inventory_counts")
      .update({
        is_current: false,
        requires_recount: false,
        recount_reason: null,
      })
      .eq("id", current.id);
    if (retireErr) throw new Error(retireErr.message);

    const { error: auditErr } = await (context.supabase as any)
      .from("inventory_count_unapproval_audit")
      .insert({
        session_id: data.session_id,
        inventory_item_id: data.item_id,
        count_id: current.id,
        old_phys_boxes: current.phys_boxes,
        old_phys_units: current.phys_units,
        old_difference_raw: current.difference_raw,
        old_difference_boxes: current.difference_boxes,
        old_difference_units: current.difference_units,
        old_diff_status: current.diff_status,
        old_system_boxes: itemRow.system_boxes,
        old_system_units: itemRow.system_units,
        old_raw_quantity_snapshot: itemRow.raw_quantity_snapshot,
        new_system_boxes: hasUsableLive ? live?.system_boxes : null,
        new_system_units: hasUsableLive ? live?.system_units : null,
        new_raw_quantity_snapshot: hasUsableLive ? live?.raw_quantity ?? null : null,
        cancelled_by: context.userId,
      });
    if (auditErr) throw new Error(auditErr.message);

    return { ok: true, snapshotUpdated: Boolean(hasUsableLive) };
  });
