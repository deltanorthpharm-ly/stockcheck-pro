alter table public.inventory_snapshot_refresh_audit
  add column if not exists refresh_reason text;

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
declare
  v_item record;
  v_count_exists boolean;
  v_next_pack_size integer;
  v_next_raw_quantity numeric;
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
    return query select false, 'not_found';
    return;
  end if;

  if v_item.session_status <> 'open' then
    return query select false, 'session_not_open';
    return;
  end if;

  if not public.has_role(auth.uid(), 'admin') and v_item.assigned_to is distinct from auth.uid() then
    raise exception 'Forbidden';
  end if;

  select exists (
    select 1
    from public.inventory_counts c
    where c.item_id = _inventory_item_id
      and c.session_id = _session_id
      and c.is_current = true
  )
  into v_count_exists;

  if v_count_exists then
    return query select false, 'count_exists';
    return;
  end if;

  v_next_pack_size := coalesce(_pack_size, v_item.pack_size);
  v_next_raw_quantity := coalesce(
    _raw_quantity_snapshot,
    case
      when v_next_pack_size is not null and v_next_pack_size > 0
      then (_system_boxes * v_next_pack_size) + _system_units
      else null
    end
  );

  update public.inventory_items
  set
    system_boxes = _system_boxes,
    system_units = _system_units,
    system_quantity_raw = _system_quantity_raw,
    pack_size = v_next_pack_size,
    raw_quantity_snapshot = v_next_raw_quantity,
    system_boxes_snapshot = _system_boxes,
    system_units_snapshot = _system_units,
    formatted_quantity_snapshot = _system_quantity_raw,
    conversion_status = case
      when v_next_raw_quantity is not null and v_next_raw_quantity < 0 then 'negative_stock'
      when v_next_pack_size is null or v_next_pack_size <= 0 then 'missing_pack_size'
      else 'ok'
    end,
    source_read_at = coalesce(_source_read_at, now())
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
    _system_boxes,
    _system_units,
    _system_quantity_raw,
    v_next_pack_size,
    v_next_raw_quantity,
    'auto_refresh_on_first_open',
    auth.uid()
  );

  return query select true, 'updated';
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
