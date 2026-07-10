import * as XLSX from "xlsx";
import { parseArabicQuantity, type ParsedQty } from "./quantity-parser";

export type ImportedRow = {
  row_index: number;
  item_name_raw: string;
  barcode: string | null;
  selling_price: number | null;
  expiry_date: string | null;
  system_quantity_raw: string;
  parsed: ParsedQty;
};

export type FieldKey =
  | "item_name"
  | "barcode"
  | "selling_price"
  | "expiry_date"
  | "system_quantity"
  | "ignore";

export const FIELD_LABELS: Record<FieldKey, string> = {
  item_name: "اسم الصنف",
  barcode: "الباركود",
  selling_price: "سعر البيع",
  expiry_date: "الصلاحية",
  system_quantity: "الكمية المعروضة",
  ignore: "تجاهل",
};

const DEFAULT_MAP: Record<string, FieldKey> = {
  "الصنف": "item_name",
  "اسم الصنف": "item_name",
  "الباركود": "barcode",
  "باركود": "barcode",
  "سعر البيع": "selling_price",
  "السعر": "selling_price",
  "الصلاحية": "expiry_date",
  "تاريخ الانتهاء": "expiry_date",
  "الكمية المعروضة": "system_quantity",
  "الكمية": "system_quantity",
};

export function readWorkbook(file: ArrayBuffer): {
  headers: string[];
  rows: unknown[][];
  suggestedMap: Record<string, FieldKey>;
} {
  const wb = XLSX.read(file, { type: "array", cellDates: false, raw: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: false,
    defval: "",
  });
  const headers = (aoa[0] as string[]).map((h) => String(h ?? "").trim());
  const rows = aoa.slice(1) as unknown[][];
  const suggestedMap: Record<string, FieldKey> = {};
  for (const h of headers) suggestedMap[h] = DEFAULT_MAP[h] ?? "ignore";
  return { headers, rows, suggestedMap };
}

export function mapRows(
  headers: string[],
  rows: unknown[][],
  fieldMap: Record<string, FieldKey>,
): ImportedRow[] {
  const idxFor = (k: FieldKey) => headers.findIndex((h) => fieldMap[h] === k);
  const iName = idxFor("item_name");
  const iBarcode = idxFor("barcode");
  const iPrice = idxFor("selling_price");
  const iExpiry = idxFor("expiry_date");
  const iQty = idxFor("system_quantity");

  const out: ImportedRow[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const name = iName >= 0 ? String(row[iName] ?? "").trim() : "";
    if (!name) continue; // skip fully empty rows
    const qtyRaw = iQty >= 0 ? String(row[iQty] ?? "").trim() : "";
    const parsed = parseArabicQuantity(qtyRaw);
    const priceStr = iPrice >= 0 ? String(row[iPrice] ?? "").replace(/,/g, "").trim() : "";
    const priceNum = priceStr ? Number(priceStr) : NaN;
    out.push({
      row_index: r + 1,
      item_name_raw: name,
      barcode: iBarcode >= 0 ? (String(row[iBarcode] ?? "").trim() || null) : null,
      selling_price: Number.isFinite(priceNum) ? priceNum : null,
      expiry_date: iExpiry >= 0 ? (String(row[iExpiry] ?? "").trim() || null) : null,
      system_quantity_raw: qtyRaw,
      parsed,
    });
  }
  return out;
}

export function exportRowsToXlsx(
  rows: Record<string, unknown>[],
  headers: string[],
  fileName: string,
  sheetName = "Report",
) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, fileName);
}