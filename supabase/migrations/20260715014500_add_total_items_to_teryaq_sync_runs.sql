alter table public.teryaq_sync_runs
  add column if not exists total_items integer not null default 0;
