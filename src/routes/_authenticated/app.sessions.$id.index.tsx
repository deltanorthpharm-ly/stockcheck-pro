import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getSession,
  getSessionStats,
  closeSession,
  autoAssignByRange,
  clearAssignments,
} from "@/lib/sessions.functions";
import { listEmployees } from "@/lib/employees.functions";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { useState, useMemo } from "react";
import { toast } from "sonner";
import { Upload, Lock, Users, FileDown, BarChart3, ClipboardList } from "lucide-react";
import { exportRowsToXlsx } from "@/lib/excel-import";
import { diffStatus, diffTriple, formatQtyArabic } from "@/lib/quantity-parser";

export const Route = createFileRoute("/_authenticated/app/sessions/$id/")({
  component: SessionDetail,
});

function SessionDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const getSess = useServerFn(getSession);
  const getStats = useServerFn(getSessionStats);
  const listEmps = useServerFn(listEmployees);
  const doAssign = useServerFn(autoAssignByRange);
  const doClear = useServerFn(clearAssignments);
  const doClose = useServerFn(closeSession);

  const { data: session } = useQuery({
    queryKey: ["session", id],
    queryFn: () => getSess({ data: { id } }),
  });
  const { data: stats } = useQuery({
    queryKey: ["session-stats", id],
    queryFn: () => getStats({ data: { session_id: id } }),
    refetchInterval: 15_000,
  });
  const { data: employees = [] } = useQuery({
    queryKey: ["employees"],
    queryFn: () => listEmps(),
  });

  const [selectedEmps, setSelectedEmps] = useState<string[]>([]);

  const assign = useMutation({
    mutationFn: () =>
      doAssign({ data: { session_id: id, employee_ids: selectedEmps, only_unassigned: false } }),
    onSuccess: (r) => {
      toast.success(`تم توزيع ${r.assigned} صنف`);
      qc.invalidateQueries({ queryKey: ["session-stats", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const clear = useMutation({
    mutationFn: () => doClear({ data: { session_id: id } }),
    onSuccess: () => {
      toast.success("تم إلغاء كل الإسنادات");
      qc.invalidateQueries({ queryKey: ["session-stats", id] });
    },
  });

  const close = useMutation({
    mutationFn: () => doClose({ data: { id } }),
    onSuccess: () => {
      toast.success("تم إغلاق الجرد");
      qc.invalidateQueries({ queryKey: ["session", id] });
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  const percent = stats && stats.total ? Math.round((stats.counted / stats.total) * 100) : 0;

  async function exportReport() {
    const { data: items } = await supabase
      .from("inventory_items")
      .select(
        "row_index, item_name_raw, barcode, expiry_date, pack_size, system_boxes, system_strips, system_units, system_quantity_raw, inventory_counts!left(phys_boxes, phys_strips, phys_units, status, is_current)",
      )
      .eq("session_id", id)
      .order("row_index", { ascending: true });
    if (!items) return;
    type Row = typeof items[number];
    const rows = (items as Row[]).map((it) => {
      const c = (it.inventory_counts as Array<{ phys_boxes: number; phys_strips: number; phys_units: number; status: string; is_current: boolean }> | null)?.find(
        (x) => x.is_current && x.status === "approved",
      );
      const sysStr = formatQtyArabic({ boxes: it.system_boxes, strips: it.system_strips, units: it.system_units });
      const physStr = c
        ? formatQtyArabic({ boxes: c.phys_boxes, strips: c.phys_strips, units: c.phys_units })
        : "";
      const diff = c
        ? diffTriple(
            { boxes: it.system_boxes, strips: it.system_strips, units: it.system_units },
            { boxes: c.phys_boxes, strips: c.phys_strips, units: c.phys_units },
            it.pack_size ?? 1,
          )
        : null;
      const statusValue = diff ? diffStatus(diff) : null;
      const diffBoxes = diff ? diff.boxes : "";
      const diffUnits = diff ? diff.units : "";
      const status = !c
        ? "لم يُعد"
        : statusValue === "match"
          ? "مطابق"
          : statusValue === "shortage"
            ? "عجز"
            : "زيادة";
      return {
        "الرقم": it.row_index,
        "اسم الصنف": it.item_name_raw,
        "الباركود": it.barcode ?? "",
        "الصلاحية": it.expiry_date ?? "",
        "الكمية بالنظام": sysStr,
        "الكمية الفعلية": physStr,
        "فرق (علبة)": diffBoxes,
        "فرق (وحدة)": diffUnits,
        "الحالة": status,
      };
    });
    const headers = [
      "الرقم", "اسم الصنف", "الباركود", "الصلاحية",
      "الكمية بالنظام", "الكمية الفعلية",
      "فرق (علبة)", "فرق (وحدة)", "الحالة",
    ];
    exportRowsToXlsx(rows, headers, `${session?.name ?? "inventory"}.xlsx`, "التقرير");
  }

  const toggleEmp = (id: string) =>
    setSelectedEmps((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold truncate">{session?.name ?? "..."}</h2>
          <div className="text-xs text-muted-foreground">
            {session?.status === "open" ? "مفتوح" : "مغلق"} ·
            {session?.exported_at && ` استيراد: ${new Date(session.exported_at).toLocaleString("ar")}`}
          </div>
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0 h-11">
          <Link to="/app/sessions/$id/import" params={{ id }}>
            <Upload className="size-4 ms-1" /> استيراد
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatBox label="إجمالي الأصناف" value={stats?.total ?? 0} />
        <StatBox label="مُسند" value={stats?.assigned ?? 0} />
        <StatBox label="تم عدّه" value={stats?.counted ?? 0} tone="success" />
        <StatBox label="متبقي" value={stats?.remaining ?? 0} tone="warning" />
      </div>

      <Card className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">نسبة الإنجاز</div>
          <div className="text-sm font-bold">{percent}%</div>
        </div>
        <Progress value={percent} />
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-primary" />
          <div className="font-semibold">توزيع الأصناف على الموظفين</div>
        </div>
        {employees.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            لا يوجد موظفون بعد.{" "}
            <Link to="/app/employees" className="text-primary underline">
              أنشئ موظف
            </Link>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              {employees.map((e) => (
                <label key={e.id} className="flex items-center gap-3 py-2 touch-target">
                  <Checkbox
                    checked={selectedEmps.includes(e.id)}
                    onCheckedChange={() => toggleEmp(e.id)}
                  />
                  <div className="text-sm">
                    <div className="font-medium">{e.display_name}</div>
                    <div className="text-xs text-muted-foreground">@{e.username}</div>
                  </div>
                </label>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-11"
                disabled={clear.isPending}
                onClick={() => clear.mutate()}
              >
                إلغاء الكل
              </Button>
              <Button
                className="h-11"
                disabled={selectedEmps.length === 0 || assign.isPending}
                onClick={() => assign.mutate()}
              >
                توزيع تلقائي
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              يتم التوزيع بترتيب صفوف الملف الأصلي ثم يُخزَّن معرّف كل صنف بشكل صريح، بحيث لا يتغيّر مالك الصنف عند إعادة الاستيراد.
            </p>
          </>
        )}
      </Card>

      <Card className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <ClipboardList className="size-4 text-primary" />
          <div className="font-semibold">التقارير</div>
        </div>
        <Button asChild variant="outline" className="w-full h-11 justify-start">
          <Link to="/app/sessions/$id/report" params={{ id }}>
            <BarChart3 className="size-4 ms-2" /> عرض التقرير التفصيلي
          </Link>
        </Button>
        <Button variant="outline" className="w-full h-11 justify-start" onClick={exportReport}>
          <FileDown className="size-4 ms-2" /> تنزيل Excel
        </Button>
      </Card>

      {session?.status === "open" && (
        <Button
          variant="destructive"
          className="w-full h-12"
          onClick={() => {
            if (confirm("إغلاق الجرد؟ لن يتمكن الموظفون من تعديل العدد بعدها.")) close.mutate();
          }}
          disabled={close.isPending}
        >
          <Lock className="size-4 ms-2" /> إغلاق الجرد
        </Button>
      )}
    </div>
  );
}

function StatBox({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "warning";
}) {
  const cls =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning-foreground"
        : "text-foreground";
  return (
    <Card className="p-4">
      <div className={`text-2xl font-bold ${cls}`}>{value.toLocaleString("ar")}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </Card>
  );
}
