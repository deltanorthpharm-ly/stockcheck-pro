import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listEmployees, createEmployee, resetEmployeePin } from "@/lib/employees.functions";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { KeyRound, UserPlus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/app/employees")({
  component: EmployeesPage,
});

function randomPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function EmployeesPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listEmployees);
  const createFn = useServerFn(createEmployee);
  const resetFn = useServerFn(resetEmployeePin);

  const { data: emps = [] } = useQuery({ queryKey: ["employees"], queryFn: () => listFn() });
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState(randomPin());

  const create = useMutation({
    mutationFn: () =>
      createFn({ data: { username, display_name: displayName, pin } }),
    onSuccess: () => {
      toast.success(`تم إنشاء الحساب — الرقم السري: ${pin}`, { duration: 15000 });
      qc.invalidateQueries({ queryKey: ["employees"] });
      setUsername("");
      setDisplayName("");
      setPin(randomPin());
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">الموظفون</h2>

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <UserPlus className="size-4 text-primary" />
          <div className="font-semibold">إضافة موظف</div>
        </div>
        <div className="grid gap-3">
          <div className="space-y-1">
            <Label htmlFor="u">اسم المستخدم (إنجليزي)</Label>
            <Input
              id="u"
              className="h-11"
              dir="ltr"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              placeholder="مثال: ali"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="d">الاسم الظاهر</Label>
            <Input
              id="d"
              className="h-11"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="مثال: علي محمد"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="p">الرقم السري (٦ أرقام)</Label>
            <div className="flex gap-2">
              <Input
                id="p"
                dir="ltr"
                className="h-11 tracking-widest text-center"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
              <Button variant="outline" onClick={() => setPin(randomPin())} className="h-11">
                توليد
              </Button>
            </div>
          </div>
          <Button
            className="h-11"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "جارٍ..." : "إنشاء الحساب"}
          </Button>
          <p className="text-xs text-muted-foreground">
            سجّل الرقم السري بعد الإنشاء — لن يظهر مرة أخرى إلا بإعادة تعيينه.
          </p>
        </div>
      </Card>

      <div className="space-y-2">
        {emps.map((e) => (
          <Card key={e.id} className="p-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium truncate">{e.display_name}</div>
              <div className="text-xs text-muted-foreground">@{e.username}</div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-10 shrink-0"
              onClick={() => {
                const p = randomPin();
                if (confirm(`إعادة تعيين رقم سري جديد للموظف: ${p}؟`)) {
                  resetFn({ data: { user_id: e.id, pin: p } })
                    .then(() => toast.success(`رقم سري جديد: ${p}`, { duration: 15000 }))
                    .catch((err: Error) => toast.error(err.message));
                }
              }}
            >
              <KeyRound className="size-4 ms-1" /> إعادة تعيين
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}