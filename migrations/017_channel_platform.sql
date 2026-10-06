-- ============================================================
-- 017 — Per-account platform (Whatnot / TikTok Shop)
-- Run in Supabase: SQL Editor → New Query → paste → Run.
-- Safe to re-run.
--
-- Lets an owner mark an Account (channel) as a TikTok Shop account instead of
-- Whatnot. buyers.platform / buyer_purchases.platform already exist and are
-- unconstrained text (schema/buyers.sql) — no migration needed there. This
-- column is read by live hit-logging and the room roster (which have no
-- packing-slip file to detect platform from) so a buyer first seen live on a
-- TikTok night is tagged 'tiktok' from the start, matching what the slip
-- import will find later instead of creating a duplicate buyer row under a
-- different platform tag.
-- ============================================================

ALTER TABLE public.channels ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'whatnot';

-- Sanity:
SELECT 'ok' AS status,
       (SELECT count(*) FROM information_schema.columns WHERE table_name = 'channels' AND column_name = 'platform') AS platform_col;
