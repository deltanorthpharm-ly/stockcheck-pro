# StockCount Pro — Build Plan

## 1. Foundation

- Enable **Lovable Cloud** (Supabase) for auth, DB, storage.
- RTL setup: `<html dir="rtl" lang="ar">`, Cairo font via Google Fonts `<link>` in `__root.tsx`.
- Theme tokens in `src/styles.css`: white bg, teal primary (`oklch` values), min touch target 48px utility, large Arabic type scale.
- **PWA (manifest-only)**: `public/manifest.webmanifest`, icons, theme color, `display: standalone`. No service worker for offline yet — see §8.

## 2. Auth (username + PIN)

- Supabase Auth doesn't support username/PIN natively → use **synthetic emails**: `{username}@stockcount.local`, PIN = password (6 digits, enforced).
- Login screen: username + PIN inputs only.
- `user_roles` table with enum `app_role` (`admin`, `employee`) + `has_role()` SECURITY DEFINER function (per user-roles knowledge).
- `profiles` table: `id`, `username`, `display_name`, `created_by`.
- Admin screen to create employees (generates synthetic email + PIN via service-role server fn).
- Protected routes under `src/routes/_authenticated/`; admin-only routes under `_authenticated/_admin/`.

## 3. Database schema

- `inventory_sessions` — `id`, `name`, `status` (`open`/`closed`), `created_by`, `created_at`, `closed_at`.
- `inventory_items` — `id`, `session_id`, `row_index` (Excel row order), `item_name` (raw Arabic), `barcode` (text), `selling_price` (numeric), `expiry_date` (text — keep as-is), `system_quantity_raw` (original Arabic string), `system_boxes`, `system_strips`, `system_pieces` (parsed ints).
- `inventory_counts` — `id`, `item_id`, `session_id`, `counted_by`, `phys_boxes`, `phys_strips`, `phys_pieces`, `counted_at`. Unique on `(item_id)` (last save wins per assigned employee; range assignment prevents collisions).
- `inventory_assignments` — `id`, `session_id`, `employee_id`, `row_start`, `row_end`. An item belongs to the employee whose range contains its `row_index`.
- `inventory_reports` — cached export metadata (optional).
- RLS: admin full access via `has_role`; employees see only their assigned session's items and can only insert/update counts for items in their assigned row range.
- GRANTs to `authenticated` and `service_role` on every public table.

## 4. Excel import (admin)

- Library: `xlsx` (SheetJS).
- Header mapping (Arabic → field): `الصنف→item_name`, `الباركود→barcode`, `سعر البيع→selling_price`, `الصلاحية→expiry_date`, `الكمية المعروضة→system_quantity_raw`.
- **Configurable mapping UI**: after file selection, show detected headers with dropdowns to map each to a known field; unknown columns ignored. Persist mapping per session for re-imports.
- Barcode always parsed as string (preserve leading zeros — read cells with `{raw:false}` or force string).
- Arabic quantity parser: extract integers preceding `علبة` (box), `شريط` (strip), `وحدة` (piece). Examples: `"40 علبة و1 وحدة"` → `{boxes:40, strips:0, pieces:1}`, `"13 وحدة"` → `{0,0,13}`. Preserve original string for report display.
- Bulk insert via server fn (chunked, ~500 rows/req) to handle 10k+ items.

## 5. Admin flows

- Sessions list + "Create session" → name input, then upload Excel.
- Session detail: item count, progress %, employees assigned, "Assign ranges" screen (split by row ranges, quick "auto-split evenly across N employees" button).
- Live progress dashboard (cards): total / counted / remaining / matched / shortage / excess / completion %.
- Reports view with tabs: matched, shortage, excess, uncounted, summary.
- Export: **Excel** (`xlsx`) and **PDF** (`jspdf` + `jspdf-autotable` with Cairo font embedded for Arabic).
- Close session (locks further counts).

## 6. Employee flows

