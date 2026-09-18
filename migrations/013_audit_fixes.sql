-- ============================================================
-- 013 — Audit fixes: atomic stock, server-side totals, org timezone,
--       indexes, notification de-dupe
-- Pairs with AUDIT.md (BL-9/10/11/12/17, AB-8, SC-2/5/6/7).
-- Run in Supabase: SQL Editor → New Query → paste → Run. Safe to re-run.
-- ============================================================

-- ── 1. Org timezone (BL-6 / BL-13 / BL-14 / BL-19) ────────────
-- Every "today", period edge and shift time is interpreted in this zone.
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/New_York';

-- ── 2. Notification de-dupe key (AB-8) ────────────────────────
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS ref_id text;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON public.notifications(user_id, is_read, created_at DESC);
  CREATE INDEX IF NOT EXISTS notifications_org_type_ref_idx ON public.notifications(organization_id, type, ref_id, created_at DESC);
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END $$;

-- ── 3. Atomic stock adjustment (BL-9 / BL-10) ─────────────────
-- Replaces every "read stock → subtract in JS → write" path. Stock may go
-- negative on purpose: a clamp at zero hid over-use and desynced the log.
CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_product_id uuid,
  p_delta      integer,
  p_action     text DEFAULT 'used',
  p_notes      text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org   uuid := public.get_my_org_id();
  v_stock integer;
  v_name  text;
  v_cost  numeric;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  UPDATE public.products
     SET current_stock = current_stock + p_delta
   WHERE id = p_product_id AND org_id = v_org
  RETURNING current_stock, name, unit_cost INTO v_stock, v_name, v_cost;
  IF NOT FOUND THEN RAISE EXCEPTION 'product not found in your organization'; END IF;
  IF p_delta <> 0 THEN
    INSERT INTO public.inventory_log (org_id, product_id, product_name, action, quantity, unit_cost, notes)
    VALUES (v_org, p_product_id, v_name, coalesce(p_action, 'used'), abs(p_delta), v_cost, p_notes);
  END IF;
  RETURN v_stock;
END;
$$;
GRANT EXECUTE ON FUNCTION public.adjust_stock(uuid, integer, text, text) TO authenticated;

