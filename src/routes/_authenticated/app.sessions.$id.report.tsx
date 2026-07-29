import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FileDown, History, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CountSheet } from "@/components/employee/count-sheet";
import { useCurrentUser } from "@/hooks/use-current-user";
import { supabase } from "@/integrations/supabase/client";
import { exportRowsToXlsx } from "@/lib/excel-import";
import { formatInventoryDiffBadge, normalizeInventoryDiffStatus } from "@/lib/inventory-diff-display";
import { diffStatus, diffTriple, formatQtyArabic, rawToQty } from "@/lib/quantity-parser";
import { fetchAllSupabasePages } from "@/lib/supabase-pagination";

export const Route = createFileRoute("/_authenticated/app/sessions/$id/report")({
  component: ReportPage,
});

type CountRow = {
  id: string;
  item_id: string;
  counted_by: string;
  counted_employee_name: string | null;
  phys_boxes: number;
  phys_strips: number;
  phys_units: number;
  difference_raw: number | string | null;
  difference_boxes: number | null;
  difference_units: number | null;
  diff_status: string | null;
  status: string;
  is_current: boolean;
  count_version: number;
  opened_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

type SnapshotAuditRow = {
  inventory_item_id: string;
  old_system_boxes: number | null;
  old_system_units: number | null;
  old_system_quantity_raw: string | null;
  new_system_boxes: number | null;
  new_system_units: number | null;
  new_system_quantity_raw: string | null;
  refresh_reason: string | null;
  executed_by: string | null;
  executed_by_name: string | null;
  executed_at: string;
};

type UnapprovalAuditRow = {
  inventory_item_id: string;
  count_id: string | null;
  old_phys_boxes: number | null;
  old_phys_units: number | null;
  old_difference_raw: number | string | null;
  old_difference_boxes: number | null;
  old_difference_units: number | null;
  old_diff_status: string | null;
  cancelled_by: string | null;
  cancelled_by_name: string | null;
  cancelled_at: string;
};

type Row = {
  id: string;
  session_id: string;
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
  raw_quantity_snapshot: number | string | null;
  created_at: string;
  last_purchase_price: number | null;
  inventory_counts: CountRow[] | null;
  snapshot_audits: SnapshotAuditRow[];
  unapproval_audits: UnapprovalAuditRow[];
};

type ProfileRow = {
  id: string;
  display_name: string | null;
  username: string | null;
};

type ReportStatus = "shortage" | "excess" | "matched" | "uncounted";
type SortKey =
  | "largestShortageValue"
  | "largestExcessValue"
  | "largestQuantityDiff"
  | "latestApproval"
  | "itemName"
  | "code"
  | "barcode"
  | "approverName";

type SavedDiff = {
  diff_status?: string | null;
  difference_raw?: number | string | null;
  difference_boxes?: number | null;
  difference_units?: number | null;
};

type TimelineEvent = {
  id: string;
  at: string;
  title: string;
  userName: string;
  detail?: string;
};

const STATUS_LABELS: Record<ReportStatus, string> = {
  shortage: "عجز",
  excess: "زيادة",
  matched: "مطابق",
  uncounted: "لم يُعد",
};

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "largestShortageValue", label: "أكبر قيمة عجز" },
  { value: "largestExcessValue", label: "أكبر قيمة زيادة" },
  { value: "largestQuantityDiff", label: "أكبر فرق كمية" },
  { value: "latestApproval", label: "آخر اعتماد" },
  { value: "itemName", label: "اسم الصنف" },
  { value: "code", label: "الكود" },
  { value: "barcode", label: "الباركود" },
  { value: "approverName", label: "اسم المعتمد" },
];

