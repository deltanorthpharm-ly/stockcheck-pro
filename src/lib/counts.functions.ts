import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

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
        ...openCols,
        ...submitCols,
        ...recountCols,
      })
      .select("id")
      .single();
    if (iErr) throw new Error(iErr.message);
    return { id: inserted.id, deduped: false };
  });