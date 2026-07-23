import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { exportRowsToXlsx } from "@/lib/excel-import";
import { diffStatus, diffTriple, formatQtyArabic } from "@/lib/quantity-parser";
import { fetchAllSupabasePages } from "@/lib/supabase-pagination";
import { FileDown } from "lucide-react";

export const Route = createFileRoute("/_authenticated/app/sessions/$id/report")({
  component: ReportPage,
});

type CountRow = {
  item_id: string;
  counted_by: string;
  counted_employee_name: string | null;
  phys_boxes: number;
  phys_strips: number;
  phys_units: number;
  status: string;
  is_current: boolean;
};

type Row = {
  id: string;
  row_index: number;
  external_item_id: string | null;
  item_name_raw: string;
  barcode: string | null;
  assigned_to: string | null;
  assigned_employee_name: string | null;
  pack_size: number | null;
  system_boxes: number;
  system_strips: number;
  system_units: number;
  system_quantity_raw: string | null;
  inventory_counts: CountRow[] | null;
};

type ProfileRow = {
  id: string;
  display_name: string | null;
  username: string | null;
};

type ReportStatus = "shortage" | "excess" | "matched" | "uncounted";

const STATUS_LABELS: Record<ReportStatus, string> = {
  shortage: "عجز",
  excess: "زيادة",
  matched: "مطابق",
  uncounted: "لم يُعد",
};

