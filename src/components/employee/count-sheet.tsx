import { useEffect, useMemo, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useServerFn } from "@tanstack/react-start";
import { saveCount } from "@/lib/counts.functions";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatQtyArabic, diffTriple, diffStatus } from "@/lib/quantity-parser";
import { cn } from "@/lib/utils";

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
  const [strips, setStrips] = useState(0);
  const [units, setUnits] = useState(0);
  const save = useServerFn(saveCount);

  useEffect(() => {
    if (item) {
      setBoxes(item.current?.phys_boxes ?? 0);
      setStrips(item.current?.phys_strips ?? 0);
      setUnits(item.current?.phys_units ?? 0);
    }
  }, [item]);

  const diff = useMemo(() => {
    if (!item) return { boxes: 0, strips: 0, units: 0 };
    return diffTriple(
      { boxes: item.system_boxes, strips: item.system_strips, units: item.system_units },
      { boxes, strips, units },
    );
  }, [item, boxes, strips, units]);

  const status = useMemo(() => diffStatus(diff), [diff]);

  const mut = useMutation({
    mutationFn: async (kind: "draft" | "approved") => {
      if (!item) return;
      return save({
        data: {
          item_id: item.id,
          session_id: item.session_id,
          phys_boxes: boxes,
          phys_strips: strips,
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
              <div className="text-xs text-muted-foreground text-start">
                بالنظام: {item.system_quantity_raw ||
                  formatQtyArabic({
                    boxes: item.system_boxes,
                    strips: item.system_strips,
                    units: item.system_units,
                  })}
              </div>
            </SheetHeader>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <QtyInput label="علبة" value={boxes} onChange={setBoxes} sys={item.system_boxes} />
                <QtyInput label="شريط" value={strips} onChange={setStrips} sys={item.system_strips} />
                <QtyInput label="وحدة" value={units} onChange={setUnits} sys={item.system_units} />
              </div>

              <div
                className={cn(
                  "rounded-lg p-3 text-sm font-semibold text-center",
                  status === "match" && "bg-success/15 text-success",
                  status === "shortage" && "bg-destructive/15 text-destructive",
                  status === "excess" && "bg-info/15 text-info",
                )}
              >
                {status === "match"
                  ? "مطابق ✓"
                  : status === "shortage"
                    ? `عجز: ${fmtDiff(diff)}`
                    : `زيادة: ${fmtDiff(diff)}`}
              </div>

              <div className="grid grid-cols-2 gap-2 sticky bottom-0 bg-background pt-2">
                <Button
                  variant="outline"
                  className="h-12"
                  disabled={mut.isPending}
                  onClick={() => mut.mutate("draft")}
                >
                  حفظ مسودة
                </Button>
                <Button
                  className="h-12 font-bold"
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

function QtyInput({
  label,
  value,
  onChange,
  sys,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  sys: number;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-11 w-11 shrink-0"
          onClick={() => onChange(Math.max(0, value - 1))}
          aria-label="نقص"
        >
          −
        </Button>
        <Input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={value}
          onChange={(e) =>
            onChange(Math.max(0, parseInt(e.target.value.replace(/\D/g, "") || "0", 10)))
          }
          className="h-11 text-center text-lg font-bold px-1"
          dir="ltr"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-11 w-11 shrink-0"
          onClick={() => onChange(value + 1)}
          aria-label="زيادة"
        >
          +
        </Button>
      </div>
      <div className="text-[10px] text-muted-foreground text-center">بالنظام: {sys}</div>
    </div>
  );
}

function fmtDiff(d: { boxes: number; strips: number; units: number }) {
  const parts: string[] = [];
  if (d.boxes) parts.push(`${d.boxes > 0 ? "+" : ""}${d.boxes} علبة`);
  if (d.strips) parts.push(`${d.strips > 0 ? "+" : ""}${d.strips} شريط`);
  if (d.units) parts.push(`${d.units > 0 ? "+" : ""}${d.units} وحدة`);
  return parts.join(" · ");
}