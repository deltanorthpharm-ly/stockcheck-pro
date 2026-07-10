import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listSessions } from "@/lib/sessions.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/app/sessions/")({
  component: SessionsList,
});

function SessionsList() {
  const list = useServerFn(listSessions);
  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => list(),
  });
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">الجرود</h2>
        <Button asChild className="h-11">
          <Link to="/app/sessions/new">
            <Plus className="size-4 ms-1" /> جديد
          </Link>
        </Button>
      </div>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">جارٍ...</div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <Link key={s.id} to="/app/sessions/$id" params={{ id: s.id }}>
              <Card className="p-4 flex items-center justify-between gap-3 hover:border-primary">
                <div>
                  <div className="font-semibold">{s.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(s.created_at).toLocaleString("ar")}
                  </div>
                </div>
                <span
                  className={
                    s.status === "open"
                      ? "text-xs bg-primary/10 text-primary rounded-full px-2 py-1"
                      : "text-xs bg-muted text-muted-foreground rounded-full px-2 py-1"
                  }
                >
                  {s.status === "open" ? "مفتوح" : "مغلق"}
                </span>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}