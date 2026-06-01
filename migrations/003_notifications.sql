-- Migration 003: notifications + notification_preferences tables
-- Idempotent — safe to re-run. Uses DO blocks for policy creation (PG15 compat).

-- ── notifications ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id  UUID        NOT NULL,
  user_id          UUID        NOT NULL,
  type             TEXT        NOT NULL,
  title            TEXT        NOT NULL,
  body             TEXT,
  action_url       TEXT,
  is_read          BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications (user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_org_id  ON notifications (organization_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread  ON notifications (user_id, is_read) WHERE is_read = false;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notifications' AND policyname='notif_select_own') THEN
    CREATE POLICY "notif_select_own" ON notifications FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notifications' AND policyname='notif_update_own') THEN
    CREATE POLICY "notif_update_own" ON notifications FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── notification_preferences ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
  id                           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                      UUID        NOT NULL UNIQUE,
  organization_id              UUID        NOT NULL,
  daily_digest_time            TIME        NOT NULL DEFAULT '08:30',
  email_notifications_enabled  BOOLEAN     NOT NULL DEFAULT true,
  in_app_notifications_enabled BOOLEAN     NOT NULL DEFAULT true,
  notify_stream_closed         BOOLEAN     NOT NULL DEFAULT true,
  notify_shift_reminder        BOOLEAN     NOT NULL DEFAULT true,
  notify_inventory_low         BOOLEAN     NOT NULL DEFAULT true,
  notify_payment_failed        BOOLEAN     NOT NULL DEFAULT true,
  notify_daily_digest          BOOLEAN     NOT NULL DEFAULT true,
  updated_at                   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notification_preferences' AND policyname='notif_prefs_select_own') THEN
    CREATE POLICY "notif_prefs_select_own" ON notification_preferences FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notification_preferences' AND policyname='notif_prefs_insert_own') THEN
    CREATE POLICY "notif_prefs_insert_own" ON notification_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notification_preferences' AND policyname='notif_prefs_update_own') THEN
    CREATE POLICY "notif_prefs_update_own" ON notification_preferences FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;
