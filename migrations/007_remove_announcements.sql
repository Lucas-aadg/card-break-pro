-- ============================================================
-- 007 — Remove the Announcements feature (unused)
-- The Announcements UI has been removed from every dashboard. This
-- purges the announcements chat channel and stops new orgs from
-- getting one. Run in Supabase: SQL Editor → New Query → paste → Run.
-- Safe to re-run.
-- ============================================================

-- 1. Reseed function without the announcements channel (keeps the other
--    default team-chat channels intact).
CREATE OR REPLACE FUNCTION seed_org_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO chat_channels (name, slug, description, org_id, can_post_roles) VALUES
    ('All Team',      'all_team',      'Visible to everyone on the team',        NEW.id, ARRAY['owner','manager','breaker','sorter']),
    ('Breakers Only', 'breakers_only', 'Private channel for breakers and above', NEW.id, ARRAY['owner','manager','breaker']),
    ('Sorters Only',  'sorters_only',  'Private channel for sorters and above',  NEW.id, ARRAY['owner','manager','sorter'])
  ON CONFLICT (org_id, slug) DO NOTHING;

  INSERT INTO leaderboard_settings (org_id)
  VALUES (NEW.id)
  ON CONFLICT (org_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- 2. Delete every existing announcements channel. chat_messages.channel_id
--    is ON DELETE CASCADE, so any old announcement posts go with it.
DELETE FROM public.chat_channels WHERE slug = 'announcements';
