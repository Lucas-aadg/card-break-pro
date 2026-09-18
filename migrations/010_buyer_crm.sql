-- ============================================================
-- 010 — Buyer CRM: data freshness, outreach log, live roster,
--       server-side rollups
-- Run in Supabase: SQL Editor → New Query → paste → Run.
-- Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE everywhere).
-- ============================================================

-- ── 1. Slip tracking on streams (data freshness) ─────────────
-- The whole buyer CRM is only as true as the last packing-slip import.
-- These stamps let every page say "data current through X" and nag the
-- breaker for closed streams that never got their slips uploaded.
ALTER TABLE public.streams ADD COLUMN IF NOT EXISTS slips_imported_at timestamptz;
ALTER TABLE public.streams ADD COLUMN IF NOT EXISTS slips_skipped_at  timestamptz;   -- "no slips for this one" (giveaway-only, test stream…)
ALTER TABLE public.streams ADD COLUMN IF NOT EXISTS slips_skip_reason text;
ALTER TABLE public.streams ADD COLUMN IF NOT EXISTS slips_nag_sent_at timestamptz;   -- cron: one nag per stream

-- Backfill from the import log, then from purchases for imports that predate it.
UPDATE public.streams s
SET slips_imported_at = i.last_import
FROM (
  SELECT stream_id, max(import_date) AS last_import
  FROM public.stream_slip_imports
  WHERE status = 'complete' AND stream_id IS NOT NULL
  GROUP BY stream_id
) i
WHERE i.stream_id = s.id AND s.slips_imported_at IS NULL;

UPDATE public.streams s
SET slips_imported_at = p.last_row
FROM (
  SELECT stream_id, max(created_at) AS last_row
  FROM public.buyer_purchases
  WHERE stream_id IS NOT NULL
  GROUP BY stream_id
) p
WHERE p.stream_id = s.id AND s.slips_imported_at IS NULL;

CREATE INDEX IF NOT EXISTS streams_slips_missing_idx
  ON public.streams(org_id, break_date DESC)
  WHERE status = 'closed' AND slips_imported_at IS NULL AND slips_skipped_at IS NULL;

-- ── 2. Buyers: cold-notification stamp + outreach assignment ──
-- last_cold_alert_at already means "someone reached out" on the board, so the
-- cron gets its own stamp — otherwise a notification would make a buyer look
-- contacted when nobody has talked to them.
ALTER TABLE public.buyers ADD COLUMN IF NOT EXISTS cold_notified_at timestamptz;
ALTER TABLE public.buyers ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS buyers_assigned_idx ON public.buyers(organization_id, assigned_to) WHERE assigned_to IS NOT NULL;

-- ── 3. Org: configurable cold window (pairs with whale_threshold) ──
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS cold_after_days integer NOT NULL DEFAULT 21;

-- ── 4. buyer_touches — the outreach log ──────────────────────
-- One row per time someone reached out to a buyer. Win-back rate = touches on
-- cold buyers that were followed by a purchase within 30 days.
CREATE TABLE IF NOT EXISTS public.buyer_touches (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  buyer_id         uuid        NOT NULL REFERENCES public.buyers(id) ON DELETE CASCADE,
  user_id          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  channel          text        NOT NULL DEFAULT 'whatnot_dm',   -- whatnot_dm | instagram | text | email | call | in_stream | other
  note             text,
  outcome          text,                                        -- NULL | no_reply | replied | returned
  segment_at_touch text,                                        -- cold | fading | whale | regular | new
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bt_org_created_idx ON public.buyer_touches(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bt_buyer_idx       ON public.buyer_touches(buyer_id, created_at DESC);
ALTER TABLE public.buyer_touches ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='buyer_touches' AND policyname='buyer_touches_org_access') THEN
    CREATE POLICY "buyer_touches_org_access" ON public.buyer_touches FOR ALL
      USING      (organization_id IN (SELECT org_id FROM public.profiles WHERE id = auth.uid()))
      WITH CHECK (organization_id IN (SELECT org_id FROM public.profiles WHERE id = auth.uid()));
  END IF;
END $$;

-- ── 5. stream_attendees — the live room roster ───────────────
-- Breakers tap "they're here" during a stream. Feeds the closeout (hit
-- suggestions, "in room but didn't buy") and the post-stream recap.
CREATE TABLE IF NOT EXISTS public.stream_attendees (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stream_id        uuid        NOT NULL REFERENCES public.streams(id) ON DELETE CASCADE,
  buyer_id         uuid        NOT NULL REFERENCES public.buyers(id) ON DELETE CASCADE,
  added_by         uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stream_id, buyer_id)
);
CREATE INDEX IF NOT EXISTS sa_stream_idx ON public.stream_attendees(stream_id);
CREATE INDEX IF NOT EXISTS sa_buyer_idx  ON public.stream_attendees(buyer_id);
CREATE INDEX IF NOT EXISTS sa_org_idx    ON public.stream_attendees(organization_id, created_at DESC);
ALTER TABLE public.stream_attendees ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='stream_attendees' AND policyname='stream_attendees_org_access') THEN
    CREATE POLICY "stream_attendees_org_access" ON public.stream_attendees FOR ALL
      USING      (organization_id IN (SELECT org_id FROM public.profiles WHERE id = auth.uid()))
      WITH CHECK (organization_id IN (SELECT org_id FROM public.profiles WHERE id = auth.uid()));
  END IF;
