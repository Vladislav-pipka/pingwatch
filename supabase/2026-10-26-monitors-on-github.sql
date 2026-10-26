-- PingWatch — 2026-10-26
-- Start customer monitor checks on GitHub Actions every 5 minutes (instead of Netlify).
-- Uses the same GitHub token you saved earlier as 'github_dispatch_token'.
-- Run once in Supabase → SQL Editor.

select cron.unschedule('pingwatch-monitor-checks')
where exists (select 1 from cron.job where jobname = 'pingwatch-monitor-checks');

select cron.schedule(
  'pingwatch-monitor-checks',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://api.github.com/repos/vladislav-pipka/pingwatch/actions/workflows/monitor-checks.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_dispatch_token'),
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'pingwatch-cron'
    ),
    body := '{"ref":"main"}'::jsonb
  );
  $$
);
