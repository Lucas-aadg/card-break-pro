-- ============================================================
-- CardBreakPro — Buyer Intelligence Schema
-- Run in Supabase SQL Editor
-- ============================================================

-- ── buyers ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.buyers (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  platform                    text        NOT NULL DEFAULT 'whatnot',
  username                    text        NOT NULL,
  real_name                   text,
  last_known_address          text,
  notes                       text,
  first_seen_date             date,
  total_spent                 numeric     NOT NULL DEFAULT 0,
  total_breaks_purchased      integer     NOT NULL DEFAULT 0,
  total_streams_participated  integer     NOT NULL DEFAULT 0,
  last_purchase_date          date,
  temperature                 text        NOT NULL DEFAULT 'cold',
  is_new_buyer                boolean     NOT NULL DEFAULT false,
  last_cold_alert_at          timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, platform, username)
);

CREATE INDEX IF NOT EXISTS buyers_org_idx           ON public.buyers(organization_id);
CREATE INDEX IF NOT EXISTS buyers_total_spent_idx   ON public.buyers(organization_id, total_spent DESC);
CREATE INDEX IF NOT EXISTS buyers_last_purchase_idx ON public.buyers(organization_id, last_purchase_date DESC);

ALTER TABLE public.buyers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "buyers_org_access" ON public.buyers
  FOR ALL USING (
    organization_id IN (
      SELECT org_id FROM public.profiles WHERE id = auth.uid()
    )
  );

-- ── buyer_purchases ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.buyer_purchases (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  buyer_id        uuid        NOT NULL REFERENCES public.buyers(id) ON DELETE CASCADE,
  stream_id       uuid        REFERENCES public.streams(id) ON DELETE SET NULL,
  break_name      text,
  order_number    text,
  amount          numeric     NOT NULL DEFAULT 0,
  purchase_date   date,
  platform        text        NOT NULL DEFAULT 'whatnot',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bp_buyer_idx  ON public.buyer_purchases(buyer_id);
CREATE INDEX IF NOT EXISTS bp_stream_idx ON public.buyer_purchases(stream_id);
CREATE INDEX IF NOT EXISTS bp_org_idx    ON public.buyer_purchases(organization_id);
CREATE INDEX IF NOT EXISTS bp_date_idx   ON public.buyer_purchases(organization_id, purchase_date DESC);

ALTER TABLE public.buyer_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "buyer_purchases_org_access" ON public.buyer_purchases
  FOR ALL USING (
    organization_id IN (
      SELECT org_id FROM public.profiles WHERE id = auth.uid()
    )
  );

-- ── buyer_hits ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.buyer_hits (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  buyer_id        uuid        NOT NULL REFERENCES public.buyers(id) ON DELETE CASCADE,
  stream_id       uuid        REFERENCES public.streams(id) ON DELETE SET NULL,
  break_name      text,
  hit_description text        NOT NULL,
  hit_type        text        NOT NULL DEFAULT 'other',
  submitted_by    uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  submitted_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bh_buyer_idx ON public.buyer_hits(buyer_id);
CREATE INDEX IF NOT EXISTS bh_org_idx   ON public.buyer_hits(organization_id);

ALTER TABLE public.buyer_hits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "buyer_hits_org_access" ON public.buyer_hits
  FOR ALL USING (
    organization_id IN (
      SELECT org_id FROM public.profiles WHERE id = auth.uid()
    )
  );

-- ── stream_slip_imports ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stream_slip_imports (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stream_id            uuid        REFERENCES public.streams(id) ON DELETE SET NULL,
  imported_by          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  import_date          timestamptz NOT NULL DEFAULT now(),
  buyers_found         integer     NOT NULL DEFAULT 0,
  new_buyers_found     integer     NOT NULL DEFAULT 0,
  total_revenue_parsed numeric     NOT NULL DEFAULT 0,
  raw_filename         text,
  status               text        NOT NULL DEFAULT 'pending',
  error_message        text
);

CREATE INDEX IF NOT EXISTS ssi_org_idx    ON public.stream_slip_imports(organization_id);
CREATE INDEX IF NOT EXISTS ssi_stream_idx ON public.stream_slip_imports(stream_id);

ALTER TABLE public.stream_slip_imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "slip_imports_org_access" ON public.stream_slip_imports
  FOR ALL USING (
    organization_id IN (
      SELECT org_id FROM public.profiles WHERE id = auth.uid()
    )
  );
