-- Migration 004: Add missing subscription columns needed by cron jobs
-- Idempotent — safe to re-run.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS renewal_reminder_7d_sent  BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS renewal_reminder_3d_sent  BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS current_period_end        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end      BOOLEAN     NOT NULL DEFAULT false;
