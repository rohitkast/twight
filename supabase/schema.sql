-- Twight Phase 1 schema
-- Run this in Supabase SQL Editor (Dashboard → SQL → New query)

-- Profiles (one row per auth user)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  drafts_balance integer not null default 0 check (drafts_balance >= 0),
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

-- Auto-create profile at 0. Guest +5 is per Chrome install via register_install_grant, not per auth user.
-- (Giving 5 here meant every Sign out minted a new anonymous user with a fresh 5.)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, drafts_balance)
  values (new.id, new.email, 0)
  on conflict (id) do nothing;

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
  p_drafts integer,
  p_user_id uuid default null
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

  if p_user_id is not null then
    select id into target_user
    from public.profiles
    where id = p_user_id
    limit 1;

    if target_user is null then
      select id into target_user
      from auth.users
      where id = p_user_id
      limit 1;

      if target_user is not null then
        insert into public.profiles (id, email, drafts_balance)
        values (target_user, p_email, 0)
        on conflict (id) do nothing;
      end if;
    end if;
  end if;

  if target_user is null then
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

-- Guest leftover → Google (once per guest). Install-scoped free grant (once per install).
create table if not exists public.anon_claims (
  anonymous_user_id uuid primary key references auth.users (id) on delete cascade,
  google_user_id uuid not null references auth.users (id) on delete cascade,
  leftover integer not null,
  bonus integer not null,
  created_at timestamptz not null default now()
);

create index if not exists anon_claims_google_user_id_idx on public.anon_claims (google_user_id);

create table if not exists public.install_grants (
  install_id text primary key,
  first_user_id uuid not null,
  granted_at timestamptz not null default now()
);

create unique index if not exists draft_ledger_google_bonus_once
  on public.draft_ledger (user_id)
  where reason = 'google_bonus';

alter table public.anon_claims enable row level security;
alter table public.install_grants enable row level security;

create or replace function public.claim_anonymous(p_google_id uuid, p_anon_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  leftover integer;
  bonus integer := 0;
  new_balance integer;
  already uuid;
  anon_flag boolean;
  inserted integer;
begin
  if p_google_id is null or p_anon_id is null then
    raise exception 'invalid_args';
  end if;

  if p_google_id = p_anon_id then
    select drafts_balance into new_balance from public.profiles where id = p_google_id;
    return coalesce(new_balance, 0);
  end if;

  select google_user_id into already
  from public.anon_claims
  where anonymous_user_id = p_anon_id;

  if already is not null then
    select drafts_balance into new_balance from public.profiles where id = p_google_id;
    return coalesce(new_balance, 0);
  end if;

  select coalesce(is_anonymous, false) into anon_flag
  from auth.users
  where id = p_anon_id;

  if not coalesce(anon_flag, false) then
    raise exception 'not_anonymous';
  end if;

  insert into public.profiles (id, email, drafts_balance)
  values (p_google_id, null, 0)
  on conflict (id) do nothing;

  select drafts_balance into leftover
  from public.profiles
  where id = p_anon_id
  for update;

  leftover := coalesce(leftover, 0);

  if not exists (
    select 1
    from public.draft_ledger
    where user_id = p_google_id
      and reason in ('google_bonus', 'signup_bonus')
  ) then
    bonus := 5;
  end if;

  insert into public.anon_claims (anonymous_user_id, google_user_id, leftover, bonus)
  values (p_anon_id, p_google_id, leftover, bonus)
  on conflict (anonymous_user_id) do nothing;

  get diagnostics inserted = row_count;
  if inserted = 0 then
    select drafts_balance into new_balance from public.profiles where id = p_google_id;
    return coalesce(new_balance, 0);
  end if;

  update public.profiles
  set drafts_balance = drafts_balance + leftover + bonus
  where id = p_google_id
  returning drafts_balance into new_balance;

  update public.profiles
  set drafts_balance = 0
  where id = p_anon_id;

  if leftover > 0 then
    insert into public.draft_ledger (user_id, delta, reason, metadata)
    values (
      p_google_id,
      leftover,
      'anon_merge',
      jsonb_build_object('from', p_anon_id)
    );
    insert into public.draft_ledger (user_id, delta, reason, metadata)
    values (
      p_anon_id,
      -leftover,
      'anon_merge_out',
      jsonb_build_object('to', p_google_id)
    );
  end if;

  if bonus > 0 then
    insert into public.draft_ledger (user_id, delta, reason)
    values (p_google_id, bonus, 'google_bonus');
  end if;

  return coalesce(new_balance, 0);
end;
$$;

create or replace function public.register_install_grant(
  p_install_id text,
  p_user_id uuid,
  p_is_anonymous boolean
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  existing uuid;
  bal integer;
  inserted integer;
  anon_flag boolean;
begin
  if p_user_id is null then
    return 0;
  end if;

  select coalesce(is_anonymous, false) into anon_flag
  from auth.users
  where id = p_user_id;
  anon_flag := coalesce(anon_flag, false) or coalesce(p_is_anonymous, false);

  insert into public.profiles (id, email, drafts_balance)
  values (p_user_id, null, 0)
  on conflict (id) do nothing;

  -- Anonymous without a valid install id must not keep a trigger-era 5.
  if p_install_id is null
     or length(p_install_id) < 8
     or length(p_install_id) > 80 then
    if anon_flag then
      return 0;
    end if;
    select drafts_balance into bal from public.profiles where id = p_user_id;
    return coalesce(bal, 0);
  end if;

  insert into public.install_grants (install_id, first_user_id)
  values (p_install_id, p_user_id)
  on conflict (install_id) do nothing;
  get diagnostics inserted = row_count;

  select first_user_id into existing
  from public.install_grants
  where install_id = p_install_id;

  -- First identity on this Chrome install: guest gets +5 once.
  if inserted > 0 then
    select drafts_balance into bal
    from public.profiles
    where id = p_user_id
    for update;

    if anon_flag and coalesce(bal, 0) = 0 then
      update public.profiles
      set drafts_balance = 5
      where id = p_user_id
      returning drafts_balance into bal;

      insert into public.draft_ledger (user_id, delta, reason, metadata)
      values (
        p_user_id,
        5,
        'anon_signup_bonus',
        jsonb_build_object('install_id', p_install_id)
      );
      return 5;
    end if;

    return coalesce(bal, 0);
  end if;

  -- Same person (re-open panel): keep their balance.
  if existing = p_user_id then
    select drafts_balance into bal from public.profiles where id = p_user_id;
    return coalesce(bal, 0);
  end if;

  -- Later guest on the same install: no second free 5.
  if anon_flag then
    select drafts_balance into bal
    from public.profiles
    where id = p_user_id
    for update;

    if coalesce(bal, 0) > 0 then
      update public.profiles
      set drafts_balance = 0
      where id = p_user_id;

      insert into public.draft_ledger (user_id, delta, reason, metadata)
      values (
        p_user_id,
        -bal,
        'install_already_granted',
        jsonb_build_object('install_id', p_install_id)
      );
    end if;
    return 0;
  end if;

  select drafts_balance into bal from public.profiles where id = p_user_id;
  return coalesce(bal, 0);
end;
$$;

revoke all on function public.claim_anonymous(uuid, uuid) from public;
revoke all on function public.register_install_grant(text, uuid, boolean) from public;
grant execute on function public.claim_anonymous(uuid, uuid) to service_role;
grant execute on function public.register_install_grant(text, uuid, boolean) to service_role;
