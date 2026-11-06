-- ============================================================
-- 021 — Profit tab on the leaderboard
-- Run in Supabase: SQL Editor → New Query → paste → Run.
-- Safe to re-run.
--
-- Owner asked to filter the same leaderboard by Breaks, Revenue or Profit.
-- Profit is computed live from breaks.net_profit (no snapshot rows, so the
-- leaderboard_snapshots category check is untouched). This only makes the new
-- tab visible: orgs that already saved leaderboard settings have a stored
-- visible_categories list without it, which would keep Profit hidden for them.
-- The owner can still untick it in Leaderboard → Settings.
-- ============================================================

UPDATE public.leaderboard_settings
SET visible_categories = array_append(visible_categories, 'net_profit'),
    updated_at = now()
WHERE NOT ('net_profit' = ANY(visible_categories));

ALTER TABLE public.leaderboard_settings
  ALTER COLUMN visible_categories SET DEFAULT ARRAY['breaks_completed','revenue_generated','net_profit'];

-- ── Sanity ─────────────────────────────────────────────────────────────────
SELECT count(*) AS orgs, count(*) FILTER (WHERE 'net_profit' = ANY(visible_categories)) AS with_profit
FROM public.leaderboard_settings;
