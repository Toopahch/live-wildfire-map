-- =============================================================================
--  Live Wildfire Map — Fire News schema
--  Run this once in the Supabase SQL Editor (see SUPABASE_SETUP.md).
--
--  Design notes:
--   • The frontend reads with the public "anon" key, protected by RLS so it can
--     only ever see non-hidden news. All writes happen from the Edge Function
--     using the service-role key, which bypasses RLS.
--   • Dedup is enforced at the database level with two unique indexes
--     (per-fire by article URL and by normalized title) so the same story can
--     never be stored twice for a fire, even across reruns.
-- =============================================================================

create extension if not exists pgcrypto;       -- gen_random_uuid()

-- ───────────────────────────── fires (snapshot) ─────────────────────────────
-- Active fires the sync job is tracking. Mirrors the live NIFC feed so news can
-- be joined to a stable fire_id (the IRWIN id) and so we can build a sitemap.
create table if not exists public.fires (
  fire_id            text primary key,           -- normalized IRWIN id (no braces, upper)
  fire_name          text,
  state              text,                        -- 2-letter, e.g. "UT"
  county             text,
  latitude           double precision,
  longitude          double precision,
  acres              double precision,
  percent_contained  double precision,
  discovered_at      timestamptz,
  is_active          boolean not null default true,
  news_checked_at    timestamptz,                 -- last time we searched news for it
  last_seen_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ───────────────────────────── fire_news ────────────────────────────────────
create table if not exists public.fire_news (
  id                 uuid primary key default gen_random_uuid(),
  fire_id            text not null,               -- → fires.fire_id (IRWIN)
  fire_name          text,
  title              text not null,
  summary            text,                        -- description / short summary
  source_name        text,
  source_url         text,                        -- publisher homepage / domain
  article_url        text not null,               -- link to the full article
  image_url          text,
  published_at       timestamptz,
  fetched_at         timestamptz not null default now(),
  confidence_score   smallint not null default 0, -- 0–100, how well it matches the fire
  match_reason       text,                        -- human-readable explanation
  is_official_source boolean not null default false,
  is_hidden          boolean not null default false,
  -- helper columns (matching/dedup/classification) -------------------------
  domain             text,                        -- normalized publisher domain
  source_type        text,                        -- 'inciweb' | 'gov' | 'news' …
  norm_title         text,                        -- normalized title for dedup
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_fire_news_fire        on public.fire_news (fire_id);
create index if not exists idx_fire_news_published    on public.fire_news (published_at desc nulls last);
create index if not exists idx_fire_news_official     on public.fire_news (is_official_source);
create index if not exists idx_fire_news_hidden       on public.fire_news (is_hidden);
-- Dedup guards: same article, or near-identical headline, can't repeat per fire.
create unique index if not exists uq_fire_news_url    on public.fire_news (fire_id, article_url);
create unique index if not exists uq_fire_news_title  on public.fire_news (fire_id, norm_title);

-- ───────────────────────────── blocked_sources ──────────────────────────────
-- Admin block-list. The sync job skips any article from these domains.
create table if not exists public.blocked_sources (
  domain      text primary key,
  reason      text,
  created_at  timestamptz not null default now()
);

-- ───────────────────────────── sync metadata ────────────────────────────────
-- Single-row table the frontend reads to show "updates last checked X ago".
create table if not exists public.news_sync_meta (
  id              boolean primary key default true check (id),  -- only one row
  last_run_at     timestamptz,
  fires_checked   integer default 0,
  articles_added  integer default 0,
  status          text,
  updated_at      timestamptz not null default now()
);
insert into public.news_sync_meta (id) values (true) on conflict (id) do nothing;

-- ───────────────────────────── updated_at trigger ───────────────────────────
create or replace function public.set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_fire_news_updated on public.fire_news;
create trigger trg_fire_news_updated before update on public.fire_news
  for each row execute function public.set_updated_at();

drop trigger if exists trg_fires_updated on public.fires;
create trigger trg_fires_updated before update on public.fires
  for each row execute function public.set_updated_at();

-- ───────────────────────────── Row Level Security ───────────────────────────
alter table public.fires           enable row level security;
alter table public.fire_news       enable row level security;
alter table public.blocked_sources enable row level security;
alter table public.news_sync_meta  enable row level security;

-- Public (anon) can READ fires, visible news, and the sync metadata. Nothing else.
drop policy if exists "public read fires" on public.fires;
create policy "public read fires" on public.fires
  for select to anon, authenticated using (true);

drop policy if exists "public read visible news" on public.fire_news;
create policy "public read visible news" on public.fire_news
  for select to anon, authenticated using (is_hidden = false);

drop policy if exists "public read sync meta" on public.news_sync_meta;
create policy "public read sync meta" on public.news_sync_meta
  for select to anon, authenticated using (true);

-- blocked_sources has NO anon policy → invisible to the public.
-- The service-role key (used only by the Edge Functions) bypasses RLS entirely,
-- so the sync + admin functions can read/write everything.

-- ───────────────────────────── helpful view (admin) ─────────────────────────
-- Newest news across all fires, including hidden, for the admin dashboard
-- (only reachable via the service role / news-admin function).
create or replace view public.fire_news_admin as
  select n.*, f.fire_name as current_fire_name, f.state, f.county
  from public.fire_news n
  left join public.fires f on f.fire_id = n.fire_id
  order by n.fetched_at desc;
