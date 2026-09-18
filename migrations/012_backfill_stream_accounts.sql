-- ============================================================
-- 012 — Backfill streams.channel_id (the account filter's blind spot)
-- A stream only inherited an account when its exact stream_key matched a
-- schedule, or the breaker was clocked into a shift. Keys like "210 9.15.26"
-- never match, so most recent streams have channel_id = NULL and every
-- purchase on them is invisible to the account filter (whales 0, 30-day
-- rev $0 while the lifetime view is full).
-- Run in Supabase: SQL Editor → New Query → paste → Run. Safe to re-run.
-- ============================================================

-- 1. Same breaker, same day, a shift on an account → that's the account.
UPDATE public.streams s
SET channel_id = m.channel_id
FROM (
  SELECT DISTINCT ON (s2.id) s2.id AS stream_id, sch.channel_id
  FROM public.streams s2
  JOIN public.schedules sch
    ON sch.org_id = s2.org_id
   AND sch.breaker_id = s2.breaker_id
   AND sch.scheduled_date = s2.break_date
   AND sch.channel_id IS NOT NULL
   AND coalesce(sch.status, '') <> 'cancelled'
  WHERE s2.channel_id IS NULL
  ORDER BY s2.id, sch.clocked_in_at DESC NULLS LAST
) m
WHERE m.stream_id = s.id AND s.channel_id IS NULL;

-- 2. Org has exactly one account → every remaining untagged stream is on it.
UPDATE public.streams s
SET channel_id = one.channel_id
FROM (
  SELECT org_id, (array_agg(id))[1] AS channel_id   -- no min(uuid) in Postgres; with count=1 any pick is the only one
  FROM public.channels
  GROUP BY org_id
  HAVING count(*) = 1
) one
WHERE one.org_id = s.org_id AND s.channel_id IS NULL;

-- 3. What's left needs a human: the owner assigns these from Buyers → "Streams
--    without an account" (or Edit Stream). Shown per org, recent first.
SELECT o.name AS org,
       count(*)                                                             AS untagged_streams,
       count(*) FILTER (WHERE s.break_date >= current_date - 90)            AS untagged_last_90d,
       (SELECT count(*) FROM public.channels c WHERE c.org_id = o.id)       AS accounts,
       coalesce(sum(s.final_sales) FILTER (WHERE s.break_date >= current_date - 90), 0) AS sales_last_90d_untagged
FROM public.streams s
JOIN public.organizations o ON o.id = s.org_id
WHERE s.channel_id IS NULL
GROUP BY o.id, o.name
ORDER BY untagged_last_90d DESC;
