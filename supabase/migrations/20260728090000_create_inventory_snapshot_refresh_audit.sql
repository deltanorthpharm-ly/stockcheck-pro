create table if not exists public.inventory_snapshot_refresh_audit (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.inventory_sessions(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  old_system_boxes integer,
  old_system_units integer,
  old_system_quantity_raw text,
  old_pack_size integer,
  old_raw_quantity_snapshot numeric,
  new_system_boxes integer,
  new_system_units integer,
  new_system_quantity_raw text,
  new_pack_size integer,
  new_raw_quantity_snapshot numeric,
  executed_by uuid references auth.users(id) on delete set null,
  executed_at timestamptz not null default now()
);

create index if not exists inventory_snapshot_refresh_audit_session_idx
  on public.inventory_snapshot_refresh_audit(session_id, executed_at desc);

grant select, insert on public.inventory_snapshot_refresh_audit to authenticated;
grant all on public.inventory_snapshot_refresh_audit to service_role;

alter table public.inventory_snapshot_refresh_audit enable row level security;

create policy "snapshot_refresh_audit_admin_select"
  on public.inventory_snapshot_refresh_audit for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

create policy "snapshot_refresh_audit_admin_insert"
  on public.inventory_snapshot_refresh_audit for insert
  to authenticated
  with check (public.has_role(auth.uid(), 'admin'));
