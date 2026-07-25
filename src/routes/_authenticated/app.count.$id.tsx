import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CountSheet } from "@/components/employee/count-sheet";
import { BarcodeScannerSheet } from "@/components/employee/barcode-scanner-sheet";
import { formatQtyArabic, diffTriple, diffStatus } from "@/lib/quantity-parser";
import { fetchAllSupabasePages } from "@/lib/supabase-pagination";
import { Camera, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/app/count/$id")({
  component: CountPage,
});

type Item = {
  id: string;
  session_id: string;
  row_index: number;
  item_name_raw: string;
  barcode: string | null;
  external_item_id: string | null;
  pack_size: number | null;
  system_boxes: number;
  system_strips: number;
  system_units: number;
  system_quantity_raw: string | null;
  quantity_parse_status: string;
  current?: {
    phys_boxes: number;
    phys_strips: number;
    phys_units: number;
    status: "draft" | "approved";
  };
};

type CountRow = {
  item_id: string;
  phys_boxes: number;
  phys_strips: number;
  phys_units: number;
  status: "draft" | "approved";
};

function CountPage() {
  const { id } = Route.useParams();
  const [openItem, setOpenItem] = useState<Item | null>(null);
  const [query, setQuery] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);

  const { data: items = [], isLoading, refetch } = useQuery({
    queryKey: ["assigned-items", id],
    queryFn: async () => {
      const itemRows = await fetchAllSupabasePages<Item>(() =>
        supabase
          .from("inventory_items")
          .select(
            "id, session_id, row_index, item_name_raw, barcode, external_item_id, pack_size, system_boxes, system_strips, system_units, system_quantity_raw, quantity_parse_status",
          )
          .eq("session_id", id)
          .order("row_index", { ascending: true })
          .order("id", { ascending: true }),
      );
      if (itemRows.length === 0) return [] as Item[];
      const counts = await fetchAllSupabasePages<CountRow>(() =>
        supabase
          .from("inventory_counts")
          .select("item_id, phys_boxes, phys_strips, phys_units, status")
          .eq("session_id", id)
          .eq("is_current", true)
          .order("item_id", { ascending: true }),
      );
      const byItem = new Map<string, Item["current"]>();
      for (const c of counts) {
        byItem.set(c.item_id, {
          phys_boxes: c.phys_boxes,
          phys_strips: c.phys_strips,
          phys_units: c.phys_units,
          status: c.status as "draft" | "approved",
        });
      }
      return itemRows.map((it) => ({ ...it, current: byItem.get(it.id) })) as Item[];
    },
  });

  // Hide items with absolutely zero stock (both boxes and units == 0).
  // Keep negative-stock items visible for review.
  const visibleItems = useMemo(
    () => items.filter((i) => !(i.system_boxes === 0 && i.system_units === 0)),
    [items],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return visibleItems;
    const q = query.trim().toLowerCase();
    return visibleItems.filter(
      (i) =>
        i.item_name_raw.toLowerCase().includes(q) ||
        (i.barcode ?? "").toLowerCase().includes(q) ||
        (i.external_item_id ?? "").toLowerCase().includes(q),
    );
  }, [visibleItems, query]);

  const total = visibleItems.length;
  const counted = visibleItems.filter((i) => i.current?.status === "approved").length;

  const handleBarcodeDetected = useCallback((barcode: string) => {
    const code = barcode.trim();
    const normalized = code.toLowerCase();
    setScannerOpen(false);
    setQuery(code);
    const matches = visibleItems.filter(
      (i) =>
        (i.barcode ?? "").toLowerCase() === normalized ||
        (i.external_item_id ?? "").toLowerCase() === normalized,
    );
    if (matches.length === 1) {
      toast.success(`تم مسح الباركود: ${code}`);
      setOpenItem(matches[0]);
      return;
    }
    if (matches.length > 1) {
      toast.warning("Multiple items share this barcode.");
      return;
    }
    toast.error("Barcode not found in this inventory session.");
  }, [visibleItems]);

  return (
    <div className="flex flex-col">
      <div className="sticky top-14 z-20 bg-background border-b border-border">
        <div className="p-3 space-y-2">
          <div className="relative">
            <Search className="absolute top-1/2 -translate-y-1/2 end-3 size-4 text-muted-foreground" />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute top-1/2 -translate-y-1/2 start-1.5 h-9 w-9"
              onClick={() => setScannerOpen(true)}
              aria-label="مسح الباركود بالكاميرا"
            >
              <Camera className="size-5" />
            </Button>
            <Input
              className="h-12 pe-10 ps-12 text-base"
              placeholder="ابحث باسم الصنف أو الكود أو الباركود"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              تم عدّ {counted.toLocaleString("ar")} من {total.toLocaleString("ar")}
            </span>
            <span>{total ? Math.round((counted / total) * 100) : 0}%</span>
          </div>
        </div>
      </div>

      <div className="p-3 space-y-2">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">جارٍ التحميل...</div>
        ) : filtered.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            لا يوجد أصناف مطابقة
          </Card>
        ) : (
          filtered.map((it) => {
            const sys = { boxes: it.system_boxes, strips: it.system_strips, units: it.system_units };
            const phys = it.current
              ? { boxes: it.current.phys_boxes, strips: it.current.phys_strips, units: it.current.phys_units }
              : null;
            const status = phys ? diffStatus(diffTriple(sys, phys, it.pack_size ?? 1)) : null;
            const identity = [
              it.external_item_id ? `Code: ${it.external_item_id}` : null,
              it.barcode ? `Barcode: ${it.barcode}` : null,
            ].filter(Boolean).join(" · ");
            const chip =
              status === "match"
                ? "bg-success/15 text-success"
                : status === "shortage"
                  ? "bg-destructive/15 text-destructive"
                  : status === "excess"
                    ? "bg-info/15 text-info"
                    : "bg-muted text-muted-foreground";
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => setOpenItem(it)}
                className={cn(
                  "w-full text-start touch-target rounded-lg border border-border bg-card p-3 active:bg-accent transition-colors",
                  it.current?.status === "draft" && "border-warning/40",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold leading-snug text-[15px]">
                      {it.item_name_raw}
                    </div>
                    {identity && (
                      <div className="text-[11px] text-muted-foreground mt-0.5" dir="ltr">
                        {identity}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground mt-1">
                      بالنظام: {it.system_quantity_raw || formatQtyArabic(sys)}
                    </div>
                  </div>
                  <span className={cn("shrink-0 text-[11px] font-semibold rounded-full px-2 py-1", chip)}>
                    {!it.current
                      ? "لم يُعد"
                      : it.current.status === "draft"
                        ? "مسودة"
                        : status === "match"
                          ? "مطابق"
                          : status === "shortage"
                            ? "عجز"
                            : "زيادة"}
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>

      <CountSheet
        item={openItem}
        onClose={() => setOpenItem(null)}
        onSaved={() => {
          setOpenItem(null);
          void refetch();
        }}
      />
      <BarcodeScannerSheet
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleBarcodeDetected}
      />
    </div>
  );
}
