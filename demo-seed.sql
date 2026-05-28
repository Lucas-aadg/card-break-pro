-- ============================================================
-- CARD BREAK PRO — DEMO ACCOUNT SEED
-- Paste entire file into Supabase → SQL Editor → Run
-- ============================================================

DO $$
DECLARE
  v_owner_id  uuid := 'de000000-0000-4000-8000-000000000001';
  v_victor_id uuid := 'de000000-0000-4000-8000-000000000002';
  v_marcus_id uuid := 'de000000-0000-4000-8000-000000000003';
  v_kevin_id  uuid := 'de000000-0000-4000-8000-000000000004';
  v_jay_id    uuid := 'de000000-0000-4000-8000-000000000005';
  v_maximo_id uuid := 'de000000-0000-4000-8000-000000000006';
  v_org_id    uuid := 'de000000-0000-4000-8000-000000000010';
  v_p_chrome  uuid := 'de000000-0000-4000-8000-000000000020';
  v_p_prizm   uuid := 'de000000-0000-4000-8000-000000000021';
  v_p_optic   uuid := 'de000000-0000-4000-8000-000000000022';
  v_p_donruss uuid := 'de000000-0000-4000-8000-000000000023';
  v_p_bowman  uuid := 'de000000-0000-4000-8000-000000000024';
  v_s1 uuid := 'de000000-0000-4000-8000-000000000030';
  v_s2 uuid := 'de000000-0000-4000-8000-000000000031';
  v_s3 uuid := 'de000000-0000-4000-8000-000000000032';
  v_s4 uuid := 'de000000-0000-4000-8000-000000000033';
  v_s5 uuid := 'de000000-0000-4000-8000-000000000034';
  v_s6 uuid := 'de000000-0000-4000-8000-000000000035';
BEGIN

