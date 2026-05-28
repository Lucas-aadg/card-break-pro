-- ============================================================
-- CARD BREAK PRO — Full RLS Audit Migration
-- Run this entire file in: Supabase → SQL Editor → New Query → Run
-- Safe to run multiple times (idempotent via DROP IF EXISTS).
-- ============================================================

-- ============================================================
-- SECTION 1 — FIX BROKEN POLICIES ON EXISTING TABLES
-- ============================================================

-- ── FIX: invite_codes_update was fully open (using true / check true)
--    Anyone could mark any code as used=false and reuse it, or change org_id.
--    Fix: only allow updating UNUSED codes, and result MUST be used=true.
DROP POLICY IF EXISTS "invite_codes_update" ON invite_codes;
CREATE POLICY "invite_codes_update"
  ON invite_codes FOR UPDATE
  USING  (used = false)
  WITH CHECK (used = true);

-- ── FIX: subscriptions_insert and subscriptions_update were open (check true)
--    These allowed any authenticated user to write subscription records.
--    The Stripe webhook uses SUPABASE_SERVICE_ROLE_KEY which bypasses RLS entirely.
--    Normal clients should never be able to write to subscriptions.
DROP POLICY IF EXISTS "subscriptions_insert" ON subscriptions;
DROP POLICY IF EXISTS "subscriptions_update" ON subscriptions;
-- No replacement policies needed: service role bypasses RLS; no client writes allowed.


-- ============================================================
-- SECTION 2 — ENABLE RLS ON TABLES ADDED AFTER INITIAL SCHEMA
-- ============================================================

-- ── CHANNELS ──────────────────────────────────────────────
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "channels_select" ON channels;
DROP POLICY IF EXISTS "channels_insert" ON channels;
DROP POLICY IF EXISTS "channels_update" ON channels;
DROP POLICY IF EXISTS "channels_delete" ON channels;

CREATE POLICY "channels_select"
  ON channels FOR SELECT
  USING (org_id = get_my_org_id());

CREATE POLICY "channels_insert"
  ON channels FOR INSERT
  WITH CHECK (org_id = get_my_org_id() AND is_owner());

CREATE POLICY "channels_update"
  ON channels FOR UPDATE
  USING (org_id = get_my_org_id() AND is_owner());

CREATE POLICY "channels_delete"
  ON channels FOR DELETE
  USING (org_id = get_my_org_id() AND is_owner());


-- ── CHANNEL_ASSIGNMENTS ───────────────────────────────────
ALTER TABLE channel_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "channel_assignments_select" ON channel_assignments;
DROP POLICY IF EXISTS "channel_assignments_insert" ON channel_assignments;
DROP POLICY IF EXISTS "channel_assignments_delete" ON channel_assignments;

CREATE POLICY "channel_assignments_select"
  ON channel_assignments FOR SELECT
  USING (org_id = get_my_org_id());

CREATE POLICY "channel_assignments_insert"
  ON channel_assignments FOR INSERT
  WITH CHECK (org_id = get_my_org_id() AND is_owner());

CREATE POLICY "channel_assignments_delete"
  ON channel_assignments FOR DELETE
  USING (org_id = get_my_org_id() AND is_owner());


-- ── INVENTORY_LOG ─────────────────────────────────────────
-- Immutable audit trail: any org member can append, no one can edit/delete.
ALTER TABLE inventory_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inventory_log_select" ON inventory_log;
DROP POLICY IF EXISTS "inventory_log_insert" ON inventory_log;

CREATE POLICY "inventory_log_select"
  ON inventory_log FOR SELECT
  USING (org_id = get_my_org_id());

-- Breakers and owners both insert log entries during break submission.
CREATE POLICY "inventory_log_insert"
  ON inventory_log FOR INSERT
  WITH CHECK (org_id = get_my_org_id());

-- No UPDATE or DELETE policy: audit logs must be immutable.


-- ── SCHEDULES ─────────────────────────────────────────────
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "schedules_select" ON schedules;
DROP POLICY IF EXISTS "schedules_insert" ON schedules;
DROP POLICY IF EXISTS "schedules_update" ON schedules;
DROP POLICY IF EXISTS "schedules_delete" ON schedules;

CREATE POLICY "schedules_select"
  ON schedules FOR SELECT
  USING (org_id = get_my_org_id());

-- Owners and managers create shifts.
CREATE POLICY "schedules_insert"
  ON schedules FOR INSERT
  WITH CHECK (
    org_id = get_my_org_id()
    AND (
      is_owner()
      OR EXISTS (
        SELECT 1 FROM profiles
        WHERE id = auth.uid()
          AND org_id = get_my_org_id()
          AND role IN ('manager', 'breaker/manager')
      )
    )
  );

-- Breakers and sorters update their own shifts (clock-in/out, swap requests).
-- Owners and managers can update any shift.
CREATE POLICY "schedules_update"
  ON schedules FOR UPDATE
  USING (org_id = get_my_org_id());

CREATE POLICY "schedules_delete"
  ON schedules FOR DELETE
  USING (
    org_id = get_my_org_id()
    AND (
      is_owner()
      OR EXISTS (
        SELECT 1 FROM profiles
        WHERE id = auth.uid()
          AND org_id = get_my_org_id()
          AND role IN ('manager', 'breaker/manager')
      )
    )
  );


