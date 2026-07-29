import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const FUNCTIONS_BASE = `${process.env.SUPABASE_URL ?? ""}/functions/v1/teryaq-stockcount-proxy`;

function getBearer(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getRequestHeader } = require("@tanstack/react-start/server") as {
    getRequestHeader: (n: string) => string | undefined;
  };
  const h = getRequestHeader("authorization") ?? "";
  return h.replace(/^Bearer\s+/i, "");
}

export type LiveStock = {
  systemBoxes: number;
  systemUnits: number;
  rawQuantity: number;
  formattedQuantity: string | null;
  packSize: number | null;
  readAt: string;
  lastLiveRefreshAt: string;
  source: "live" | "cached" | "fallback";
  ageMinutes: number;
};

// Fetch live stock for a single item via the Teryaq proxy.
// Employees may call this only for items assigned to them in an OPEN session
// (enforced by the edge function itself).
export const getLiveItemStock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      external_item_id: z.string().min(1).max(64),
      inventory_item_id: z.string().uuid(),
      forceRefresh: z.boolean().optional(),
    }).parse(input),
  )
  .handler(async ({ data }): Promise<LiveStock> => {
    const jwt = getBearer();
    const url = new URL(`${FUNCTIONS_BASE}/items/${encodeURIComponent(data.external_item_id)}/stock`);
    url.searchParams.set("inventoryItemId", data.inventory_item_id);
    if (data.forceRefresh) url.searchParams.set("forceRefresh", "1");
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const msg = typeof body === "string" ? body : (body as { error?: string })?.error ?? `HTTP ${res.status}`;
      throw new Error(msg);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    // Some upstreams wrap in { data: {...} }
    const src = (b.data && typeof b.data === "object" ? b.data : b) as Record<string, unknown>;
    const num = (v: unknown) => (v == null ? 0 : Number(v));
    const intOrNull = (v: unknown) => {
      if (v == null) return null;
      const n = Number(v);
      return Number.isInteger(n) ? n : null;
    };
    return {
      systemBoxes: Math.max(0, Math.trunc(num(src.systemBoxes))),
      systemUnits: Math.max(0, Math.trunc(num(src.systemUnits))),
      rawQuantity: num(src.rawQuantity),
      formattedQuantity: (src.formattedQuantity as string | null) ?? null,
      packSize: intOrNull(src.packSize),
      readAt: (src.readAt as string | null) ?? new Date().toISOString(),
      lastLiveRefreshAt: (src.lastLiveRefreshAt as string | null) ?? (src.readAt as string | null) ?? new Date().toISOString(),
      source: src.source === "cached" || src.source === "fallback" ? src.source : "live",
      ageMinutes: Number.isFinite(num(src.ageMinutes)) ? num(src.ageMinutes) : 0,
    };
  });
