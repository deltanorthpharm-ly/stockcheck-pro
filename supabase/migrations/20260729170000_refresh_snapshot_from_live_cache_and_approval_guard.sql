create or replace function public.refresh_inventory_item_snapshot_from_live(
  _inventory_item_id uuid,
  _session_id uuid,
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
  v_live record;
  v_current_status text;
  v_next_pack_size integer;
  v_next_raw_quantity numeric;
  v_next_formatted text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select
    i.id,
    i.session_id,
    i.assigned_to,
    i.pack_size,
    i.system_boxes,
    i.system_units,
    i.system_quantity_raw,
    i.raw_quantity_snapshot,
    s.status as session_status
  into v_item
  from public.inventory_items i
  join public.inventory_sessions s on s.id = i.session_id
  where i.id = _inventory_item_id
    and i.session_id = _session_id
  for update of i;

  if not found then
    return query select false, 'not_found', false, null::numeric, null::numeric;
    return;
  end if;

  if v_item.session_status <> 'open' then
    return query select false, 'session_not_open', false, v_item.raw_quantity_snapshot, null::numeric;
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
    return query select false, 'approved_count_exists', true, v_item.raw_quantity_snapshot, null::numeric;
    return;
  end if;

  if v_current_status is not null and (not _allow_current_draft or v_current_status <> 'draft') then
    return query select false, 'count_exists', true, v_item.raw_quantity_snapshot, null::numeric;
    return;
  end if;

  select
    l.raw_quantity,
    l.pack_size,
    l.system_boxes,
    l.system_units,
    l.formatted_quantity,
    l.source_read_at
  into v_live
  from public.inventory_item_live_cache l
  where l.inventory_item_id = _inventory_item_id
    and l.session_id = _session_id;

  if not found or v_live.system_boxes is null or v_live.system_units is null then
    return query select false, 'missing_live_stock', v_current_status is not null, v_item.raw_quantity_snapshot, null::numeric;
    return;
  end if;

  v_next_pack_size := coalesce(v_live.pack_size, v_item.pack_size);
  v_next_raw_quantity := coalesce(
    v_live.raw_quantity,
    case
      when v_next_pack_size is not null and v_next_pack_size > 0
      then (v_live.system_boxes * v_next_pack_size) + v_live.system_units
      else null
    end
  );
  v_next_formatted := coalesce(
    v_live.formatted_quantity,
    case
      when coalesce(v_live.system_boxes, 0) <> 0 and coalesce(v_live.system_units, 0) <> 0
        then v_live.system_boxes::text || ' علبة و' || v_live.system_units::text || ' وحدة'
      when coalesce(v_live.system_boxes, 0) <> 0
        then v_live.system_boxes::text || ' علبة'
      when coalesce(v_live.system_units, 0) <> 0
        then v_live.system_units::text || ' وحدة'
      else '0'
    end
  );

  update public.inventory_items
  set
    system_boxes = v_live.system_boxes,
    system_units = v_live.system_units,
    system_quantity_raw = v_next_formatted,
    pack_size = v_next_pack_size,
    raw_quantity_snapshot = v_next_raw_quantity,
    system_boxes_snapshot = v_live.system_boxes,
    system_units_snapshot = v_live.system_units,
    formatted_quantity_snapshot = v_next_formatted,
    conversion_status = case
      when v_next_raw_quantity is not null and v_next_raw_quantity < 0 then 'negative_stock'
      when v_next_pack_size is null or v_next_pack_size <= 0 then 'missing_pack_size'
      else 'ok'
    end,
    source_read_at = coalesce(v_live.source_read_at, now())
  where id = _inventory_item_id
    and session_id = _session_id;

  insert into public.inventory_snapshot_refresh_audit (
    session_id,
    inventory_item_id,
    old_system_boxes,
    old_system_units,
    old_system_quantity_raw,
    old_pack_size,
    old_raw_quantity_snapshot,
    new_system_boxes,
    new_system_units,
    new_system_quantity_raw,
    new_pack_size,
    new_raw_quantity_snapshot,
    refresh_reason,
    executed_by
  )
  values (
    _session_id,
    _inventory_item_id,
    v_item.system_boxes,
    v_item.system_units,
    v_item.system_quantity_raw,
    v_item.pack_size,
    v_item.raw_quantity_snapshot,
    v_live.system_boxes,
    v_live.system_units,
    v_next_formatted,
    v_next_pack_size,
    v_next_raw_quantity,
    coalesce(nullif(_refresh_reason, ''), 'auto_refresh_on_first_open'),
    auth.uid()
  );

  return query select true, 'updated', v_current_status is not null, v_item.raw_quantity_snapshot, v_next_raw_quantity;
end;
$$;

grant execute on function public.refresh_inventory_item_snapshot_from_live(
  uuid,
  uuid,
  text,
  boolean
) to authenticated;

create or replace function public.refresh_uncounted_item_snapshot_on_open(
  _inventory_item_id uuid,
  _session_id uuid,
  _system_boxes integer,
  _system_units integer,
  _system_quantity_raw text,
  _pack_size integer,
  _raw_quantity_snapshot numeric,
  _source_read_at timestamptz
)
returns table(updated boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select r.updated, r.reason
  from public.refresh_inventory_item_snapshot_from_live(
    _inventory_item_id,
    _session_id,
    'auto_refresh_on_first_open',
    false
  ) r;
end;
$$;

grant execute on function public.refresh_uncounted_item_snapshot_on_open(
  uuid,
  uuid,
  integer,
  integer,
  text,
  integer,
  numeric,
  timestamptz
) to authenticated;