-- Service-role variant (stream delete restores stock without a user session).
CREATE OR REPLACE FUNCTION public.adjust_stock_admin(
  p_org        uuid,
  p_product_id uuid,
  p_delta      integer,
  p_action     text DEFAULT 'restored',
  p_notes      text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_stock integer; v_name text; v_cost numeric;
BEGIN
  UPDATE public.products SET current_stock = current_stock + p_delta
   WHERE id = p_product_id AND org_id = p_org
  RETURNING current_stock, name, unit_cost INTO v_stock, v_name, v_cost;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_delta <> 0 THEN
    INSERT INTO public.inventory_log (org_id, product_id, product_name, action, quantity, unit_cost, notes)
    VALUES (p_org, p_product_id, v_name, coalesce(p_action, 'restored'), abs(p_delta), v_cost, p_notes);
  END IF;
  RETURN v_stock;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.adjust_stock_admin(uuid, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.adjust_stock_admin(uuid, uuid, integer, text, text) TO service_role;

-- ── 4. Stream totals from breaks, not a running sum (BL-11) ───
CREATE OR REPLACE FUNCTION public.recompute_stream_totals(p_stream_id uuid)
RETURNS TABLE (total_submitted_revenue numeric, total_product_cost numeric, total_fees numeric, total_other_costs numeric, break_count integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_org uuid := public.get_my_org_id();
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  RETURN QUERY
  UPDATE public.streams s
     SET total_submitted_revenue = a.rev,
         total_product_cost      = a.cost,
         total_fees              = a.fees,
         total_other_costs       = a.other,
         break_count             = a.cnt
    FROM (
      SELECT coalesce(sum(b.revenue), 0)             AS rev,
             coalesce(sum(b.total_product_cost), 0)  AS cost,
             coalesce(sum(b.estimated_fees), 0)      AS fees,
             coalesce(sum(b.other_costs), 0)         AS other,
             count(*)::integer                       AS cnt
        FROM public.breaks b
       WHERE b.stream_id = p_stream_id AND b.org_id = v_org
    ) a
   WHERE s.id = p_stream_id AND s.org_id = v_org
  RETURNING s.total_submitted_revenue, s.total_product_cost, s.total_fees, s.total_other_costs, s.break_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.recompute_stream_totals(uuid) TO authenticated;

-- ── 5. Buyer totals recompute in one statement (SC-7) ─────────
CREATE OR REPLACE FUNCTION public.recompute_buyer_totals(p_org uuid, p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  WITH agg AS (
    SELECT b.id AS buyer_id,
           coalesce(sum(p.amount), 0)              AS spent,
           count(p.id)::integer                    AS breaks,
           count(DISTINCT p.stream_id)::integer    AS streams,
           max(p.purchase_date)                    AS last_date
      FROM public.buyers b
      LEFT JOIN public.buyer_purchases p ON p.buyer_id = b.id
     WHERE b.organization_id = p_org AND b.id = ANY(p_ids)
     GROUP BY b.id
  )
  UPDATE public.buyers b
     SET total_spent                = round(agg.spent, 2),
         total_breaks_purchased     = agg.breaks,
         total_streams_participated = agg.streams,
         last_purchase_date         = agg.last_date,
         temperature                = CASE WHEN agg.last_date IS NULL THEN 'cold'
                                           WHEN agg.last_date >= current_date - 7  THEN 'hot'
                                           WHEN agg.last_date >= current_date - 20 THEN 'warm'
                                           ELSE 'cold' END,
         is_new_buyer               = CASE WHEN agg.breaks > 0 THEN false ELSE b.is_new_buyer END,
         updated_at                 = now()
    FROM agg
   WHERE b.id = agg.buyer_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.recompute_buyer_totals(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.recompute_buyer_totals(uuid, uuid[]) TO service_role;

-- ── 6. Leaderboard ranks in one statement (BL-17) ─────────────
CREATE OR REPLACE FUNCTION public.recalc_leaderboard_ranks(p_org uuid, p_year integer, p_month integer, p_category text)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.leaderboard_snapshots s
     SET rank = r.rn
    FROM (
      SELECT id, row_number() OVER (ORDER BY value DESC, staff_id) AS rn
        FROM public.leaderboard_snapshots
       WHERE org_id = p_org AND period_year = p_year AND period_month = p_month AND category = p_category
    ) r
   WHERE s.id = r.id;
$$;
REVOKE EXECUTE ON FUNCTION public.recalc_leaderboard_ranks(uuid, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.recalc_leaderboard_ranks(uuid, integer, integer, text) TO service_role;

-- ── 7. Account scope helper (SC-2) ────────────────────────────
-- Same rule the owner app used client-side: a stream belongs to an account
-- if it's tagged to it, or it's untagged and its breaker is assigned to it.
CREATE OR REPLACE FUNCTION public.channel_stream_ids(p_channel uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id
    FROM public.streams s
   WHERE s.org_id = public.get_my_org_id()
     AND (
       s.channel_id = p_channel
       OR (s.channel_id IS NULL AND s.breaker_id IN (
            SELECT ca.profile_id FROM public.channel_assignments ca WHERE ca.channel_id = p_channel
          ))
     );
$$;
GRANT EXECUTE ON FUNCTION public.channel_stream_ids(uuid) TO authenticated;

-- ── 8. Server-side aggregates (AB-1 / SC-6) ───────────────────
-- 8a. Dashboard totals — replaces two full-table pulls of breaks + streams.
CREATE OR REPLACE FUNCTION public.org_dashboard_totals(p_channel uuid DEFAULT NULL, p_today date DEFAULT current_date)
RETURNS TABLE (
  today_revenue numeric, today_breaks integer, today_profit numeric,
  total_revenue numeric, total_breaks integer, total_streams integer, total_profit numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH org AS (SELECT public.get_my_org_id() AS id),
  scope AS (
    SELECT s.id, s.status, s.break_date, s.net_profit, s.commission_payout, s.final_sales, s.total_product_cost, s.total_other_costs
      FROM public.streams s, org
     WHERE s.org_id = org.id
       AND (p_channel IS NULL OR s.id IN (SELECT public.channel_stream_ids(p_channel)))
  ),
  b AS (
    SELECT br.revenue, br.net_profit, br.break_date, br.stream_id, sc.status AS stream_status
      FROM public.breaks br
      JOIN org ON br.org_id = org.id
      LEFT JOIN scope sc ON sc.id = br.stream_id
     WHERE p_channel IS NULL OR sc.id IS NOT NULL
  ),
  closed AS (
    SELECT sc.break_date,
           coalesce(sc.net_profit, coalesce(sc.final_sales,0) - coalesce(sc.total_product_cost,0) - coalesce(sc.total_other_costs,0))
             - coalesce(sc.commission_payout, 0) AS profit
      FROM scope sc WHERE sc.status = 'closed'
  )
  SELECT
    coalesce((SELECT sum(revenue) FROM b WHERE break_date = p_today), 0),
    coalesce((SELECT count(*)::integer FROM b WHERE break_date = p_today), 0),
    coalesce((SELECT sum(profit) FROM closed WHERE break_date = p_today), 0)
      + coalesce((SELECT sum(net_profit) FROM b WHERE break_date = p_today AND coalesce(stream_status,'active') <> 'closed'), 0),
    coalesce((SELECT sum(revenue) FROM b), 0),
    coalesce((SELECT count(*)::integer FROM b), 0),
    coalesce((SELECT count(*)::integer FROM scope), 0),
    coalesce((SELECT sum(profit) FROM closed), 0)
      + coalesce((SELECT sum(net_profit) FROM b WHERE coalesce(stream_status,'active') <> 'closed'), 0);
$$;
GRANT EXECUTE ON FUNCTION public.org_dashboard_totals(uuid, date) TO authenticated;

-- 8b. Breaker performance — one row per breaker.
CREATE OR REPLACE FUNCTION public.breaker_performance(p_channel uuid DEFAULT NULL)
RETURNS TABLE (breaker_id uuid, break_count integer, stream_count integer, total_revenue numeric, total_profit numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT br.breaker_id,
         count(*)::integer,
         count(DISTINCT br.stream_id)::integer,
         coalesce(sum(br.revenue), 0),
         coalesce(sum(br.net_profit), 0)
    FROM public.breaks br
   WHERE br.org_id = public.get_my_org_id()
     AND br.breaker_id IS NOT NULL
     AND (p_channel IS NULL OR br.stream_id IN (SELECT public.channel_stream_ids(p_channel)))
   GROUP BY br.breaker_id;
$$;
GRANT EXECUTE ON FUNCTION public.breaker_performance(uuid) TO authenticated;

-- 8c. Product ROI — revenue attributed per unit share within each break.
CREATE OR REPLACE FUNCTION public.product_roi(p_channel uuid DEFAULT NULL)
RETURNS TABLE (product_key text, name text, times_used integer, total_units numeric, total_cost numeric, total_revenue numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH e AS (
    SELECT br.id AS break_id, br.revenue,
           coalesce(nullif(x->>'product_id',''), x->>'name')                                    AS product_key,
           x->>'name'                                                                              AS pname,
           CASE WHEN (x->>'qty') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (x->>'qty')::numeric ELSE 0 END      AS qty,
           CASE WHEN (x->>'ext_cost') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (x->>'ext_cost')::numeric ELSE 0 END AS ext
      FROM public.breaks br
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(br.products_used) = 'array' THEN br.products_used ELSE '[]'::jsonb END) x
     WHERE br.org_id = public.get_my_org_id()
       AND (p_channel IS NULL OR br.stream_id IN (SELECT public.channel_stream_ids(p_channel)))
  ),
  t AS (SELECT break_id, sum(qty) AS tq FROM e GROUP BY break_id)
  SELECT e.product_key,
         max(e.pname),
         count(*)::integer,
         coalesce(sum(e.qty), 0),
         coalesce(sum(e.ext), 0),
         coalesce(sum(CASE WHEN t.tq > 0 THEN coalesce(e.revenue,0) * e.qty / t.tq ELSE 0 END), 0)
    FROM e JOIN t USING (break_id)
   WHERE e.product_key IS NOT NULL
   GROUP BY e.product_key;
$$;
GRANT EXECUTE ON FUNCTION public.product_roi(uuid) TO authenticated;

-- ── 9. Indexes on the hot filters (SC-5) ──────────────────────
-- Tables not defined in this repo (schedules, sort_tasks, tips) are wrapped
-- so a missing column just skips that index instead of aborting the file.
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS streams_org_status_date_idx     ON public.streams(org_id, status, break_date DESC);
  CREATE INDEX IF NOT EXISTS streams_breaker_status_date_idx ON public.streams(breaker_id, status, break_date DESC);
  CREATE INDEX IF NOT EXISTS streams_org_channel_idx         ON public.streams(org_id, channel_id);
  CREATE INDEX IF NOT EXISTS breaks_org_date_idx             ON public.breaks(org_id, break_date DESC);
  CREATE INDEX IF NOT EXISTS breaks_breaker_date_idx         ON public.breaks(breaker_id, break_date DESC);
  CREATE INDEX IF NOT EXISTS buyer_purchases_org_date_idx    ON public.buyer_purchases(organization_id, purchase_date DESC);
EXCEPTION WHEN undefined_column OR undefined_table THEN RAISE NOTICE 'skipped a core index: %', SQLERRM; END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS schedules_org_date_idx      ON public.schedules(org_id, scheduled_date);
  CREATE INDEX IF NOT EXISTS schedules_breaker_clock_idx ON public.schedules(breaker_id, clocked_in_at);
  CREATE INDEX IF NOT EXISTS schedules_sorter_clock_idx  ON public.schedules(sorter_id, clocked_in_at);
EXCEPTION WHEN undefined_column OR undefined_table THEN RAISE NOTICE 'skipped schedules index: %', SQLERRM; END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS sort_tasks_org_status_idx ON public.sort_tasks(org_id, status, created_at);
EXCEPTION WHEN undefined_column OR undefined_table THEN RAISE NOTICE 'skipped sort_tasks index: %', SQLERRM; END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS tips_breaker_created_idx ON public.tips(breaker_id, created_at);
EXCEPTION WHEN undefined_column OR undefined_table THEN RAISE NOTICE 'skipped tips index: %', SQLERRM; END $$;

-- ── 10. No duplicate shifts (BL-12) ───────────────────────────
-- Best-effort: if duplicates already exist the index can't be created; the
-- app now also checks before inserting, so this is belt-and-braces.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS schedules_no_dupe_idx
    ON public.schedules (org_id, coalesce(breaker_id, sorter_id), scheduled_date, coalesce(scheduled_time, '00:00'::time))
    WHERE status <> 'cancelled';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'schedules has existing duplicate shifts — clean them up, then re-run this block';
          WHEN undefined_column OR undefined_table THEN RAISE NOTICE 'skipped schedules unique index: %', SQLERRM; END $$;

-- ── 11. Sorter splits are retired (sorters are hourly) ────────
-- Table kept for history; no code path reads or writes it any more.
COMMENT ON TABLE public.sorter_splits IS 'DEPRECATED 2026-09: sorters are paid hourly; split feature removed from the app.';

-- ── 12. Sanity ────────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM pg_proc WHERE proname IN ('adjust_stock','recompute_stream_totals','recompute_buyer_totals','org_dashboard_totals','breaker_performance','product_roi','channel_stream_ids','recalc_leaderboard_ranks')) AS functions_installed,
  (SELECT count(*) FROM public.breaks) AS total_breaks_all_orgs,
  (SELECT max(c) FROM (SELECT count(*) c FROM public.breaks GROUP BY org_id) x) AS largest_org_breaks;
