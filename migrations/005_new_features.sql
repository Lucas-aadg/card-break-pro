-- Migration 005: Team Chat, Leaderboards, Milestones, Stream Templates, Sorter Split, Monthly Goals
-- Idempotent — safe to re-run. Uses IF NOT EXISTS and DO $$ blocks for PG15 compat.
-- NOTE: Foreign keys to "staff" reference the profiles table (confirmed from existing API code).

-- ═══════════════════════════════════════════════════════════════════
-- TASK 1 — TEAM CHAT
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_channels (
  id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  name           TEXT        NOT NULL,
  slug           TEXT        NOT NULL,
  description    TEXT,
  org_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  can_post_roles TEXT[]      NOT NULL DEFAULT ARRAY['owner','manager','breaker','sorter'],
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  UNIQUE(org_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_chat_channels_org    ON chat_channels (org_id);
CREATE INDEX IF NOT EXISTS idx_chat_channels_active ON chat_channels (org_id, is_active);

ALTER TABLE chat_channels ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='chat_channels' AND policyname='chat_channels_org_read') THEN
    CREATE POLICY "chat_channels_org_read" ON chat_channels FOR SELECT USING (
      org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
    );
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel_id  UUID        NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  sender_id   UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  content     TEXT        NOT NULL,
  is_deleted  BOOLEAN     NOT NULL DEFAULT false,
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages (channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender  ON chat_messages (sender_id);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='chat_messages' AND policyname='chat_messages_org_read') THEN
    CREATE POLICY "chat_messages_org_read" ON chat_messages FOR SELECT USING (
      channel_id IN (
        SELECT id FROM chat_channels
        WHERE org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='chat_messages' AND policyname='chat_messages_insert_own') THEN
    CREATE POLICY "chat_messages_insert_own" ON chat_messages FOR INSERT WITH CHECK (
      sender_id = auth.uid()
    );
  END IF;
END $$;

-- Enable Realtime
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_reactions (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_id UUID        NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  staff_id   UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  emoji      TEXT        NOT NULL CHECK (emoji IN ('👍','🔥','💰','✅')),
  UNIQUE(message_id, staff_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_chat_reactions_message ON chat_reactions (message_id);

ALTER TABLE chat_reactions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='chat_reactions' AND policyname='chat_reactions_org_read') THEN
    CREATE POLICY "chat_reactions_org_read" ON chat_reactions FOR SELECT USING (
      message_id IN (
        SELECT cm.id FROM chat_messages cm
        JOIN chat_channels cc ON cc.id = cm.channel_id
        WHERE cc.org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='chat_reactions' AND policyname='chat_reactions_insert_own') THEN
    CREATE POLICY "chat_reactions_insert_own" ON chat_reactions FOR INSERT WITH CHECK (staff_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='chat_reactions' AND policyname='chat_reactions_delete_own') THEN
    CREATE POLICY "chat_reactions_delete_own" ON chat_reactions FOR DELETE USING (staff_id = auth.uid());
  END IF;
END $$;

-- Enable Realtime
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_reactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_reactions;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_read_status (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  channel_id   UUID        NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  staff_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(channel_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_read_staff ON chat_read_status (staff_id);

ALTER TABLE chat_read_status ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='chat_read_status' AND policyname='chat_read_own') THEN
    CREATE POLICY "chat_read_own" ON chat_read_status FOR ALL USING (staff_id = auth.uid());
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- TASK 2 — LEADERBOARDS
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  staff_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  period_year  INTEGER     NOT NULL,
  period_month INTEGER     NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  category     TEXT        NOT NULL CHECK (category IN ('breaks_completed','revenue_generated','commission_earned','consistency_score','longest_streak')),
  value        NUMERIC     NOT NULL DEFAULT 0,
  rank         INTEGER,
  UNIQUE(org_id, staff_id, period_year, period_month, category)
);

CREATE INDEX IF NOT EXISTS idx_lb_snapshots_org_period ON leaderboard_snapshots (org_id, period_year, period_month, category);
CREATE INDEX IF NOT EXISTS idx_lb_snapshots_staff      ON leaderboard_snapshots (staff_id);

ALTER TABLE leaderboard_snapshots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='leaderboard_snapshots' AND policyname='lb_snapshots_org_read') THEN
    CREATE POLICY "lb_snapshots_org_read" ON leaderboard_snapshots FOR SELECT USING (
      org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
    );
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leaderboard_settings (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id              UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE UNIQUE,
  visible_to_breakers BOOLEAN     NOT NULL DEFAULT true,
  visible_to_sorters  BOOLEAN     NOT NULL DEFAULT false,
  visible_categories  TEXT[]      NOT NULL DEFAULT ARRAY['breaks_completed','revenue_generated','commission_earned','consistency_score','longest_streak'],
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE leaderboard_settings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='leaderboard_settings' AND policyname='lb_settings_org_read') THEN
    CREATE POLICY "lb_settings_org_read" ON leaderboard_settings FOR SELECT USING (
      org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='leaderboard_settings' AND policyname='lb_settings_owner_write') THEN
    CREATE POLICY "lb_settings_owner_write" ON leaderboard_settings FOR UPDATE USING (
      org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid() AND role = 'owner')
    );
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- TASK 3 — MILESTONES
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS milestone_definitions (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id          UUID        REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  description     TEXT        NOT NULL,
  badge_icon      TEXT        NOT NULL,
  badge_color     TEXT        NOT NULL,
  trigger_type    TEXT        NOT NULL CHECK (trigger_type IN ('manual','automatic')),
  trigger_metric  TEXT        CHECK (trigger_metric IN ('breaks_completed','revenue_generated','streak_days','commission_earned')),
  trigger_value   NUMERIC,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  display_order   INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_milestones_org       ON milestone_definitions (org_id);
CREATE INDEX IF NOT EXISTS idx_milestones_system    ON milestone_definitions (org_id) WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_milestones_active    ON milestone_definitions (is_active);

ALTER TABLE milestone_definitions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='milestone_definitions' AND policyname='milestones_visible') THEN
    CREATE POLICY "milestones_visible" ON milestone_definitions FOR SELECT USING (
      org_id IS NULL
      OR org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='milestone_definitions' AND policyname='milestones_owner_insert') THEN
    CREATE POLICY "milestones_owner_insert" ON milestone_definitions FOR INSERT WITH CHECK (
      org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid() AND role = 'owner')
    );
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_milestones (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  staff_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  milestone_id UUID        NOT NULL REFERENCES milestone_definitions(id) ON DELETE CASCADE,
  awarded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  awarded_by   UUID        REFERENCES profiles(id),
  org_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(staff_id, milestone_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_milestones_staff ON staff_milestones (staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_milestones_org   ON staff_milestones (org_id);

ALTER TABLE staff_milestones ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='staff_milestones' AND policyname='staff_milestones_org_read') THEN
    CREATE POLICY "staff_milestones_org_read" ON staff_milestones FOR SELECT USING (
      org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='staff_milestones' AND policyname='staff_milestones_insert') THEN
    CREATE POLICY "staff_milestones_insert" ON staff_milestones FOR INSERT WITH CHECK (
      org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
    );
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- TASK 4 — STREAM TEMPLATES
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS stream_templates (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by   UUID        NOT NULL REFERENCES profiles(id),
  name         TEXT        NOT NULL,
  description  TEXT,
  breaks       JSONB       NOT NULL DEFAULT '[]',
  total_breaks INTEGER     NOT NULL DEFAULT 0,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  use_count    INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_templates_org    ON stream_templates (org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_templates_active ON stream_templates (org_id) WHERE is_active = true;

ALTER TABLE stream_templates ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='stream_templates' AND policyname='templates_org_read') THEN
    CREATE POLICY "templates_org_read" ON stream_templates FOR SELECT USING (
      org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='stream_templates' AND policyname='templates_manager_write') THEN
    CREATE POLICY "templates_manager_write" ON stream_templates FOR ALL USING (
      org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid() AND role IN ('owner','manager'))
    );
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- TASK 5 — SORTER SPLIT
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sorter_splits (
  id                           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stream_id                    UUID        NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  initiating_sorter_id         UUID        NOT NULL REFERENCES profiles(id),
  receiving_sorter_id          UUID        NOT NULL REFERENCES profiles(id),
  split_type                   TEXT        NOT NULL CHECK (split_type IN ('equal','custom')),
  initiating_sorter_percentage NUMERIC     NOT NULL,
  receiving_sorter_percentage  NUMERIC     NOT NULL,
  status                       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','declined','expired','completed')),
  confirmed_at                 TIMESTAMPTZ,
  expires_at                   TIMESTAMPTZ NOT NULL,
  initiating_sorter_earnings   NUMERIC,
  receiving_sorter_earnings    NUMERIC,
  UNIQUE(stream_id),
  CONSTRAINT pct_sum_100 CHECK (initiating_sorter_percentage + receiving_sorter_percentage = 100)
);

CREATE INDEX IF NOT EXISTS idx_splits_receiving ON sorter_splits (receiving_sorter_id, status);
CREATE INDEX IF NOT EXISTS idx_splits_initiating ON sorter_splits (initiating_sorter_id);
CREATE INDEX IF NOT EXISTS idx_splits_stream     ON sorter_splits (stream_id);

ALTER TABLE sorter_splits ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sorter_splits' AND policyname='splits_participants_read') THEN
    CREATE POLICY "splits_participants_read" ON sorter_splits FOR SELECT USING (
      initiating_sorter_id = auth.uid() OR receiving_sorter_id = auth.uid()
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sorter_splits' AND policyname='splits_initiating_insert') THEN
    CREATE POLICY "splits_initiating_insert" ON sorter_splits FOR INSERT WITH CHECK (
      initiating_sorter_id = auth.uid()
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sorter_splits' AND policyname='splits_participants_update') THEN
    CREATE POLICY "splits_participants_update" ON sorter_splits FOR UPDATE USING (
      initiating_sorter_id = auth.uid() OR receiving_sorter_id = auth.uid()
    );
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- TASK 6 — MONTHLY GOALS
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS monthly_goals (
  id                 UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id             UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  goal_year          INTEGER     NOT NULL,
  goal_month         INTEGER     NOT NULL CHECK (goal_month BETWEEN 1 AND 12),
  goal_type          TEXT        NOT NULL CHECK (goal_type IN ('organization_revenue','individual_breaks','individual_revenue')),
  staff_id           UUID        REFERENCES profiles(id),
  target_value       NUMERIC     NOT NULL,
  current_value      NUMERIC     NOT NULL DEFAULT 0,
  is_visible_to_all  BOOLEAN     NOT NULL DEFAULT true,
  created_by         UUID        NOT NULL REFERENCES profiles(id),
  UNIQUE NULLS NOT DISTINCT (org_id, goal_year, goal_month, goal_type, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_goals_org_period ON monthly_goals (org_id, goal_year, goal_month);
CREATE INDEX IF NOT EXISTS idx_goals_staff      ON monthly_goals (staff_id);

ALTER TABLE monthly_goals ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_goals' AND policyname='goals_org_read') THEN
    CREATE POLICY "goals_org_read" ON monthly_goals FOR SELECT USING (
      org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
      AND (
        is_visible_to_all = true
        OR staff_id = auth.uid()
        OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('owner','manager'))
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monthly_goals' AND policyname='goals_owner_write') THEN
    CREATE POLICY "goals_owner_write" ON monthly_goals FOR ALL USING (
      org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid() AND role = 'owner')
    );
  END IF;
END $$;

-- Enable Realtime
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'monthly_goals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE monthly_goals;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- ORG CREATION TRIGGER — seeds channels + leaderboard_settings
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION seed_org_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Four default chat channels
  INSERT INTO chat_channels (name, slug, description, org_id, can_post_roles) VALUES
    ('All Team',      'all_team',      'Visible to everyone on the team',          NEW.id, ARRAY['owner','manager','breaker','sorter']),
    ('Breakers Only', 'breakers_only', 'Private channel for breakers and above',   NEW.id, ARRAY['owner','manager','breaker']),
    ('Sorters Only',  'sorters_only',  'Private channel for sorters and above',    NEW.id, ARRAY['owner','manager','sorter']),
    ('Announcements', 'announcements', 'Owner and manager announcements only',     NEW.id, ARRAY['owner','manager'])
  ON CONFLICT (org_id, slug) DO NOTHING;

  -- Default leaderboard settings
  INSERT INTO leaderboard_settings (org_id)
  VALUES (NEW.id)
  ON CONFLICT (org_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Attach trigger (drop and recreate to ensure it's current)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'on_org_created_seed_defaults'
    AND tgrelid = 'organizations'::regclass
  ) THEN
    DROP TRIGGER on_org_created_seed_defaults ON organizations;
  END IF;
END $$;

CREATE TRIGGER on_org_created_seed_defaults
  AFTER INSERT ON organizations
  FOR EACH ROW EXECUTE FUNCTION seed_org_defaults();

-- Retroactively seed existing orgs that don't yet have defaults
INSERT INTO chat_channels (name, slug, description, org_id, can_post_roles)
SELECT defaults.name, defaults.slug, defaults.description, o.id, defaults.roles
FROM organizations o
CROSS JOIN (VALUES
  ('All Team',      'all_team',      'Visible to everyone on the team',        ARRAY['owner','manager','breaker','sorter']),
  ('Breakers Only', 'breakers_only', 'Private channel for breakers and above', ARRAY['owner','manager','breaker']),
  ('Sorters Only',  'sorters_only',  'Private channel for sorters and above',  ARRAY['owner','manager','sorter']),
  ('Announcements', 'announcements', 'Owner and manager announcements only',   ARRAY['owner','manager'])
) AS defaults(name, slug, description, roles)
ON CONFLICT (org_id, slug) DO NOTHING;

INSERT INTO leaderboard_settings (org_id)
SELECT id FROM organizations
ON CONFLICT (org_id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════
-- BUYER INTELLIGENCE — add case_hits column (idempotent)
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.buyers ADD COLUMN IF NOT EXISTS case_hits INTEGER NOT NULL DEFAULT 0;

-- ═══════════════════════════════════════════════════════════════════
-- SYSTEM MILESTONE SEEDS (org_id NULL = visible to all orgs)
-- 13 total: 6 breaks + 4 revenue + 3 streak
-- ═══════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM milestone_definitions WHERE org_id IS NULL LIMIT 1) THEN
    INSERT INTO milestone_definitions
      (org_id, name, description, badge_icon, badge_color, trigger_type, trigger_metric, trigger_value, display_order)
    VALUES
      -- Breaks milestones
      (NULL, 'First Break',   'Completed your very first break',        '🎯', '#39ff85', 'automatic', 'breaks_completed',  1,    1),
      (NULL, '10 Breaks',     'Completed 10 breaks',                    '🎯', '#3b82f6', 'automatic', 'breaks_completed',  10,   2),
      (NULL, '50 Breaks',     'Completed 50 breaks',                    '🎯', '#6366f1', 'automatic', 'breaks_completed',  50,   3),
      (NULL, '100 Breaks',    'Completed 100 breaks',                   '🎯', '#8b5cf6', 'automatic', 'breaks_completed',  100,  4),
      (NULL, '500 Breaks',    'Completed 500 breaks',                   '🎯', '#ec4899', 'automatic', 'breaks_completed',  500,  5),
      (NULL, '1000 Breaks',   'Completed 1000 breaks — elite status',   '🎯', '#f59e0b', 'automatic', 'breaks_completed',  1000, 6),
      -- Revenue milestones
      (NULL, 'First $1K Generated',  'Generated $1,000 in revenue',     '💰', '#fbbf24', 'automatic', 'revenue_generated', 1000,   7),
      (NULL, '$10K Generated',        'Generated $10,000 in revenue',    '💰', '#f59e0b', 'automatic', 'revenue_generated', 10000,  8),
      (NULL, '$50K Generated',        'Generated $50,000 in revenue',    '💰', '#f97316', 'automatic', 'revenue_generated', 50000,  9),
      (NULL, '$100K Generated',       'Generated $100,000 in revenue',   '💰', '#ef4444', 'automatic', 'revenue_generated', 100000, 10),
      -- Streak milestones
      (NULL, '7 Day Streak',  '7 consecutive days with at least one break',  '🔥', '#f97316', 'automatic', 'streak_days', 7,  11),
      (NULL, '30 Day Streak', '30 consecutive days with at least one break', '🔥', '#ef4444', 'automatic', 'streak_days', 30, 12),
      (NULL, '60 Day Streak', '60 consecutive days with at least one break', '🔥', '#dc2626', 'automatic', 'streak_days', 60, 13);
  END IF;
END $$;
