-- One-time cleanup: remove fake "outages" of sites that were already broken when we added them
-- (they never answered OK even once). Run once in Supabase → SQL Editor.
delete from public.outreach_incidents i
  using public.outreach_sites s
  where i.site_id = s.id and s.checks_up = 0;

update public.outreach_sites
  set last_status = 'BROKEN'
  where last_status = 'DOWN' and checks_up = 0;
