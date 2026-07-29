import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CountSheet, type SavedCountResult } from "@/components/employee/count-sheet";
import { BarcodeScannerSheet } from "@/components/employee/barcode-scanner-sheet";
import { formatQtyArabic } from "@/lib/quantity-parser";
import { formatInventoryDiffBadge, normalizeInventoryDiffStatus } from "@/lib/inventory-diff-display";
import { fetchAllSupabasePages } from "@/lib/supabase-pagination";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Camera, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

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
  raw_quantity_snapshot: number | string | null;
  quantity_parse_status: string;
  current?: {
    phys_boxes: number;
    phys_strips: number;
    phys_units: number;
    difference_raw?: number | string | null;
    difference_boxes?: number | null;
    difference_units?: number | null;
    diff_status?: string | null;
    counted_by?: string | null;
    counted_employee_name?: string | null;
    status: "draft" | "approved";
  };
};

type CountRow = {
  item_id: string;
  phys_boxes: number;
  phys_strips: number;
  phys_units: number;
  difference_raw: number | string | null;
  difference_boxes: number | null;
  difference_units: number | null;
  diff_status: string | null;
  counted_by: string | null;
  status: "draft" | "approved";
};

type ProfileRow = {
  id: string;
  display_name: string | null;
  username: string | null;
};

type CountStatusFilter = "uncounted" | "shortage" | "excess" | "match" | "all";

const COUNT_STATUS_CARDS: Array<{
  key: CountStatusFilter;
  label: string;
  tone: "muted" | "destructive" | "info" | "success" | "primary";
}> = [
  { key: "uncounted", label: "لم يُعدّ", tone: "muted" },
  { key: "shortage", label: "عجز", tone: "destructive" },
  { key: "excess", label: "زيادة", tone: "info" },
  { key: "match", label: "مطابق", tone: "success" },
  { key: "all", label: "الكل", tone: "primary" },
];

function CountPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();
  const [openItem, setOpenItem] = useState<Item | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<CountStatusFilter>("uncounted");
  const [scannerOpen, setScannerOpen] = useState(false);
  const { data: currentUser } = useCurrentUser();
  const isAdmin = currentUser?.role === "admin";

  const { data: items = [], isLoading, refetch } = useQuery({
    queryKey: ["assigned-items", id],
    queryFn: async () => {
      const itemRows = await fetchAllSupabasePages<Item>(() =>
        supabase
          .from("inventory_items")
          .select(
            "id, session_id, row_index, item_name_raw, barcode, external_item_id, pack_size, system_boxes, system_strips, system_units, system_quantity_raw, raw_quantity_snapshot, quantity_parse_status",
          )
          .eq("session_id", id)
          .order("row_index", { ascending: true })
          .order("id", { ascending: true }),
      );
      if (itemRows.length === 0) return [] as Item[];
      const counts = await fetchAllSupabasePages<CountRow>(() =>
        supabase
          .from("inventory_counts")
          .select("item_id, phys_boxes, phys_strips, phys_units, difference_raw, difference_boxes, difference_units, diff_status, counted_by, status")
          .eq("session_id", id)
          .eq("is_current", true)
          .order("item_id", { ascending: true }),
      );
      const countedByIds = Array.from(
        new Set(counts.map((count) => count.counted_by).filter(Boolean) as string[]),
      );
      const profilesById = new Map<string, string>();
      if (countedByIds.length > 0) {
        const profiles = await fetchAllSupabasePages<ProfileRow>(() =>
          supabase
            .from("profiles")
            .select("id, display_name, username")
            .in("id", countedByIds)
            .order("display_name", { ascending: true }),
        );
        for (const profile of profiles) {
          profilesById.set(profile.id, profile.display_name || profile.username || "مستخدم غير معروف");
        }
      }
      const byItem = new Map<string, Item["current"]>();
      for (const c of counts) {
        byItem.set(c.item_id, {
          phys_boxes: c.phys_boxes,
          phys_strips: c.phys_strips,
          phys_units: c.phys_units,
          difference_raw: c.difference_raw,
          difference_boxes: c.difference_boxes,
          difference_units: c.difference_units,
          diff_status: c.diff_status,
          counted_by: c.counted_by,
          counted_employee_name: c.counted_by ? profilesById.get(c.counted_by) ?? "مستخدم غير معروف" : null,
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

  const searchFilteredItems = useMemo(() => {
    if (!query.trim()) return visibleItems;
    const q = query.trim().toLowerCase();
    return visibleItems.filter(
      (i) =>
        i.item_name_raw.toLowerCase().includes(q) ||
        (i.barcode ?? "").toLowerCase().includes(q) ||
        (i.external_item_id ?? "").toLowerCase().includes(q),
    );
  }, [visibleItems, query]);

  const statusCounts = useMemo(
    () =>
      searchFilteredItems.reduce(
        (acc, item) => {
          const status = getCountStatus(item);
          acc[status] += 1;
          acc.all += 1;
          return acc;
        },
        { uncounted: 0, shortage: 0, excess: 0, match: 0, all: 0 } as Record<CountStatusFilter, number>,
      ),
    [searchFilteredItems],
  );

  const filtered = useMemo(() => {
    if (statusFilter === "all") return searchFilteredItems;
    return searchFilteredItems.filter((item) => getCountStatus(item) === statusFilter);
  }, [searchFilteredItems, statusFilter]);

  const progressTotal = statusCounts.all;
  const progressCompleted = statusCounts.match + statusCounts.shortage + statusCounts.excess;
  const progressPercent = progressTotal ? Math.round((progressCompleted / progressTotal) * 100) : 0;

  const updateCachedItemCount = useCallback(
    (itemId: string, current: Item["current"] | undefined) => {
      queryClient.setQueryData<Item[]>(["assigned-items", id], (previous) =>
        previous?.map((item) => (item.id === itemId ? { ...item, current } : item)) ?? previous,
      );
    },
    [id, queryClient],
  );

  const applySavedCountOptimistically = useCallback(
    (saved?: SavedCountResult) => {
      if (!saved?.item_id || !saved.status) return;

      const current: Item["current"] = {
        phys_boxes: saved.phys_boxes ?? 0,
        phys_strips: saved.phys_strips ?? 0,
        phys_units: saved.phys_units ?? 0,
        difference_raw: saved.difference_raw ?? null,
        difference_boxes: saved.difference_boxes ?? null,
        difference_units: saved.difference_units ?? null,
        diff_status: saved.diff_status ?? null,
        counted_by: saved.counted_by ?? currentUser?.id ?? null,
        counted_employee_name:
          currentUser?.display_name || currentUser?.username || "مستخدم غير معروف",
        status: saved.status,
      };

      updateCachedItemCount(saved.item_id, current);
    },
    [currentUser?.display_name, currentUser?.id, currentUser?.username, updateCachedItemCount],
  );

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

  const handleSnapshotRefreshed = useCallback(async () => {
    const result = await refetch();
    const updated = result.data?.find((item) => item.id === openItem?.id);
    if (updated) setOpenItem(updated);
  }, [refetch, openItem?.id]);

  useEffect(() => {
    if (!openItem?.id) return;
    const updated = items.find((item) => item.id === openItem.id);
    if (updated && updated !== openItem) setOpenItem(updated);
  }, [items, openItem?.id]);

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
          <div className="-mx-1 overflow-x-auto pb-1">
            <div className="flex min-w-max gap-2 px-1">
              {COUNT_STATUS_CARDS.map((card) => (
                <button
                  key={card.key}
                  type="button"
                  onClick={() => setStatusFilter(card.key)}
                  className={cn(
                    "min-w-[76px] rounded-xl border px-3 py-2 text-start transition-colors",
                    statusFilter === card.key
                      ? statusCardActiveClass(card.tone)
                      : "border-border bg-card text-foreground active:bg-accent",
                  )}
                  aria-pressed={statusFilter === card.key}
                >
                  <div
                    className={cn(
                      "text-[11px] font-semibold leading-none",
                      statusFilter === card.key ? "text-current opacity-80" : "text-muted-foreground",
                    )}
                  >
                    {card.label}
                  </div>
                  <div className="mt-1 text-lg font-extrabold tabular-nums">
                    {statusCounts[card.key].toLocaleString("ar")}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                تم عدّ {progressCompleted.toLocaleString("ar")} من {progressTotal.toLocaleString("ar")} صنفًا
              </span>
              <span className="font-semibold text-foreground">{progressPercent.toLocaleString("ar")}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
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
            const status = getCountStatus(it);
            const diffBadge = it.current
              ? formatInventoryDiffBadge(
                  {
                    diff_status: it.current.diff_status ?? status,
                    difference_raw: it.current.difference_raw,
                    difference_boxes: it.current.difference_boxes,
                    difference_units: it.current.difference_units,
                  },
                  it.pack_size,
                )
              : "";
            const identity = [
              it.external_item_id ? `Code: ${it.external_item_id}` : null,
              it.barcode ? `Barcode: ${it.barcode}` : null,
            ].filter(Boolean).join(" · ");
            const chip =
              it.current?.status === "draft"
                ? "bg-warning/15 text-warning-foreground"
                : status === "match"
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
                    {it.current?.status === "approved" && (
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        تم الاعتماد بواسطة: {it.current.counted_employee_name || "مستخدم غير معروف"}
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
                        : diffBadge}
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>

      <CountSheet
        item={openItem}
        isAdmin={isAdmin}
        onClose={() => setOpenItem(null)}
        onSaved={(saved) => {
          applySavedCountOptimistically(saved);
          setOpenItem(null);
          void refetch();
        }}
        onCancelled={() => {
          if (openItem?.id) {
            updateCachedItemCount(openItem.id, undefined);
          }
          void refetch();
        }}
        onSnapshotRefreshed={handleSnapshotRefreshed}
      />
      <BarcodeScannerSheet
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleBarcodeDetected}
      />
    </div>
  );
}

function getCountStatus(item: Item): Exclude<CountStatusFilter, "all"> {
  if (item.current?.status !== "approved") return "uncounted";

  const savedStatus = normalizeInventoryDiffStatus(item.current.diff_status);
  if (savedStatus === "match" || savedStatus === "shortage" || savedStatus === "excess") {
    return savedStatus;
  }

  const raw = Number(item.current.difference_raw);
  if (Number.isFinite(raw)) {
    if (raw < 0) return "shortage";
    if (raw > 0) return "excess";
    return "match";
  }

  const boxes = Number(item.current.difference_boxes ?? 0);
  const units = Number(item.current.difference_units ?? 0);
  const combined = boxes + units;
  if (combined < 0) return "shortage";
  if (combined > 0) return "excess";
  return "match";
}

function statusCardActiveClass(tone: (typeof COUNT_STATUS_CARDS)[number]["tone"]) {
  switch (tone) {
    case "destructive":
      return "border-destructive/50 bg-destructive/15 text-destructive shadow-sm";
    case "info":
      return "border-info/50 bg-info/15 text-info shadow-sm";
    case "success":
      return "border-success/50 bg-success/15 text-success shadow-sm";
    case "primary":
      return "border-primary/50 bg-primary/15 text-primary shadow-sm";
    case "muted":
    default:
      return "border-foreground/20 bg-muted text-foreground shadow-sm";
  }
}
