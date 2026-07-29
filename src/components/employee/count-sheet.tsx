import { useEffect, useMemo, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useServerFn } from "@tanstack/react-start";
import { cancelApprovedCount, refreshUncountedItemSnapshotOnOpen, saveCount } from "@/lib/counts.functions";
import { getLiveItemStock, type LiveStock } from "@/lib/teryaq-stock.functions";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatQtyArabic, diffTriple, diffStatus, normalizePackSize, qtyToRaw } from "@/lib/quantity-parser";
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
  raw_quantity_snapshot: number | string | null;
  current?: {
    phys_boxes: number;
    phys_strips: number;
    phys_units: number;
    status: "draft" | "approved";
  };
};

type SessionSnapshotOverride = {
  systemBoxes: number;
  systemUnits: number;
  rawQuantity: number | null;
  formattedQuantity: string | null;
  packSize: number | null;
};

type ApprovalGateState = "idle" | "checking" | "refreshing" | "ready" | "blocked";

const STOCK_CHANGED_BEFORE_APPROVAL_MESSAGE =
  "تغيّر رصيد الصنف في المنظومة، يجب تحديث رصيد الجلسة قبل الاعتماد.";
const SNAPSHOT_REFRESH_FAILED_MESSAGE = "تعذر تحديث رصيد الجلسة، لا يمكن اعتماد الصنف الآن.";
const LIVE_UNAVAILABLE_MESSAGE = "تعذر التحقق من الرصيد المباشر، حاول مرة أخرى.";
const LIVE_CHANGED_REVIEW_MESSAGE =
  "تغيّر رصيد الصنف في المنظومة أثناء العد.\nتم تحديث رصيد الجلسة، يرجى مراجعة الكمية ثم الاعتماد من جديد.";

function makeOpId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getItemSnapshotRaw(item: Item): number | null {
  const raw = item.raw_quantity_snapshot == null ? null : Number(item.raw_quantity_snapshot);
  if (Number.isFinite(raw)) return raw;
  return qtyToRaw(
    { boxes: item.system_boxes, units: item.system_units },
    normalizePackSize(item.pack_size),
  );
}

