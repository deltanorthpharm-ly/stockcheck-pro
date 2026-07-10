import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { readWorkbook, mapRows, FIELD_LABELS, type FieldKey } from "@/lib/excel-import";
import { useServerFn } from "@tanstack/react-start";
import { importItems } from "@/lib/sessions.functions";
import { useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FileSpreadsheet } from "lucide-react";

export const Route = createFileRoute("/_authenticated/app/sessions/$id/import")({
  component: ImportPage,
});

function ImportPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [fieldMap, setFieldMap] = useState<Record<string, FieldKey>>({});

  const importFn = useServerFn(importItems);
  const mut = useMutation({
    mutationFn: async () => {
      const mapped = mapRows(headers, rows, fieldMap);
      if (mapped.length === 0) throw new Error("لا توجد صفوف صالحة للاستيراد");
      return importFn({
        data: {
          session_id: id,
          rows: mapped.map((r) => ({
            row_index: r.row_index,
            item_name_raw: r.item_name_raw,
            barcode: r.barcode,
            selling_price: r.selling_price,
            expiry_date: r.expiry_date,
            system_quantity_raw: r.system_quantity_raw,
            parsed: {
              boxes: r.parsed.boxes,
              strips: r.parsed.strips,
              units: r.parsed.units,
              status: r.parsed.status,
            },
          })),
          replace: true,
        },
      });
    },
    onSuccess: (res) => {
      toast.success(`تم استيراد ${res.inserted} صنف`);
      navigate({ to: "/app/sessions/$id", params: { id } });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function handleFile(f: File) {
    setFile(f);
    const buf = await f.arrayBuffer();
    const { headers, rows, suggestedMap } = readWorkbook(buf);
    setHeaders(headers);
    setRows(rows);
    setFieldMap(suggestedMap);
  }

  const mapped = headers.length ? mapRows(headers, rows, fieldMap) : [];
  const problems = mapped.filter(
    (r) => r.parsed.status === "unrecognized" || r.parsed.status === "partial",
  );
  const hasName = Object.values(fieldMap).includes("item_name");
  const hasQty = Object.values(fieldMap).includes("system_quantity");

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">استيراد ملف Excel</h2>

      <Card className="p-4">
        <label className="flex flex-col items-center justify-center gap-3 py-6 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary">
          <FileSpreadsheet className="size-8 text-primary" />
          <div className="text-sm font-medium text-center">
            {file ? file.name : "اضغط لاختيار ملف Excel"}
          </div>
          <input
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
        </label>
      </Card>

      {headers.length > 0 && (
        <>
          <Card className="p-4 space-y-3">
            <div className="font-semibold">تحديد الأعمدة</div>
            <div className="space-y-2">
              {headers.map((h) => (
                <div key={h} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                  <div className="text-sm truncate">{h}</div>
                  <Select
                    value={fieldMap[h] ?? "ignore"}
                    onValueChange={(v) =>
                      setFieldMap((m) => ({ ...m, [h]: v as FieldKey }))
                    }
                  >
                    <SelectTrigger className="w-40 h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(FIELD_LABELS).map(([k, l]) => (
                        <SelectItem key={k} value={k}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            <div className="text-xs text-muted-foreground">
              يجب اختيار عمود لـ <b>اسم الصنف</b> و <b>الكمية المعروضة</b> على الأقل.
            </div>
          </Card>

          <Card className="p-4 space-y-2">
            <div className="font-semibold">معاينة سريعة</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-primary/5 p-3">
                <div className="text-xs text-muted-foreground">صفوف صالحة</div>
                <div className="text-2xl font-bold">{mapped.length}</div>
              </div>
              <div className="rounded-lg bg-warning/10 p-3">
                <div className="text-xs text-muted-foreground">تحتاج مراجعة</div>
                <div className="text-2xl font-bold text-warning-foreground">
                  {problems.length}
                </div>
              </div>
            </div>
            {problems.length > 0 && (
              <div className="text-xs text-warning-foreground flex items-start gap-2 mt-2">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                <span>
                  {problems.length} صف بكمية غير مفهومة أو ناقصة. سيتم استيرادها بحالة "بحاجة مراجعة" حتى لا نحوّلها إلى صفر تلقائياً.
                </span>
              </div>
            )}
          </Card>

          <Button
            className="w-full h-12"
            disabled={mut.isPending || !hasName || !hasQty || mapped.length === 0}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? (
              "جارٍ الاستيراد..."
            ) : (
              <>
                <CheckCircle2 className="size-4 ms-1" />
                استيراد {mapped.length} صنف
              </>
            )}
          </Button>
        </>
      )}
    </div>
  );
}