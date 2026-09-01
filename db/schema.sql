-- GXPAY POS - Supabase schema
-- Run this once in your Supabase project's SQL Editor (or via `psql`/the
-- Supabase CLI if you prefer). Covers both the transaction store
-- (store/transactionStore.js) and the item/service catalog
-- (store/catalogStore.js) - one migration for both features.
--
-- This app connects using the SERVICE ROLE key (server-side only, never
-- exposed to the browser - see config/env.js), which bypasses Row Level
-- Security entirely. RLS is still enabled below with a default-deny
-- policy as defense in depth, in case the anon key or a direct client
-- connection is ever introduced later - it costs nothing for this app's
-- own access pattern.

create extension if not exists pgcrypto; -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------
create table if not exists transactions (
  reference text primary key,
  status text not null default 'pending',
  amount numeric(14,2) not null,
  currency text not null,
  -- Free-text description of what was sold, e.g. "Sale of wine" or
  -- "Payment for swimming service" - set from a catalog item at checkout,
  -- or typed manually. Shown on the receipt/PDF/print instead of (or
  -- alongside) the bare amount. Nullable - existing transactions and
  -- custom-amount charges may not have one.
  description text,
  -- device payload actually sent to GxPay (entry mode, masked PAN, etc.) -
  -- never a cleartext PAN/track/PIN, matches lib/cardPayload.js's rules.
  device jsonb,
  -- full receipt object as returned to the client (routes/payments.js
  -- buildReceipt()) - kept as-is rather than split into columns so the
  -- API response shape and the stored shape never drift apart.
  receipt jsonb,
  gateway_reference text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists transactions_created_at_idx on transactions (created_at desc);
create index if not exists transactions_status_idx on transactions (status);

alter table transactions enable row level security;
drop policy if exists "service role only" on transactions;
create policy "service role only" on transactions
  for all
  using (false)
  with check (false);
-- The service role key bypasses RLS entirely, so this policy only matters
-- if a non-service-role key (e.g. anon) is ever used against this table -
-- in that case it correctly denies all access by default.

-- ---------------------------------------------------------------------------
-- Catalog: sellable items and services with a price attached
-- ---------------------------------------------------------------------------
create table if not exists catalog_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric(14,2) not null check (price >= 0),
  type text not null check (type in ('sale', 'service')),
  currency text not null default 'NGN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists catalog_items_type_idx on catalog_items (type);
create index if not exists catalog_items_name_idx on catalog_items (name);

alter table catalog_items enable row level security;
drop policy if exists "service role only" on catalog_items;
create policy "service role only" on catalog_items
  for all
  using (false)
  with check (false);

-- Example seed data (optional - remove or edit before running, or just
-- add your own real items via the Items tab in the app once it's running).
-- insert into catalog_items (name, price, type, currency) values
--   ('Bottled water (case of 50)', 5000, 'sale', 'NGN'),
--   ('Spa and massage service', 60000, 'service', 'NGN');