- Home: list of open sessions where they have an assignment.
- Counting screen:
  - Sticky RTL search bar (instant client-side filter over their assigned items by item_name substring; barcode field indexed for future).
  - Item list: name + system qty (Arabic string) + status chip.
  - Tap item → count sheet: 3 large numeric inputs (boxes / strips / pieces), auto-computed difference per unit shown live with color (red shortage / green match / blue excess), sticky Save button.
  - Autosave on blur + explicit Save; no manual difference field.

## 7. UI/UX

- Bottom nav (RTL-mirrored): Home / Search / Progress / Profile.
- 48px min touch targets, `text-lg`+ everywhere, no unnecessary transitions.
- Loading states with skeletons, not spinners, for perceived speed.
- Virtualized list (`@tanstack/react-virtual`) for 10k items.

## 8. Offline + sync

- Local queue: IndexedDB (via `idb`) stores pending count writes when offline.
- On app load and on `online` event, drain queue → server fn upsert.
- Read-side: items for the employee's assignment cached in IndexedDB on session open so search works offline.
- Skip service worker (per PWA guidance, manifest-only) — offline uses IndexedDB in the running tab; user keeps the PWA open during counting.

## Technical notes

- Server fns in `src/lib/*.functions.ts` using `requireSupabaseAuth`; admin ops (create employee, bulk import) verify `has_role(admin)` inside handler and dynamic-import `client.server`.
- Head metadata in `__root.tsx`: title "StockCount Pro — جرد الصيدلية", Arabic description.
- Deps to add: `xlsx`, `jspdf`, `jspdf-autotable`, `idb`, `@tanstack/react-virtual`.

## Out of scope (per spec)

Barcode scanner, SQL Server integration, live stock, multi-branch, batch/expiry tracking beyond raw field, AI analysis.

&nbsp;

Critical corrections before implementation:

&nbsp;

1. The pharmacy remains open while counting. The imported Excel quantity is a snapshot, not live stock. Add exported_at to every inventory session and clearly label all differences as calculated against the imported snapshot.

&nbsp;

2. Preserve item names exactly:

- Store item_name_raw exactly as received.

- Do not trim, normalize, translate, deduplicate, replace punctuation, remove "/" or "\" symbols, or modify spacing.

- A separate item_name_search field may be generated only for searching.

- Always display item_name_raw.

&nbsp;

3. Use system_units and phys_units, not pieces, because the Excel uses the Arabic term "وحدة" and it must not be assumed to mean a tablet or piece.

&nbsp;

4. Quantity units are independent in version 1. Never convert boxes, strips, and units into each other unless conversion metadata exists for that specific item.

&nbsp;

5. Quantity parser must recognize:

علبة، علب، شريط، شرائط، وحدة، وحده، وحدات

and Arabic/English digits.

Store quantity_parse_status as:

parsed, partial, unrecognized, empty.

Never silently convert an unrecognized quantity to zero.

Show an import review screen for problematic rows.

&nbsp;

6. Barcode must be stored as text. Detect and flag scientific notation, decimal formatting, missing values, or possibly corrupted barcodes before import.

&nbsp;

7. Do not overwrite count history. inventory_counts must support versions:

count_version, is_current, created_at, updated_at.

Every correction creates a new auditable version.

&nbsp;

8. Do not rely only on row_start and row_end after assignment. Auto-split can use Excel row order, but assignments must ultimately store explicit item IDs per employee so reordering or re-importing cannot change ownership.

&nbsp;

9. While typing, save only a local draft. A count becomes official only when the employee presses "اعتماد العدد". Editing an approved count must create an audit record.

&nbsp;

10. Offline writes must include a unique client_operation_id for idempotency. Show pending sync count, last successful sync, and prevent session closure while unsynced counts exist.

&nbsp;

11. Reports must classify differences per unit:

box difference, strip difference, unit difference.

Do not calculate a combined net quantity without item-specific conversion data.

&nbsp;

12. Prioritize Excel export and printable RTL HTML reports. PDF generation with jsPDF is optional and should not block version 1.