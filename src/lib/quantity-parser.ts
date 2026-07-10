// Parses Arabic pharmacy quantity strings like:
//   "40 علبة و1 وحدة", "13 وحدة", "5 شرائط", "٢ علب"
// Recognizes: علبة/علب/علبه (box), شريط/شرائط/اشرطة (strip), وحدة/وحده/وحدات (unit)
// Supports Arabic-Indic digits (٠-٩).

export type ParsedQty = {
  boxes: number;
  strips: number;
  units: number;
  status: "parsed" | "partial" | "unrecognized" | "empty";
  raw: string;
};

const AR_DIGIT_MAP: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

function normalize(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => AR_DIGIT_MAP[d] ?? d);
}

const UNIT_PATTERNS: Array<{ kind: "boxes" | "strips" | "units"; re: RegExp }> = [
  { kind: "boxes", re: /(\d+)\s*(?:علب[ةه]|علب)/g },
  { kind: "strips", re: /(\d+)\s*(?:شرائط|شريط|اشرط[ةه]|أشرط[ةه])/g },
  { kind: "units", re: /(\d+)\s*(?:وحد[ةه]|وحدات)/g },
];

export function parseArabicQuantity(input: string | number | null | undefined): ParsedQty {
  const raw = input == null ? "" : String(input).trim();
  if (!raw) return { boxes: 0, strips: 0, units: 0, status: "empty", raw: "" };

  const text = normalize(raw);
  const out = { boxes: 0, strips: 0, units: 0 };
  let matched = false;
  let consumed = "";

  for (const { kind, re } of UNIT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matched = true;
      out[kind] += parseInt(m[1], 10) || 0;
      consumed += m[0] + " ";
    }
  }

  // Fallback: bare number with no unit → treat as units (partial confidence)
  if (!matched) {
    const bare = /^\s*(\d+)\s*$/.exec(text);
    if (bare) {
      return {
        boxes: 0,
        strips: 0,
        units: parseInt(bare[1], 10) || 0,
        status: "partial",
        raw,
      };
    }
    return { boxes: 0, strips: 0, units: 0, status: "unrecognized", raw };
  }

  // Detect partial: extra tokens with digits we didn't consume
  const leftover = text
    .split(/\s+|و/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((tok) => /\d/.test(tok) && !consumed.includes(tok));
  const status: ParsedQty["status"] = leftover.length ? "partial" : "parsed";

  return { ...out, status, raw };
}

export function formatQtyArabic(q: { boxes: number; strips: number; units: number }): string {
  const parts: string[] = [];
  if (q.boxes) parts.push(`${q.boxes} علبة`);
  if (q.strips) parts.push(`${q.strips} شريط`);
  if (q.units) parts.push(`${q.units} وحدة`);
  return parts.length ? parts.join(" و") : "٠";
}

export function diffTriple(
  sys: { boxes: number; strips: number; units: number },
  phys: { boxes: number; strips: number; units: number },
) {
  return {
    boxes: phys.boxes - sys.boxes,
    strips: phys.strips - sys.strips,
    units: phys.units - sys.units,
  };
}

export type DiffStatus = "match" | "shortage" | "excess";
export function diffStatus(d: { boxes: number; strips: number; units: number }): DiffStatus {
  const anyNeg = d.boxes < 0 || d.strips < 0 || d.units < 0;
  const anyPos = d.boxes > 0 || d.strips > 0 || d.units > 0;
  if (anyNeg && !anyPos) return "shortage";
  if (anyPos && !anyNeg) return "excess";
  if (!anyNeg && !anyPos) return "match";
  // Mixed → treat as shortage (missing something takes priority)
  return "shortage";
}