function ReportPage() {
  const { id } = Route.useParams();
  const [employeeFilter, setEmployeeFilter] = useState("all");
  const [activeStatus, setActiveStatus] = useState<ReportStatus>("shortage");

  const { data: rows = [], isLoading } = useQuery<Row[]>({
    queryKey: ["report", id],
    queryFn: async () => {
      const items = await fetchAllSupabasePages<Omit<Row, "inventory_counts" | "assigned_employee_name">>(() =>
        supabase
          .from("inventory_items")
          .select(
            "id, row_index, external_item_id, item_name_raw, barcode, assigned_to, pack_size, system_boxes, system_strips, system_units, system_quantity_raw",
          )
          .eq("session_id", id)
          .order("row_index", { ascending: true })
          .order("id", { ascending: true }),
      );

      const counts = await fetchAllSupabasePages<Omit<CountRow, "counted_employee_name">>(() =>
        supabase
          .from("inventory_counts")
          .select("item_id, counted_by, phys_boxes, phys_strips, phys_units, status, is_current")
          .eq("session_id", id)
          .eq("is_current", true)
          .order("item_id", { ascending: true }),
      );

      const employeeIds = Array.from(
        new Set(
          [
            ...items.map((item) => item.assigned_to),
            ...counts.map((count) => count.counted_by),
          ].filter(Boolean) as string[],
        ),
      );

      const profilesById = new Map<string, string>();
      if (employeeIds.length > 0) {
        const profiles = await fetchAllSupabasePages<ProfileRow>(() =>
          supabase
            .from("profiles")
            .select("id, display_name, username")
            .in("id", employeeIds)
            .order("display_name", { ascending: true }),
        );

        for (const profile of profiles) {
          profilesById.set(profile.id, profile.display_name || profile.username || "غير محدد");
        }
      }

      const countsByItem = new Map<string, CountRow[]>();
      for (const count of counts) {
        const list = countsByItem.get(count.item_id) ?? [];
        list.push({
          ...count,
          counted_employee_name: profilesById.get(count.counted_by) ?? null,
        });
        countsByItem.set(count.item_id, list);
      }

      return items.map((item) => ({
        ...item,
        assigned_employee_name: item.assigned_to ? profilesById.get(item.assigned_to) ?? null : null,
        inventory_counts: countsByItem.get(item.id) ?? null,
      }));
    },
  });

  const employeeOptions = useMemo(() => {
    const employees = new Map<string, string>();

    for (const row of rows) {
      if (row.assigned_to) employees.set(row.assigned_to, row.assigned_employee_name || "غير محدد");
      for (const count of row.inventory_counts ?? []) {
        employees.set(count.counted_by, count.counted_employee_name || "غير محدد");
      }
    }

    return Array.from(employees, ([employeeId, name]) => ({ employeeId, name })).sort((a, b) =>
      a.name.localeCompare(b.name, "ar"),
    );
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (employeeFilter === "all") return rows;

    return rows.filter((row) => {
      const approvedCount = getApprovedCount(row);
      if (approvedCount) return approvedCount.counted_by === employeeFilter;
      return row.assigned_to === employeeFilter;
    });
  }, [employeeFilter, rows]);

  const grouped = useMemo(() => {
    const groups = { matched: [] as Row[], shortage: [] as Row[], excess: [] as Row[], uncounted: [] as Row[] };

    for (const row of filteredRows) {
      const count = getApprovedCount(row);
      if (!count) {
        groups.uncounted.push(row);
        continue;
      }

      const diff = diffTriple(
        { boxes: row.system_boxes, strips: row.system_strips, units: row.system_units },
        { boxes: count.phys_boxes, strips: count.phys_strips, units: count.phys_units },
        row.pack_size ?? 1,
      );
      const status = diffStatus(diff);

      if (status === "match") groups.matched.push(row);
      else if (status === "shortage") groups.shortage.push(row);
      else groups.excess.push(row);
    }

    return groups;
  }, [filteredRows]);

  const visibleRows = grouped[activeStatus];

  function exportVisibleRows() {
    if (visibleRows.length === 0) {
      window.alert("لا توجد نتائج ظاهرة لتصديرها.");
      return;
    }

    const exportRows = visibleRows.map((row) => {
      const count = getApprovedCount(row);
      const systemQty = { boxes: row.system_boxes, strips: row.system_strips, units: row.system_units };
      const physicalQty = count
        ? { boxes: count.phys_boxes, strips: count.phys_strips, units: count.phys_units }
        : null;
      const diff = physicalQty ? diffTriple(systemQty, physicalQty, row.pack_size ?? 1) : null;

      return {
        "الرقم": row.row_index,
        "اسم الصنف": row.item_name_raw,
        "كود الصنف": row.external_item_id || "غير مسجل",
        "الباركود": row.barcode || "غير مسجل",
        "الموظف المسند إليه": getAssignedEmployeeName(row),
        "تم العد بواسطة": getCountedEmployeeName(row),
        "رصيد النظام": row.system_quantity_raw || formatQtyArabic(systemQty),
        "العدد الفعلي": physicalQty ? formatQtyArabic(physicalQty) : "غير محدد",
        "الفرق": formatDifference(diff),
        "الحالة": STATUS_LABELS[activeStatus],
      };
    });

    const headers = [
      "الرقم",
      "اسم الصنف",
      "كود الصنف",
      "الباركود",
      "الموظف المسند إليه",
      "تم العد بواسطة",
      "رصيد النظام",
      "العدد الفعلي",
      "الفرق",
      "الحالة",
    ];

    const employeeName = employeeFilter === "all"
      ? "all-employees"
      : employeeOptions.find((employee) => employee.employeeId === employeeFilter)?.name || "employee";

    exportRowsToXlsx(
      exportRows,
      headers,
      `inventory-report-${safeFilePart(STATUS_LABELS[activeStatus])}-${safeFilePart(employeeName)}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      "تقرير الجرد",
    );
  }

  if (isLoading) return <div className="p-6 text-center text-muted-foreground">جاري التحميل...</div>;

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-xl font-bold">تقرير الجرد</h2>

      <div className="grid grid-cols-4 gap-2">
        <Tile label="مطابق" value={grouped.matched.length} tone="success" />
        <Tile label="عجز" value={grouped.shortage.length} tone="destructive" />
        <Tile label="زيادة" value={grouped.excess.length} tone="info" />
        <Tile label="لم يُعد" value={grouped.uncounted.length} tone="muted" />
      </div>

      <Card className="p-3">
        <label htmlFor="employee-filter" className="mb-2 block text-xs font-semibold text-muted-foreground">
          الموظف
        </label>
        <select
          id="employee-filter"
          value={employeeFilter}
          onChange={(event) => setEmployeeFilter(event.target.value)}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="all">كل الموظفين</option>
          {employeeOptions.map((employee) => (
            <option key={employee.employeeId} value={employee.employeeId}>
              {employee.name}
            </option>
          ))}
        </select>
        <Button variant="outline" className="mt-3 h-11 w-full justify-start" onClick={exportVisibleRows}>
          <FileDown className="ms-2 size-4" />
          تصدير Excel للنتائج الظاهرة
        </Button>
      </Card>

      <Tabs value={activeStatus} onValueChange={(value) => setActiveStatus(value as ReportStatus)}>
        <TabsList className="grid h-11 w-full grid-cols-4">
          <TabsTrigger value="shortage">عجز</TabsTrigger>
          <TabsTrigger value="excess">زيادة</TabsTrigger>
          <TabsTrigger value="matched">مطابق</TabsTrigger>
          <TabsTrigger value="uncounted">لم يُعد</TabsTrigger>
        </TabsList>
        <TabsContent value="shortage">
          <RowList rows={grouped.shortage} kind="shortage" />
        </TabsContent>
        <TabsContent value="excess">
          <RowList rows={grouped.excess} kind="excess" />
        </TabsContent>
        <TabsContent value="matched">
          <RowList rows={grouped.matched} kind="match" />
        </TabsContent>
        <TabsContent value="uncounted">
          <RowList rows={grouped.uncounted} kind="none" />
        </TabsContent>
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
    <div className="mt-2 space-y-2">
      {rows.map((row) => {
        const count = getApprovedCount(row);
        const systemQty = { boxes: row.system_boxes, strips: row.system_strips, units: row.system_units };
        const physicalQty = count
          ? { boxes: count.phys_boxes, strips: count.phys_strips, units: count.phys_units }
          : null;
        const diff = physicalQty ? diffTriple(systemQty, physicalQty, row.pack_size ?? 1) : null;

        return (
          <Card key={row.id} className="space-y-2 p-3">
            <div className="text-sm font-semibold leading-6">{row.item_name_raw}</div>
            <div className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2">
              <InfoLine label="الكود" value={row.external_item_id || "غير مسجل"} dir={row.external_item_id ? "ltr" : "rtl"} />
              <InfoLine label="الباركود" value={row.barcode || "غير مسجل"} dir={row.barcode ? "ltr" : "rtl"} />
              <EmployeeLines row={row} />
              <InfoLine label="رصيد النظام" value={row.system_quantity_raw || formatQtyArabic(systemQty)} />
              <InfoLine label="العدد الفعلي" value={physicalQty ? formatQtyArabic(physicalQty) : "غير محدد"} />
              <InfoLine
                label="الفرق"
                value={formatDifference(diff)}
                className={
                  kind === "shortage" ? "text-destructive" :
                  kind === "excess" ? "text-info" :
                  kind === "match" ? "text-success" : undefined
                }
              />
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function getApprovedCount(row: Row) {
  return row.inventory_counts?.find((count) => count.is_current && count.status === "approved") ?? null;
}

function getEmployeeName(row: Row) {
  const approvedCount = getApprovedCount(row);
  if (approvedCount?.counted_by) return approvedCount.counted_employee_name || "غير محدد";
  return "غير محدد";
}

function getAssignedEmployeeName(row: Row) {
  if (row.assigned_to) return row.assigned_employee_name || "غير محدد";
  return "غير محدد";
}

function getCountedEmployeeName(row: Row) {
  return getEmployeeName(row);
}

function isSameAssignedAndCounted(row: Row) {
  const approvedCount = getApprovedCount(row);
  return Boolean(approvedCount?.counted_by && row.assigned_to && approvedCount.counted_by === row.assigned_to);
}

function EmployeeLines({ row }: { row: Row }) {
  if (isSameAssignedAndCounted(row)) {
    return <InfoLine label="الموظف" value={getCountedEmployeeName(row)} />;
  }

  return (
    <>
      <InfoLine label="المسند إلى" value={getAssignedEmployeeName(row)} />
      <InfoLine label="تم العد بواسطة" value={getCountedEmployeeName(row)} />
    </>
  );
}

function formatDifference(diff: ReturnType<typeof diffTriple> | null) {
  if (!diff) return "غير محدد";
  if (diff.raw === 0) return "مطابق";

  const sign = diff.raw > 0 ? "+" : "-";
  const parts = [
    diff.boxes ? `${Math.abs(diff.boxes)} علبة` : null,
    diff.strips ? `${Math.abs(diff.strips)} شريط` : null,
    diff.units ? `${Math.abs(diff.units)} وحدة` : null,
  ].filter(Boolean);

  return `${sign}${parts.join(" و ") || Math.abs(diff.raw).toLocaleString("ar")}`;
}

function safeFilePart(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "-").trim() || "report";
}

function InfoLine({
  label,
  value,
  dir = "rtl",
  className = "",
}: {
  label: string;
  value: string;
  dir?: "rtl" | "ltr";
  className?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-muted/35 px-2 py-1.5">
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span dir={dir} className={`min-w-0 truncate font-medium text-foreground ${className}`}>
        {value}
      </span>
    </div>
  );
}
