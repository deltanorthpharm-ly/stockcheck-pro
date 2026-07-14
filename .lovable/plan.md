
# ربط StockCount Pro بـ Teryaq — خطة معتمدة مع التعديلات الإلزامية

## المبدأ العام (بلا تغيير)

`App → Supabase Edge Function (teryaq-stockcount-proxy) → Teryaq StockCount API`
لا مفاتيح في المتصفح، لا اتصال مباشر، لا تعديل تصميم عام.
Excel يبقى fallback، ولا يُحذَف.

## تنفيذ على مراحل — نتوقف بعد كل مرحلة

### ✅ المرحلة 1 (الآن — سنبدأ بها فقط)
Edge Function + health + مزامنة تجريبية (10 أصناف) + شاشة عد مبسّطة + منع اعتماد عند تغيّر الرصيد + تقرير فروقات بسيط.

### ⏸ المرحلة 2 (بعد نجاح 1)
توزيع الموظفين، لوحة تقدم، سجل تعديلات (audit)، تقارير متقدمة.

### ⏸ المرحلة 3 (بعد نجاح 2)
Offline كامل: IndexedDB + sync queue + client_operation_id + device sync status.
**لن نلمس Offline في المرحلة 1 أو 2.**

---

## المرحلة 1 — التفاصيل

### 1) Migration SQL (نهائية)

**`inventory_sessions`** — إضافة مصدر الجلسة:
```sql
alter table public.inventory_sessions
  add column source_type text not null default 'excel_import'
    check (source_type in ('live_api','excel_import'));
```
> الافتراضي = `excel_import`. يتحوّل إلى `live_api` فقط بعد نجاح `/health` (بند 13).

**`inventory_items`** — snapshot لحظة السحب:
```sql
alter table public.inventory_items
  add column external_item_id text,
  add column pack_size integer,
  add column raw_quantity_snapshot numeric,
  add column system_boxes_snapshot integer,
  add column system_units_snapshot integer,
  add column formatted_quantity_snapshot text,
  add column conversion_status text
    check (conversion_status in ('ok','missing_pack_size','negative_stock','unavailable')),
  add column source_read_at timestamptz;

create unique index inventory_items_session_ext_uidx
  on public.inventory_items(session_id, external_item_id)
  where external_item_id is not null;
```
> بند 7: القيد الفريد شرطي فقط عندما `external_item_id IS NOT NULL`.

**`inventory_counts`** — snapshot الفتح/الاعتماد + منع اعتماد عند تغيّر الرصيد:
```sql
alter table public.inventory_counts
  add column raw_quantity_at_open numeric,
  add column pack_size_at_open integer,
  add column system_boxes_at_open integer,
  add column system_units_at_open integer,
  add column opened_at timestamptz,
  add column source_read_at_open timestamptz,

  add column raw_quantity_at_submit numeric,
  add column pack_size_at_submit integer,
  add column system_boxes_at_submit integer,
  add column system_units_at_submit integer,
  add column submitted_at timestamptz,
  add column source_read_at_submit timestamptz,

  add column physical_raw_quantity numeric,
  add column difference_raw numeric,
  add column difference_boxes integer,
  add column difference_units integer,
  add column diff_status text
    check (diff_status in ('match','shortage','excess','negative_stock','conversion_unavailable')),

  add column requires_recount boolean not null default false,
  add column recount_reason text;
```
> **بند 1:** إذا `raw_quantity_at_submit ≠ raw_quantity_at_open` أو `pack_size_at_submit ≠ pack_size_at_open` → لا يُحسب الفرق، ويُحفظ `requires_recount=true` مع سبب (`stock_changed` / `pack_size_changed`).
>
> **بند 12:** نبقي `count_version` و`is_current` الموجودَين — لا last-save-wins؛ أي اعتماد جديد ينشئ نسخة جديدة ويقلب القديمة إلى `is_current=false` (لا حذف).

**جدول تقدم المزامنة (بند 11):**
```sql
create table public.teryaq_sync_runs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.inventory_sessions(id) on delete cascade,
  started_by uuid not null,
  status text not null check (status in ('running','succeeded','failed','cancelled')),
  page_cursor integer not null default 0,
  items_synced integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index teryaq_sync_runs_one_running
  on public.teryaq_sync_runs(session_id)
  where status = 'running';

grant select, insert, update on public.teryaq_sync_runs to authenticated;
grant all on public.teryaq_sync_runs to service_role;

alter table public.teryaq_sync_runs enable row level security;

create policy "admins manage sync runs"
  on public.teryaq_sync_runs for all
  to authenticated
  using (public.has_role(auth.uid(),'admin'))
  with check (public.has_role(auth.uid(),'admin'));
```
> الفهرس الفريد الجزئي = منع تشغيل مزامنتين متوازيتين لنفس الجلسة.