function ReportPage() {
  const { id } = Route.useParams();
  const { data: currentUser } = useCurrentUser();
  const [employeeFilter, setEmployeeFilter] = useState("all");
  const [activeStatus, setActiveStatus] = useState<ReportStatus>("shortage");
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("largestShortageValue");
  const [timelineRow, setTimelineRow] = useState<Row | null>(null);
  const [reviewRow, setReviewRow] = useState<Row | null>(null);

  const { data: rows = [], isLoading, refetch } = useQuery<Row[]>({
    queryKey: ["report", id],
    queryFn: async () => {
      const items = await fetchAllSupabasePages<Omit<Row, "inventory_counts" | "assigned_employee_name" | "snapshot_audits" | "unapproval_audits">>(() =>
        supabase
          .from("inventory_items")
          .select(
            "id, session_id, row_index, external_item_id, item_name_raw, barcode, assigned_to, pack_size, system_boxes, system_strips, system_units, system_quantity_raw, raw_quantity_snapshot, created_at, last_purchase_price",
          )
          .eq("session_id", id)
          .order("row_index", { ascending: true })
          .order("id", { ascending: true }),
      );

      const [counts, snapshotAudits, unapprovalAudits] = await Promise.all([
        fetchAllSupabasePages<Omit<CountRow, "counted_employee_name">>(() =>
          supabase
            .from("inventory_counts")
            .select(
              "id, item_id, counted_by, phys_boxes, phys_strips, phys_units, difference_raw, difference_boxes, difference_units, diff_status, status, is_current, count_version, opened_at, submitted_at, created_at, updated_at",
            )
            .eq("session_id", id)
            .order("item_id", { ascending: true })
            .order("created_at", { ascending: true }),
        ),
        safeFetchAuditRows<SnapshotAuditRow>(() =>
          (supabase as any)
            .from("inventory_snapshot_refresh_audit")
            .select(
              "inventory_item_id, old_system_boxes, old_system_units, old_system_quantity_raw, new_system_boxes, new_system_units, new_system_quantity_raw, refresh_reason, executed_by, executed_at",
            )
            .eq("session_id", id)
            .order("executed_at", { ascending: true }),
        ),
        safeFetchAuditRows<UnapprovalAuditRow>(() =>
          (supabase as any)
            .from("inventory_count_unapproval_audit")
            .select(
              "inventory_item_id, count_id, old_phys_boxes, old_phys_units, old_difference_raw, old_difference_boxes, old_difference_units, old_diff_status, cancelled_by, cancelled_at",
            )
            .eq("session_id", id)
            .order("cancelled_at", { ascending: true }),
        ),
      ]);

      const employeeIds = Array.from(
        new Set(
          [
            ...items.map((item) => item.assigned_to),
            ...counts.map((count) => count.counted_by),
            ...snapshotAudits.map((audit) => audit.executed_by),
            ...unapprovalAudits.map((audit) => audit.cancelled_by),
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
          profilesById.set(profile.id, profile.display_name || profile.username || "مستخدم غير معروف");
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

      const snapshotAuditsByItem = new Map<string, SnapshotAuditRow[]>();
      for (const audit of snapshotAudits) {
        const list = snapshotAuditsByItem.get(audit.inventory_item_id) ?? [];
        list.push({
          ...audit,
          executed_by_name: audit.executed_by ? profilesById.get(audit.executed_by) ?? null : null,
        });
        snapshotAuditsByItem.set(audit.inventory_item_id, list);
      }

      const unapprovalAuditsByItem = new Map<string, UnapprovalAuditRow[]>();
      for (const audit of unapprovalAudits) {
        const list = unapprovalAuditsByItem.get(audit.inventory_item_id) ?? [];
        list.push({
          ...audit,
          cancelled_by_name: audit.cancelled_by ? profilesById.get(audit.cancelled_by) ?? null : null,
        });
        unapprovalAuditsByItem.set(audit.inventory_item_id, list);
      }

      return items.map((item) => ({
        ...item,
        assigned_employee_name: item.assigned_to ? profilesById.get(item.assigned_to) ?? null : null,
        inventory_counts: countsByItem.get(item.id) ?? null,
        snapshot_audits: snapshotAuditsByItem.get(item.id) ?? [],
        unapproval_audits: unapprovalAuditsByItem.get(item.id) ?? [],
      }));
    },
  });

  const employeeOptions = useMemo(() => {
    const employees = new Map<string, string>();

    for (const row of rows) {
      if (row.assigned_to) employees.set(row.assigned_to, row.assigned_employee_name || "مستخدم غير معروف");
      for (const count of row.inventory_counts ?? []) {
        employees.set(count.counted_by, count.counted_employee_name || "مستخدم غير معروف");
      }
    }

    return Array.from(employees, ([employeeId, name]) => ({ employeeId, name })).sort((a, b) =>
      a.name.localeCompare(b.name, "ar"),
    );
  }, [rows]);

  const filteredRows = useMemo(() => {
    const needle = searchTerm.trim().toLocaleLowerCase("ar");

    return rows.filter((row) => {
      if (employeeFilter !== "all") {
        const approvedCount = getApprovedCount(row);
        if (approvedCount) {
          if (approvedCount.counted_by !== employeeFilter) return false;
        } else if (row.assigned_to !== employeeFilter) {
          return false;
        }
      }

      if (!needle) return true;

      const searchable = [
        row.item_name_raw,
        row.external_item_id,
        row.barcode,
        row.assigned_employee_name,
        getApprovalInfo(row)?.userName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("ar");

      return searchable.includes(needle);
    });
  }, [employeeFilter, rows, searchTerm]);

  const grouped = useMemo(() => groupRows(filteredRows), [filteredRows]);
  const financialSummary = useMemo(() => summarizeFinancial(filteredRows), [filteredRows]);
  const visibleRows = useMemo(() => sortRows(grouped[activeStatus], sortBy), [activeStatus, grouped, sortBy]);
  const isAdmin = currentUser?.role === "admin";

  useEffect(() => {
    if (!reviewRow?.id) return;
    const updated = rows.find((row) => row.id === reviewRow.id);
    if (updated && updated !== reviewRow) setReviewRow(updated);
  }, [rows, reviewRow?.id]);

  const handleSnapshotRefreshed = useCallback(() => {
    void refetch();
  }, [refetch]);

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
      const diff = count ? getDisplayDiff(row, count) : null;
      const approval = getApprovalInfo(row);

      return {
        الرقم: row.row_index,
        "اسم الصنف": row.item_name_raw,
        "كود الصنف": row.external_item_id || "غير مسجل",
        الباركود: row.barcode || "غير مسجل",
        "الموظف المسند إليه": getAssignedEmployeeName(row),
        "تم الاعتماد بواسطة": approval?.userName || "غير محدد",
        "وقت الاعتماد": approval ? `${formatDate(approval.at)} ${formatTime(approval.at)}` : "غير محدد",
        "رصيد النظام": row.system_quantity_raw || formatQtyArabic(systemQty),
        "العدد الفعلي": physicalQty ? formatQtyArabic(physicalQty) : "غير محدد",
        الفرق: formatDifference(diff, row.pack_size),
        "قيمة الفرق": formatFinancialDifference(row),
        الحالة: STATUS_LABELS[activeStatus],
      };
    });

    const headers = [
      "الرقم",
      "اسم الصنف",
      "كود الصنف",
      "الباركود",
      "الموظف المسند إليه",
      "تم الاعتماد بواسطة",
      "وقت الاعتماد",
      "رصيد النظام",
      "العدد الفعلي",
      "الفرق",
      "قيمة الفرق",
      "الحالة",
    ];

    const employeeName =
      employeeFilter === "all"
        ? "all-employees"
        : employeeOptions.find((employee) => employee.employeeId === employeeFilter)?.name || "employee";

    exportRowsToXlsx(
      exportRows,
      headers,
      `inventory-report-${safeFilePart(STATUS_LABELS[activeStatus])}-${safeFilePart(employeeName)}-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`,
      "تقرير الجرد",
    );
  }

  if (isLoading) return <div className="p-6 text-center text-muted-foreground">جاري التحميل...</div>;

  return (
    <div className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-xl font-bold">تفاصيل الجرد</h2>
        <p className="text-xs text-muted-foreground">صفحة مراجعة المدير: فروقات، قيمة مالية، اعتماد، وسجل الصنف.</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Tile label="إجمالي الأصناف" value={filteredRows.length} tone="primary" />
        <Tile label="مطابق" value={grouped.matched.length} tone="success" />
        <Tile label="عجز" value={grouped.shortage.length} tone="destructive" />
        <Tile label="زيادة" value={grouped.excess.length} tone="info" />
        <Tile label="لم يُعد" value={grouped.uncounted.length} tone="muted" />
      </div>

      {financialSummary.hasAnyPurchasePrice ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <MoneyTile label="إجمالي قيمة العجز" value={financialSummary.shortageValue ?? 0} tone="destructive" />
          <MoneyTile label="إجمالي قيمة الزيادة" value={financialSummary.excessValue ?? 0} tone="info" />
          <MoneyTile label="صافي الفرق المالي" value={financialSummary.netValue ?? 0} tone={(financialSummary.netValue ?? 0) >= 0 ? "info" : "destructive"} />
        </div>
      ) : (
        <Card className="flex items-center gap-3 p-3">
          <div className="grid size-10 place-items-center rounded-full bg-muted text-lg">💰</div>
          <div>
            <div className="text-sm font-bold">القيمة المالية غير متاحة</div>
            <div className="text-xs text-muted-foreground">لا يوجد سعر شراء محفوظ لهذه النتائج.</div>
          </div>
        </Card>
      )}

      <Card className="space-y-3 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="بحث بالاسم أو الكود أو الباركود أو المعتمد"
            className="pe-10"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-xs font-semibold text-muted-foreground">
            الموظف
            <select
              value={employeeFilter}
              onChange={(event) => setEmployeeFilter(event.target.value)}
              className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value="all">كل الموظفين</option>
              {employeeOptions.map((employee) => (
                <option key={employee.employeeId} value={employee.employeeId}>
                  {employee.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs font-semibold text-muted-foreground">
            ترتيب حسب
            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as SortKey)}
              className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <Button variant="outline" className="h-11 w-full justify-start" onClick={exportVisibleRows}>
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
          <RowList rows={visibleRows} kind="shortage" onReview={setReviewRow} onTimeline={setTimelineRow} />
        </TabsContent>
        <TabsContent value="excess">
          <RowList rows={visibleRows} kind="excess" onReview={setReviewRow} onTimeline={setTimelineRow} />
        </TabsContent>
        <TabsContent value="matched">
          <RowList rows={visibleRows} kind="match" onReview={setReviewRow} onTimeline={setTimelineRow} />
        </TabsContent>
        <TabsContent value="uncounted">
          <RowList rows={visibleRows} kind="none" onReview={setReviewRow} onTimeline={setTimelineRow} />
        </TabsContent>
      </Tabs>

      <TimelineDialog row={timelineRow} onClose={() => setTimelineRow(null)} />

      <CountSheet
        item={reviewRow ? toCountSheetItem(reviewRow) : null}
        isAdmin={isAdmin}
        onClose={() => setReviewRow(null)}
        onSaved={() => {
          setReviewRow(null);
          void refetch();
        }}
        onCancelled={() => {
          void refetch();
        }}
        onSnapshotRefreshed={handleSnapshotRefreshed}
      />
    </div>
  );
}

async function safeFetchAuditRows<T>(
  createQuery: () => {
    range: (
      from: number,
      to: number,
    ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  },
) {
  try {
    return await fetchAllSupabasePages<T>(createQuery);
  } catch {
    return [];
  }
}

function groupRows(rows: Row[]) {
  const groups = { matched: [] as Row[], shortage: [] as Row[], excess: [] as Row[], uncounted: [] as Row[] };

  for (const row of rows) {
    const count = getApprovedCount(row);
    if (!count) {
      groups.uncounted.push(row);
      continue;
    }

    const status = getDisplayStatus(row, count);
    if (status === "match") groups.matched.push(row);
    else if (status === "shortage") groups.shortage.push(row);
    else groups.excess.push(row);
  }

  return groups;
}

function Tile({ label, value, tone }: { label: string; value: number; tone: string }) {
  const cls =
    tone === "primary" ? "text-primary" :
    tone === "success" ? "text-success" :
    tone === "destructive" ? "text-destructive" :
    tone === "info" ? "text-info" : "text-muted-foreground";

  return (
    <Card className="p-3 text-center">
      <div className={`text-xl font-bold ${cls}`}>{formatNumber(value)}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </Card>
  );
}

function MoneyTile({ label, value, tone }: { label: string; value: number | null; tone: string }) {
  const cls =
    tone === "success" ? "text-success" :
    tone === "destructive" ? "text-destructive" :
    tone === "info" ? "text-info" : "text-muted-foreground";

  return (
    <Card className="p-3">
      <div className="text-[11px] font-semibold text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-extrabold ${cls}`}>{value == null ? "غير متوفر" : `${formatMoney(value)} د.ل`}</div>
    </Card>
  );
}

function DiffChip({
  diff,
  kind,
  packSize,
}: {
  diff: SavedDiff | null;
  kind: "shortage" | "excess" | "match" | "none";
  packSize: number | null;
}) {
  const status = normalizeInventoryDiffStatus(diff?.diff_status);
  if (!diff || kind === "none" || !status) {
    return (
      <span className="shrink-0 rounded-full bg-muted/60 px-2 py-0.5 text-xs font-bold leading-5 text-muted-foreground">
        غير محدد
      </span>
    );
  }

  if (status === "match") {
    return (
      <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-xs font-bold leading-5 text-success">
        مطابق
      </span>
    );
  }

  const raw = Number(diff.difference_raw);
  const qty = Number.isFinite(raw)
    ? rawToQty(raw, packSize ?? 1)
    : {
        boxes: Number(diff.difference_boxes ?? 0),
        strips: 0,
        units: Number(diff.difference_units ?? 0),
        raw: 0,
      };
  const toneClass = status === "shortage" ? "bg-destructive/10 text-destructive" : "bg-info/10 text-info";
  const icon = status === "shortage" ? "🔻" : "🔺";
  const label = status === "shortage" ? "عجز" : "زيادة";
  const parts = [
    qty.boxes ? `${formatNumber(Math.abs(qty.boxes))} علبة` : null,
    qty.units ? `${formatNumber(Math.abs(qty.units))} وحدة` : null,
  ].filter(Boolean);

  return (
    <div className={`shrink-0 rounded-xl px-2.5 py-1 text-center text-[11px] font-extrabold leading-4 ${toneClass}`}>
      <div>{icon} {label}</div>
      {parts.length > 0 && (
        <div className="mt-0.5 font-bold">
          {parts.join(" + ")}
        </div>
      )}
    </div>
  );
}

function QuantityCard({ icon, label, value }: { icon: string; label: string; value: string[] }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-2 py-2">
      <div className="text-[11px] font-semibold text-muted-foreground">{icon} {label}</div>
      <div className="mt-1 space-y-0.5 text-sm font-bold leading-5">
        {value.map((line, index) => (
          <div key={`${label}-${index}`}>{line}</div>
        ))}
      </div>
    </div>
  );
}

function RowList({
  rows,
  kind,
  onReview,
  onTimeline,
}: {
  rows: Row[];
  kind: "shortage" | "excess" | "match" | "none";
  onReview: (row: Row) => void;
  onTimeline: (row: Row) => void;
}) {
  if (rows.length === 0) return <div className="p-6 text-center text-sm text-muted-foreground">لا يوجد</div>;

  return (
    <div className="mt-2 space-y-2">
      {rows.map((row) => {
        const count = getApprovedCount(row);
        const systemQty = { boxes: row.system_boxes, strips: row.system_strips, units: row.system_units };
        const physicalQty = count
          ? { boxes: count.phys_boxes, strips: count.phys_strips, units: count.phys_units }
          : null;
        const diff = count ? getDisplayDiff(row, count) : null;
        const approval = getApprovalInfo(row);
        logInventoryReportDiagnostics(row, count, diff);

        return (
          <Card key={row.id} className="space-y-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold leading-5">{row.item_name_raw}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted-foreground">
                  <span>
                    الكود: <span dir={row.external_item_id ? "ltr" : "rtl"}>{row.external_item_id || "غير مسجل"}</span>
                  </span>
                  <span>
                    الباركود: <span dir={row.barcode ? "ltr" : "rtl"}>{row.barcode || "غير مسجل"}</span>
                  </span>
                </div>
              </div>
              <DiffChip diff={diff} kind={kind} packSize={row.pack_size} />
            </div>

            {approval && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-success/20 bg-success/5 px-3 py-2 text-[11px] leading-4">
                <div className="min-w-0">
                  <div className="font-bold text-success">✔ تم الاعتماد</div>
                  <div className="truncate text-foreground">{approval.userName}</div>
                </div>
                <div className="shrink-0 text-left text-muted-foreground">
                  <div>{formatDate(approval.at)}</div>
                  <div>{formatTime(approval.at)}</div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <QuantityCard icon="📦" label="النظام" value={formatQtyLines(row.system_quantity_raw || formatQtyArabic(systemQty))} />
              <QuantityCard icon="📋" label="الفعلي" value={physicalQty ? formatQtyLines(formatQtyArabic(physicalQty)) : ["غير محدد"]} />
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] leading-4">
              <EmployeeMeta row={row} />
              <CompactMeta label="قيمة الفرق" value={formatFinancialDifference(row)} className="col-span-2" />
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <Button type="button" className="h-10 text-xs font-bold" onClick={() => onReview(row)}>
                🔍 مراجعة الصنف
              </Button>
              <Button type="button" variant="outline" className="h-10 text-xs font-semibold" onClick={() => onTimeline(row)}>
                <History className="ms-1 size-3.5" />
                سجل الصنف
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function TimelineDialog({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const events = useMemo(() => (row ? buildTimeline(row) : []), [row]);

  if (!row) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/45 p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true">
      <Card className="max-h-[85vh] w-full overflow-hidden rounded-b-none p-0 shadow-xl sm:mx-auto sm:max-w-xl sm:rounded-lg">
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div className="min-w-0">
            <h3 className="text-base font-bold">سجل الصنف</h3>
            <p className="truncate text-xs text-muted-foreground">{row.item_name_raw}</p>
          </div>
          <Button type="button" variant="outline" className="h-9 px-3 text-xs" onClick={onClose}>
            إغلاق
          </Button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {events.length === 0 ? (
            <div className="rounded-lg bg-muted/60 p-4 text-center text-sm text-muted-foreground">لا يوجد سجل متاح لهذا الصنف.</div>
          ) : (
            <div className="space-y-3">
              {events.map((event) => (
                <div key={event.id} className="border-s-2 border-primary/30 ps-3">
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span>{formatDate(event.at)}</span>
                    <span>{formatTime(event.at)}</span>
                  </div>
                  <div className="mt-1 text-sm font-semibold">{event.title}</div>
                  <div className="text-xs text-muted-foreground">بواسطة {event.userName}</div>
                  {event.detail && <div className="mt-1 rounded-md bg-muted/50 px-2 py-1 text-xs">{event.detail}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function buildTimeline(row: Row): TimelineEvent[] {
  const events: TimelineEvent[] = [
    {
      id: `item-created-${row.id}`,
      at: row.created_at,
      title: "تم إنشاء الصنف داخل الجلسة",
      userName: "النظام",
    },
  ];

  for (const count of row.inventory_counts ?? []) {
    if (count.opened_at) {
      events.push({
        id: `opened-${count.id}`,
        at: count.opened_at,
        title: "تم فتح الصنف",
        userName: count.counted_employee_name || "مستخدم غير معروف",
      });
    }

    if (count.status === "draft") {
      events.push({
        id: `draft-${count.id}`,
        at: count.updated_at || count.created_at,
        title: "تم حفظ مسودة",
        userName: count.counted_employee_name || "مستخدم غير معروف",
      });
    }

    if (count.status === "approved") {
      events.push({
        id: `approved-${count.id}`,
        at: count.submitted_at || count.updated_at || count.created_at,
        title: count.count_version > 1 ? "تمت إعادة الاعتماد" : "تم الاعتماد",
        userName: count.counted_employee_name || "مستخدم غير معروف",
        detail: formatCountAuditDetail(count),
      });
    }
  }

  for (const audit of row.unapproval_audits) {
    events.push({
      id: `unapproved-${audit.count_id || audit.cancelled_at}`,
      at: audit.cancelled_at,
      title: "تم إلغاء الاعتماد",
      userName: audit.cancelled_by_name || "مستخدم غير معروف",
      detail: formatUnapprovalDetail(audit, row.pack_size),
    });
  }

  for (const audit of row.snapshot_audits) {
    events.push({
      id: `snapshot-${audit.executed_at}-${audit.inventory_item_id}`,
      at: audit.executed_at,
      title: audit.refresh_reason === "auto_refresh_on_first_open" ? "تم تحديث Snapshot عند فتح الصنف" : "تحديث المدير للـ Snapshot",
      userName: audit.executed_by_name || "مستخدم غير معروف",
      detail: formatSnapshotAuditDetail(audit),
    });
  }

  return events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function getCurrentCount(row: Row) {
  return row.inventory_counts?.find((count) => count.is_current) ?? null;
}

function getApprovedCount(row: Row) {
  return row.inventory_counts?.find((count) => count.is_current && count.status === "approved") ?? null;
}

function getApprovalInfo(row: Row) {
  const approvedCount = getApprovedCount(row);
  if (!approvedCount) return null;

  return {
    userName: approvedCount.counted_employee_name || "مستخدم غير معروف",
    at: approvedCount.submitted_at || approvedCount.updated_at || approvedCount.created_at,
  };
}

function getCalculatedDiff(row: Row, count: CountRow) {
  return diffTriple(
    { boxes: row.system_boxes, strips: row.system_strips, units: row.system_units },
    { boxes: count.phys_boxes, strips: count.phys_strips, units: count.phys_units },
    row.pack_size ?? 1,
  );
}

function getDisplayDiff(row: Row, count: CountRow): SavedDiff {
  const calculated = getCalculatedDiff(row, count);
  const savedStatus = normalizeInventoryDiffStatus(count.diff_status);
  const savedRaw = Number(count.difference_raw);

  if (savedStatus && Number.isFinite(savedRaw) && savedRaw !== calculated.raw) {
    console.warn(
      "[inventory-report] saved difference mismatch; using displayed snapshot/count values",
      {
        itemId: row.external_item_id,
        itemName: row.item_name_raw,
        packSize: row.pack_size,
        systemBoxes: row.system_boxes,
        systemUnits: row.system_units,
        countedBoxes: count.phys_boxes,
        countedUnits: count.phys_units,
        savedDifferenceRaw: savedRaw,
        calculatedDifferenceRaw: calculated.raw,
        savedDifferenceBoxes: count.difference_boxes,
        savedDifferenceUnits: count.difference_units,
        calculatedDifferenceBoxes: calculated.boxes,
        calculatedDifferenceUnits: calculated.units,
      },
    );
  }

  return {
    diff_status: diffStatus(calculated),
    difference_raw: calculated.raw,
    difference_boxes: calculated.boxes,
    difference_units: calculated.units,
  };
}

function getDisplayStatus(row: Row, count: CountRow) {
  return diffStatus(getCalculatedDiff(row, count));
}

function getRawDiff(row: Row) {
  const count = getApprovedCount(row);
  if (!count) return null;

  const diff = getDisplayDiff(row, count);
  const savedRaw = Number(diff.difference_raw);
  if (Number.isFinite(savedRaw)) return savedRaw;

  const boxes = Number(diff.difference_boxes ?? 0);
  const units = Number(diff.difference_units ?? 0);
  const packSize = row.pack_size ?? 1;
  const raw = (boxes * packSize) + units;
  const status = normalizeInventoryDiffStatus(diff.diff_status);

  if (status === "shortage") return -Math.abs(raw);
  if (status === "excess") return Math.abs(raw);
  if (status === "match") return 0;
  return null;
}

function getUnitPurchasePrice(row: Row) {
  const packPrice = Number(row.last_purchase_price);
  const packSize = Number(row.pack_size);
  if (!Number.isFinite(packPrice) || packPrice <= 0) return null;
  if (!Number.isFinite(packSize) || packSize <= 0) return null;
  return packPrice / packSize;
}

function getDifferenceFinancialValue(row: Row) {
  const rawDiff = getRawDiff(row);
  if (rawDiff == null) return null;
  if (rawDiff === 0) return 0;

  const unitPurchasePrice = getUnitPurchasePrice(row);
  if (unitPurchasePrice == null) return null;

  return Math.abs(rawDiff) * unitPurchasePrice;
}

function getFinancialValueUsingPackPriceAsRawUnit(row: Row) {
  const rawDiff = getRawDiff(row);
  const packPrice = Number(row.last_purchase_price);
  if (rawDiff == null || !Number.isFinite(packPrice) || packPrice <= 0) return null;
  return Math.abs(rawDiff) * packPrice;
}

function logInventoryReportDiagnostics(row: Row, count: CountRow | null, diff: SavedDiff | null) {
  if (!/قفازات|قفاز|glove/i.test(row.item_name_raw)) return;

  const packSize = Number(row.pack_size);
  const systemQuantityRaw = Number.isFinite(packSize)
    ? (Number(row.system_boxes || 0) * packSize) + Number(row.system_units || 0)
    : null;
  const countedQuantityRaw = count && Number.isFinite(packSize)
    ? (Number(count.phys_boxes || 0) * packSize) + Number(count.phys_units || 0)
    : null;
  const displayDiffRaw = diff?.difference_raw == null ? null : Number(diff.difference_raw);

  console.log(
    "[inventory-report] item financial/diff diagnostic:",
    JSON.stringify({
      itemId: row.external_item_id,
      itemName: row.item_name_raw,
      pack_size: row.pack_size,
      last_purchase_price: row.last_purchase_price,
      system_boxes: row.system_boxes,
      system_units: row.system_units,
      counted_boxes: count?.phys_boxes ?? null,
      counted_units: count?.phys_units ?? null,
      system_quantity_raw: systemQuantityRaw,
      counted_quantity_raw: countedQuantityRaw,
      difference_raw: displayDiffRaw,
      difference_boxes: diff?.difference_boxes ?? null,
      difference_units: diff?.difference_units ?? null,
      financial_value_before_fix: getFinancialValueUsingPackPriceAsRawUnit(row),
      financial_value_after_fix: getDifferenceFinancialValue(row),
    }),
  );
}

function formatFinancialDifference(row: Row) {
  const value = getDifferenceFinancialValue(row);
  return value == null ? "غير متوفر" : `${formatMoney(value)} د.ل`;
}

function summarizeFinancial(rows: Row[]) {
  let shortageValue: number | null = null;
  let excessValue: number | null = null;
  let hasAnyPurchasePrice = false;

  for (const row of rows) {
    if (getUnitPurchasePrice(row) != null) hasAnyPurchasePrice = true;

    const count = getApprovedCount(row);
    if (!count) continue;

    const status = getDisplayStatus(row, count);
    const value = getDifferenceFinancialValue(row);
    if (value == null) continue;

    if (status === "shortage") shortageValue = (shortageValue ?? 0) + value;
    if (status === "excess") excessValue = (excessValue ?? 0) + value;
  }

  return {
    hasAnyPurchasePrice,
    shortageValue,
    excessValue,
    netValue: shortageValue == null && excessValue == null ? null : (excessValue ?? 0) - (shortageValue ?? 0),
  };
}

function sortRows(rows: Row[], sortBy: SortKey) {
  return [...rows].sort((a, b) => {
    if (sortBy === "largestShortageValue") return compareFinancialOrQuantity(b, a, "shortage");
    if (sortBy === "largestExcessValue") return compareFinancialOrQuantity(b, a, "excess");
    if (sortBy === "largestQuantityDiff") return Math.abs(getRawDiff(b) ?? 0) - Math.abs(getRawDiff(a) ?? 0);
    if (sortBy === "latestApproval") return getApprovalTime(b) - getApprovalTime(a);
    if (sortBy === "itemName") return a.item_name_raw.localeCompare(b.item_name_raw, "ar");
    if (sortBy === "code") return (a.external_item_id || "").localeCompare(b.external_item_id || "", "ar");
    if (sortBy === "barcode") return (a.barcode || "").localeCompare(b.barcode || "", "ar");
    if (sortBy === "approverName") return (getApprovalInfo(a)?.userName || "").localeCompare(getApprovalInfo(b)?.userName || "", "ar");
    return a.row_index - b.row_index;
  });
}

function compareFinancialOrQuantity(a: Row, b: Row, expectedStatus: "shortage" | "excess") {
  const aStatus = getApprovedCount(a) ? getDisplayStatus(a, getApprovedCount(a)!) : null;
  const bStatus = getApprovedCount(b) ? getDisplayStatus(b, getApprovedCount(b)!) : null;
  const aPriority = aStatus === expectedStatus ? 1 : 0;
  const bPriority = bStatus === expectedStatus ? 1 : 0;
  if (aPriority !== bPriority) return aPriority - bPriority;

  const aMoney = getDifferenceFinancialValue(a);
  const bMoney = getDifferenceFinancialValue(b);
  if (aMoney != null && bMoney != null && aMoney !== bMoney) return aMoney - bMoney;
  if (aMoney != null && bMoney == null) return 1;
  if (aMoney == null && bMoney != null) return -1;

  return Math.abs(getRawDiff(a) ?? 0) - Math.abs(getRawDiff(b) ?? 0);
}

function getApprovalTime(row: Row) {
  const approval = getApprovalInfo(row);
  return approval ? new Date(approval.at).getTime() : 0;
}

function getEmployeeName(row: Row) {
  const approvedCount = getApprovedCount(row);
  if (approvedCount?.counted_by) return approvedCount.counted_employee_name || "مستخدم غير معروف";
  return "غير محدد";
}

function getAssignedEmployeeName(row: Row) {
  if (row.assigned_to) return row.assigned_employee_name || "مستخدم غير معروف";
  return "غير محدد";
}

function getCountedEmployeeName(row: Row) {
  return getEmployeeName(row);
}

function isSameAssignedAndCounted(row: Row) {
  const approvedCount = getApprovedCount(row);
  return Boolean(approvedCount?.counted_by && row.assigned_to && approvedCount.counted_by === row.assigned_to);
}

function EmployeeMeta({ row }: { row: Row }) {
  const approvedCount = getApprovedCount(row);
  if (!approvedCount) {
    return <CompactMeta label="المسند إلى" value={getAssignedEmployeeName(row)} className="col-span-2" />;
  }

  if (isSameAssignedAndCounted(row)) {
    return <CompactMeta label="الموظف" value={getCountedEmployeeName(row)} className="col-span-2" />;
  }

  return (
    <>
      <CompactMeta label="المسند إلى" value={getAssignedEmployeeName(row)} />
      <CompactMeta label="اعتمده" value={getCountedEmployeeName(row)} />
    </>
  );
}

function differenceTone(kind: "shortage" | "excess" | "match" | "none") {
  if (kind === "shortage") return "text-destructive";
  if (kind === "excess") return "text-info";
  if (kind === "match") return "text-success";
  return "text-muted-foreground";
}

function formatDifference(diff: SavedDiff | null, packSize: number | null) {
  if (!diff) return "غير محدد";

  const status = normalizeInventoryDiffStatus(diff.diff_status);
  if (status === "match") return "مطابق";

  let raw = Number(diff.difference_raw);
  if (!Number.isFinite(raw)) {
    const boxes = Number(diff.difference_boxes ?? 0);
    const units = Number(diff.difference_units ?? 0);
    raw = (boxes * (packSize ?? 1)) + units;
    if (status === "shortage") raw = -Math.abs(raw);
  }

  if (!Number.isFinite(raw) || raw === 0) return "مطابق";

  const sign = raw > 0 ? "+" : "-";
  const qty = rawToQty(raw, packSize ?? 1);
  const parts = [
    qty.boxes ? `${formatNumber(qty.boxes)} علبة` : null,
    qty.units ? `${formatNumber(qty.units)} وحدة` : null,
  ].filter(Boolean);

  return `${sign}${parts.join(" و") || formatNumber(Math.abs(raw))}`;
}

function formatCountAuditDetail(count: CountRow) {
  const qty = formatQtyArabic({ boxes: count.phys_boxes, strips: count.phys_strips, units: count.phys_units });
  const diff = formatDifference(
    {
      diff_status: count.diff_status,
      difference_raw: count.difference_raw,
      difference_boxes: count.difference_boxes,
      difference_units: count.difference_units,
    },
    count.pack_size_at_submit ?? count.pack_size_at_open ?? 1,
  );
  return `العدد: ${qty} · الفرق: ${diff}`;
}

function formatUnapprovalDetail(audit: UnapprovalAuditRow, packSize: number | null) {
  const countQty = formatQtyArabic({
    boxes: audit.old_phys_boxes ?? 0,
    strips: 0,
    units: audit.old_phys_units ?? 0,
  });
  const diff = formatDifference(
    {
      diff_status: audit.old_diff_status,
      difference_raw: audit.old_difference_raw,
      difference_boxes: audit.old_difference_boxes,
      difference_units: audit.old_difference_units,
    },
    packSize,
  );
  return `العدد السابق: ${countQty} · الفرق السابق: ${diff}`;
}

function formatSnapshotAuditDetail(audit: SnapshotAuditRow) {
  const oldValue = audit.old_system_quantity_raw || formatSimpleBoxesUnits(audit.old_system_boxes, audit.old_system_units);
  const newValue = audit.new_system_quantity_raw || formatSimpleBoxesUnits(audit.new_system_boxes, audit.new_system_units);
  return `${oldValue} → ${newValue}`;
}

function formatSimpleBoxesUnits(boxes: number | null, units: number | null) {
  const parts = [
    boxes ? `${formatNumber(boxes)} علبة` : null,
    units ? `${formatNumber(units)} وحدة` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" و") : "غير متوفر";
}

function formatQtyLines(value: string) {
  const normalized = value
    .replace(/\s+و\s+/g, " و")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return ["0"];
  return normalized.split(/\s+و(?=\d)/).map((part) => part.trim()).filter(Boolean);
}

function toCountSheetItem(row: Row) {
  const current = getCurrentCount(row);

  return {
    id: row.id,
    session_id: row.session_id,
    external_item_id: row.external_item_id,
    item_name_raw: row.item_name_raw,
    barcode: row.barcode,
    pack_size: row.pack_size,
    system_boxes: row.system_boxes,
    system_strips: row.system_strips,
    system_units: row.system_units,
    system_quantity_raw: row.system_quantity_raw,
    raw_quantity_snapshot: row.raw_quantity_snapshot,
    current: current
      ? {
          phys_boxes: current.phys_boxes,
          phys_strips: current.phys_strips,
          phys_units: current.phys_units,
          status: current.status === "approved" ? ("approved" as const) : ("draft" as const),
        }
      : undefined,
  };
}

function safeFilePart(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "-").trim() || "report";
}

function CompactMeta({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatMoney(value: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "غير متوفر";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const hour12 = hours % 12 || 12;
  const suffix = hours < 12 ? "صباحاً" : "مساءً";
  return `${String(hour12).padStart(2, "0")}:${minutes} ${suffix}`;
}
