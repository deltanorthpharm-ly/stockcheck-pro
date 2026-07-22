import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { usernameToEmail } from "@/hooks/use-current-user";
import { bootstrapAdmin, listLoginEmployees, pinToAuthPassword } from "@/lib/employees.functions";
import { useServerFn } from "@tanstack/react-start";
import { Eye, EyeOff, PillIcon } from "lucide-react";

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
  const [employeeId, setEmployeeId] = useState("");
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [pin, setPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"employee" | "admin" | "first-admin">("employee");
  const promote = useServerFn(bootstrapAdmin);
  const listEmployees = useServerFn(listLoginEmployees);
  const { data: employees = [], isLoading: employeesLoading } = useQuery({
    queryKey: ["login-employees"],
    queryFn: () => listEmployees(),
    enabled: mode === "employee",
  });
  const filteredEmployees = employees.filter((employee) => {
    const term = employeeSearch.trim().toLowerCase();
    if (!term) return true;
    return (
      employee.display_name.toLowerCase().includes(term) ||
      employee.username.toLowerCase().includes(term)
    );
  });

  async function signInWithPin(email: string, pinValue: string) {
    const securePassword = pinToAuthPassword(pinValue);
    const first = await supabase.auth.signInWithPassword({ email, password: securePassword });
    if (!first.error) return first;
    return supabase.auth.signInWithPassword({ email, password: pinValue });
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/app" });
    });
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[a-z0-9_]{3,32}$/.test(username.trim().toLowerCase())) {
      if (mode !== "employee") {
      toast.error("اسم المستخدم غير صالح");
      return;
      }
    }
    if (!/^[0-9]{1,12}$/.test(pin)) {
      toast.error("الرقم السري يجب أن يكون أرقاماً فقط");
      return;
    }
    setLoading(true);
    try {
      const selectedEmployee = employees.find((employee) => employee.id === employeeId);
      if (mode === "employee" && !selectedEmployee) {
        toast.error("اختر اسم الموظف أولاً");
        return;
      }
      const loginUsername = mode === "employee" ? selectedEmployee!.username : username;
      const email = usernameToEmail(loginUsername);
      if (mode === "first-admin") {
        // Create the very first admin account.
        const { error: sErr } = await supabase.auth.signUp({
          email,
          password: pinToAuthPassword(pin),
          options: { data: { username, display_name: username } },
        });
        if (sErr) throw sErr;
        const { error: lErr } = await supabase.auth.signInWithPassword({
          email,
          password: pinToAuthPassword(pin),
        });
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
      const { error } = await signInWithPin(email, pin);
      if (error) throw error;
      navigate({ to: "/app" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "خطأ غير متوقع";
      toast.error(msg.includes("Invalid login") ? "الرقم السري غير صحيح" : msg);
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
            {mode === "employee"
              ? "دخول الموظف"
              : mode === "admin"
                ? "دخول المدير"
                : "إنشاء حساب المدير الأول"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "employee" ? (
              <div className="space-y-2">
                <Label htmlFor="employee-search">الموظف</Label>
                <Input
                  id="employee-search"
                  value={employeeSearch}
                  onChange={(e) => setEmployeeSearch(e.target.value)}
                  placeholder="ابحث عن اسم الموظف"
                  className="h-12 text-base"
                />
                <select
                  className="h-12 w-full rounded-md border border-input bg-background px-3 text-base"
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                  disabled={employeesLoading}
                >
                  <option value="">
                    {employeesLoading ? "جارٍ تحميل الموظفين..." : "اختر اسمك"}
                  </option>
                  {filteredEmployees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.display_name} (@{employee.username})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
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
            )}
            <div className="space-y-2">
              <Label htmlFor="pin">الرقم السري</Label>
              <div className="flex gap-2">
                <Input
                  id="pin"
                  type={showPin ? "text" : "password"}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={12}
                  autoComplete="current-password"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))}
                  placeholder="أرقام فقط"
                  className="h-12 text-base tracking-widest text-center"
                  dir="ltr"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-12 w-12 p-0"
                  onClick={() => setShowPin((value) => !value)}
                  aria-label={showPin ? "إخفاء الرقم السري" : "إظهار الرقم السري"}
                >
                  {showPin ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </div>
            <Button
              type="submit"
              className="w-full h-12 text-base font-semibold"
              disabled={loading}
            >
              {loading ? "جارٍ..." : mode === "first-admin" ? "إنشاء وتسجيل الدخول" : "دخول"}
            </Button>
            <button
              type="button"
              className="w-full text-xs text-muted-foreground hover:text-foreground pt-2"
              onClick={() => setMode((m) => (m === "employee" ? "admin" : "employee"))}
            >
              {mode === "employee" ? "دخول المدير باسم المستخدم" : "دخول الموظف من القائمة"}
            </button>
            {mode !== "employee" && (
              <button
                type="button"
                className="w-full text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setMode((m) => (m === "first-admin" ? "admin" : "first-admin"))}
              >
                {mode === "first-admin"
                  ? "لديك حساب مدير؟ سجّل الدخول"
                  : "أول مرة تستخدم النظام؟ أنشئ حساب المدير"}
              </button>
            )}
          </form>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground mt-6 text-center max-w-xs">
        الحسابات ينشئها المدير من داخل التطبيق. لا يوجد تسجيل ذاتي للموظفين.
      </p>
    </div>
  );
}