-- ── AUTH USERS ────────────────────────────────────────────
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at)
VALUES
  (v_owner_id,  '00000000-0000-0000-0000-000000000000','authenticated','authenticated','testdemo@gmail.com',        crypt('Testdemorun1', gen_salt('bf')), now(),'{"provider":"email","providers":["email"]}','{}',false,now(),now()),
  (v_victor_id, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','victor@primebreakco.com',   crypt('Demo1234!',    gen_salt('bf')), now(),'{"provider":"email","providers":["email"]}','{}',false,now(),now()),
  (v_marcus_id, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','marcus@primebreakco.com',   crypt('Demo1234!',    gen_salt('bf')), now(),'{"provider":"email","providers":["email"]}','{}',false,now(),now()),
  (v_kevin_id,  '00000000-0000-0000-0000-000000000000','authenticated','authenticated','kevin@primebreakco.com',    crypt('Demo1234!',    gen_salt('bf')), now(),'{"provider":"email","providers":["email"]}','{}',false,now(),now()),
  (v_jay_id,    '00000000-0000-0000-0000-000000000000','authenticated','authenticated','jay@primebreakco.com',      crypt('Demo1234!',    gen_salt('bf')), now(),'{"provider":"email","providers":["email"]}','{}',false,now(),now()),
  (v_maximo_id, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','maximo@primebreakco.com',   crypt('Demo1234!',    gen_salt('bf')), now(),'{"provider":"email","providers":["email"]}','{}',false,now(),now());

-- ── ORGANIZATION ─────────────────────────────────────────
INSERT INTO organizations (id, name, owner_id, created_at)
VALUES (v_org_id, 'Prime Break Co', v_owner_id, now());

-- ── SUBSCRIPTION (comped — no Stripe needed) ─────────────
INSERT INTO subscriptions (id, org_id, user_id, status, comped, created_at, updated_at)
VALUES (gen_random_uuid(), v_org_id, v_owner_id, 'active', true, now(), now());

-- ── PROFILES ─────────────────────────────────────────────
INSERT INTO profiles (id, org_id, role, display_name, created_at)
VALUES
  (v_owner_id,  v_org_id, 'owner',   'Alex Rivera',    now()),
  (v_victor_id, v_org_id, 'breaker', 'Victor Reyes',   now()),
  (v_marcus_id, v_org_id, 'breaker', 'Marcus Johnson', now()),
  (v_kevin_id,  v_org_id, 'breaker', 'Kevin Torres',   now()),
  (v_jay_id,    v_org_id, 'sorter',  'Jay Williams',   now()),
  (v_maximo_id, v_org_id, 'sorter',  'Maximo Cruz',    now());

UPDATE profiles SET pay_type = 'commission', commission_rate = 8    WHERE id IN (v_victor_id, v_marcus_id, v_kevin_id);
UPDATE profiles SET pay_type = 'per_break',  per_break_rate  = 2.50 WHERE id IN (v_jay_id, v_maximo_id);

-- ── INVITE CODE ──────────────────────────────────────────
INSERT INTO invite_codes (id, org_id, code, used, created_at)
VALUES (gen_random_uuid(), v_org_id, 'PRIMEDEMO', false, now());

-- ── PRODUCTS ─────────────────────────────────────────────
INSERT INTO products (id, org_id, name, category, unit_cost, current_stock, min_stock_alert, active, display_order, created_at)
VALUES
  (v_p_chrome,  v_org_id, '2025 Topps Chrome Football Hobby',   'Football', 185.00,  1, 5,  true, 1, now()),
  (v_p_prizm,   v_org_id, '2025 Panini Prizm Football Hobby',   'Football', 225.00,  0, 5,  true, 2, now()),
  (v_p_optic,   v_org_id, '2025 Panini Optic Football Hobby',   'Football', 165.00, 15, 5,  true, 3, now()),
  (v_p_donruss, v_org_id, '2025 Panini Donruss Football Hobby', 'Football',  98.00, 23, 10, true, 4, now()),
  (v_p_bowman,  v_org_id, '2025 Bowman University Football',    'Football', 142.00, 12, 5,  true, 5, now());

-- ── INVENTORY LOG ─────────────────────────────────────────
INSERT INTO inventory_log (id, org_id, product_id, product_name, action, quantity, unit_cost, notes, created_at)
VALUES
  (gen_random_uuid(), v_org_id, v_p_chrome,  '2025 Topps Chrome Football Hobby',   'initial',  36, 185.00, 'Initial stock', now() - interval '9 days'),
  (gen_random_uuid(), v_org_id, v_p_prizm,   '2025 Panini Prizm Football Hobby',   'initial',  24, 225.00, 'Initial stock', now() - interval '9 days'),
  (gen_random_uuid(), v_org_id, v_p_optic,   '2025 Panini Optic Football Hobby',   'initial',  45, 165.00, 'Initial stock', now() - interval '9 days'),
  (gen_random_uuid(), v_org_id, v_p_donruss, '2025 Panini Donruss Football Hobby', 'initial',  48,  98.00, 'Initial stock', now() - interval '9 days'),
  (gen_random_uuid(), v_org_id, v_p_bowman,  '2025 Bowman University Football',    'initial',  20, 142.00, 'Initial stock', now() - interval '9 days'),
  (gen_random_uuid(), v_org_id, v_p_chrome,  '2025 Topps Chrome Football Hobby',   'used', 12, 185.00, 'Used in VIC 5-12-26',  '2026-05-12 18:00:00+00'),
  (gen_random_uuid(), v_org_id, v_p_prizm,   '2025 Panini Prizm Football Hobby',   'used', 10, 225.00, 'Used in MARC 5-13-26', '2026-05-13 18:30:00+00'),
  (gen_random_uuid(), v_org_id, v_p_optic,   '2025 Panini Optic Football Hobby',   'used', 15, 165.00, 'Used in KEV 5-14-26',  '2026-05-14 17:45:00+00'),
  (gen_random_uuid(), v_org_id, v_p_chrome,  '2025 Topps Chrome Football Hobby',   'used', 11, 185.00, 'Used in VIC 5-15-26',  '2026-05-15 18:15:00+00'),
  (gen_random_uuid(), v_org_id, v_p_donruss, '2025 Panini Donruss Football Hobby', 'used', 13,  98.00, 'Used in MARC 5-16-26', '2026-05-16 18:00:00+00'),
  (gen_random_uuid(), v_org_id, v_p_prizm,   '2025 Panini Prizm Football Hobby',   'used',  8, 225.00, 'Used in KEV 5-17-26',  '2026-05-17 18:00:00+00');

-- ── STREAM 1 — VIC 5-12-26 (Victor · Chrome · 12 breaks · CLOSED) ──
INSERT INTO streams (id, org_id, breaker_id, stream_key, break_date, status, total_submitted_revenue, final_sales, total_product_cost, total_fees, total_other_costs, net_profit, break_count, commission_payout, closed_at, created_at)
VALUES (v_s1, v_org_id, v_victor_id, 'VIC 5-12-26', '2026-05-12', 'closed', 2567.00, 2331.00, 2220.00, 236.00, 0, 111.00, 12, 8.88, '2026-05-12 22:45:00+00', '2026-05-12 18:00:00+00');

INSERT INTO breaks (id, org_id, stream_id, breaker_id, break_number, break_date, revenue, total_product_cost, estimated_fees, net_profit, fee_rate, spots, total_units_used, products_used, created_at) VALUES
  (gen_random_uuid(),v_org_id,v_s1,v_victor_id, 1,'2026-05-12',215.00,185.00,19.78, 10.22,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-12 18:15:00+00'),
  (gen_random_uuid(),v_org_id,v_s1,v_victor_id, 2,'2026-05-12',198.00,185.00,18.22, -5.22,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-12 18:32:00+00'),
  (gen_random_uuid(),v_org_id,v_s1,v_victor_id, 3,'2026-05-12',225.00,185.00,20.70, 19.30,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-12 18:48:00+00'),
  (gen_random_uuid(),v_org_id,v_s1,v_victor_id, 4,'2026-05-12',189.00,185.00,17.39,-13.39,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-12 19:05:00+00'),
  (gen_random_uuid(),v_org_id,v_s1,v_victor_id, 5,'2026-05-12',234.00,185.00,21.53, 27.47,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-12 19:22:00+00'),
  (gen_random_uuid(),v_org_id,v_s1,v_victor_id, 6,'2026-05-12',212.00,185.00,19.50,  7.50,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-12 19:38:00+00'),
  (gen_random_uuid(),v_org_id,v_s1,v_victor_id, 7,'2026-05-12',198.00,185.00,18.22, -5.22,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-12 19:55:00+00'),
  (gen_random_uuid(),v_org_id,v_s1,v_victor_id, 8,'2026-05-12',245.00,185.00,22.54, 37.46,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-12 20:12:00+00'),
  (gen_random_uuid(),v_org_id,v_s1,v_victor_id, 9,'2026-05-12',221.00,185.00,20.33, 15.67,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-12 20:29:00+00'),
  (gen_random_uuid(),v_org_id,v_s1,v_victor_id,10,'2026-05-12',210.00,185.00,19.32,  5.68,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-12 20:46:00+00'),
  (gen_random_uuid(),v_org_id,v_s1,v_victor_id,11,'2026-05-12',195.00,185.00,17.94, -7.94,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-12 21:03:00+00'),
  (gen_random_uuid(),v_org_id,v_s1,v_victor_id,12,'2026-05-12',225.00,185.00,20.70, 19.30,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-12 21:20:00+00');

-- ── STREAM 2 — MARC 5-13-26 (Marcus · Prizm · 10 breaks · CLOSED) ──
INSERT INTO streams (id, org_id, breaker_id, stream_key, break_date, status, total_submitted_revenue, final_sales, total_product_cost, total_fees, total_other_costs, net_profit, break_count, commission_payout, closed_at, created_at)
VALUES (v_s2, v_org_id, v_marcus_id, 'MARC 5-13-26', '2026-05-13', 'closed', 2890.00, 2628.00, 2250.00, 262.00, 0, 378.00, 10, 30.24, '2026-05-13 23:00:00+00', '2026-05-13 18:30:00+00');

INSERT INTO breaks (id, org_id, stream_id, breaker_id, break_number, break_date, revenue, total_product_cost, estimated_fees, net_profit, fee_rate, spots, total_units_used, products_used, created_at) VALUES
  (gen_random_uuid(),v_org_id,v_s2,v_marcus_id, 1,'2026-05-13',289.00,225.00,26.59,37.41,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-13 18:45:00+00'),
  (gen_random_uuid(),v_org_id,v_s2,v_marcus_id, 2,'2026-05-13',312.00,225.00,28.70,58.30,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-13 19:02:00+00'),
  (gen_random_uuid(),v_org_id,v_s2,v_marcus_id, 3,'2026-05-13',245.00,225.00,22.54,-2.54,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-13 19:19:00+00'),
  (gen_random_uuid(),v_org_id,v_s2,v_marcus_id, 4,'2026-05-13',298.00,225.00,27.42,45.58,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-13 19:36:00+00'),
  (gen_random_uuid(),v_org_id,v_s2,v_marcus_id, 5,'2026-05-13',265.00,225.00,24.38,15.62,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-13 19:53:00+00'),
  (gen_random_uuid(),v_org_id,v_s2,v_marcus_id, 6,'2026-05-13',278.00,225.00,25.58,27.42,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-13 20:10:00+00'),
  (gen_random_uuid(),v_org_id,v_s2,v_marcus_id, 7,'2026-05-13',334.00,225.00,30.73,78.27,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-13 20:27:00+00'),
  (gen_random_uuid(),v_org_id,v_s2,v_marcus_id, 8,'2026-05-13',289.00,225.00,26.59,37.41,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-13 20:44:00+00'),
  (gen_random_uuid(),v_org_id,v_s2,v_marcus_id, 9,'2026-05-13',265.00,225.00,24.38,15.62,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-13 21:01:00+00'),
  (gen_random_uuid(),v_org_id,v_s2,v_marcus_id,10,'2026-05-13',315.00,225.00,28.98,61.02,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-13 21:18:00+00');

-- ── STREAM 3 — KEV 5-14-26 (Kevin · Optic · 15 breaks · CLOSED) ──
INSERT INTO streams (id, org_id, breaker_id, stream_key, break_date, status, total_submitted_revenue, final_sales, total_product_cost, total_fees, total_other_costs, net_profit, break_count, commission_payout, closed_at, created_at)
VALUES (v_s3, v_org_id, v_kevin_id, 'KEV 5-14-26', '2026-05-14', 'closed', 3245.00, 2951.00, 2475.00, 294.00, 0, 476.00, 15, 38.08, '2026-05-14 23:15:00+00', '2026-05-14 17:45:00+00');

INSERT INTO breaks (id, org_id, stream_id, breaker_id, break_number, break_date, revenue, total_product_cost, estimated_fees, net_profit, fee_rate, spots, total_units_used, products_used, created_at) VALUES
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id, 1,'2026-05-14',215.00,165.00,19.78,30.22,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 18:00:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id, 2,'2026-05-14',198.00,165.00,18.22,14.78,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 18:15:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id, 3,'2026-05-14',225.00,165.00,20.70,39.30,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 18:30:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id, 4,'2026-05-14',189.00,165.00,17.39, 6.61,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 18:45:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id, 5,'2026-05-14',234.00,165.00,21.53,47.47,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 19:00:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id, 6,'2026-05-14',208.00,165.00,19.14,23.86,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 19:15:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id, 7,'2026-05-14',198.00,165.00,18.22,14.78,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 19:30:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id, 8,'2026-05-14',255.00,165.00,23.46,66.54,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 19:45:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id, 9,'2026-05-14',212.00,165.00,19.50,27.50,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 20:00:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id,10,'2026-05-14',221.00,165.00,20.33,35.67,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 20:15:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id,11,'2026-05-14',215.00,165.00,19.78,30.22,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 20:30:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id,12,'2026-05-14',245.00,165.00,22.54,57.46,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 20:45:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id,13,'2026-05-14',198.00,165.00,18.22,14.78,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 21:00:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id,14,'2026-05-14',215.00,165.00,19.78,30.22,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 21:15:00+00'),
  (gen_random_uuid(),v_org_id,v_s3,v_kevin_id,15,'2026-05-14',217.00,165.00,19.96,32.04,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_optic,'name','2025 Panini Optic Football Hobby','qty',1,'unit_cost',165.00,'ext_cost',165.00)),'2026-05-14 21:30:00+00');

-- ── STREAM 4 — VIC 5-15-26 (Victor · Chrome · 11 breaks · CLOSED) ──
INSERT INTO streams (id, org_id, breaker_id, stream_key, break_date, status, total_submitted_revenue, final_sales, total_product_cost, total_fees, total_other_costs, net_profit, break_count, commission_payout, closed_at, created_at)
VALUES (v_s4, v_org_id, v_victor_id, 'VIC 5-15-26', '2026-05-15', 'closed', 2389.00, 2172.00, 2035.00, 217.00, 0, 137.00, 11, 10.96, '2026-05-15 22:30:00+00', '2026-05-15 18:15:00+00');

INSERT INTO breaks (id, org_id, stream_id, breaker_id, break_number, break_date, revenue, total_product_cost, estimated_fees, net_profit, fee_rate, spots, total_units_used, products_used, created_at) VALUES
  (gen_random_uuid(),v_org_id,v_s4,v_victor_id, 1,'2026-05-15',289.00,185.00,26.59, 77.41,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-15 18:30:00+00'),
  (gen_random_uuid(),v_org_id,v_s4,v_victor_id, 2,'2026-05-15',201.00,185.00,18.49, -2.49,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-15 18:47:00+00'),
  (gen_random_uuid(),v_org_id,v_s4,v_victor_id, 3,'2026-05-15',212.00,185.00,19.50,  7.50,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-15 19:04:00+00'),
  (gen_random_uuid(),v_org_id,v_s4,v_victor_id, 4,'2026-05-15',235.00,185.00,21.62, 28.38,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-15 19:21:00+00'),
  (gen_random_uuid(),v_org_id,v_s4,v_victor_id, 5,'2026-05-15',198.00,185.00,18.22, -5.22,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-15 19:38:00+00'),
  (gen_random_uuid(),v_org_id,v_s4,v_victor_id, 6,'2026-05-15',234.00,185.00,21.53, 27.47,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-15 19:55:00+00'),
  (gen_random_uuid(),v_org_id,v_s4,v_victor_id, 7,'2026-05-15',189.00,185.00,17.39,-13.39,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-15 20:12:00+00'),
  (gen_random_uuid(),v_org_id,v_s4,v_victor_id, 8,'2026-05-15',213.00,185.00,19.60,  8.40,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-15 20:29:00+00'),
  (gen_random_uuid(),v_org_id,v_s4,v_victor_id, 9,'2026-05-15',225.00,185.00,20.70, 19.30,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-15 20:46:00+00'),
  (gen_random_uuid(),v_org_id,v_s4,v_victor_id,10,'2026-05-15',198.00,185.00,18.22, -5.22,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-15 21:03:00+00'),
  (gen_random_uuid(),v_org_id,v_s4,v_victor_id,11,'2026-05-15',195.00,185.00,17.94, -7.94,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_chrome,'name','2025 Topps Chrome Football Hobby','qty',1,'unit_cost',185.00,'ext_cost',185.00)),'2026-05-15 21:20:00+00');

-- ── STREAM 5 — MARC 5-16-26 (Marcus · Donruss · 13 breaks · CLOSED) ──
INSERT INTO streams (id, org_id, breaker_id, stream_key, break_date, status, total_submitted_revenue, final_sales, total_product_cost, total_fees, total_other_costs, net_profit, break_count, commission_payout, closed_at, created_at)
VALUES (v_s5, v_org_id, v_marcus_id, 'MARC 5-16-26', '2026-05-16', 'closed', 1867.00, 1698.00, 1274.00, 169.00, 0, 424.00, 13, 33.92, '2026-05-16 22:45:00+00', '2026-05-16 18:00:00+00');

INSERT INTO breaks (id, org_id, stream_id, breaker_id, break_number, break_date, revenue, total_product_cost, estimated_fees, net_profit, fee_rate, spots, total_units_used, products_used, created_at) VALUES
  (gen_random_uuid(),v_org_id,v_s5,v_marcus_id, 1,'2026-05-16',145.00,98.00,13.34,33.66,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_donruss,'name','2025 Panini Donruss Football Hobby','qty',1,'unit_cost',98.00,'ext_cost',98.00)),'2026-05-16 18:15:00+00'),
  (gen_random_uuid(),v_org_id,v_s5,v_marcus_id, 2,'2026-05-16',123.00,98.00,11.32,13.68,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_donruss,'name','2025 Panini Donruss Football Hobby','qty',1,'unit_cost',98.00,'ext_cost',98.00)),'2026-05-16 18:30:00+00'),
  (gen_random_uuid(),v_org_id,v_s5,v_marcus_id, 3,'2026-05-16',156.00,98.00,14.35,43.65,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_donruss,'name','2025 Panini Donruss Football Hobby','qty',1,'unit_cost',98.00,'ext_cost',98.00)),'2026-05-16 18:45:00+00'),
  (gen_random_uuid(),v_org_id,v_s5,v_marcus_id, 4,'2026-05-16',134.00,98.00,12.33,23.67,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_donruss,'name','2025 Panini Donruss Football Hobby','qty',1,'unit_cost',98.00,'ext_cost',98.00)),'2026-05-16 19:00:00+00'),
  (gen_random_uuid(),v_org_id,v_s5,v_marcus_id, 5,'2026-05-16',167.00,98.00,15.36,53.64,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_donruss,'name','2025 Panini Donruss Football Hobby','qty',1,'unit_cost',98.00,'ext_cost',98.00)),'2026-05-16 19:15:00+00'),
  (gen_random_uuid(),v_org_id,v_s5,v_marcus_id, 6,'2026-05-16',142.00,98.00,13.06,30.94,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_donruss,'name','2025 Panini Donruss Football Hobby','qty',1,'unit_cost',98.00,'ext_cost',98.00)),'2026-05-16 19:30:00+00'),
  (gen_random_uuid(),v_org_id,v_s5,v_marcus_id, 7,'2026-05-16',138.00,98.00,12.70,27.30,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_donruss,'name','2025 Panini Donruss Football Hobby','qty',1,'unit_cost',98.00,'ext_cost',98.00)),'2026-05-16 19:45:00+00'),
  (gen_random_uuid(),v_org_id,v_s5,v_marcus_id, 8,'2026-05-16',156.00,98.00,14.35,43.65,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_donruss,'name','2025 Panini Donruss Football Hobby','qty',1,'unit_cost',98.00,'ext_cost',98.00)),'2026-05-16 20:00:00+00'),
  (gen_random_uuid(),v_org_id,v_s5,v_marcus_id, 9,'2026-05-16',145.00,98.00,13.34,33.66,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_donruss,'name','2025 Panini Donruss Football Hobby','qty',1,'unit_cost',98.00,'ext_cost',98.00)),'2026-05-16 20:15:00+00'),
  (gen_random_uuid(),v_org_id,v_s5,v_marcus_id,10,'2026-05-16',134.00,98.00,12.33,23.67,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_donruss,'name','2025 Panini Donruss Football Hobby','qty',1,'unit_cost',98.00,'ext_cost',98.00)),'2026-05-16 20:30:00+00'),
  (gen_random_uuid(),v_org_id,v_s5,v_marcus_id,11,'2026-05-16',167.00,98.00,15.36,53.64,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_donruss,'name','2025 Panini Donruss Football Hobby','qty',1,'unit_cost',98.00,'ext_cost',98.00)),'2026-05-16 20:45:00+00'),
  (gen_random_uuid(),v_org_id,v_s5,v_marcus_id,12,'2026-05-16',145.00,98.00,13.34,33.66,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_donruss,'name','2025 Panini Donruss Football Hobby','qty',1,'unit_cost',98.00,'ext_cost',98.00)),'2026-05-16 21:00:00+00'),
  (gen_random_uuid(),v_org_id,v_s5,v_marcus_id,13,'2026-05-16',115.00,98.00,10.58, 6.42,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_donruss,'name','2025 Panini Donruss Football Hobby','qty',1,'unit_cost',98.00,'ext_cost',98.00)),'2026-05-16 21:15:00+00');

-- ── STREAM 6 — KEV 5-17-26 (Kevin · Prizm · 8 breaks · ACTIVE) ──
INSERT INTO streams (id, org_id, breaker_id, stream_key, break_date, status, total_submitted_revenue, total_product_cost, total_fees, break_count, created_at)
VALUES (v_s6, v_org_id, v_kevin_id, 'KEV 5-17-26', '2026-05-17', 'active', 2156.00, 1800.00, 198.00, 8, '2026-05-17 18:00:00+00');

INSERT INTO breaks (id, org_id, stream_id, breaker_id, break_number, break_date, revenue, total_product_cost, estimated_fees, net_profit, fee_rate, spots, total_units_used, products_used, created_at) VALUES
  (gen_random_uuid(),v_org_id,v_s6,v_kevin_id,1,'2026-05-17',245.00,225.00,22.54, -2.54,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-17 18:15:00+00'),
  (gen_random_uuid(),v_org_id,v_s6,v_kevin_id,2,'2026-05-17',289.00,225.00,26.59, 37.41,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-17 18:30:00+00'),
  (gen_random_uuid(),v_org_id,v_s6,v_kevin_id,3,'2026-05-17',256.00,225.00,23.55,  7.45,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-17 18:45:00+00'),
  (gen_random_uuid(),v_org_id,v_s6,v_kevin_id,4,'2026-05-17',267.00,225.00,24.56, 17.44,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-17 19:00:00+00'),
  (gen_random_uuid(),v_org_id,v_s6,v_kevin_id,5,'2026-05-17',278.00,225.00,25.58, 27.42,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-17 19:15:00+00'),
  (gen_random_uuid(),v_org_id,v_s6,v_kevin_id,6,'2026-05-17',289.00,225.00,26.59, 37.41,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-17 19:30:00+00'),
  (gen_random_uuid(),v_org_id,v_s6,v_kevin_id,7,'2026-05-17',267.00,225.00,24.56, 17.44,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-17 19:45:00+00'),
  (gen_random_uuid(),v_org_id,v_s6,v_kevin_id,8,'2026-05-17',265.00,225.00,24.38, 15.62,0.092,32,1,jsonb_build_array(jsonb_build_object('product_id',v_p_prizm,'name','2025 Panini Prizm Football Hobby','qty',1,'unit_cost',225.00,'ext_cost',225.00)),'2026-05-17 20:00:00+00');

-- ── SORT TASKS ────────────────────────────────────────────
INSERT INTO sort_tasks (id, org_id, stream_id, status, sorter_id, completed_at, created_at) VALUES
  (gen_random_uuid(), v_org_id, v_s1, 'completed', v_jay_id,    '2026-05-13 10:30:00+00', '2026-05-12 22:45:00+00'),
  (gen_random_uuid(), v_org_id, v_s2, 'completed', v_maximo_id, '2026-05-14 11:00:00+00', '2026-05-13 23:00:00+00'),
  (gen_random_uuid(), v_org_id, v_s3, 'completed', v_jay_id,    '2026-05-15 10:45:00+00', '2026-05-14 23:15:00+00'),
  (gen_random_uuid(), v_org_id, v_s4, 'completed', v_maximo_id, '2026-05-16 11:15:00+00', '2026-05-15 22:30:00+00'),
  (gen_random_uuid(), v_org_id, v_s5, 'completed', v_jay_id,    '2026-05-17 10:30:00+00', '2026-05-16 22:45:00+00');

INSERT INTO sort_tasks (id, org_id, stream_id, status, created_at) VALUES
  (gen_random_uuid(), v_org_id, v_s6, 'pending', '2026-05-17 20:00:00+00');

-- ── SCHEDULES ─────────────────────────────────────────────
-- Breaker shifts (completed)
INSERT INTO schedules (id, org_id, breaker_id, scheduled_date, scheduled_time, stream_key, status, clocked_in_at, clocked_out_at, created_at) VALUES
  (gen_random_uuid(), v_org_id, v_victor_id, '2026-05-12', '18:00', 'VIC 5-12-26',  'completed', '2026-05-12 18:02:00+00', '2026-05-12 22:50:00+00', now()),
  (gen_random_uuid(), v_org_id, v_marcus_id, '2026-05-13', '18:30', 'MARC 5-13-26', 'completed', '2026-05-13 18:31:00+00', '2026-05-13 23:05:00+00', now()),
  (gen_random_uuid(), v_org_id, v_kevin_id,  '2026-05-14', '17:45', 'KEV 5-14-26',  'completed', '2026-05-14 17:47:00+00', '2026-05-14 23:20:00+00', now()),
  (gen_random_uuid(), v_org_id, v_victor_id, '2026-05-15', '18:00', 'VIC 5-15-26',  'completed', '2026-05-15 18:17:00+00', '2026-05-15 22:35:00+00', now()),
  (gen_random_uuid(), v_org_id, v_marcus_id, '2026-05-16', '18:00', 'MARC 5-16-26', 'completed', '2026-05-16 18:03:00+00', '2026-05-16 22:50:00+00', now()),
  (gen_random_uuid(), v_org_id, v_kevin_id,  '2026-05-17', '18:00', 'KEV 5-17-26',  'in_progress','2026-05-17 18:01:00+00', null, now());

-- Sorter shifts (completed)
INSERT INTO schedules (id, org_id, sorter_id, scheduled_date, scheduled_time, status, clocked_in_at, clocked_out_at, created_at) VALUES
  (gen_random_uuid(), v_org_id, v_jay_id,    '2026-05-13', '09:00', 'completed', '2026-05-13 09:05:00+00', '2026-05-13 11:30:00+00', now()),
  (gen_random_uuid(), v_org_id, v_maximo_id, '2026-05-14', '09:00', 'completed', '2026-05-14 09:02:00+00', '2026-05-14 11:15:00+00', now()),
  (gen_random_uuid(), v_org_id, v_jay_id,    '2026-05-15', '09:00', 'completed', '2026-05-15 09:08:00+00', '2026-05-15 12:00:00+00', now()),
  (gen_random_uuid(), v_org_id, v_maximo_id, '2026-05-16', '09:30', 'completed', '2026-05-16 09:33:00+00', '2026-05-16 11:45:00+00', now()),
  (gen_random_uuid(), v_org_id, v_jay_id,    '2026-05-17', '09:00', 'completed', '2026-05-17 09:01:00+00', '2026-05-17 10:30:00+00', now());

-- Upcoming shifts (next week — shows on calendar)
INSERT INTO schedules (id, org_id, breaker_id, scheduled_date, scheduled_time, status, created_at) VALUES
  (gen_random_uuid(), v_org_id, v_victor_id, '2026-05-19', '18:00', 'scheduled', now()),
  (gen_random_uuid(), v_org_id, v_marcus_id, '2026-05-20', '18:30', 'scheduled', now()),
  (gen_random_uuid(), v_org_id, v_kevin_id,  '2026-05-21', '17:45', 'scheduled', now()),
  (gen_random_uuid(), v_org_id, v_victor_id, '2026-05-22', '18:00', 'scheduled', now()),
  (gen_random_uuid(), v_org_id, v_marcus_id, '2026-05-23', '18:30', 'scheduled', now());

END $$;
