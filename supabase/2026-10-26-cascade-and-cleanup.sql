-- PingWatch migration — 2026-10-26
-- 1) Deleting a monitor also deletes its incidents and check history (no more
--    "foreign key" errors or orphaned rows when a user removes a monitor).
-- 2) Index so the hourly 30-day cleanup of monitor_checks stays fast.
-- Run once in Supabase → SQL Editor. Safe to run again.

do $$
declare r record;
begin
  for r in
    select con.conname, rel.relname, att.attname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'f'
      and con.confrelid = 'public.monitors'::regclass
      and ns.nspname = 'public'
      and array_length(con.conkey, 1) = 1
      and con.confdeltype <> 'c'
  loop
    execute format('alter table public.%I drop constraint %I', r.relname, r.conname);
    execute format('alter table public.%I add constraint %I foreign key (%I) references public.monitors(id) on delete cascade',
                   r.relname, r.conname, r.attname);
    raise notice 'now cascades: %.%', r.relname, r.attname;
  end loop;
end $$;

create index if not exists monitor_checks_checked_at_idx on public.monitor_checks (checked_at);
