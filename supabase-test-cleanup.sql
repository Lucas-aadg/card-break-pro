-- ============================================================
-- CARD BREAK PRO — Test Organization Cleanup
-- STEP 1: Run ONLY the SELECT below. Report the output back.
--         Do NOT run the DELETE block until confirmed.
-- STEP 2: After confirming the org list, run the DELETE block.
-- ============================================================

-- ============================================================
-- STEP 1 — PREVIEW: Which organizations will be deleted?
-- Run this first. Confirm output before proceeding.
-- ============================================================

SELECT
  o.id,
  o.name,
  o.created_at::date AS created,
  COUNT(DISTINCT p.id)  AS team_members,
  COUNT(DISTINCT s.id)  AS streams,
  COUNT(DISTINCT b.id)  AS breaks
FROM organizations o
LEFT JOIN profiles p ON p.org_id = o.id
LEFT JOIN streams s  ON s.org_id  = o.id
LEFT JOIN breaks b   ON b.org_id  = o.id
WHERE o.name NOT IN ('GasPackBreaks', 'Prime Break Co')
GROUP BY o.id, o.name, o.created_at
ORDER BY o.created_at;

-- ============================================================
-- STEP 1b — Safety check: confirm kept orgs still exist
-- ============================================================

SELECT id, name, created_at FROM organizations
WHERE name IN ('GasPackBreaks', 'Prime Break Co');

-- ============================================================
-- STOP HERE. Report the output of both queries above.
-- Only proceed to STEP 2 after explicit confirmation.
-- ============================================================


-- ============================================================
-- STEP 2 — DELETION SCRIPT (run only after confirming Step 1)
-- Deletes all test orgs in foreign-key-safe order.
-- GasPackBreaks and Prime Break Co are never touched.
-- ============================================================

DO $$
DECLARE
  del_ids uuid[];
  del_count int;
BEGIN
  -- Capture IDs to delete (everything except the two kept orgs)
  SELECT ARRAY_AGG(id) INTO del_ids
  FROM organizations
  WHERE name NOT IN ('GasPackBreaks', 'Prime Break Co');

  IF del_ids IS NULL OR array_length(del_ids, 1) IS NULL THEN
    RAISE NOTICE 'No test organizations found. Nothing deleted.';
    RETURN;
  END IF;

  del_count := array_length(del_ids, 1);
  RAISE NOTICE 'Deleting data for % organization(s)...', del_count;

  -- Delete in FK-safe order (most dependent → least dependent)
  DELETE FROM sort_tasks        WHERE org_id = ANY(del_ids);
  DELETE FROM breaks            WHERE org_id = ANY(del_ids);
  DELETE FROM tips              WHERE org_id = ANY(del_ids);
  DELETE FROM streams           WHERE org_id = ANY(del_ids);
  DELETE FROM payroll_runs      WHERE org_id = ANY(del_ids);
  DELETE FROM schedules         WHERE org_id = ANY(del_ids);
  DELETE FROM channel_assignments WHERE org_id = ANY(del_ids);
  DELETE FROM notifications     WHERE org_id = ANY(del_ids);
  DELETE FROM inventory_log     WHERE org_id = ANY(del_ids);
  DELETE FROM products          WHERE org_id = ANY(del_ids);
  DELETE FROM channels          WHERE org_id = ANY(del_ids);
  DELETE FROM invite_codes      WHERE org_id = ANY(del_ids);
  DELETE FROM subscriptions     WHERE org_id = ANY(del_ids);
  DELETE FROM profiles          WHERE org_id = ANY(del_ids);
  DELETE FROM organizations     WHERE id     = ANY(del_ids);

  RAISE NOTICE 'Deletion complete. % organization(s) removed.', del_count;
END $$;

-- ============================================================
-- STEP 3 — POST-DELETION VERIFICATION
-- Run after the DO block to confirm kept orgs are intact.
-- ============================================================

SELECT
  o.name,
  COUNT(DISTINCT p.id)  AS team_members,
  COUNT(DISTINCT s.id)  AS streams,
  COUNT(DISTINCT b.id)  AS breaks
FROM organizations o
LEFT JOIN profiles p ON p.org_id = o.id
LEFT JOIN streams s  ON s.org_id  = o.id
LEFT JOIN breaks b   ON b.org_id  = o.id
WHERE o.name IN ('GasPackBreaks', 'Prime Break Co')
GROUP BY o.name;
