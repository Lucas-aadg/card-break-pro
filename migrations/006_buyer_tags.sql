-- ============================================================
-- 006 — Buyer "what they collect" tags
-- Adds manual tag fields to buyers so breakers can note a buyer's
-- favorite team / player / sport (random-wheel format means these
-- can't be inferred from purchases — they're set by hand).
-- Run in Supabase: SQL Editor → New Query → paste → Run.
-- Safe to re-run (IF NOT EXISTS).
-- ============================================================

ALTER TABLE public.buyers ADD COLUMN IF NOT EXISTS fav_team   text;
ALTER TABLE public.buyers ADD COLUMN IF NOT EXISTS fav_player text;
ALTER TABLE public.buyers ADD COLUMN IF NOT EXISTS fav_sport  text;
