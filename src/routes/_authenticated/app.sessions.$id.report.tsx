import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { formatQtyArabic, diffTriple, diffStatus } from "@/lib/quantity-parser";
import { useMemo } from "react";

export const Route = createFileRoute("/_authenticated/app/sessions/$id/report")({
  component: ReportPage,
});

type Row = {
  id: string;
  row_index: number;
  item_name_raw: string;
  barcode: string | null;
  pack_size: number | null;
  system_boxes: number;
  system_strips: number;
  system_units: number;
  system_quantity_raw: string | null;
  inventory_counts: Array<{
    phys_boxes: number;
    phys_strips: number;
    phys_units: number;
    status: string;
    is_current: boolean;
  }> | null;
};

function ReportPage() {
  const { id } = Route.useParams();
  const { data: rows = [], isLoading } = useQuery<Row[]>({
    queryKey: ["report", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inventory_items")
        .select(
          "id, row_index, item_name_raw, barcode, pack_size, system_boxes, system_strips, system_units, system_quantity_raw, inventory_counts!left(phys_boxes, phys_strips, phys_units, status, is_current)",
        )
        .eq("session_id", id)
        .order("row_index", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const grouped = useMemo(() => {
    const g = { matched: [] as Row[], shortage: [] as Row[], excess: [] as Row[], uncounted: [] as Row[] };
    for (const r of rows) {
      const c = r.inventory_counts?.find((x) => x.is_current && x.status === "approved");
      if (!c) { g.uncounted.push(r); continue; }
      const d = diffTriple(
        { boxes: r.system_boxes, strips: r.system_strips, units: r.system_units },
        { boxes: c.phys_boxes, strips: c.phys_strips, units: c.phys_units },
        r.pack_size ?? 1,
      );
      const s = diffStatus(d);
      if (s === "match") g.matched.push(r);
      else if (s === "shortage") g.shortage.push(r);
      else g.excess.push(r);
    }
    return g;
  }, [rows]);

  if (isLoading) return <div className="p-6 text-center text-muted-foreground">جارٍ...</div>;

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">تقرير الجرد</h2>
      <div className="grid grid-cols-4 gap-2">
        <Tile label="مطابق" value={grouped.matched.length} tone="success" />
        <Tile label="عجز" value={grouped.shortage.length} tone="destructive" />
        <Tile label="زيادة" value={grouped.excess.length} tone="info" />
        <Tile label="لم يُعد" value={grouped.uncounted.length} tone="muted" />
      </div>
      <Tabs defaultValue="shortage">
        <TabsList className="w-full grid grid-cols-4 h-11">
          <TabsTrigger value="shortage">عجز</TabsTrigger>
          <TabsTrigger value="excess">زيادة</TabsTrigger>
          <TabsTrigger value="matched">مطابق</TabsTrigger>
          <TabsTrigger value="uncounted">لم يُعد</TabsTrigger>
        </TabsList>
        <TabsContent value="shortage"><RowList rows={grouped.shortage} kind="shortage" /></TabsContent>
        <TabsContent value="excess"><RowList rows={grouped.excess} kind="excess" /></TabsContent>
        <TabsContent value="matched"><RowList rows={grouped.matched} kind="match" /></TabsContent>
        <TabsContent value="uncounted"><RowList rows={grouped.uncounted} kind="none" /></TabsContent>
      </Tabs>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone: string }) {
  const cls =
    tone === "success" ? "text-success" :
    tone === "destructive" ? "text-destructive" :
    tone === "info" ? "text-info" : "text-muted-foreground";
  return (
    <Card className="p-3 text-center">
      <div className={`text-xl font-bold ${cls}`}>{value.toLocaleString("ar")}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </Card>
  );
}

function RowList({ rows, kind }: { rows: Row[]; kind: "shortage" | "excess" | "match" | "none" }) {
  if (rows.length === 0) return <div className="p-6 text-center text-sm text-muted-foreground">لا يوجد</div>;
  return (
    <div className="space-y-2 mt-2">
      {rows.map((r) => {
        const c = r.inventory_counts?.find((x) => x.is_current && x.status === "approved");
        const sys = { boxes: r.system_boxes, strips: r.system_strips, units: r.system_units };
        const phys = c ? { boxes: c.phys_boxes, strips: c.phys_strips, units: c.phys_units } : null;
        const d = phys ? diffTriple(sys, phys, r.pack_size ?? 1) : null;
        return (
          <Card key={r.id} className="p-3">
            <div className="font-semibold text-sm">{r.item_name_raw}</div>
            <div className="text-xs text-muted-foreground mt-1">
              بالنظام: {formatQtyArabic(sys)}
            </div>
            {phys && (
              <div className="text-xs text-muted-foreground">
                فعلي: {formatQtyArabic(phys)}
              </div>
            )}
            {d && (kind === "shortage" || kind === "excess") && (
              <div className={`text-xs font-semibold mt-1 ${kind === "shortage" ? "text-destructive" : "text-info"}`}>
                فرق: {[
                  d.boxes && `${d.boxes > 0 ? "+" : ""}${d.boxes} علبة`,
                  d.strips && `${d.strips > 0 ? "+" : ""}${d.strips} شريط`,
                  d.units && `${d.units > 0 ? "+" : ""}${d.units} وحدة`,
                ].filter(Boolean).join(" · ")}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
