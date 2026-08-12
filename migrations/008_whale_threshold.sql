-- ============================================================
-- 008 — Owner-configurable whale threshold
-- Lets each business set what counts as a "whale" (spend in the last 30
-- days) since accounts scale very differently. Default $1,000.
-- Run in Supabase: SQL Editor → New Query → paste → Run. Safe to re-run.
-- ============================================================

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS whale_threshold numeric NOT NULL DEFAULT 1000;
