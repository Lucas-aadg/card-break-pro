-- ============================================================
-- 015 — Fix inventory_log action check constraint
-- Run in Supabase: SQL Editor → New Query → paste → Run.
-- Safe to re-run.
--
-- The Stock Audit correction feature (migration 014 client code) writes
-- action = 'adjust_in' / 'adjust_out' when an owner or manager corrects a
-- product's count. inventory_log_action_check predates that and only allows
-- the original set, so every correction save failed with:
--   "new row for relation "inventory_log" violates check constraint
--    "inventory_log_action_check""
-- This widens the constraint to the full set the app actually writes.
-- ============================================================

ALTER TABLE public.inventory_log DROP CONSTRAINT IF EXISTS inventory_log_action_check;

ALTER TABLE public.inventory_log ADD CONSTRAINT inventory_log_action_check
  CHECK (action IN ('initial', 'restock', 'used', 'restored', 'adjust_in', 'adjust_out'));

-- ── Sanity ─────────────────────────────────────────────────────────────────
SELECT 'ok' AS status, pg_get_constraintdef(oid) AS constraint_def
FROM pg_constraint
WHERE conname = 'inventory_log_action_check';
