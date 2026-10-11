-- PingWatch migration — 2026-10-11
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to run again: everything uses "if not exists" / "or replace".

-- ─────────────────────────────────────────────────────────────
-- 1. Telegram one-click connect
-- ─────────────────────────────────────────────────────────────
alter table public.users add column if not exists telegram_link_token text;
alter table public.users add column if not exists telegram_link_expires_at timestamptz;

create unique index if not exists users_telegram_link_token_idx
  on public.users (telegram_link_token)
  where telegram_link_token is not null;

-- ─────────────────────────────────────────────────────────────
-- 2. Protect paid fields from being changed in the browser.
--    The browser talks to Supabase directly, so without this a user could
--    run   sb.from('users').update({ plan: 'unlimited' })   and get a free plan.
--    Only the server (Stripe webhook, service role) can change these now.
-- ─────────────────────────────────────────────────────────────
create or replace function public.pw_protect_user_fields()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.plan := 'free';
      new.stripe_customer_id := null;
      new.stripe_subscription_id := null;
      new.telegram_link_token := null;
      new.telegram_link_expires_at := null;
    else
      new.plan := old.plan;
      new.stripe_customer_id := old.stripe_customer_id;
      new.stripe_subscription_id := old.stripe_subscription_id;
      new.telegram_link_token := old.telegram_link_token;
      new.telegram_link_expires_at := old.telegram_link_expires_at;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists pw_protect_user_fields on public.users;
create trigger pw_protect_user_fields
  before insert or update on public.users
  for each row execute function public.pw_protect_user_fields();

-- ─────────────────────────────────────────────────────────────
-- 3. Enforce monitor limits in the database (Free 2 / Pro 10 / Unlimited).
--    Before, the limit was only checked in the browser.
-- ─────────────────────────────────────────────────────────────
create or replace function public.pw_enforce_monitor_limit()
returns trigger
language plpgsql
as $$
declare
  user_plan text;
  max_monitors int;
  current_count int;
begin
  if current_user not in ('anon', 'authenticated') then
    return new; -- server-side inserts are not limited
  end if;

  select plan into user_plan from public.users where id = new.user_id;
  max_monitors := case coalesce(user_plan, 'free')
                    when 'unlimited' then null
                    when 'pro' then 10
                    else 2
                  end;
  if max_monitors is null then
    return new;
  end if;

  select count(*) into current_count from public.monitors where user_id = new.user_id;
  if current_count >= max_monitors then
    raise exception 'Monitor limit reached for your plan (%). Upgrade to add more monitors.', max_monitors;
  end if;
  return new;
end;
$$;

drop trigger if exists pw_enforce_monitor_limit on public.monitors;
create trigger pw_enforce_monitor_limit
  before insert on public.monitors
  for each row execute function public.pw_enforce_monitor_limit();

-- ─────────────────────────────────────────────────────────────
-- 4. Outreach: sites we watch quietly, and their outages
-- ─────────────────────────────────────────────────────────────
create table if not exists public.outreach_sites (
  id               uuid primary key default gen_random_uuid(),
  domain           text not null unique,
  url              text not null,
  report_slug      text not null unique default substr(md5(random()::text || clock_timestamp()::text), 1, 10),
  source           text,
  contact_email    text,
  notes            text,
  stage            text not null default 'watching'
                     check (stage in ('watching', 'contacted', 'replied', 'signed_up', 'not_interested')),
  is_active        boolean not null default true,
  last_status      text,          -- UP | DOWN | BLOCKED | DEAD
  last_status_code int,
  last_error       text,
  last_checked_at  timestamptz,
  checks_total     int not null default 0,
  checks_up        int not null default 0,
  contacted_at     timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists outreach_sites_queue_idx
  on public.outreach_sites (is_active, last_checked_at nulls first);

create table if not exists public.outreach_incidents (
  id               uuid primary key default gen_random_uuid(),
  site_id          uuid not null references public.outreach_sites(id) on delete cascade,
  started_at       timestamptz not null,
  resolved_at      timestamptz,
  duration_seconds int,
  error_reason     text,
  error_details    text,
  status_code      int
);

create index if not exists outreach_incidents_site_idx
  on public.outreach_incidents (site_id, started_at desc);

-- Row Level Security ON and no policies = the browser can't read or write these tables.
-- Only our Netlify functions (service role key) can.
alter table public.outreach_sites enable row level security;
alter table public.outreach_incidents enable row level security;

-- Saves one round of checks in a single call (fast enough for hundreds of sites).
create or replace function public.pw_outreach_apply(results jsonb)
returns void
language plpgsql
as $$
begin
  update public.outreach_sites s set
    last_status      = r.last_status,
    last_status_code = r.last_status_code,
    last_error       = r.last_error,
    last_checked_at  = r.last_checked_at,
    checks_total     = s.checks_total + coalesce(r.add_total, 0),
    checks_up        = s.checks_up + coalesce(r.add_up, 0),
    is_active        = coalesce(r.is_active, s.is_active)
  from jsonb_to_recordset(results) as r(
    id uuid, last_status text, last_status_code int, last_error text,
    last_checked_at timestamptz, add_total int, add_up int, is_active boolean
  )
  where s.id = r.id;

  -- close outages that ended
  update public.outreach_incidents i set
    resolved_at      = r.last_checked_at,
    duration_seconds = greatest(0, extract(epoch from (r.last_checked_at - i.started_at))::int)
  from jsonb_to_recordset(results) as r(id uuid, last_checked_at timestamptz, close_incident boolean)
  where r.close_incident and i.site_id = r.id and i.resolved_at is null;

  -- open new outages
  insert into public.outreach_incidents (site_id, started_at, error_reason, error_details, status_code)
  select r.id, r.last_checked_at, r.error_reason, r.error_details, r.last_status_code
  from jsonb_to_recordset(results) as r(
    id uuid, last_checked_at timestamptz, error_reason text, error_details text,
    last_status_code int, open_incident boolean
  )
  where r.open_incident;
end;
$$;

revoke execute on function public.pw_outreach_apply(jsonb) from public, anon, authenticated;
grant execute on function public.pw_outreach_apply(jsonb) to service_role;
