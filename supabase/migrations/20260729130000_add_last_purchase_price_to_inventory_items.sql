alter table public.inventory_items
  add column if not exists last_purchase_price numeric;

notify pgrst, 'reload schema';
