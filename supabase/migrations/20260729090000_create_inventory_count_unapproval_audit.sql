create table if not exists public.inventory_count_unapproval_audit (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.inventory_sessions(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  count_id uuid references public.inventory_counts(id) on delete set null,
  old_phys_boxes integer,
  old_phys_units integer,
  old_difference_raw numeric,
  old_difference_boxes integer,
  old_difference_units integer,
  old_diff_status text,
  old_system_boxes integer,
  old_system_units integer,
  old_raw_quantity_snapshot numeric,
  new_system_boxes integer,
  new_system_units integer,
  new_raw_quantity_snapshot numeric,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz not null default now()
);

create index if not exists inventory_count_unapproval_audit_session_idx
  on public.inventory_count_unapproval_audit(session_id, cancelled_at desc);

grant select, insert on public.inventory_count_unapproval_audit to authenticated;
grant all on public.inventory_count_unapproval_audit to service_role;

alter table public.inventory_count_unapproval_audit enable row level security;

create policy "count_unapproval_audit_admin_select"
  on public.inventory_count_unapproval_audit for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

create policy "count_unapproval_audit_admin_insert"
  on public.inventory_count_unapproval_audit for insert
  to authenticated
  with check (public.has_role(auth.uid(), 'admin'));
