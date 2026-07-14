import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listSessions } from "@/lib/sessions.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Package, CheckCircle2, Lock } from "lucide-react";
import { TeryaqHealthCard } from "./teryaq-health-card";

export function AdminHome() {
  const list = useServerFn(listSessions);
  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => list(),
  });
  const open = sessions.filter((s) => s.status === "open");
  const closed = sessions.filter((s) => s.status === "closed");

  return (
    <div className="p-4 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">لوحة المدير</h2>
        <Button asChild className="h-11">
          <Link to="/app/sessions/new">
            <Plus className="size-4 ms-1" /> جرد جديد
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="جرود مفتوحة" value={open.length} icon={<Package className="size-5" />} tone="primary" />
        <StatCard label="جرود مغلقة" value={closed.length} icon={<Lock className="size-5" />} tone="muted" />
      </div>

      <TeryaqHealthCard />

      <div>
        <h3 className="text-sm font-semibold text-muted-foreground mb-2">آخر الجرود</h3>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">جارٍ التحميل...</div>
        ) : sessions.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            لا يوجد جرد بعد. اضغط "جرد جديد" لإنشاء أول جرد ورفع ملف Excel.
          </Card>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <Link key={s.id} to="/app/sessions/$id" params={{ id: s.id }}>
                <Card className="p-4 flex items-center justify-between gap-3 hover:border-primary transition-colors">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{s.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(s.created_at).toLocaleString("ar")}
                    </div>
                  </div>
                  <span
                    className={
                      s.status === "open"
                        ? "shrink-0 inline-flex items-center gap-1 text-xs bg-primary/10 text-primary rounded-full px-2 py-1"
                        : "shrink-0 inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground rounded-full px-2 py-1"
                    }
                  >
                    {s.status === "open" ? <CheckCircle2 className="size-3" /> : <Lock className="size-3" />}
                    {s.status === "open" ? "مفتوح" : "مغلق"}
                  </span>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: "primary" | "muted";
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div
          className={
            tone === "primary"
              ? "size-10 rounded-lg bg-primary/10 text-primary grid place-items-center"
              : "size-10 rounded-lg bg-muted text-muted-foreground grid place-items-center"
          }
        >
          {icon}
        </div>
      </div>
      <div className="mt-3 text-2xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </Card>
  );
}