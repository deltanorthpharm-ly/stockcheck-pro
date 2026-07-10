import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { usernameToEmail } from "@/hooks/use-current-user";
import { bootstrapAdmin } from "@/lib/employees.functions";
import { useServerFn } from "@tanstack/react-start";
import { PillIcon } from "lucide-react";

export const Route = createFileRoute("/auth")({
  ssr: false,
  component: AuthPage,
  head: () => ({
    meta: [
      { title: "تسجيل الدخول — StockCount Pro" },
      { name: "description", content: "تسجيل الدخول لتطبيق جرد الصيدلية" },
    ],
  }),
});

function AuthPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"signin" | "first-admin">("signin");
  const promote = useServerFn(bootstrapAdmin);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/app" });
    });
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[a-z0-9_]{3,32}$/.test(username.trim().toLowerCase())) {
      toast.error("اسم المستخدم غير صالح");
      return;
    }
    if (!/^[0-9]{6}$/.test(pin)) {
      toast.error("الرقم السري 6 أرقام");
      return;
    }
    setLoading(true);
    try {
      const email = usernameToEmail(username);
      if (mode === "first-admin") {
        // Create the very first admin account.
        const { error: sErr } = await supabase.auth.signUp({
          email,
          password: pin,
          options: { data: { username, display_name: username } },
        });
        if (sErr) throw sErr;
        const { error: lErr } = await supabase.auth.signInWithPassword({ email, password: pin });
        if (lErr) throw lErr;
        // Ensure profile row & admin role
        const { data: userRes } = await supabase.auth.getUser();
        const uid = userRes.user?.id;
        if (uid) {
          await supabase.from("profiles").upsert({
            id: uid,
            username,
            display_name: username,
          });
        }
        const res = await promote();
        if (!res.promoted) {
          toast.error("يوجد مدير مسجّل بالفعل — سجّل دخول عادي");
        } else {
          toast.success("تم إنشاء حساب المدير");
        }
        navigate({ to: "/app" });
        return;
      }
      const { error } = await supabase.auth.signInWithPassword({ email, password: pin });
      if (error) throw error;
      navigate({ to: "/app" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "خطأ غير متوقع";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center px-6 py-10">
      <div className="flex flex-col items-center gap-3 mb-8">
        <div className="size-16 rounded-2xl bg-primary text-primary-foreground grid place-items-center shadow-lg">
          <PillIcon className="size-8" />
        </div>
        <h1 className="text-2xl font-bold">StockCount Pro</h1>
        <p className="text-sm text-muted-foreground">جرد الصيدلية على الهاتف</p>
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg">
            {mode === "signin" ? "تسجيل الدخول" : "إنشاء حساب المدير الأول"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">اسم المستخدم</Label>
              <Input
                id="username"
                inputMode="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                placeholder="مثال: ali"
                className="h-12 text-base"
                dir="ltr"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pin">الرقم السري (6 أرقام)</Label>
              <Input
                id="pin"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                autoComplete="current-password"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="******"
                className="h-12 text-base tracking-[0.5em] text-center"
                dir="ltr"
              />
            </div>
            <Button
              type="submit"
              className="w-full h-12 text-base font-semibold"
              disabled={loading}
            >
              {loading ? "جارٍ..." : mode === "signin" ? "دخول" : "إنشاء وتسجيل الدخول"}
            </Button>
            <button
              type="button"
              className="w-full text-xs text-muted-foreground hover:text-foreground pt-2"
              onClick={() =>
                setMode((m) => (m === "signin" ? "first-admin" : "signin"))
              }
            >
              {mode === "signin"
                ? "أول مرة تستخدم النظام؟ أنشئ حساب المدير"
                : "لديك حساب؟ سجّل الدخول"}
            </button>
          </form>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground mt-6 text-center max-w-xs">
        الحسابات ينشئها المدير من داخل التطبيق. لا يوجد تسجيل ذاتي للموظفين.
      </p>
    </div>
  );
}