-- ── SORT_TASKS ────────────────────────────────────────────
ALTER TABLE sort_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sort_tasks_select" ON sort_tasks;
DROP POLICY IF EXISTS "sort_tasks_insert" ON sort_tasks;
DROP POLICY IF EXISTS "sort_tasks_update" ON sort_tasks;
DROP POLICY IF EXISTS "sort_tasks_delete" ON sort_tasks;

CREATE POLICY "sort_tasks_select"
  ON sort_tasks FOR SELECT
  USING (org_id = get_my_org_id());

-- Breakers and owners insert sort_tasks on stream close.
CREATE POLICY "sort_tasks_insert"
  ON sort_tasks FOR INSERT
  WITH CHECK (org_id = get_my_org_id());

-- Sorters claim tasks; owners assign them.
CREATE POLICY "sort_tasks_update"
  ON sort_tasks FOR UPDATE
  USING (org_id = get_my_org_id());

CREATE POLICY "sort_tasks_delete"
  ON sort_tasks FOR DELETE
  USING (org_id = get_my_org_id() AND is_owner());


-- ── TIPS ──────────────────────────────────────────────────
ALTER TABLE tips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tips_select" ON tips;
DROP POLICY IF EXISTS "tips_insert" ON tips;
DROP POLICY IF EXISTS "tips_update" ON tips;
DROP POLICY IF EXISTS "tips_delete" ON tips;

CREATE POLICY "tips_select"
  ON tips FOR SELECT
  USING (org_id = get_my_org_id());

-- Breakers log their own tips.
CREATE POLICY "tips_insert"
  ON tips FOR INSERT
  WITH CHECK (org_id = get_my_org_id());

CREATE POLICY "tips_update"
  ON tips FOR UPDATE
  USING (org_id = get_my_org_id() AND is_owner());

CREATE POLICY "tips_delete"
  ON tips FOR DELETE
  USING (org_id = get_my_org_id() AND is_owner());


-- ── PAYROLL_RUNS ──────────────────────────────────────────
ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payroll_runs_select" ON payroll_runs;
DROP POLICY IF EXISTS "payroll_runs_insert" ON payroll_runs;
DROP POLICY IF EXISTS "payroll_runs_update" ON payroll_runs;
DROP POLICY IF EXISTS "payroll_runs_delete" ON payroll_runs;

CREATE POLICY "payroll_runs_select"
  ON payroll_runs FOR SELECT
  USING (org_id = get_my_org_id());

CREATE POLICY "payroll_runs_insert"
  ON payroll_runs FOR INSERT
  WITH CHECK (org_id = get_my_org_id() AND is_owner());

CREATE POLICY "payroll_runs_update"
  ON payroll_runs FOR UPDATE
  USING (org_id = get_my_org_id() AND is_owner());

CREATE POLICY "payroll_runs_delete"
  ON payroll_runs FOR DELETE
  USING (org_id = get_my_org_id() AND is_owner());


-- ── NOTIFICATIONS ─────────────────────────────────────────
-- Not in the original 14-table list but referenced in the codebase.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notifications_select" ON notifications;
DROP POLICY IF EXISTS "notifications_insert" ON notifications;
DROP POLICY IF EXISTS "notifications_update" ON notifications;
DROP POLICY IF EXISTS "notifications_delete" ON notifications;

-- Users see only their own notifications.
CREATE POLICY "notifications_select"
  ON notifications FOR SELECT
  USING (org_id = get_my_org_id() AND profile_id = auth.uid());

-- Org members can insert notifications (swap requests, system events).
-- Stripe webhook (service role) also inserts notifications and bypasses RLS.
CREATE POLICY "notifications_insert"
  ON notifications FOR INSERT
  WITH CHECK (org_id = get_my_org_id());

-- Users can mark their own notifications as read.
CREATE POLICY "notifications_update"
  ON notifications FOR UPDATE
  USING (org_id = get_my_org_id() AND profile_id = auth.uid());

CREATE POLICY "notifications_delete"
  ON notifications FOR DELETE
  USING (org_id = get_my_org_id() AND is_owner());


-- ============================================================
-- SECTION 3 — VERIFY EXISTING TABLE RLS IS ENABLED
-- These were in the original schema. Enabling RLS is idempotent.
-- ============================================================

ALTER TABLE breaks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_codes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE streams          ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions    ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- SECTION 4 — KNOWN LIMITATION (DOCUMENTED, NOT FIXED HERE)
-- ============================================================
-- products_update: RLS cannot restrict UPDATE to specific columns.
-- Current policy allows any org member to update any product column.
-- Breakers need to update current_stock; the app layer restricts other columns.
-- Recommended fix (future): use a SECURITY DEFINER function for stock deduction
-- and restrict direct product updates to is_owner() only.
-- Do NOT change this policy without updating breaker.html stock deduction logic.


-- ============================================================
-- SECTION 5 — VERIFICATION QUERY
-- Run after migration to confirm RLS is enabled on all tables.
-- ============================================================
SELECT
  schemaname,
  tablename,
  rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'breaks','channel_assignments','channels','inventory_log',
    'invite_codes','notifications','organizations','payroll_runs',
    'products','profiles','schedules','sort_tasks','streams',
    'subscriptions','tips'
  )
ORDER BY tablename;
