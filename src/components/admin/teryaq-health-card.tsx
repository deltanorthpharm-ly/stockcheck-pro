import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { pingTeryaqHealth, getLatestHealthPing, syncSessionFromTeryaq } from "@/lib/teryaq.functions";
import { listSessions } from "@/lib/sessions.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Loader2, Activity, Database } from "lucide-react";
import { useState } from "react";

export function TeryaqHealthCard() {
  const qc = useQueryClient();
  const ping = useServerFn(pingTeryaqHealth);
  const getLatest = useServerFn(getLatestHealthPing);
  const sync = useServerFn(syncSessionFromTeryaq);
  const listSess = useServerFn(listSessions);

  const { data: latest } = useQuery({
    queryKey: ["teryaq-health-latest"],
    queryFn: () => getLatest(),
  });

  const pingM = useMutation({
    mutationFn: () => ping(),
    onSettled: () => qc.invalidateQueries({ queryKey: ["teryaq-health-latest"] }),
  });

  const [chosenSession, setChosenSession] = useState<string>("");
  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => listSess(),
  });

  const syncM = useMutation({
    mutationFn: () => sync({ data: { session_id: chosenSession, limit: 10 } }),
  });

  const healthOk = latest?.ok === true;
  const canSync = healthOk && chosenSession;

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="size-4" />
          <span className="font-semibold text-sm">اتصال Teryaq</span>
        </div>
        <StatusPill ok={healthOk} loading={pingM.isPending} unknown={!latest} />
      </div>

      {latest && (
        <div className="text-xs text-muted-foreground">
          آخر فحص: {new Date(latest.checked_at).toLocaleString("ar")}
          {latest.latency_ms != null ? ` · ${latest.latency_ms}ms` : ""}
          {latest.error ? ` · ${latest.error}` : ""}
        </div>
      )}

      <Button
        size="sm"
        variant="outline"
        onClick={() => pingM.mutate()}
        disabled={pingM.isPending}
        className="h-9"
      >
        {pingM.isPending ? <Loader2 className="size-4 animate-spin" /> : "اختبار الاتصال الآن"}
      </Button>

      <div className="pt-3 border-t space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Database className="size-4" />
          مزامنة تجريبية (10 أصناف)
        </div>
        <select
          className="w-full h-10 rounded-md border bg-background px-2 text-sm"
          value={chosenSession}
          onChange={(e) => setChosenSession(e.target.value)}
        >
          <option value="">اختر جلسة…</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.status === "open" ? "مفتوحة" : "مغلقة"})
            </option>
          ))}
        </select>
        <Button
          size="sm"
          onClick={() => syncM.mutate()}
          disabled={!canSync || syncM.isPending}
          className="h-9"
        >
          {syncM.isPending ? <Loader2 className="size-4 animate-spin" /> : "مزامنة 10 أصناف"}
        </Button>
        {!healthOk && (
          <div className="text-xs text-muted-foreground">اختبر الاتصال أولاً بنجاح.</div>
        )}
        {syncM.data && (
          <div className="text-xs space-y-0.5">
            <div>مستلَم من Teryaq: {syncM.data.received_from_teryaq}</div>
            <div>مُطابَق: {syncM.data.mapped_rows}</div>
            <div className="text-primary">محفوظ: {syncM.data.saved_rows}</div>
          </div>
        )}
        {syncM.error && (
          <div className="text-xs text-destructive">
            {(syncM.error as Error).message}
          </div>
        )}
      </div>
    </Card>
  );
}

function StatusPill({ ok, loading, unknown }: { ok: boolean; loading: boolean; unknown: boolean }) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-muted rounded-full px-2 py-1">
        <Loader2 className="size-3 animate-spin" /> جارٍ
      </span>
    );
  }
  if (unknown) {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground rounded-full px-2 py-1">
        لم يُختبر بعد
      </span>
    );
  }
  return ok ? (
    <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary rounded-full px-2 py-1">
      <CheckCircle2 className="size-3" /> متصل
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs bg-destructive/10 text-destructive rounded-full px-2 py-1">
      <XCircle className="size-3" /> غير متصل
    </span>
  );
}