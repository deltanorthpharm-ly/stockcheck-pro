import { rawToQty } from "@/lib/quantity-parser";

type DiffStatusLabel = "match" | "shortage" | "excess";

type SavedDiff = {
  diff_status?: string | null;
  difference_raw?: number | string | null;
  difference_boxes?: number | null;
  difference_units?: number | null;
};

export function normalizeInventoryDiffStatus(status: string | null | undefined): DiffStatusLabel | null {
  if (!status) return null;
  if (status === "match" || status === "matched") return "match";
  if (status === "shortage") return "shortage";
  if (status === "excess" || status === "surplus") return "excess";
  return null;
}

export function formatInventoryDiffBadge(
  diff: SavedDiff | null | undefined,
  packSize?: number | null,
): string {
  if (!diff) return "غير محدد";

  const status = normalizeInventoryDiffStatus(diff.diff_status);
  if (status === "match") return "مطابق";

  const label = status === "shortage" ? "عجز" : status === "excess" ? "زيادة" : null;
  if (!label) return "غير محدد";

  let boxes = 0;
  let units = 0;
  const raw = Number(diff.difference_raw);

  if (Number.isFinite(raw) && raw !== 0) {
    const qty = rawToQty(raw, packSize ?? 1);
    boxes = qty.boxes;
    units = qty.units;
  } else {
    boxes = Number(diff.difference_boxes ?? 0);
    units = Number(diff.difference_units ?? 0);
  }

  const parts = [
    boxes ? `${formatDiffNumber(Math.abs(boxes))} علبة` : null,
    units ? `${formatDiffNumber(Math.abs(units))} وحدة` : null,
  ].filter(Boolean);

  return parts.length ? `${label} ${parts.join(" و")}` : label;
}

function formatDiffNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toLocaleString("en-US");
}