**جدول حالة الاتصال بـ Teryaq (لواجهة المدير + بند 13):**
```sql
create table public.teryaq_health_pings (
  id uuid primary key default gen_random_uuid(),
  ok boolean not null,
  latency_ms integer,
  error text,
  checked_by uuid,
  checked_at timestamptz not null default now()
);
grant select, insert on public.teryaq_health_pings to authenticated;
grant all on public.teryaq_health_pings to service_role;
alter table public.teryaq_health_pings enable row level security;
create policy "admins read health" on public.teryaq_health_pings
  for select to authenticated using (public.has_role(auth.uid(),'admin'));
create policy "admins write health" on public.teryaq_health_pings
  for insert to authenticated with check (public.has_role(auth.uid(),'admin'));
```

### 2) Edge Function `teryaq-stockcount-proxy`

الملف: `supabase/functions/teryaq-stockcount-proxy/index.ts`
`verify_jwt = true`.

**الأسرار (سيضيفها المستخدم بعد اعتماد الخطة):**
- `TERYAQ_STOCKCOUNT_BASE_URL` (HTTPS عام فقط — لا `localhost` ولا `192.168.x.x`؛ يُرفض عند تشغيل الدالة).
- `TERYAQ_STOCKCOUNT_API_KEY`.

**المسارات المسموح بها فقط (whitelist):**

| Method | Path | يحتاج دور | يترجم إلى |
|---|---|---|---|
| GET | `/health` | admin | `GET {BASE}/api/v1/stockcount/health` |
| GET | `/items?page=&pageSize=` | admin | `GET {BASE}/api/v1/stockcount/items` |
| GET | `/items/:itemId` | employee/admin (+ فحص جلسة/إسناد) | `GET {BASE}/api/v1/stockcount/items/:itemId` |
| GET | `/items/:itemId/stock` | employee/admin (+ فحص جلسة/إسناد) | `GET {BASE}/api/v1/stockcount/items/:itemId/stock` |

- أي شيء آخر → `404`. أي non-GET → `405`.
- `:itemId` يخضع لـ regex آمن قبل التمرير.
- **بند 5:** فحص الدور داخل الدالة:
  - `admin` فقط: `/health`, `/items` (المزامنة).
  - `employee`: `/items/:id`, `/items/:id/stock` — بشرط وجود صنف بـ `external_item_id` في جلسة `open` ومسند إليه (`assigned_to = auth.uid`).
- **بند 6:** لا rate limiting داخل الذاكرة الآن.
- `X-StockCount-Key` تُضاف من السر فقط.

### 3) اختبار /health أولًا
- طلب من المستخدم إدخال السرّين عبر نموذج آمن.
- نداء `GET /health` عبر الدالة، حفظ النتيجة في `teryaq_health_pings`، عرضها في لوحة المدير.
- **بند 13:** إن فشل → يظل الافتراضي `excel_import`، ولا يُعرَض خيار `live_api` بعد.

### 4) مزامنة تجريبية — 10 أصناف
- Server fn `syncSessionFromTeryaq({ session_id, limit? })` — admin only:
  - تفتح صفًا في `teryaq_sync_runs` (يفشل تلقائيًا إن كانت هناك مزامنة جارية — بند 11).
  - في المرحلة 1 نمرّر `limit=10` من الواجهة كاختبار.
  - `upsert` على `inventory_items` بمفتاح `(session_id, external_item_id)`.
  - يحدّث `page_cursor`, `items_synced`، ثم `succeeded`.
  - **لا حذف أصناف** غير الموجودة في الاستجابة.
  - يحفظ `raw_quantity_snapshot`, `pack_size`, `formatted_quantity_snapshot`, `conversion_status`, `source_read_at`.
  - `item_name_raw` كما ورد حرفيًا — لا تنظيف.

### 5) شاشة العد (المرحلة 1)
تعديل `src/components/employee/count-sheet.tsx` و`app.count.$id.tsx`:
- **إزالة الشريط** من الواجهة (يبقى العمود في DB لكن غير مرئي/مستخدم في `live_api`).
- عند فتح الصنف:
  - نداء `/items/:externalId/stock` عبر الدالة.
  - إدراج/تحديث صف `inventory_counts` بحالة `draft` مع كل `*_at_open` و`source_read_at_open`.
- عرض: اسم الصنف كاملًا + الباركود + بطاقة "رصيد المنظومة" (علبة/وحدة/الصيغة النصية).
- إدخال: حقلا رقم كبيران فقط — **علبة** و**وحدة**، مع أزرار `+1/-1` صغيرة بجانب كل حقل.
- **بند 9:** إذا `conversion_status = missing_pack_size`:
  - قفل حقل العلبة، السماح بالوحدات فقط.
  - زر "أضف للمراجعة" يعلّم الصنف.
