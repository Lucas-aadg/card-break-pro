-- ============================================================
-- 014 — Inventory audit trail + slip import history
-- Run in Supabase: SQL Editor → New Query → paste → Run.
-- Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE everywhere).
-- Requires 013 (adjust_stock, get_my_org_id).
-- ============================================================

-- ── 1. adjust_stock: optional batch unit cost for the log line ─────────────
-- Restocks are bought at a batch price; the log used to record the product's
-- current unit cost instead, which made the Inventory Cost export misstate
-- purchases. The 4-arg signature is dropped and replaced by a 5-arg one with a
-- default, so every existing caller keeps working unchanged.
DROP FUNCTION IF EXISTS public.adjust_stock(uuid, integer, text, text);
CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_product_id uuid,
  p_delta      integer,
  p_action     text    DEFAULT 'used',
  p_notes      text    DEFAULT NULL,
  p_unit_cost  numeric DEFAULT NULL
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
    VALUES (v_org, p_product_id, v_name, coalesce(p_action, 'used'), abs(p_delta), coalesce(p_unit_cost, v_cost), p_notes);
  END IF;
  RETURN v_stock;
END;
$$;
GRANT EXECUTE ON FUNCTION public.adjust_stock(uuid, integer, text, text, numeric) TO authenticated;

-- ── 2. Stock reconciliation: system count vs. what the log says ────────────
-- Sign convention for inventory_log.quantity (always stored positive):
--   +  initial, restock, restored, adjust_in
--   −  used, adjust_out
-- drift = current_stock − log_balance. Non-zero drift means a stock change
-- happened without a log line (or a log line was deleted) — the Stock Audit
-- panel in the owner dashboard shows this per product.
CREATE OR REPLACE FUNCTION public.inventory_reconciliation(p_channel uuid DEFAULT NULL)
RETURNS TABLE (
  product_id     uuid,
  name           text,
  category       text,
  channel_id     uuid,
  active         boolean,
  current_stock  integer,
  unit_cost      numeric,
  log_balance    bigint,
  log_rows       bigint,
  first_movement timestamptz,
  last_movement  timestamptz
)
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.name, p.category, p.channel_id, p.active, p.current_stock, p.unit_cost,
         coalesce(sum(CASE WHEN l.action IN ('used', 'adjust_out') THEN -l.quantity ELSE l.quantity END), 0)::bigint AS log_balance,
         count(l.id)::bigint AS log_rows,
         min(l.created_at)   AS first_movement,
         max(l.created_at)   AS last_movement
    FROM public.products p
    LEFT JOIN public.inventory_log l ON l.product_id = p.id AND l.org_id = p.org_id
   WHERE p.org_id = public.get_my_org_id()
     AND (p_channel IS NULL OR p.channel_id = p_channel)
   GROUP BY p.id
   ORDER BY p.display_order, p.name;
$$;
GRANT EXECUTE ON FUNCTION public.inventory_reconciliation(uuid) TO authenticated;

CREATE INDEX IF NOT EXISTS inventory_log_product_time_idx
  ON public.inventory_log (org_id, product_id, created_at DESC);

-- ── 3. Slip import history: every attempt is recorded, including failures ──
-- Imports used to delete the previous record for a stream and only ever wrote
-- status='complete'; a failed 150-slip import left no trace. Rows are now
-- appended (one per attempt) with the outcome.
ALTER TABLE public.stream_slip_imports ADD COLUMN IF NOT EXISTS error_message   text;
ALTER TABLE public.stream_slip_imports ADD COLUMN IF NOT EXISTS mode            text;      -- 'merge' | 'replace'
ALTER TABLE public.stream_slip_imports ADD COLUMN IF NOT EXISTS purchases_count integer;   -- rows written this attempt
ALTER TABLE public.stream_slip_imports ADD COLUMN IF NOT EXISTS orders_replaced integer;   -- same order numbers re-imported
ALTER TABLE public.stream_slip_imports ADD COLUMN IF NOT EXISTS parse_source    text;      -- 'browser' | 'server'
ALTER TABLE public.stream_slip_imports ADD COLUMN IF NOT EXISTS file_size       integer;

CREATE INDEX IF NOT EXISTS ssi_stream_time_idx ON public.stream_slip_imports (stream_id, import_date DESC);

-- Merge-mode imports de-dupe on order number within a stream.
CREATE INDEX IF NOT EXISTS buyer_purchases_stream_order_idx
  ON public.buyer_purchases (stream_id, order_number);

-- ── Sanity ─────────────────────────────────────────────────────────────────
SELECT 'ok' AS status,
       (SELECT count(*) FROM pg_proc WHERE proname = 'inventory_reconciliation') AS reconciliation_fn,
       (SELECT count(*) FROM pg_proc WHERE proname = 'adjust_stock') AS adjust_stock_fn,
       (SELECT count(*) FROM information_schema.columns WHERE table_name = 'stream_slip_imports' AND column_name = 'mode') AS slip_mode_col;
