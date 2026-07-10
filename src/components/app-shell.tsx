import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { useCurrentUser } from "@/hooks/use-current-user";
import { supabase } from "@/integrations/supabase/client";
import { LogOut, Home, Package, Users, BarChart3, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const isAdmin = user?.role === "admin";

  const tabs = isAdmin
    ? [
        { to: "/app", label: "الرئيسية", icon: Home, exact: true },
        { to: "/app/sessions", label: "الجرود", icon: Package },
        { to: "/app/employees", label: "الموظفون", icon: Users },
      ]
    : [
        { to: "/app", label: "الجرود", icon: ListChecks, exact: true },
      ];

  async function handleSignOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      <header className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border">
        <div className="flex items-center justify-between px-4 h-14 max-w-4xl mx-auto w-full">
          <div className="flex items-center gap-2 min-w-0">
            <div className="size-8 rounded-lg bg-primary text-primary-foreground grid place-items-center shrink-0">
              <BarChart3 className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold truncate">StockCount Pro</div>
              {user && (
                <div className="text-[10px] text-muted-foreground truncate">
                  {user.display_name} · {isAdmin ? "مدير" : "موظف"}
                </div>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSignOut}
            className="touch-target"
            aria-label="تسجيل الخروج"
          >
            <LogOut className="size-5" />
          </Button>
        </div>
      </header>
      <main className="flex-1 pb-20 max-w-4xl mx-auto w-full">{children}</main>
      <nav className="fixed bottom-0 inset-x-0 z-40 bg-background border-t border-border">
        <div className="max-w-4xl mx-auto grid" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
          {tabs.map((t) => {
            const active = t.exact ? pathname === t.to : pathname.startsWith(t.to);
            const Icon = t.icon;
            return (
              <Link
                key={t.to}
                to={t.to}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 py-2 touch-target text-[11px] font-medium",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <Icon className="size-5" />
                <span>{t.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}