-- =============================================================================
--  Schedule syncFireNews to run automatically (every 12 hours).
--  Run this in the Supabase SQL Editor AFTER deploying the sync-fire-news
--  function and setting its secrets. See SUPABASE_SETUP.md step 5.
--
--  Replace the two placeholders below:
--    <PROJECT_REF>  → your project ref (the subdomain of your project URL)
--    <CRON_SECRET>  → the same value you set as the CRON_SECRET function secret
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any previous schedule with this name (safe to re-run).
select cron.unschedule('sync-fire-news')
where exists (select 1 from cron.job where jobname = 'sync-fire-news');

-- Run at 06:00 and 18:00 UTC every day.
select cron.schedule(
  'sync-fire-news',
  '0 6,18 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.functions.supabase.co/sync-fire-news',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- To verify:   select * from cron.job;
-- To see runs: select * from cron.job_run_details order by start_time desc limit 10;
-- To run once now (manual test), execute the net.http_post(...) statement on its own.
