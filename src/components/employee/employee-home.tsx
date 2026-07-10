import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Package } from "lucide-react";

export function EmployeeHome() {
  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ["employee-sessions"],
    queryFn: async () => {
      // Sessions the RLS layer lets the employee see (has assignments).
      const { data, error } = await supabase
        .from("inventory_sessions")
        .select("id, name, status, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">جرودك</h2>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">جارٍ التحميل...</div>
      ) : sessions.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          لا يوجد لديك جرد مسند. اطلب من المدير إسناد أصناف لك.
        </Card>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <Link key={s.id} to="/app/count/$id" params={{ id: s.id }}>
              <Card className="p-4 flex items-center justify-between gap-3 hover:border-primary transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="size-10 rounded-lg bg-primary/10 text-primary grid place-items-center shrink-0">
                    <Package className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{s.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.status === "open" ? "مفتوح للعد" : "مغلق"}
                    </div>
                  </div>
                </div>
                <ArrowLeft className="size-5 text-muted-foreground shrink-0 rtl:rotate-180" />
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}