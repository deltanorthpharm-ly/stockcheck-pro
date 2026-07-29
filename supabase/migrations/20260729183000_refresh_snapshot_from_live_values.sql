create or replace function public.refresh_inventory_item_snapshot_from_values(
  _inventory_item_id uuid,
  _session_id uuid,
  _system_boxes integer,
  _system_units integer,
  _system_quantity_raw text,
  _pack_size integer,
  _raw_quantity_snapshot numeric,
  _source_read_at timestamptz,
  _refresh_reason text default 'auto_refresh_on_first_open',
  _allow_current_draft boolean default false
)
returns table(
  updated boolean,
  reason text,
  has_current_count boolean,
  old_raw_quantity_snapshot numeric,
  live_raw_quantity numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_current_status text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if _system_boxes is null or _system_units is null or _pack_size is null or _pack_size <= 0 then
    return query select false, 'invalid_live_stock', false, null::numeric, null::numeric;
    return;
  end if;

  if _raw_quantity_snapshot is null then
    return query select false, 'missing_live_raw_quantity', false, null::numeric, null::numeric;
    return;
  end if;

  select
    i.id,
    i.session_id,
    i.external_item_id,
    i.assigned_to,
    i.raw_quantity_snapshot,
    s.status as session_status
  into v_item
  from public.inventory_items i
  join public.inventory_sessions s on s.id = i.session_id
  where i.id = _inventory_item_id
    and i.session_id = _session_id;

  if not found then
    return query select false, 'not_found', false, null::numeric, _raw_quantity_snapshot;
    return;
  end if;

  if v_item.session_status <> 'open' then
    return query select false, 'session_not_open', false, v_item.raw_quantity_snapshot, _raw_quantity_snapshot;
    return;
  end if;

  if not public.has_role(auth.uid(), 'admin') and v_item.assigned_to is distinct from auth.uid() then
    raise exception 'Forbidden';
  end if;

  select c.status
  into v_current_status
  from public.inventory_counts c
  where c.item_id = _inventory_item_id
    and c.session_id = _session_id
    and c.is_current = true
  order by c.updated_at desc
  limit 1;

  if v_current_status = 'approved' then
    return query select false, 'approved_count_exists', true, v_item.raw_quantity_snapshot, _raw_quantity_snapshot;
    return;
  end if;

  if v_current_status is not null and (not _allow_current_draft or v_current_status <> 'draft') then
    return query select false, 'count_exists', true, v_item.raw_quantity_snapshot, _raw_quantity_snapshot;
    return;
  end if;

  insert into public.inventory_item_live_cache (
    inventory_item_id,
    session_id,
    external_item_id,
    raw_quantity,
    pack_size,
    system_boxes,
    system_units,
    formatted_quantity,
    source_read_at,
    last_live_refresh_at,
    updated_at
  )
  values (
    _inventory_item_id,
    _session_id,
    v_item.external_item_id,
    _raw_quantity_snapshot,
    _pack_size,
    _system_boxes,
    _system_units,
    _system_quantity_raw,
    coalesce(_source_read_at, now()),
    now(),
    now()
  )
  on conflict (inventory_item_id) do update
  set
    session_id = excluded.session_id,
    external_item_id = excluded.external_item_id,
    raw_quantity = excluded.raw_quantity,
    pack_size = excluded.pack_size,
    system_boxes = excluded.system_boxes,
    system_units = excluded.system_units,
    formatted_quantity = excluded.formatted_quantity,
    source_read_at = excluded.source_read_at,
    last_live_refresh_at = excluded.last_live_refresh_at,
    updated_at = excluded.updated_at;

  return query
  select *
  from public.refresh_inventory_item_snapshot_from_live(
    _inventory_item_id,
    _session_id,
    coalesce(nullif(_refresh_reason, ''), 'auto_refresh_on_first_open'),
    _allow_current_draft
  );
end;
$$;

grant execute on function public.refresh_inventory_item_snapshot_from_values(
  uuid,
  uuid,
  integer,
  integer,
  text,
  integer,
  numeric,
  timestamptz,
  text,
  boolean
) to authenticated;