END $$;

-- ── 6. Rollup functions ──────────────────────────────────────
-- SECURITY DEFINER so a breaker (who can only read their own streams under
-- RLS) still gets org-wide buyer figures — the same numbers the owner sees.
-- Every function is hard-scoped to the caller's org via get_my_org_id(), so
-- there is nothing to pass in and nothing to spoof.

-- 6a. buyer_rollups — per buyer, lifetime (is_total) and per account (channel).
--     Replaces paging every buyer_purchases row to the browser on each board load.
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
    SELECT buyer_id,
           purchase_date - lag(purchase_date) OVER (PARTITION BY buyer_id ORDER BY purchase_date) AS gap
    FROM (SELECT DISTINCT buyer_id, purchase_date FROM p WHERE purchase_date IS NOT NULL) d
  ),
  cadence AS (
    SELECT buyer_id,
           count(*)::bigint AS purchase_days,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY gap::float8))::numeric AS median_gap_days
    FROM days
    GROUP BY buyer_id
  ),
  g AS (
    SELECT buyer_id, channel_id, (grouping(channel_id) = 1) AS is_total,
           coalesce(sum(amount), 0)                                                                            AS spent,
           count(*)::bigint                                                                                    AS breaks,
           count(DISTINCT stream_id)::bigint                                                                   AS streams,
           min(purchase_date)                                                                                  AS first_date,
           max(purchase_date)                                                                                  AS last_date,
           coalesce(sum(amount) FILTER (WHERE purchase_date >= current_date - 30), 0)                          AS recent30,
           coalesce(sum(amount) FILTER (WHERE purchase_date <  current_date - 30
                                          AND purchase_date >= current_date - 60), 0)                          AS prior30,
           coalesce(sum(amount) FILTER (WHERE purchase_date >= current_date - 90), 0)                          AS recent90
    FROM p
    GROUP BY GROUPING SETS ((buyer_id), (buyer_id, channel_id))
  )
  SELECT g.buyer_id, g.channel_id, g.is_total,
         g.spent, g.breaks, g.streams, g.first_date, g.last_date,
         g.recent30, g.prior30, g.recent90,
         CASE WHEN g.is_total THEN c.purchase_days   END,
         CASE WHEN g.is_total THEN c.median_gap_days END
  FROM g
  LEFT JOIN cadence c ON c.buyer_id = g.buyer_id
  WHERE g.is_total OR g.channel_id IS NOT NULL;   -- drop the "untagged-stream" pseudo-channel row
$$;

-- 6b. buyer_stream_facts — one row per (buyer, stream): who bought, from which
--     breaker, on which account, when, how much. Powers breaker attribution,
--     cohorts, whale churn and revenue concentration.
CREATE OR REPLACE FUNCTION public.buyer_stream_facts()
RETURNS TABLE (
  buyer_id      uuid,
  stream_id     uuid,
  breaker_id    uuid,
  channel_id    uuid,
  purchase_date date,
  amount        numeric,
  items         bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT bp.buyer_id, bp.stream_id, s.breaker_id, s.channel_id,
         min(bp.purchase_date), coalesce(sum(bp.amount), 0), count(*)::bigint
  FROM public.buyer_purchases bp
  LEFT JOIN public.streams s ON s.id = bp.stream_id
  WHERE bp.organization_id = public.get_my_org_id()
  GROUP BY bp.buyer_id, bp.stream_id, s.breaker_id, s.channel_id;
$$;

-- 6c. stream_category_mix — what product categories were actually opened in
--     each stream (from breaks.products_used). Combined with buyer_stream_facts
--     this infers what a buyer collects without anyone typing a tag.
CREATE OR REPLACE FUNCTION public.stream_category_mix()
RETURNS TABLE (
  stream_id uuid,
  category  text,
  units     numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.stream_id,
         coalesce(nullif(trim(pr.category), ''), 'Uncategorized') AS category,
         sum(CASE WHEN (e->>'qty') ~ '^[0-9]+(\.[0-9]+)?$' THEN (e->>'qty')::numeric ELSE 0 END) AS units
  FROM public.breaks b
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(b.products_used) = 'array' THEN b.products_used ELSE '[]'::jsonb END
  ) e
  LEFT JOIN public.products pr ON pr.id::text = e->>'product_id'
  WHERE b.org_id = public.get_my_org_id()
  GROUP BY b.stream_id, 2;
$$;

GRANT EXECUTE ON FUNCTION public.buyer_rollups()       TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_stream_facts()  TO authenticated;
GRANT EXECUTE ON FUNCTION public.stream_category_mix() TO authenticated;

-- ── 7. Sanity ────────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM public.streams WHERE status = 'closed' AND slips_imported_at IS NULL AND slips_skipped_at IS NULL) AS closed_streams_missing_slips,
  (SELECT count(*) FROM public.buyer_touches)     AS touches,
  (SELECT count(*) FROM public.stream_attendees)  AS attendees;
