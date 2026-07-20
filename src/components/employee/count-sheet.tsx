import { useEffect, useMemo, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useServerFn } from "@tanstack/react-start";
import { saveCount } from "@/lib/counts.functions";
import { getLiveItemStock, type LiveStock } from "@/lib/teryaq-stock.functions";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatQtyArabic, diffTriple, diffStatus } from "@/lib/quantity-parser";
import { cn } from "@/lib/utils";
import { Package, Pill, Loader2, AlertTriangle } from "lucide-react";

type Item = {
  id: string;
  session_id: string;
  external_item_id: string | null;
  item_name_raw: string;
  barcode: string | null;
  pack_size: number | null;
  system_boxes: number;
  system_strips: number;
  system_units: number;
  system_quantity_raw: string | null;
  current?: {
    phys_boxes: number;
    phys_strips: number;
    phys_units: number;
    status: "draft" | "approved";
  };
};

function makeOpId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function CountSheet({
  item,
  onClose,
  onSaved,
}: {
  item: Item | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [boxes, setBoxes] = useState(0);
  const [units, setUnits] = useState(0);
  const [live, setLive] = useState<LiveStock | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [openSnap, setOpenSnap] = useState<LiveStock | null>(null);
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const [recountBlock, setRecountBlock] = useState<
    | null
    | { reason: "stock_changed" | "pack_size_changed"; submit: LiveStock }
  >(null);
  const save = useServerFn(saveCount);
  const fetchLive = useServerFn(getLiveItemStock);

  useEffect(() => {
    if (item) {
      setBoxes(item.current?.phys_boxes ?? 0);
      setUnits(item.current?.phys_units ?? 0);
      setLive(null);
      setLiveError(null);
      setOpenSnap(null);
      setRecountBlock(null);
      setOpenedAt(null);
      if (item.external_item_id) {
        setLiveLoading(true);
        const openedAtIso = new Date().toISOString();
        fetchLive({ data: { external_item_id: item.external_item_id } })
          .then((s) => {
            setLive(s);
            setOpenSnap(s);
            setOpenedAt(openedAtIso);
            setLiveError(null);
          })
          .catch((e: Error) => {
            setLiveError(e.message || "تعذر جلب الرصيد");
          })
          .finally(() => setLiveLoading(false));
      }
    }
  }, [item, fetchLive]);

  // Displayed system stock: live when available, else saved snapshot.
  const displayedSys = useMemo(() => {
    if (live) {
      return {
        boxes: live.systemBoxes,
        strips: 0,
        units: live.systemUnits,
      };
    }
    return item
      ? { boxes: item.system_boxes, strips: item.system_strips, units: item.system_units }
      : { boxes: 0, strips: 0, units: 0 };
  }, [live, item]);

  const displayedPackSize = live?.packSize ?? item?.pack_size ?? 1;

  const diff = useMemo(() => {
    if (!item) return { boxes: 0, strips: 0, units: 0 };
    return diffTriple(displayedSys, { boxes, strips: displayedSys.strips, units }, displayedPackSize);
  }, [item, boxes, units, displayedSys, displayedPackSize]);

  const status = useMemo(() => diffStatus(diff), [diff]);

  const mut = useMutation({
    mutationFn: async (kind: "draft" | "approved") => {
      if (!item) return;
      // On approve: fetch live again and compare with opening snapshot.
      let submitSnap: LiveStock | null = null;
      let requires_recount = false;
      let recount_reason: "stock_changed" | "pack_size_changed" | null = null;
      if (kind === "approved" && item.external_item_id && openSnap) {
        try {
          submitSnap = await fetchLive({ data: { external_item_id: item.external_item_id } });
          if (submitSnap.rawQuantity !== openSnap.rawQuantity) {
            requires_recount = true;
            recount_reason = "stock_changed";
          } else if (submitSnap.packSize !== openSnap.packSize) {
            requires_recount = true;
            recount_reason = "pack_size_changed";
          }
        } catch {
          // If refetch fails, don't block approval on change-detection.
        }
      }

      const openPayload = openSnap && openedAt
        ? {
            raw_quantity: openSnap.rawQuantity,
            pack_size: openSnap.packSize,
            system_boxes: openSnap.systemBoxes,
            system_units: openSnap.systemUnits,
            source_read_at: openSnap.readAt,
            opened_at: openedAt,
          }
        : undefined;
      const submitPayload = submitSnap
        ? {
            raw_quantity: submitSnap.rawQuantity,
            pack_size: submitSnap.packSize,
            system_boxes: submitSnap.systemBoxes,
            system_units: submitSnap.systemUnits,
            source_read_at: submitSnap.readAt,
            submitted_at: new Date().toISOString(),
          }
        : undefined;

      // If a recount is required, save as draft with requires_recount=true and
      // surface the choice to the user; do NOT approve the stale count.
      if (requires_recount && recount_reason && submitSnap) {
        await save({
          data: {
            item_id: item.id,
            session_id: item.session_id,
            phys_boxes: boxes,
            phys_strips: item.current?.phys_strips ?? 0,
            phys_units: units,
            status: "draft",
            client_operation_id: makeOpId(),
            open_snapshot: openPayload,
            submit_snapshot: submitPayload,
            requires_recount: true,
            recount_reason,
          },
        });
        setRecountBlock({ reason: recount_reason, submit: submitSnap });
        return { blocked: true as const };
      }

      return save({
        data: {
          item_id: item.id,
          session_id: item.session_id,
          phys_boxes: boxes,
          phys_strips: item.current?.phys_strips ?? 0,
          phys_units: units,
          status: kind,
          client_operation_id: makeOpId(),
          open_snapshot: openPayload,
          submit_snapshot: submitPayload,
          requires_recount: kind === "approved" ? false : undefined,
          recount_reason: kind === "approved" ? null : undefined,
        },
      });
    },
    onSuccess: (res, kind) => {
      if (res && "blocked" in res && res.blocked) {
        toast.warning("تغير رصيد المنظومة أثناء العد");
        return;
      }
      toast.success(kind === "approved" ? "تم اعتماد العدد" : "تم حفظ مسودة");
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function refetchLiveNow() {
    if (!item?.external_item_id) return;
    setLiveLoading(true);
    setLiveError(null);
    const openedAtIso = new Date().toISOString();
    try {
      const s = await fetchLive({ data: { external_item_id: item.external_item_id } });
      setLive(s);
      setOpenSnap(s);
      setOpenedAt(openedAtIso);
      setRecountBlock(null);
    } catch (e) {
      setLiveError((e as Error).message || "تعذر جلب الرصيد");
    } finally {
      setLiveLoading(false);
    }
  }

  return (
    <Sheet open={!!item} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto p-0">
        {item && (
          <>
            <SheetHeader className="p-4 border-b border-border">
              <SheetTitle className="text-base leading-snug text-start">
                {item.item_name_raw}
              </SheetTitle>
              {(item.external_item_id || item.barcode) && (
                <div className="text-xs text-muted-foreground text-start">
                  {[item.external_item_id ? `Code: ${item.external_item_id}` : null, item.barcode ? `Barcode: ${item.barcode}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              )}
            </SheetHeader>
            <div className="p-4 space-y-4">
              <div className="rounded-2xl bg-muted/50 border border-border p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-semibold text-muted-foreground text-start">
                    المخزون بالنظام
                  </div>
                  {liveLoading ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      جاري جلب الرصيد الحالي...
                    </span>
                  ) : live ? (
                    <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-success/15 text-success">
                      مباشر
                    </span>
                  ) : liveError ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2 py-0.5 bg-warning/15 text-warning">
                      <AlertTriangle className="size-3" />
                      رصيد محفوظ — ليس مباشرًا
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center justify-around gap-3">
                  <div className="flex items-center gap-2">
                    <Package className="size-5 text-primary" />
                    <span className="text-lg font-bold tabular-nums">{displayedSys.boxes}</span>
                    <span className="text-xs text-muted-foreground">علبة</span>
                  </div>
                  <div className="h-8 w-px bg-border" />
                  <div className="flex items-center gap-2">
                    <Pill className="size-5 text-primary" />
                    <span className="text-lg font-bold tabular-nums">{displayedSys.units}</span>
                    <span className="text-xs text-muted-foreground">وحدة</span>
                  </div>
                </div>
                {live?.formattedQuantity && (
                  <div className="text-[11px] text-muted-foreground text-center mt-2">
                    {live.formattedQuantity}
                  </div>
                )}
              </div>

              {recountBlock && (
                <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 space-y-2">
                  <div className="text-sm font-semibold text-destructive text-center">
                    تغير رصيد المنظومة أثناء العد. يجب إعادة عد الصنف.
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="outline" onClick={onClose}>
                      تأجيل للمراجعة
                    </Button>
                    <Button
                      onClick={() => {
                        setBoxes(0);
                        setUnits(0);
                        void refetchLiveNow();
                      }}
                    >
                      إعادة العد الآن
                    </Button>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <BigQtyCard
                  icon={<Package className="size-5" />}
                  title="علبة"
                  value={boxes}
                  onChange={setBoxes}
                  inputId="qty-boxes"
                  nextId="qty-units"
                />
                <BigQtyCard
                  icon={<Pill className="size-5" />}
                  title="وحدة"
                  value={units}
                  onChange={setUnits}
                  inputId="qty-units"
                  nextId="btn-confirm"
                />
              </div>

              <div
                className={cn(
                  "rounded-xl p-3 text-sm font-semibold text-center",
                  status === "match" && "bg-success/15 text-success",
                  status === "shortage" && "bg-destructive/15 text-destructive",
                  status === "excess" && "bg-info/15 text-info",
                )}
              >
                {status === "match"
                  ? "✅ مطابق"
                  : status === "shortage"
                    ? `🔴 عجز: ${fmtDiffAbs(diff)}`
                    : `🔵 زيادة: ${fmtDiffAbs(diff)}`}
              </div>

              <div className="grid grid-cols-2 gap-2 sticky bottom-0 bg-background pt-2">
                <Button
                  variant="outline"
                  className="h-14 text-base"
                  disabled={mut.isPending || liveLoading}
                  onClick={() => mut.mutate("draft")}
                >
                  حفظ مسودة
                </Button>
                <Button
                  id="btn-confirm"
                  className="h-14 font-bold text-base"
                  disabled={mut.isPending || liveLoading || !!recountBlock}
                  onClick={() => mut.mutate("approved")}
                >
                  اعتماد العدد
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground text-center">
                الفرق يُحسب تلقائياً. لا يمكن تعديله يدوياً.
              </p>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function BigQtyCard({
  icon,
  title,
  value,
  onChange,
  inputId,
  nextId,
}: {
  icon: React.ReactNode;
  title: string;
  value: number;
  onChange: (n: number) => void;
  inputId: string;
  nextId: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-3 shadow-sm space-y-2">
      <div className="flex items-center justify-center gap-2 text-muted-foreground">
        <span className="text-primary">{icon}</span>
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <Input
        id={inputId}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        enterKeyHint={nextId === "btn-confirm" ? "done" : "next"}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) =>
          onChange(Math.max(0, parseInt(e.target.value.replace(/\D/g, "") || "0", 10)))
        }
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const el = document.getElementById(nextId) as HTMLElement | null;
            if (el && "focus" in el) el.focus();
            if (el && el.tagName === "BUTTON") (el as HTMLButtonElement).focus();
          }
        }}
        className="h-16 text-center text-4xl font-black tabular-nums px-1"
        dir="ltr"
      />
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="secondary"
          className="h-9 text-sm"
          onClick={() => onChange(Math.max(0, value - 1))}
        >
          −1
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="h-9 text-sm"
          onClick={() => onChange(value + 1)}
        >
          +1
        </Button>
      </div>
    </div>
  );
}

function fmtDiffAbs(d: { boxes: number; strips: number; units: number }) {
  const parts: string[] = [];
  if (d.boxes) parts.push(`${Math.abs(d.boxes)} علبة`);
  if (d.units) parts.push(`${Math.abs(d.units)} وحدة`);
  return parts.length ? parts.join(" و") : formatQtyArabic({ boxes: 0, strips: 0, units: 0 });
}
