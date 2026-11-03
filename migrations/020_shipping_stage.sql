-- ============================================================
-- 020 — Shipping stage on sort tasks (sort → ship, each with its own person)
-- Run in Supabase: SQL Editor → New Query → paste → Run.
-- Safe to re-run.
--
-- A stream now goes through two jobs: sorting, then shipping. Sorters click
-- Start/Finish Sorting, then anyone (the same sorter or another one) clicks
-- Start/Finish Shipping. The owner sees who sorted and who shipped — e.g.
-- "sorted by Lucas, shipped by Gus" when someone else had to ship it.
--
-- Shipping lives in its own ship_status column so the existing sort `status`
-- values (pending / in_progress / completed) and every report built on them
-- stay exactly as they are.
-- ============================================================

ALTER TABLE public.sort_tasks ADD COLUMN IF NOT EXISTS sort_started_at timestamptz;
ALTER TABLE public.sort_tasks ADD COLUMN IF NOT EXISTS shipper_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.sort_tasks ADD COLUMN IF NOT EXISTS ship_started_at timestamptz;
ALTER TABLE public.sort_tasks ADD COLUMN IF NOT EXISTS shipped_at      timestamptz;

-- Backfill: before this, the sorter's single "Mark Complete" button meant
-- "sorted and shipped". Treat every already-completed task as shipped by the
-- same person, or the whole history would land in the new shipping queue.
-- Runs only on the first run (when ship_status is created) — a re-run must
-- not mark streams that were sorted under the new flow as shipped.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'sort_tasks' AND column_name = 'ship_status') THEN
    ALTER TABLE public.sort_tasks ADD COLUMN ship_status text NOT NULL DEFAULT 'pending';
    UPDATE public.sort_tasks
    SET ship_status = 'shipped',
        shipper_id  = sorter_id,
        shipped_at  = completed_at
    WHERE status = 'completed';
  END IF;
END $$;

ALTER TABLE public.sort_tasks DROP CONSTRAINT IF EXISTS sort_tasks_ship_status_check;
ALTER TABLE public.sort_tasks ADD CONSTRAINT sort_tasks_ship_status_check CHECK (ship_status IN ('pending', 'in_progress', 'shipped'));

CREATE INDEX IF NOT EXISTS sort_tasks_org_ship_idx ON public.sort_tasks(org_id, ship_status);

-- ── Sanity ─────────────────────────────────────────────────────────────────
SELECT ship_status, status, count(*) FROM public.sort_tasks GROUP BY 1, 2 ORDER BY 1, 2;
