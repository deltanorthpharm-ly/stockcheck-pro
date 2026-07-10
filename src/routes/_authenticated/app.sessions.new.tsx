import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { createSession } from "@/lib/sessions.functions";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/app/sessions/new")({
  component: NewSession,
});

function NewSession() {
  const [name, setName] = useState("");
  const create = useServerFn(createSession);
  const navigate = useNavigate();
  const mut = useMutation({
    mutationFn: (n: string) => create({ data: { name: n } }),
    onSuccess: (s) => {
      toast.success("تم إنشاء الجرد. ارفع ملف Excel الآن.");
      navigate({ to: "/app/sessions/$id/import", params: { id: s.id } });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">جرد جديد</h2>
      <Card className="p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim().length < 2) return toast.error("اسم الجرد قصير");
            mut.mutate(name.trim());
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="name">اسم الجرد</Label>
            <Input
              id="name"
              className="h-12 text-base"
              placeholder="مثال: الجرد السنوي ٢٠٢٦"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button type="submit" className="w-full h-12" disabled={mut.isPending}>
            {mut.isPending ? "جارٍ..." : "إنشاء ورفع ملف Excel"}
          </Button>
        </form>
      </Card>
    </div>
  );
}