create table if not exists public.inventory_item_live_cache (
  inventory_item_id uuid primary key references public.inventory_items(id) on delete cascade,
  session_id uuid not null references public.inventory_sessions(id) on delete cascade,
  external_item_id text not null,
  raw_quantity numeric,
  pack_size integer,
  system_boxes integer,
  system_units integer,
  formatted_quantity text,
  source_read_at timestamptz,
  last_live_refresh_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists inventory_item_live_cache_session_idx
  on public.inventory_item_live_cache(session_id);

grant select on public.inventory_item_live_cache to authenticated;
grant all on public.inventory_item_live_cache to service_role;

alter table public.inventory_item_live_cache enable row level security;

create policy "live_cache_admin_select"
  on public.inventory_item_live_cache for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

create policy "live_cache_employee_select_assigned"
  on public.inventory_item_live_cache for select
  to authenticated
  using (
    exists (
      select 1
      from public.inventory_items i
      where i.id = inventory_item_live_cache.inventory_item_id
        and i.assigned_to = auth.uid()
    )
  );