export function CountSheet({
  item,
  isAdmin = false,
  onClose,
  onSaved,
  onCancelled,
  onSnapshotRefreshed,
}: {
  item: Item | null;
  isAdmin?: boolean;
  onClose: () => void;
  onSaved: () => void;
  onCancelled?: () => void;
  onSnapshotRefreshed?: () => void | Promise<void>;
}) {
  const [boxes, setBoxes] = useState(0);
  const [units, setUnits] = useState(0);
  const [countCleared, setCountCleared] = useState(false);
  const [countStarted, setCountStarted] = useState(false);
  const [live, setLive] = useState<LiveStock | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [snapshotOverride, setSnapshotOverride] = useState<SessionSnapshotOverride | null>(null);
  const [openSnap, setOpenSnap] = useState<LiveStock | null>(null);
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const [approvalBlockMessage, setApprovalBlockMessage] = useState<string | null>(null);
  const [approvalGate, setApprovalGate] = useState<ApprovalGateState>("idle");
  const [approvalGateMessage, setApprovalGateMessage] = useState<string | null>(null);
  const save = useServerFn(saveCount);
  const cancelCount = useServerFn(cancelApprovedCount);
  const refreshSnapshotOnOpen = useServerFn(refreshUncountedItemSnapshotOnOpen);
  const fetchLive = useServerFn(getLiveItemStock);
  const isApproved = item?.current?.status === "approved" && !countCleared;
  const showClearedState = countCleared && !countStarted;

  useEffect(() => {
    if (item) {
      setBoxes(item.current?.phys_boxes ?? 0);
      setUnits(item.current?.phys_units ?? 0);
      setCountCleared(false);
      setCountStarted(false);
      setLive(null);
      setLiveError(null);
      setSnapshotOverride(null);
      setOpenSnap(null);
      setApprovalBlockMessage(null);
      setApprovalGate(item.current?.status === "approved" ? "ready" : "checking");
      setApprovalGateMessage(null);
      setOpenedAt(null);
      if (item.external_item_id) {
        setLiveLoading(true);
        const openedAtIso = new Date().toISOString();
        fetchLive({ data: { external_item_id: item.external_item_id, inventory_item_id: item.id } })
          .then(async (s) => {
            setLive(s);
            setOpenSnap(s);
            setOpenedAt(openedAtIso);
            setLiveError(null);
            if (item.current?.status === "approved") {
              setApprovalGate("ready");
              return;
            }

            const snapshotRaw = getItemSnapshotRaw(item);
            if (s.rawQuantity == null || snapshotRaw == null) {
              setApprovalGate("blocked");
              setApprovalGateMessage(LIVE_UNAVAILABLE_MESSAGE);
              return;
            }

            if (s.rawQuantity === snapshotRaw) {
              setApprovalGate("ready");
              setApprovalGateMessage(null);
              return;
            }

            setApprovalGate("refreshing");
            setApprovalGateMessage(STOCK_CHANGED_BEFORE_APPROVAL_MESSAGE);
            try {
              const refreshed = await refreshSnapshotOnOpen({
                data: {
                  item_id: item.id,
                  session_id: item.session_id,
                  live_snapshot: {
                    raw_quantity: s.rawQuantity,
                    pack_size: s.packSize,
                    system_boxes: s.systemBoxes,
                    system_units: s.systemUnits,
                    formatted_quantity: s.formattedQuantity,
                    source_read_at: s.readAt,
                  },
                  reason: item.current?.status === "draft"
                    ? "approval_guard_live_mismatch"
                    : "auto_refresh_on_first_open",
                  allow_current_draft: item.current?.status === "draft",
                },
              });
              const refreshedRaw = refreshed.snapshot?.raw_quantity_snapshot == null
                ? null
                : Number(refreshed.snapshot.raw_quantity_snapshot);

              if (refreshed.snapshot && Number.isFinite(refreshedRaw) && refreshedRaw === s.rawQuantity) {
                setSnapshotOverride({
                  systemBoxes: refreshed.snapshot.system_boxes,
                  systemUnits: refreshed.snapshot.system_units,
                  rawQuantity: refreshed.snapshot.raw_quantity_snapshot,
                  formattedQuantity: refreshed.snapshot.system_quantity_raw,
                  packSize: refreshed.snapshot.pack_size,
                });
                setApprovalGate("ready");
                setApprovalGateMessage(null);
                await onSnapshotRefreshed?.();
                return;
              }

              setApprovalGate("blocked");
              setApprovalGateMessage(SNAPSHOT_REFRESH_FAILED_MESSAGE);
            } catch {
              setApprovalGate("blocked");
              setApprovalGateMessage(SNAPSHOT_REFRESH_FAILED_MESSAGE);
            }
          })
          .catch((e: Error) => {
            setApprovalGate(item.current?.status === "approved" ? "ready" : "blocked");
            setApprovalGateMessage(LIVE_UNAVAILABLE_MESSAGE);
            setLiveError(e.message || "تعذر جلب الرصيد");
          })
          .finally(() => setLiveLoading(false));
      } else {
        setApprovalGate(item.current?.status === "approved" ? "ready" : "blocked");
        setApprovalGateMessage(LIVE_UNAVAILABLE_MESSAGE);
      }
    }
  }, [item, fetchLive, refreshSnapshotOnOpen, onSnapshotRefreshed]);

  // Inventory differences must always use the fixed session snapshot.
  // Live stock is displayed separately and is only used for recount validation.
  const displayedSys = useMemo(() => {
    if (countCleared && live) {
      return { boxes: live.systemBoxes, strips: 0, units: live.systemUnits };
    }
    if (!isApproved && snapshotOverride) {
      return { boxes: snapshotOverride.systemBoxes, strips: 0, units: snapshotOverride.systemUnits };
    }
    return item
      ? { boxes: item.system_boxes, strips: item.system_strips, units: item.system_units }
      : { boxes: 0, strips: 0, units: 0 };
  }, [item, countCleared, live, snapshotOverride, isApproved]);

  const displayedPackSize =
    (countCleared && live?.packSize)
      ? live.packSize
      : (!isApproved && snapshotOverride?.packSize)
        ? snapshotOverride.packSize
        : (item?.pack_size ?? 1);

  const displayedSnapshotRaw = useMemo(() => {
    if (!item) return null;
    const overrideRaw =
      snapshotOverride?.rawQuantity == null ? null : Number(snapshotOverride.rawQuantity);
    if (!isApproved && Number.isFinite(overrideRaw)) return overrideRaw;
    const rowRaw = item.raw_quantity_snapshot == null ? null : Number(item.raw_quantity_snapshot);
    if (Number.isFinite(rowRaw)) return rowRaw;
    return qtyToRaw(
      { boxes: displayedSys.boxes, units: displayedSys.units },
      normalizePackSize(displayedPackSize),
    );
  }, [item, snapshotOverride, isApproved, displayedSys, displayedPackSize]);

  const diff = useMemo(() => {
    if (!item) return { boxes: 0, strips: 0, units: 0 };
    return diffTriple(displayedSys, { boxes, strips: displayedSys.strips, units }, displayedPackSize);
  }, [item, boxes, units, displayedSys, displayedPackSize]);

  const status = useMemo(() => diffStatus(diff), [diff]);
  const approvalStatusMessage = approvalBlockMessage ?? approvalGateMessage;
  const approveBlockedByStock = !isApproved && approvalGate !== "ready";

  const cancelMut = useMutation({
    mutationFn: async () => {
      if (!item) return;
      return cancelCount({
        data: {
          item_id: item.id,
          session_id: item.session_id,
          live_snapshot: live
            ? {
                raw_quantity: live.rawQuantity,
                pack_size: live.packSize,
                system_boxes: live.systemBoxes,
                system_units: live.systemUnits,
                formatted_quantity: live.formattedQuantity,
                source_read_at: live.readAt,
              }
            : undefined,
        },
      });
    },
    onSuccess: () => {
      setBoxes(0);
      setUnits(0);
      setCountStarted(false);
      setCountCleared(true);
      if (live) {
        setOpenSnap(live);
        setOpenedAt(new Date().toISOString());
      }
      toast.success("تم إلغاء اعتماد الصنف");
      onCancelled?.();
    },
    onError: (e: Error) => {
      toast.error(e.message);
      if (e.message.includes("تغيّر رصيد الصنف")) {
        setApprovalBlockMessage(e.message);
        onSnapshotRefreshed?.();
      }
    },
  });

  const mut = useMutation({
    mutationFn: async (kind: "draft" | "approved") => {
      if (!item) return;
      // On approve: fetch a fresh live snapshot and compare it with the
      // session snapshot raw quantity. Live stock is not a calculation basis.
      let submitSnap: LiveStock | null = null;
      if (kind === "approved" && item.external_item_id && !isApproved) {
        try {
          submitSnap = await fetchLive({
            data: {
              external_item_id: item.external_item_id,
              inventory_item_id: item.id,
              forceRefresh: true,
            },
          });
          setLive(submitSnap);
          setOpenSnap(submitSnap);
          setOpenedAt(new Date().toISOString());

          if (submitSnap.rawQuantity == null || displayedSnapshotRaw == null) {
            setApprovalGate("blocked");
            setApprovalGateMessage(LIVE_UNAVAILABLE_MESSAGE);
            setApprovalBlockMessage(LIVE_UNAVAILABLE_MESSAGE);
            return { blocked: true as const, reason: "live_unavailable" as const };
          }

          if (submitSnap.rawQuantity !== displayedSnapshotRaw) {
            setApprovalGate("refreshing");
            setApprovalGateMessage(STOCK_CHANGED_BEFORE_APPROVAL_MESSAGE);
            const refreshed = await refreshSnapshotOnOpen({
              data: {
                item_id: item.id,
                session_id: item.session_id,
                live_snapshot: {
                  raw_quantity: submitSnap.rawQuantity,
                  pack_size: submitSnap.packSize,
                  system_boxes: submitSnap.systemBoxes,
                  system_units: submitSnap.systemUnits,
                  formatted_quantity: submitSnap.formattedQuantity,
                  source_read_at: submitSnap.readAt,
                },
                reason: "approval_guard_live_mismatch",
                allow_current_draft: item.current?.status === "draft",
              },
            });
            if (refreshed.snapshot) {
              const refreshedRaw = refreshed.snapshot.raw_quantity_snapshot == null
                ? null
                : Number(refreshed.snapshot.raw_quantity_snapshot);
              setSnapshotOverride({
                systemBoxes: refreshed.snapshot.system_boxes,
                systemUnits: refreshed.snapshot.system_units,
                rawQuantity: refreshed.snapshot.raw_quantity_snapshot,
                formattedQuantity: refreshed.snapshot.system_quantity_raw,
                packSize: refreshed.snapshot.pack_size,
              });
              if (Number.isFinite(refreshedRaw) && refreshedRaw === submitSnap.rawQuantity) {
                setApprovalGate("ready");
                setApprovalGateMessage(null);
              } else {
                setApprovalGate("blocked");
                setApprovalGateMessage(SNAPSHOT_REFRESH_FAILED_MESSAGE);
              }
              await onSnapshotRefreshed?.();
            } else {
              setApprovalGate("blocked");
              setApprovalGateMessage(SNAPSHOT_REFRESH_FAILED_MESSAGE);
            }
            setApprovalBlockMessage(LIVE_CHANGED_REVIEW_MESSAGE);
            return { blocked: true as const, reason: "live_changed" as const };
          }
        } catch (e) {
          setApprovalGate("blocked");
          setApprovalGateMessage(SNAPSHOT_REFRESH_FAILED_MESSAGE);
          setApprovalBlockMessage((e as Error).message || SNAPSHOT_REFRESH_FAILED_MESSAGE);
          return { blocked: true as const, reason: "live_unavailable" as const };
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
      setApprovalBlockMessage(null);
      onSaved();
    },
    onError: (e: Error) => {
      toast.error(e.message);
      if (e.message.includes("تغيّر رصيد الصنف")) {
        setApprovalBlockMessage(e.message);
        onSnapshotRefreshed?.();
      }
    },
  });

  async function refetchLiveNow() {
    if (!item?.external_item_id) return;
    setLiveLoading(true);
    setLiveError(null);
    const openedAtIso = new Date().toISOString();
    try {
      const s = await fetchLive({ data: { external_item_id: item.external_item_id, inventory_item_id: item.id } });
      setLive(s);
      setOpenSnap(s);
      setOpenedAt(openedAtIso);
      setApprovalBlockMessage(null);
      if (!isApproved) {
        if (s.rawQuantity == null || displayedSnapshotRaw == null) {
          setApprovalGate("blocked");
          setApprovalGateMessage(LIVE_UNAVAILABLE_MESSAGE);
        } else if (s.rawQuantity === displayedSnapshotRaw) {
          setApprovalGate("ready");
          setApprovalGateMessage(null);
        } else {
          setApprovalGate("refreshing");
          setApprovalGateMessage(STOCK_CHANGED_BEFORE_APPROVAL_MESSAGE);
          try {
            const refreshed = await refreshSnapshotOnOpen({
              data: {
                item_id: item.id,
                session_id: item.session_id,
                live_snapshot: {
                  raw_quantity: s.rawQuantity,
                  pack_size: s.packSize,
                  system_boxes: s.systemBoxes,
                  system_units: s.systemUnits,
                  formatted_quantity: s.formattedQuantity,
                  source_read_at: s.readAt,
                },
                reason: item.current?.status === "draft"
                  ? "approval_guard_live_mismatch"
                  : "auto_refresh_on_first_open",
                allow_current_draft: item.current?.status === "draft",
              },
            });
            const refreshedRaw = refreshed.snapshot?.raw_quantity_snapshot == null
              ? null
              : Number(refreshed.snapshot.raw_quantity_snapshot);
            if (refreshed.snapshot && Number.isFinite(refreshedRaw) && refreshedRaw === s.rawQuantity) {
              setSnapshotOverride({
                systemBoxes: refreshed.snapshot.system_boxes,
                systemUnits: refreshed.snapshot.system_units,
                rawQuantity: refreshed.snapshot.raw_quantity_snapshot,
                formattedQuantity: refreshed.snapshot.system_quantity_raw,
                packSize: refreshed.snapshot.pack_size,
              });
              setApprovalGate("ready");
              setApprovalGateMessage(null);
              await onSnapshotRefreshed?.();
            } else {
              setApprovalGate("blocked");
              setApprovalGateMessage(SNAPSHOT_REFRESH_FAILED_MESSAGE);
            }
          } catch {
            setApprovalGate("blocked");
            setApprovalGateMessage(SNAPSHOT_REFRESH_FAILED_MESSAGE);
          }
        }
      }
    } catch (e) {
      setApprovalGate(isApproved ? "ready" : "blocked");
      setApprovalGateMessage(LIVE_UNAVAILABLE_MESSAGE);
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
              {!countCleared && (
                <div className="rounded-2xl bg-muted/50 border border-border p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[11px] font-semibold text-muted-foreground text-start">
                      رصيد الجلسة
                    </div>
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
                </div>
              )}

              {(liveLoading || live || liveError) && (
                <div className="rounded-2xl border border-border bg-background p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold text-muted-foreground">
                      الرصيد المباشر الحالي
                    </div>
                    {liveLoading ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" />
                        جاري التحديث...
                      </span>
                    ) : live?.source === "fallback" ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2 py-0.5 bg-warning/15 text-warning">
                        <AlertTriangle className="size-3" />
                        {`رصيد محفوظ — آخر تحديث منذ ${live.ageMinutes} دقيقة`}
                      </span>
                    ) : live ? (
                      <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-success/15 text-success">
                        مباشر
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2 py-0.5 bg-warning/15 text-warning">
                        <AlertTriangle className="size-3" />
                        غير متاح الآن
                      </span>
                    )}
                  </div>
                  {live ? (
                    <div className="flex items-center justify-around gap-3">
                      <div className="flex items-center gap-2">
                        <Package className="size-4 text-muted-foreground" />
                        <span className="text-base font-bold tabular-nums">{live.systemBoxes}</span>
                        <span className="text-xs text-muted-foreground">علبة</span>
                      </div>
                      <div className="h-7 w-px bg-border" />
                      <div className="flex items-center gap-2">
                        <Pill className="size-4 text-muted-foreground" />
                        <span className="text-base font-bold tabular-nums">{live.systemUnits}</span>
                        <span className="text-xs text-muted-foreground">وحدة</span>
                      </div>
                    </div>
                  ) : liveError ? (
                    <div className="text-[11px] text-muted-foreground text-center">
                      يتم استخدام رصيد الجلسة للحساب. الرصيد المباشر للعرض فقط.
                    </div>
                  ) : null}
                  {live?.formattedQuantity && (
                    <div className="text-[11px] text-muted-foreground text-center">
                      {live.formattedQuantity}
                    </div>
                  )}
                </div>
              )}

              {approvalStatusMessage && (
                <div className="rounded-xl border border-warning/40 bg-warning/10 p-3">
                  <div className="text-sm font-semibold text-warning-foreground text-center whitespace-pre-line">
                    {approvalStatusMessage}
                  </div>
                </div>
              )}

              {isAdmin && isApproved && (
                <Button
                  type="button"
                  variant="destructive"
                  className="w-full h-11 font-semibold"
                  disabled={cancelMut.isPending}
                  onClick={() => {
                    const ok = confirm("سيتم إلغاء اعتماد هذا الصنف وحذف العد المعتمد الحالي. هل تريد المتابعة؟");
                    if (ok) cancelMut.mutate();
                  }}
                >
                  {cancelMut.isPending ? "جاري إلغاء الاعتماد..." : "إلغاء الاعتماد"}
                </Button>
              )}

              <div className="grid grid-cols-2 gap-3">
                <BigQtyCard
                  icon={<Package className="size-5" />}
                  title="علبة"
                  value={boxes}
                  onChange={(value) => {
                    setBoxes(value);
                    setCountStarted(true);
                    setApprovalBlockMessage(null);
                  }}
                  inputId="qty-boxes"
                  nextId="qty-units"
                  disabled={isApproved}
                />
                <BigQtyCard
                  icon={<Pill className="size-5" />}
                  title="وحدة"
                  value={units}
                  onChange={(value) => {
                    setUnits(value);
                    setCountStarted(true);
                    setApprovalBlockMessage(null);
                  }}
                  inputId="qty-units"
                  nextId="btn-confirm"
                  disabled={isApproved}
                />
              </div>

              {showClearedState ? (
                <div className="rounded-xl p-3 text-sm font-semibold text-center bg-muted text-muted-foreground">
                  لم يتم إدخال عد جديد
                </div>
              ) : (
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
              )}

              <div className="grid grid-cols-2 gap-2 sticky bottom-0 bg-background pt-2">
                <Button
                  variant="outline"
                  className="h-14 text-base"
                  disabled={isApproved || mut.isPending || liveLoading}
                  onClick={() => mut.mutate("draft")}
                >
                  حفظ مسودة
                </Button>
                <Button
                  id="btn-confirm"
                  className="h-14 font-bold text-base"
                  disabled={isApproved || mut.isPending || liveLoading || approveBlockedByStock}
                  onClick={() => mut.mutate("approved")}
                >
                  {isApproved ? "تم الاعتماد" : "اعتماد العدد"}
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
  disabled = false,
}: {
  icon: React.ReactNode;
  title: string;
  value: number;
  onChange: (n: number) => void;
  inputId: string;
  nextId: string;
  disabled?: boolean;
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
        disabled={disabled}
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
          disabled={disabled}
          onClick={() => onChange(Math.max(0, value - 1))}
        >
          −1
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="h-9 text-sm"
          disabled={disabled}
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
