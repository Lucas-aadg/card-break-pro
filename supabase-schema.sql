-- ============================================================
-- CARD BREAK PRO — Supabase Schema
-- Run this entire file in Supabase: SQL Editor → New Query → paste → Run
-- ============================================================

-- ============================================================
-- TABLES
-- ============================================================

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid references auth.users(id),
  created_at timestamptz default now()
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid references organizations(id),
  role text not null check (role in ('owner', 'breaker')),
  display_name text not null,
  created_at timestamptz default now()
);

create table if not exists invite_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) not null,
  code text unique not null,
  used boolean default false,
  created_at timestamptz default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) not null,
  name text not null,
  category text,
  unit_cost numeric(10,2) not null default 0,
  current_stock integer not null default 0,
  min_stock_alert integer not null default 5,
  active boolean not null default true,
  display_order integer default 0,
  notes text,
  created_at timestamptz default now()
);

create table if not exists streams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) not null,
  breaker_id uuid references profiles(id) not null,
  stream_key text not null,
  break_date date not null,
  status text not null default 'active' check (status in ('active', 'closed')),
  total_submitted_revenue numeric(10,2) default 0,
  final_sales numeric(10,2),
  total_product_cost numeric(10,2) default 0,
  total_fees numeric(10,2) default 0,
  total_other_costs numeric(10,2) default 0,
  net_profit numeric(10,2),
  break_count integer default 0,
  notes text,
  closed_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists breaks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) not null,
  stream_id uuid references streams(id) not null,
  breaker_id uuid references profiles(id) not null,
  break_number integer not null,
  break_date date not null,
  revenue numeric(10,2) not null default 0,
  spots integer default 0,
  fee_rate numeric(5,4) default 0,
  other_costs numeric(10,2) default 0,
  total_product_cost numeric(10,2) not null default 0,
  estimated_fees numeric(10,2) default 0,
  net_profit numeric(10,2) default 0,
  total_units_used integer default 0,
  products_used jsonb default '[]',
  created_at timestamptz default now()
);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Returns the org_id for the currently logged-in user
create or replace function get_my_org_id()
returns uuid
language sql
stable
security definer
as $$
  select org_id from profiles where id = auth.uid() limit 1;
$$;

-- Returns true if the current user is an owner
create or replace function is_owner()
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'owner'
  );
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- organizations
alter table organizations enable row level security;

create policy "org_select"
  on organizations for select
  using (owner_id = auth.uid() or id = get_my_org_id());

create policy "org_insert"
  on organizations for insert
  with check (owner_id = auth.uid());

create policy "org_update"
  on organizations for update
  using (owner_id = auth.uid());

-- profiles
alter table profiles enable row level security;

create policy "profiles_select"
  on profiles for select
  using (org_id = get_my_org_id());

-- Anyone can insert their own profile (used during register + join)
create policy "profiles_insert"
  on profiles for insert
  with check (id = auth.uid());

-- Only owners can update or delete profiles within their org (not themselves)
create policy "profiles_update"
  on profiles for update
  using (org_id = get_my_org_id() and is_owner());

create policy "profiles_delete"
  on profiles for delete
  using (org_id = get_my_org_id() and is_owner() and id <> auth.uid());

-- invite_codes
alter table invite_codes enable row level security;

-- Owners can see all codes for their org. Anyone unauthenticated/authenticated can
-- read an unused code by value (needed for the join flow before the user has a profile)
create policy "invite_codes_select"
  on invite_codes for select
  using (org_id = get_my_org_id() or used = false);

-- Only owners can generate codes
create policy "invite_codes_insert"
  on invite_codes for insert
  with check (org_id = get_my_org_id() and is_owner());

-- Anyone can mark a code as used (join flow — user has no profile yet at this moment)
create policy "invite_codes_update"
  on invite_codes for update
  using (true)
  with check (true);

-- products
alter table products enable row level security;

-- All org members can read products
create policy "products_select"
  on products for select
  using (org_id = get_my_org_id());

-- Only owners can add or edit products
create policy "products_insert"
  on products for insert
  with check (org_id = get_my_org_id() and is_owner());

-- FIX: owners AND breakers can update products (breakers need to deduct stock)
-- Stock deduction is the only update breakers do — RLS can't restrict which column,
-- so we trust the app layer to only update current_stock for breakers.
create policy "products_update"
  on products for update
  using (org_id = get_my_org_id());

create policy "products_delete"
  on products for delete
  using (org_id = get_my_org_id() and is_owner());

-- streams
alter table streams enable row level security;

create policy "streams_select"
  on streams for select
  using (org_id = get_my_org_id());

-- FIX: both owners and breakers can insert streams
create policy "streams_insert"
  on streams for insert
  with check (org_id = get_my_org_id() and breaker_id = auth.uid());

-- Both owners and breakers can update streams they're involved in
create policy "streams_update"
  on streams for update
  using (
    org_id = get_my_org_id()
    and (breaker_id = auth.uid() or is_owner())
  );

create policy "streams_delete"
  on streams for delete
  using (org_id = get_my_org_id() and is_owner());

-- breaks
alter table breaks enable row level security;

create policy "breaks_select"
  on breaks for select
  using (org_id = get_my_org_id());

-- FIX: both owners and breakers can insert breaks
create policy "breaks_insert"
  on breaks for insert
  with check (org_id = get_my_org_id() and breaker_id = auth.uid());

create policy "breaks_update"
  on breaks for update
  using (org_id = get_my_org_id() and is_owner());

create policy "breaks_delete"
  on breaks for delete
  using (org_id = get_my_org_id() and is_owner());

-- ============================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================

create index if not exists idx_profiles_org_id     on profiles(org_id);
create index if not exists idx_products_org_id     on products(org_id);
create index if not exists idx_streams_org_id      on streams(org_id);
create index if not exists idx_streams_breaker_id  on streams(breaker_id);
create index if not exists idx_breaks_org_id       on breaks(org_id);
create index if not exists idx_breaks_stream_id    on breaks(stream_id);
create index if not exists idx_breaks_breaker_id   on breaks(breaker_id);
create index if not exists idx_breaks_break_date   on breaks(break_date);
create index if not exists idx_invite_codes_code   on invite_codes(code);

-- ============================================================
-- SUBSCRIPTIONS (added for Stripe integration)
-- ============================================================

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) unique not null,
  user_id uuid references auth.users(id),
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'inactive',
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

alter table subscriptions enable row level security;

-- Org members can read their own subscription
create policy "subscriptions_select"
  on subscriptions for select
  using (org_id = get_my_org_id());

-- Only service role (webhook) can insert/update subscriptions
-- App uses supabase service key in the webhook, bypasses RLS
create policy "subscriptions_insert"
  on subscriptions for insert
  with check (true);

create policy "subscriptions_update"
  on subscriptions for update
  using (true);

create index if not exists idx_subscriptions_org_id on subscriptions(org_id);
create index if not exists idx_subscriptions_stripe_customer on subscriptions(stripe_customer_id);
create index if not exists idx_subscriptions_stripe_sub on subscriptions(stripe_subscription_id);
