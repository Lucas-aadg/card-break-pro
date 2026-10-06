-- ============================================================
-- 016 — Soft-delete (deactivate) users
-- Run in Supabase: SQL Editor → New Query → paste → Run.
-- Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE everywhere).
-- No foreign keys are touched. No row in profiles (or anything that
-- references it) is ever deleted by this migration or by the app code
-- that uses it.
-- ============================================================

-- ── 1. The flag ──────────────────────────────────────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;

-- Speeds up every "active team / active assignees" query (.eq('org_id',…)
-- .is('deleted_at', null)) without slowing down anything else.
CREATE INDEX IF NOT EXISTS profiles_org_active_idx
  ON public.profiles (org_id)
  WHERE deleted_at IS NULL;

-- ── 2. Close the gap between "banned" and "token actually expires" ────────
-- auth.admin.updateUserById(..., { ban_duration }) blocks future sign-ins
-- and token refreshes, but a short-lived access token issued just before
-- the ban can still carry weight for the rest of its life (commonly up to
-- ~1h) because Supabase validates it locally, not against auth.users on
-- every request. get_my_org_id() is what nearly every RLS policy (and every
-- SECURITY DEFINER function — adjust_stock, recompute_stream_totals, etc.)
-- gates on, so teaching it to return NULL for a deactivated caller makes
-- every org-scoped read/write fail closed for that user the instant
-- deleted_at is set — no row is hidden FROM other people, only access BY
-- the deactivated account itself is cut. This is additive: for every
-- currently-active user (deleted_at IS NULL) behavior is byte-identical to
-- before.
--
-- NOTE: this assumes get_my_org_id()/is_owner() still match the definitions
-- in supabase-schema.sql (select org_id from profiles where id = auth.uid()
-- limit 1). If your live versions have since diverged, tell me and I'll
-- adjust this migration instead of silently overwriting something else.
CREATE OR REPLACE FUNCTION public.get_my_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id FROM public.profiles WHERE id = auth.uid() AND deleted_at IS NULL LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'owner' AND deleted_at IS NULL
  );
$$;

-- ── 3. Verify — run these by hand and eyeball the output ───────────────────
-- (a) The column + index exist:
SELECT 'ok' AS status,
       (SELECT count(*) FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'deleted_at') AS deleted_at_col,
       (SELECT count(*) FROM pg_indexes WHERE indexname = 'profiles_org_active_idx') AS active_idx;

-- (b) Every RLS policy currently on profiles (confirm nothing unexpected
--     references deleted_at already, and that profiles_select is still the
--     simple org-scoped policy — it should NOT itself filter on deleted_at;
--     that would hide deactivated teammates from reports, which is wrong):
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'profiles'
ORDER BY policyname;

-- (c) get_my_org_id() now excludes a deactivated caller's own row:
--     SELECT public.get_my_org_id();  -- run this logged in as a test deactivated user; expect NULL.
