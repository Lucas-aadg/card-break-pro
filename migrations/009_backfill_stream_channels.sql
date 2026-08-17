-- ============================================================
-- 009 — Backfill streams.channel_id from schedules
-- The breaker app only tagged a stream's account (channel_id) when an active
-- schedule matched the exact stream_key at creation time. Ad-hoc streams were
-- saved with channel_id = NULL, so their buyers mapped to no account and the
-- account filter had nothing to filter. This recovers the account for existing
-- streams by matching each NULL-channel stream to a schedule for the same
-- org + breaker + stream_key that DOES have a channel.
-- Run in Supabase: SQL Editor -> New Query -> paste -> Run. Safe to re-run.
-- ============================================================

UPDATE public.streams s
SET channel_id = sch.channel_id
FROM public.schedules sch
WHERE s.channel_id IS NULL
  AND sch.channel_id IS NOT NULL
  AND sch.org_id      = s.org_id
  AND sch.breaker_id  = s.breaker_id
  AND sch.stream_key  = s.stream_key;

-- How many streams still have no account after the backfill (no matching
-- schedule ever carried a channel). These can only be tagged going forward or
-- by the owner reassigning them.
SELECT count(*) AS streams_still_unassigned
FROM public.streams
WHERE channel_id IS NULL;
