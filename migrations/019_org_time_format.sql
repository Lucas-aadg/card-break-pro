-- ============================================================
-- 019 — Org-wide time format preference (12h AM/PM vs 24h military)
-- Run in Supabase: SQL Editor → New Query → paste → Run.
-- Safe to re-run.
--
-- Owner asked: "why is the entire platform military time" — most raw shift
-- times (schedule chips, week grid, "Start time:" banners) were displayed
-- straight from the scheduled_time column with no AM/PM formatting at all,
-- and the one 12h/24h toggle that did exist (Settings → Preferences) only
-- wrote to localStorage, so it was per-browser and never reached breaker/
-- manager/sorter pages or even most of the owner's own schedule views. This
-- moves the preference onto the organization so one choice in Owner Settings
-- applies for every role, every device. Defaults to 12h (AM/PM) — the format
-- almost every display already fell back to before this fix.
-- ============================================================

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS time_format text NOT NULL DEFAULT '12h';

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_time_format_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_time_format_check CHECK (time_format IN ('12h', '24h'));

-- ── Sanity ─────────────────────────────────────────────────────────────────
SELECT 'ok' AS status, count(*) AS orgs_with_time_format
FROM public.organizations
WHERE time_format IN ('12h', '24h');
