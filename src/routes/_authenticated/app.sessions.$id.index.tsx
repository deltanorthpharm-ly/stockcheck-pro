import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getSession,
  getSessionStats,
  closeSession,
  assignItemsBatch,
  returnUncountedItems,
  transferUncountedItems,
} from "@/lib/sessions.functions";
import { listEmployees } from "@/lib/employees.functions";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useState } from "react";
import { toast } from "sonner";
import { Upload, Lock, Users, FileDown, BarChart3, ClipboardList } from "lucide-react";
import { exportRowsToXlsx } from "@/lib/excel-import";
import { diffStatus, diffTriple, formatQtyArabic } from "@/lib/quantity-parser";
import { fetchAllSupabasePages } from "@/lib/supabase-pagination";

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
  const doAssign = useServerFn(assignItemsBatch);
  const doReturn = useServerFn(returnUncountedItems);
  const doTransfer = useServerFn(transferUncountedItems);
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

  const [batchQty, setBatchQty] = useState<Record<string, string>>({});
  const [transferTargets, setTransferTargets] = useState<Record<string, string>>({});
  const [transferQty, setTransferQty] = useState<Record<string, string>>({});

  const assign = useMutation({
    mutationFn: ({ employeeId, quantity }: { employeeId: string; quantity: number }) =>
      doAssign({ data: { session_id: id, employee_id: employeeId, quantity } }),
    onSuccess: (r) => {
      toast.success(`تم إسناد ${r.assigned} صنف`);
      qc.invalidateQueries({ queryKey: ["session-stats", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const returnItems = useMutation({
    mutationFn: ({ employeeId }: { employeeId: string }) =>
      doReturn({ data: { session_id: id, employee_id: employeeId } }),
    onSuccess: (r) => {
      toast.success(`تم إرجاع ${r.returned} صنف غير معدود`);
      qc.invalidateQueries({ queryKey: ["session-stats", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const transferItems = useMutation({
    mutationFn: ({
      fromEmployeeId,
      toEmployeeId,
      quantity,
    }: {
      fromEmployeeId: string;
      toEmployeeId: string;
      quantity?: number;
    }) =>
      doTransfer({
        data: {
          session_id: id,
          from_employee_id: fromEmployeeId,
          to_employee_id: toEmployeeId,
          quantity,
        },
      }),
    onSuccess: (r) => {
      toast.success(`تم نقل ${r.transferred} صنف غير معدود`);
      qc.invalidateQueries({ queryKey: ["session-stats", id] });
    },
    onError: (e: Error) => toast.error(e.message),
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
    type ExportItemRow = {
      id: string;
      row_index: number;
      item_name_raw: string;
      barcode: string | null;
      expiry_date: string | null;
      pack_size: number | null;
      system_boxes: number;
      system_strips: number;
      system_units: number;
      system_quantity_raw: string | null;
    };
    type ExportCountRow = {
      item_id: string;
      phys_boxes: number;
      phys_strips: number;
      phys_units: number;
      status: string;
      is_current: boolean;
    };
    const items = await fetchAllSupabasePages<ExportItemRow>(() =>
      supabase
        .from("inventory_items")
        .select(
          "id, row_index, item_name_raw, barcode, expiry_date, pack_size, system_boxes, system_strips, system_units, system_quantity_raw",
        )
        .eq("session_id", id)
        .order("row_index", { ascending: true })
        .order("id", { ascending: true }),
    );
    const counts = await fetchAllSupabasePages<ExportCountRow>(() =>
      supabase
        .from("inventory_counts")
        .select("item_id, phys_boxes, phys_strips, phys_units, status, is_current")
        .eq("session_id", id)
        .eq("is_current", true)
        .order("item_id", { ascending: true }),
    );
    const countsByItem = new Map<string, ExportCountRow>();
    for (const count of counts) {
      if (count.status === "approved") countsByItem.set(count.item_id, count);
    }
    const rows = items.map((it) => {
      const c = countsByItem.get(it.id);
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
        <StatBox label="غير مسند" value={stats?.unassigned ?? 0} tone="warning" />
        <StatBox label="مُسند" value={stats?.assigned ?? 0} />
        <StatBox label="مكتمل" value={stats?.completed ?? stats?.counted ?? 0} tone="success" />
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
          <div className="font-semibold">إسناد دفعات للموظفين</div>
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
              {employees.map((e) => {
                const employeeStats = stats?.perEmployee?.find((row) => row.employee_id === e.id);
                const assignedCount = employeeStats?.assigned ?? 0;
                const completedCount = employeeStats?.completed ?? 0;
                const remainingCount = employeeStats?.remaining ?? 0;
                const qty = Number(batchQty[e.id] ?? 0);
                const transferTarget = transferTargets[e.id] ?? "";
                const transferCountText = transferQty[e.id] ?? "";
                const parsedTransferCount = transferCountText ? Number(transferCountText) : undefined;
                return (
                  <Card key={e.id} className="p-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{e.display_name}</div>
                        <div className="text-xs text-muted-foreground">@{e.username}</div>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        متبقي: <span className="font-bold text-foreground">{remainingCount}</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <MiniStat label="مسند" value={assignedCount} />
                      <MiniStat label="مكتمل" value={completedCount} tone="success" />
                      <MiniStat label="متبقي" value={remainingCount} tone="warning" />
                    </div>
                    <div className="flex gap-2">
                      <Input
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="عدد الأصناف"
                        className="h-10 text-center"
                        value={batchQty[e.id] ?? ""}
                        onChange={(event) =>
                          setBatchQty((current) => ({
                            ...current,
                            [e.id]: event.target.value.replace(/\D/g, ""),
                          }))
                        }
                      />
                      <Button
                        className="h-10 shrink-0"
                        disabled={
                          assign.isPending ||
                          qty <= 0 ||
                          qty > (stats?.unassigned ?? 0)
                        }
                        onClick={() => assign.mutate({ employeeId: e.id, quantity: qty })}
                      >
                        إسناد
                      </Button>
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                      <Button
                        variant="outline"
                        className="h-10"
                        disabled={returnItems.isPending || remainingCount === 0}
                        onClick={() => returnItems.mutate({ employeeId: e.id })}
                      >
                        إرجاع غير المعدود
                      </Button>
                      <div className="grid grid-cols-[1fr_auto] gap-2">
                        <select
                          className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                          value={transferTarget}
                          onChange={(event) =>
                            setTransferTargets((current) => ({
                              ...current,
                              [e.id]: event.target.value,
                            }))
                          }
                        >
                          <option value="">نقل إلى موظف...</option>
                          {employees
                            .filter((employee) => employee.id !== e.id)
                            .map((employee) => (
                              <option key={employee.id} value={employee.id}>
                                {employee.display_name}
                              </option>
                            ))}
                        </select>
                        <Button
                          variant="outline"
                          className="h-10"
                          disabled={
                            transferItems.isPending ||
                            remainingCount === 0 ||
                            !transferTarget ||
                            (parsedTransferCount !== undefined &&
                              (parsedTransferCount <= 0 || parsedTransferCount > remainingCount))
                          }
                          onClick={() =>
                            transferItems.mutate({
                              fromEmployeeId: e.id,
                              toEmployeeId: transferTarget,
                              quantity: parsedTransferCount,
                            })
                          }
                        >
                          نقل
                        </Button>
                      </div>
                      <Input
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="عدد النقل اختياري، فارغ = كل المتبقي"
                        className="h-10 text-center"
                        value={transferCountText}
                        onChange={(event) =>
                          setTransferQty((current) => ({
                            ...current,
                            [e.id]: event.target.value.replace(/\D/g, ""),
                          }))
                        }
                      />
                    </div>
                  </Card>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              تبدأ الأصناف غير مسندة. اختر الموظف والعدد المطلوب فقط، ولن يتم نقل الأصناف المكتملة إلا عند إعادة عدّها صراحة.
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

function MiniStat({
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
    <div className="rounded-md border p-2">
      <div className={`text-base font-bold ${cls}`}>{value.toLocaleString("ar")}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
