-- Fix Teryaq live API upsert conflict target.
--
-- src/lib/teryaq.functions.ts uses:
--   upsert(rows, { onConflict: "session_id,external_item_id" })
--
-- The previous index on these columns is partial:
--   where external_item_id is not null
--
-- PostgreSQL cannot use that partial index for ON CONFLICT (session_id, external_item_id)
-- without the same predicate, and Supabase/PostgREST's upsert onConflict option does
-- not provide the predicate. This full unique index matches the upsert target.
--
-- PostgreSQL unique indexes allow multiple NULL external_item_id values, so Excel-import
-- rows without an external Teryaq id remain supported.
create unique index if not exists inventory_items_session_ext_full_uidx
  on public.inventory_items(session_id, external_item_id);