- **بند 8:** الفرق يُعرض بقيمة مطلقة مع تسمية "عجز/زيادة/مطابق" — لا أرقام سالبة مربكة (`|difference_boxes|` و`|difference_units|`).
- زر ثابت أسفل الشاشة: **اعتماد العدد**.
- بعد الاعتماد: قفزة تلقائية للصنف التالي + "X من Y" + %.

### 6) اعتماد العدد + منع الاعتماد عند تغيّر الرصيد (بند 1)
عند الضغط على "اعتماد العدد":
1. إعادة نداء `/items/:id/stock` → snapshot الاعتماد.
2. **إن تغيّر `raw_quantity` أو `pack_size` عن snapshot الفتح:**
   - **لا نحسب الفرق.**
   - نحفظ نسخة `inventory_counts` جديدة بـ `requires_recount=true` + `recount_reason` (`stock_changed`/`pack_size_changed`) + كل `*_at_submit`.
   - نعرض حوارًا بخيارين فقط: **إعادة العد الآن** أو **تأجيل للمراجعة**.
3. إن لم يتغيّر:
   - نحسب: `physical_raw = boxes×pack_size_at_submit + units`، `difference_raw = physical_raw − raw_quantity_at_submit`.
   - `difference_boxes = trunc(difference_raw / pack_size_at_submit)`، `difference_units = remainder`.
   - `diff_status` من {`match`, `shortage`, `excess`, `negative_stock`, `conversion_unavailable`}.
   - **بند 12:** إن كانت هناك نسخة `is_current=true` نقلبها إلى `false` وننشئ نسخة جديدة بـ `count_version = prev+1`.

### 7) تقرير فروقات بسيط
تعديل `app.sessions.$id.report.tsx` (المرحلة 1 فقط):
- أعمدة: اسم الصنف، الباركود، رصيد المنظومة عند الاعتماد، العدد الفعلي (علبة/وحدة)، الفرق (علبة/وحدة كقيمة مطلقة)، الحالة، `requires_recount`.
- تصفية سريعة: الكل / مطابق / عجز / زيادة / يحتاج إعادة عد / تحويل غير متاح.

### 8) ما لن يُنفَّذ في المرحلة 1
- Offline / IndexedDB / sync queue / client_operation_id / device sync status.
- لوحة "العمليات غير المتزامنة عبر الأجهزة" (بند 10 — لن نوهم بذلك).
- توزيع الموظفين التلقائي الجديد، لوحة التقدم المتقدمة، audit log كامل.
- تقارير متقدمة (تصدير Excel/PDF للتنسيق الجديد).

---

## الملفات المتأثرة في المرحلة 1

**جديدة:**
- `supabase/functions/teryaq-stockcount-proxy/index.ts`
- `supabase/migrations/<ts>_teryaq_live_api_phase1.sql`
- `src/lib/teryaq.functions.ts` (`pingTeryaq`, `syncSessionFromTeryaq`, `getItemStock`, `submitCountLive`)

**معدّلة:**
- `src/routes/_authenticated/app.sessions.new.tsx` — إضافة خيار `live_api` (معطّل حتى نجاح `/health`).
- `src/components/admin/admin-home.tsx` — بطاقة "حالة الاتصال بـ Teryaq" وزر "اختبار الآن".
- `src/components/employee/count-sheet.tsx` — إزالة الشريط، snapshot الفتح/الاعتماد، منع الاعتماد عند التغيّر.
- `src/routes/_authenticated/app.count.$id.tsx` — استخدام `external_item_id` والقفزة التالية.
- `src/routes/_authenticated/app.sessions.$id.report.tsx` — تقرير فروقات مبسّط.
- `src/lib/quantity-parser.ts` — دوال العرض بقيمة مطلقة (بند 8).

**لن تُمَس:** `client.ts`, `client.server.ts`, `auth-middleware.ts`, `auth-attacher.ts`, `.env`, `supabase/config.toml` (على مستوى المشروع).

---

## ترتيب التنفيذ الصارم للمرحلة 1

1. تشغيل الـ Migration أعلاه.
2. إنشاء Edge Function مع whitelist وفحص الدور.
3. طلب السرّين من المستخدم.
4. تشغيل `/health` وعرض النتيجة.
5. **التوقف للتأكيد.**
6. مزامنة 10 أصناف على جلسة اختبار وعرض النتائج.
7. **التوقف للتأكيد.**
8. تفعيل شاشة العد المبسّطة + منع الاعتماد + التقرير البسيط.
9. **التوقف** — لا مرحلة 2 قبل موافقة صريحة.

هل نعتمد لبدء المرحلة 1؟
