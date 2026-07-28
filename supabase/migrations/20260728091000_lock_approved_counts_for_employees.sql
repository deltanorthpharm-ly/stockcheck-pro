drop policy if exists "counts_employee_update" on public.inventory_counts;

create policy "counts_employee_update"
  on public.inventory_counts for update
  to authenticated
  using (
    counted_by = auth.uid()
    and status = 'draft'
    and exists (
      select 1
      from public.inventory_items i
      join public.inventory_sessions s on s.id = i.session_id
      where i.id = inventory_counts.item_id
        and i.assigned_to = auth.uid()
        and s.status = 'open'
    )
  )
  with check (
    counted_by = auth.uid()
    and status = 'draft'
    and exists (
      select 1
      from public.inventory_items i
      join public.inventory_sessions s on s.id = i.session_id
      where i.id = inventory_counts.item_id
        and i.assigned_to = auth.uid()
        and s.status = 'open'
    )
  );
