
-- 1) source_type on inventory_sessions
alter table public.inventory_sessions
  add column source_type text not null default 'excel_import'
    check (source_type in ('live_api','excel_import'));

-- 2) live snapshot fields on inventory_items
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

-- 3) open/submit snapshot + recount fields on inventory_counts
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

-- 4) sync run tracking (one running per session enforced by partial unique index)
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

-- 5) Teryaq health pings
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

create policy "admins read health"
  on public.teryaq_health_pings for select
  to authenticated
  using (public.has_role(auth.uid(),'admin'));

create policy "admins write health"
  on public.teryaq_health_pings for insert
  to authenticated
  with check (public.has_role(auth.uid(),'admin'));
