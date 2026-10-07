-- ============================================================
-- 018 — Fix subscriptions.tier check constraint (blocking ALL checkouts)
-- Run in Supabase: SQL Editor → New Query → paste → Run.
-- Safe to re-run.
--
-- Root cause of "Subscription Required" after a successful Stripe checkout:
-- subscriptions_tier_check predates the single $99/mo "standard" plan and
-- only allowed the old starter/pro/empire/legacy/exempt values. Every
-- checkout.session.completed webhook since the standard plan launched has
-- been failing at the database write with:
--   "new row for relation "subscriptions" violates check constraint
--    "subscriptions_tier_check""
-- Stripe charges nothing when this happens (the subscription IS created in
-- Stripe, trial and all) — the customer just never gets activated in our
-- app, and Stripe retries the webhook a few times then gives up. This widens
-- the constraint to every tier value the app actually writes.
-- ============================================================

ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_tier_check;

ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_tier_check
  CHECK (tier IN ('standard', 'starter', 'pro', 'empire', 'legacy', 'exempt'));

-- ── Sanity ─────────────────────────────────────────────────────────────────
SELECT 'ok' AS status, pg_get_constraintdef(oid) AS constraint_def
FROM pg_constraint
WHERE conname = 'subscriptions_tier_check';
