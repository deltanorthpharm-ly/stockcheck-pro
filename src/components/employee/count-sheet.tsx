import { useEffect, useMemo, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useServerFn } from "@tanstack/react-start";
import { saveCount } from "@/lib/counts.functions";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatQtyArabic, diffTriple, diffStatus } from "@/lib/quantity-parser";
import { cn } from "@/lib/utils";
import { Package, Pill } from "lucide-react";

type Item = {
  id: string;
  session_id: string;
  item_name_raw: string;
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
  const save = useServerFn(saveCount);

  useEffect(() => {
    if (item) {
      setBoxes(item.current?.phys_boxes ?? 0);
      setUnits(item.current?.phys_units ?? 0);
    }
  }, [item]);

  const diff = useMemo(() => {
    if (!item) return { boxes: 0, strips: 0, units: 0 };
    return diffTriple(
      { boxes: item.system_boxes, strips: item.system_strips, units: item.system_units },
      { boxes, strips: item.system_strips, units },
    );
  }, [item, boxes, units]);

  const status = useMemo(() => diffStatus(diff), [diff]);

  const mut = useMutation({
    mutationFn: async (kind: "draft" | "approved") => {
      if (!item) return;
      return save({
        data: {
          item_id: item.id,
          session_id: item.session_id,
          phys_boxes: boxes,
          phys_strips: item.current?.phys_strips ?? 0,
          phys_units: units,
          status: kind,
          client_operation_id: makeOpId(),
        },
      });
    },
    onSuccess: (_, kind) => {
      toast.success(kind === "approved" ? "تم اعتماد العدد" : "تم حفظ مسودة");
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Sheet open={!!item} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto p-0">
        {item && (
          <>
            <SheetHeader className="p-4 border-b border-border">
              <SheetTitle className="text-base leading-snug text-start">
                {item.item_name_raw}
              </SheetTitle>
            </SheetHeader>
            <div className="p-4 space-y-4">
              <div className="rounded-2xl bg-muted/50 border border-border p-4">
                <div className="text-[11px] font-semibold text-muted-foreground mb-2 text-start">
                  المخزون بالنظام
                </div>
                <div className="flex items-center justify-around gap-3">
                  <div className="flex items-center gap-2">
                    <Package className="size-5 text-primary" />
                    <span className="text-lg font-bold tabular-nums">{item.system_boxes}</span>
                    <span className="text-xs text-muted-foreground">علبة</span>
                  </div>
                  <div className="h-8 w-px bg-border" />
                  <div className="flex items-center gap-2">
                    <Pill className="size-5 text-primary" />
                    <span className="text-lg font-bold tabular-nums">{item.system_units}</span>
                    <span className="text-xs text-muted-foreground">وحدة</span>
                  </div>
                </div>
              </div>

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
                  disabled={mut.isPending}
                  onClick={() => mut.mutate("draft")}
                >
                  حفظ مسودة
                </Button>
                <Button
                  id="btn-confirm"
                  className="h-14 font-bold text-base"
                  disabled={mut.isPending}
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