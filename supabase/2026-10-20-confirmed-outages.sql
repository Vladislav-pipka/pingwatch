-- PingWatch migration — 2026-10-20
-- Outages are confirmed only after two failed runs in a row (~10 min apart),
-- and the old unreliable data (checks were running every 5–16 hours) is reset.
-- Run once in Supabase → SQL Editor.

alter table public.outreach_sites add column if not exists suspect_since timestamptz;

create or replace function public.pw_outreach_apply(results jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  update public.outreach_sites s set
    last_status      = r.last_status,
    last_status_code = r.last_status_code,
    last_error       = r.last_error,
    last_checked_at  = r.last_checked_at,
    suspect_since    = r.suspect_since,
    checks_total     = s.checks_total + coalesce(r.add_total, 0),
    checks_up        = s.checks_up + coalesce(r.add_up, 0),
    is_active        = coalesce(r.is_active, s.is_active)
  from jsonb_to_recordset(results) as r(
    id uuid, last_status text, last_status_code int, last_error text,
    last_checked_at timestamptz, suspect_since timestamptz,
    add_total int, add_up int, is_active boolean
  )
  where s.id = r.id;

  update public.outreach_incidents i set
    resolved_at      = r.last_checked_at,
    duration_seconds = greatest(0, extract(epoch from (r.last_checked_at - i.started_at))::int)
  from jsonb_to_recordset(results) as r(id uuid, last_checked_at timestamptz, close_incident boolean)
  where r.close_incident and i.site_id = r.id and i.resolved_at is null;

  insert into public.outreach_incidents (site_id, started_at, error_reason, error_details, status_code)
  select r.id, coalesce(r.incident_started_at, r.last_checked_at), r.error_reason, r.error_details, r.last_status_code
  from jsonb_to_recordset(results) as r(
    id uuid, last_checked_at timestamptz, incident_started_at timestamptz,
    error_reason text, error_details text, last_status_code int, open_incident boolean
  )
  where r.open_incident;
end;
$$;

revoke execute on function public.pw_outreach_apply(jsonb) from public, anon, authenticated;
grant execute on function public.pw_outreach_apply(jsonb) to service_role;

-- Reset: forget the unreliable history and start counting honestly from now.
delete from public.outreach_incidents;

update public.outreach_sites
  set last_status = 'UP', checks_total = 1, checks_up = 1, suspect_since = null
  where is_active and checks_up > 0;

update public.outreach_sites
  set checks_total = 0, checks_up = 0, suspect_since = null
  where is_active and checks_up = 0;
