-- ============================================================
-- CardBreakPro — Notifications Schema Migration
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================

-- ── Table: notifications ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notifications (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         uuid        REFERENCES public.profiles(id) ON DELETE CASCADE,
  type            text        NOT NULL DEFAULT 'info',
  title           text        NOT NULL,
  body            text        NOT NULL DEFAULT '',
  is_read         boolean     NOT NULL DEFAULT false,
  action_url      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_id_idx       ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS notifications_org_id_idx        ON public.notifications(organization_id);
CREATE INDEX IF NOT EXISTS notifications_is_read_idx       ON public.notifications(user_id, is_read);

-- RLS
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Users read/update their own
CREATE POLICY "notifs_select_own" ON public.notifications
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "notifs_update_own" ON public.notifications
  FOR UPDATE USING (user_id = auth.uid());

-- Owners also read all org notifications
CREATE POLICY "notifs_select_org_owner" ON public.notifications
  FOR SELECT USING (
    organization_id IN (
      SELECT org_id FROM public.profiles
      WHERE id = auth.uid() AND role = 'owner'
    )
  );

-- ── Table: notification_preferences ──────────────────────────
CREATE TABLE IF NOT EXISTS public.notification_preferences (
  id                           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                      uuid    UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  organization_id              uuid    REFERENCES public.organizations(id) ON DELETE CASCADE,
  daily_digest_time            time    NOT NULL DEFAULT '08:30',
  email_notifications_enabled  boolean NOT NULL DEFAULT true,
  in_app_notifications_enabled boolean NOT NULL DEFAULT true,
  notify_stream_closed         boolean NOT NULL DEFAULT true,
  notify_shift_reminder        boolean NOT NULL DEFAULT true,
  notify_inventory_low         boolean NOT NULL DEFAULT true,
  notify_payment_failed        boolean NOT NULL DEFAULT true,
  notify_daily_digest          boolean NOT NULL DEFAULT true,
  last_digest_sent             date,
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notif_prefs_manage_own" ON public.notification_preferences
  FOR ALL USING (user_id = auth.uid());

-- ── Auto-create preferences when a profile is created ────────
CREATE OR REPLACE FUNCTION public.create_notification_preferences()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.notification_preferences (user_id, organization_id)
  VALUES (NEW.id, NEW.org_id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_profile_created_create_prefs ON public.profiles;
CREATE TRIGGER on_profile_created_create_prefs
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.create_notification_preferences();

-- Backfill preferences for existing profiles
INSERT INTO public.notification_preferences (user_id, organization_id)
SELECT id, org_id FROM public.profiles
ON CONFLICT (user_id) DO NOTHING;

-- ── Add reminder_sent to schedules (for shift reminder cron) ─
ALTER TABLE public.schedules
  ADD COLUMN IF NOT EXISTS reminder_sent boolean NOT NULL DEFAULT false;

-- ── Enable Realtime on notifications table ───────────────────
-- Run this separately if the above doesn't automatically enable it:
-- ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
