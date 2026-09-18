-- ============================================================
-- 011 — buyer_rollups v2: plain GROUP BYs + stable ORDER BY
-- Replaces the GROUPING SETS version from 010 with two ordinary
-- aggregations unioned together (lifetime rows + per-account rows).
-- Same output columns, same callers. Adds ORDER BY so paging past
-- 1,000 rows is deterministic (offset paging over an unordered
-- set-returning function can overlap or skip rows).
-- Run in Supabase: SQL Editor → New Query → paste → Run. Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.buyer_rollups()
RETURNS TABLE (
  buyer_id        uuid,
  channel_id      uuid,
  is_total        boolean,
  spent           numeric,
  breaks          bigint,
  streams         bigint,
  first_date      date,
  last_date       date,
  recent30        numeric,
  prior30         numeric,
  recent90        numeric,
  purchase_days   bigint,
  median_gap_days numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH p AS (
    SELECT bp.buyer_id, s.channel_id, bp.amount, bp.purchase_date, bp.stream_id
    FROM public.buyer_purchases bp
    LEFT JOIN public.streams s ON s.id = bp.stream_id
    WHERE bp.organization_id = public.get_my_org_id()
  ),
  days AS (
    SELECT d.buyer_id,
           d.purchase_date - lag(d.purchase_date) OVER (PARTITION BY d.buyer_id ORDER BY d.purchase_date) AS gap
    FROM (SELECT DISTINCT p.buyer_id, p.purchase_date FROM p WHERE p.purchase_date IS NOT NULL) d
  ),
  cadence AS (
    SELECT days.buyer_id,
           count(*)::bigint AS purchase_days,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY days.gap::float8))::numeric AS median_gap_days
    FROM days
    GROUP BY days.buyer_id
  ),
  totals AS (
    SELECT p.buyer_id,
           NULL::uuid                                                                                 AS channel_id,
           true                                                                                       AS is_total,
           coalesce(sum(p.amount), 0)                                                                 AS spent,
           count(*)::bigint                                                                           AS breaks,
           count(DISTINCT p.stream_id)::bigint                                                        AS streams,
           min(p.purchase_date)                                                                       AS first_date,
           max(p.purchase_date)                                                                       AS last_date,
           coalesce(sum(p.amount) FILTER (WHERE p.purchase_date >= current_date - 30), 0)             AS recent30,
           coalesce(sum(p.amount) FILTER (WHERE p.purchase_date <  current_date - 30
                                            AND p.purchase_date >= current_date - 60), 0)             AS prior30,
           coalesce(sum(p.amount) FILTER (WHERE p.purchase_date >= current_date - 90), 0)             AS recent90
    FROM p
    GROUP BY p.buyer_id
  ),
  per_channel AS (
    SELECT p.buyer_id,
           p.channel_id,
           false                                                                                      AS is_total,
           coalesce(sum(p.amount), 0)                                                                 AS spent,
           count(*)::bigint                                                                           AS breaks,
           count(DISTINCT p.stream_id)::bigint                                                        AS streams,
           min(p.purchase_date)                                                                       AS first_date,
           max(p.purchase_date)                                                                       AS last_date,
           coalesce(sum(p.amount) FILTER (WHERE p.purchase_date >= current_date - 30), 0)             AS recent30,
           coalesce(sum(p.amount) FILTER (WHERE p.purchase_date <  current_date - 30
                                            AND p.purchase_date >= current_date - 60), 0)             AS prior30,
           coalesce(sum(p.amount) FILTER (WHERE p.purchase_date >= current_date - 90), 0)             AS recent90
    FROM p
    WHERE p.channel_id IS NOT NULL
    GROUP BY p.buyer_id, p.channel_id
  ),
  u AS (
    SELECT * FROM totals
    UNION ALL
    SELECT * FROM per_channel
  )
  SELECT u.buyer_id, u.channel_id, u.is_total,
         u.spent, u.breaks, u.streams, u.first_date, u.last_date,
         u.recent30, u.prior30, u.recent90,
         CASE WHEN u.is_total THEN c.purchase_days   END,
         CASE WHEN u.is_total THEN c.median_gap_days END
  FROM u
  LEFT JOIN cadence c ON c.buyer_id = u.buyer_id
  ORDER BY u.buyer_id, u.is_total DESC, u.channel_id;
$$;

GRANT EXECUTE ON FUNCTION public.buyer_rollups() TO authenticated;

-- ── Sanity: what the function will hand the pages, org by org ──
-- (Runs as the SQL editor role, so it bypasses get_my_org_id() and shows
--  every org. "channel_rows" is what the account filter depends on.)
WITH p AS (
  SELECT bp.organization_id, bp.buyer_id, s.channel_id
  FROM public.buyer_purchases bp
  LEFT JOIN public.streams s ON s.id = bp.stream_id
)
SELECT o.name                                                          AS org,
       count(DISTINCT p.buyer_id)                                      AS buyers_with_purchases,
       count(DISTINCT (p.buyer_id, p.channel_id)) FILTER (WHERE p.channel_id IS NOT NULL) AS channel_rows,
       count(*) FILTER (WHERE p.channel_id IS NULL)                    AS purchases_on_untagged_streams,
       count(*) FILTER (WHERE p.channel_id IS NOT NULL)                AS purchases_on_tagged_streams,
       (SELECT count(*) FROM public.channels c WHERE c.org_id = o.id)  AS accounts
FROM p
JOIN public.organizations o ON o.id = p.organization_id
GROUP BY o.id, o.name
ORDER BY buyers_with_purchases DESC;
