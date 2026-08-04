-- Twight Phase 1 schema
-- Run this in Supabase SQL Editor (Dashboard → SQL → New query)

-- Profiles (one row per auth user)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  drafts_balance integer not null default 10 check (drafts_balance >= 0),
  created_at timestamptz not null default now()
);

-- Ledger for audit / debugging
create table if not exists public.draft_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  delta integer not null,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists draft_ledger_user_id_idx on public.draft_ledger (user_id);

-- Idempotent Polar order fulfillment
create table if not exists public.polar_orders (
  order_id text primary key,
  user_id uuid references public.profiles (id) on delete set null,
  email text,
  drafts_added integer not null,
  created_at timestamptz not null default now()
);

-- Auto-create profile with 10 free drafts on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, drafts_balance)
  values (new.id, new.email, 10)
  on conflict (id) do nothing;

  insert into public.draft_ledger (user_id, delta, reason, metadata)
  values (new.id, 10, 'signup_bonus', '{}'::jsonb);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Atomic draft deduction (returns new balance, or raises)
create or replace function public.deduct_draft(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_balance integer;
begin
  update public.profiles
  set drafts_balance = drafts_balance - 1
  where id = p_user_id
    and drafts_balance > 0
  returning drafts_balance into new_balance;

  if new_balance is null then
    raise exception 'insufficient_drafts';
  end if;

  insert into public.draft_ledger (user_id, delta, reason)
  values (p_user_id, -1, 'generate');

  return new_balance;
end;
$$;

-- Add drafts after purchase (idempotent via polar_orders)
create or replace function public.add_drafts_from_order(
  p_order_id text,
  p_email text,
  p_drafts integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user uuid;
  new_balance integer;
begin
  -- Already fulfilled?
  if exists (select 1 from public.polar_orders where order_id = p_order_id) then
    select drafts_balance into new_balance
    from public.profiles p
    join public.polar_orders o on o.user_id = p.id
    where o.order_id = p_order_id;
    return coalesce(new_balance, 0);
  end if;

  select id into target_user
  from public.profiles
  where lower(email) = lower(p_email)
  limit 1;

  if target_user is null then
    -- Try auth.users in case profile trigger lagged
    select id into target_user
    from auth.users
    where lower(email) = lower(p_email)
    limit 1;

    if target_user is not null then
      insert into public.profiles (id, email, drafts_balance)
      values (target_user, p_email, 0)
      on conflict (id) do nothing;
    end if;
  end if;

  if target_user is null then
    raise exception 'user_not_found';
  end if;

  update public.profiles
  set drafts_balance = drafts_balance + p_drafts,
      email = coalesce(email, p_email)
  where id = target_user
  returning drafts_balance into new_balance;

  insert into public.polar_orders (order_id, user_id, email, drafts_added)
  values (p_order_id, target_user, p_email, p_drafts);

  insert into public.draft_ledger (user_id, delta, reason, metadata)
  values (
    target_user,
    p_drafts,
    'purchase',
    jsonb_build_object('order_id', p_order_id)
  );

  return new_balance;
end;
$$;

-- RLS
alter table public.profiles enable row level security;
alter table public.draft_ledger enable row level security;
alter table public.polar_orders enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "Users can read own ledger" on public.draft_ledger;
create policy "Users can read own ledger"
  on public.draft_ledger for select
  using (auth.uid() = user_id);

-- polar_orders: no client access (service role only)
-- profiles/ledger writes: service role only via RPCs
