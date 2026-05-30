-- ============================================================
-- CardBreakPro Migration 002: Annual Billing & Referral Program
-- Run in Supabase SQL Editor (supabase.com → SQL Editor → New query)
-- Safe to run multiple times (uses IF NOT EXISTS / DO blocks)
-- ============================================================

-- TASK 2: Annual billing columns on subscriptions
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS billing_cycle text DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS annual_renewal_date date,
  ADD COLUMN IF NOT EXISTS months_credited integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS annual_reminder_30_sent boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS annual_reminder_7_sent boolean DEFAULT false;

UPDATE subscriptions SET billing_cycle = 'monthly' WHERE billing_cycle IS NULL;

-- TASK 5: referral_codes table
CREATE TABLE IF NOT EXISTS referral_codes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid REFERENCES organizations(id) ON DELETE CASCADE,
  code                text UNIQUE NOT NULL,
  created_at          timestamptz DEFAULT now(),
  times_used          integer DEFAULT 0,
  times_converted     integer DEFAULT 0,
  total_credits_earned integer DEFAULT 0
);

-- TASK 5: referral_uses table
CREATE TABLE IF NOT EXISTS referral_uses (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_code_id          uuid REFERENCES referral_codes(id) ON DELETE CASCADE,
  referred_organization_id  uuid REFERENCES organizations(id) ON DELETE CASCADE,
  used_at                   timestamptz DEFAULT now(),
  converted_at              timestamptz,
  status                    text DEFAULT 'pending',
  reward_granted            boolean DEFAULT false,
  referrer_credited_at      timestamptz,
  referred_trial_extended   boolean DEFAULT false
);

-- TASK 5: Add referral_code_used to organizations
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS referral_code_used text;

-- TASK 5: Enable RLS on referral tables
ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_uses ENABLE ROW LEVEL SECURITY;

-- RLS: owners can read their own referral codes
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'referral_codes' AND policyname = 'owners_select_referral_codes'
  ) THEN
    CREATE POLICY "owners_select_referral_codes" ON referral_codes
      FOR SELECT USING (
        organization_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
      );
  END IF;
END $$;

-- RLS: owners can insert their own referral codes
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'referral_codes' AND policyname = 'owners_insert_referral_codes'
  ) THEN
    CREATE POLICY "owners_insert_referral_codes" ON referral_codes
      FOR INSERT WITH CHECK (
        organization_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
      );
  END IF;
END $$;

-- RLS: service role bypass for referral_codes (for webhooks / crons)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'referral_codes' AND policyname = 'service_role_referral_codes'
  ) THEN
    CREATE POLICY "service_role_referral_codes" ON referral_codes
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- RLS: owners can read uses of their own referral codes
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'referral_uses' AND policyname = 'owners_select_referral_uses'
  ) THEN
    CREATE POLICY "owners_select_referral_uses" ON referral_uses
      FOR SELECT USING (
        referral_code_id IN (
          SELECT id FROM referral_codes
          WHERE organization_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
        )
      );
  END IF;
END $$;

-- RLS: service role bypass for referral_uses (for webhooks / crons)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'referral_uses' AND policyname = 'service_role_referral_uses'
  ) THEN
    CREATE POLICY "service_role_referral_uses" ON referral_uses
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ============================================================
-- Verification queries (run after migration to confirm success)
-- ============================================================
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'subscriptions' AND column_name IN ('billing_cycle','annual_renewal_date','months_credited');
-- SELECT table_name FROM information_schema.tables WHERE table_name IN ('referral_codes','referral_uses');
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'referral_code_used';
