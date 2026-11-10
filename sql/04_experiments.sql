-- A/B tests on the For You ranking (dojo-foryou-v3 lib/experiments.ts).
--
-- An experiment splits viewers between variants; each variant is a set of overrides on the
-- ranker's config (lib/config.ts), e.g. {"weights": {"quality": 0.6}}. A viewer's variant is a
-- hash of the experiment key and their profile (stable, nothing stored per viewer). Each ranked
-- list records the variants it was ranked with in meta.experiments, and the results compare
-- what viewers then did with the posts they were served.
--
-- Start one (no deploy needed; the function picks it up within a minute):
--   insert into private.foryou_experiments (key, description, variants, active, started_at)
--   values ('quality_weight', 'Does more weight on quality lift likes per view?',
--     '[{"name":"control","weight":50,"config":{}},
--       {"name":"more_quality","weight":50,"config":{"weights":{"quality":0.6}}}]', true, now());
-- Read it:   select * from public.foryou_experiment_results_v1('quality_weight');
-- Stop it:   update private.foryou_experiments set active = false, ended_at = now() where key = '...';

set local lock_timeout = '5s';

create table if not exists private.foryou_experiments (
  key text primary key check (key ~ '^[a-z0-9_]{2,64}$'),
  description text not null default '',
  variants jsonb not null check (jsonb_typeof(variants) = 'array'),
  active boolean not null default false,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
alter table private.foryou_experiments enable row level security;

-- The running experiments, for the ranker. Config only: nothing about any viewer.
create or replace function public.foryou_experiments_v1()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', e.key, 'variants', e.variants) order by e.key), '[]'::jsonb)
  from private.foryou_experiments e
  where e.active;
$$;
revoke all on function public.foryou_experiments_v1() from public, anon;
grant execute on function public.foryou_experiments_v1() to authenticated;

-- Results per variant: what viewers did with the posts in the lists ranked for them, within
-- `p_window` of each list being ranked. Views count distinct posts seen per session; rates are per
-- 100 of those views; the like rate carries a 95% interval so a difference can be judged.
-- post_interactions keeps one row per (viewer, post, type), updated in place, so a view counts by
-- when it last happened (updated_at), not the first time.
create or replace function public.foryou_experiment_results_v1(
  p_key text,
  p_since timestamptz default null,
  p_feed text default 'foryou',
  p_window interval default '3 hours'
)
returns table (
  variant text,
  viewers bigint,
  sessions bigint,
  views bigint,
  views_per_session numeric,
  avg_dwell_seconds numeric,
  likes_per_100_views numeric,
  likes_per_100_ci95 numeric,
  comments_per_100_views numeric,
  saves_per_100_views numeric,
  not_interested_per_100_views numeric,
  sessions_with_a_like_pct numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since timestamptz;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select coalesce(p_since, e.started_at, e.created_at) into v_since
  from private.foryou_experiments e where e.key = p_key;
  if v_since is null then
    raise exception 'no experiment %', p_key using errcode = 'P0002';
  end if;

  return query
  with lists as (
    select r.profile_id, r.created_at, r.post_ids, r.meta -> 'experiments' ->> p_key as arm
    from private.foryou_ranked_lists r
    where r.feed = p_feed
      and r.created_at >= v_since
      and r.meta -> 'experiments' ? p_key
  ),
  per_session as (
    select
      l.arm,
      l.profile_id,
      (select count(distinct pi.post_id) from public.post_interactions pi
        where pi.user_id = l.profile_id and pi.interaction_type = 'view' and pi.post_id = any (l.post_ids)
          and coalesce(pi.updated_at, pi.created_at) >= l.created_at and coalesce(pi.updated_at, pi.created_at) < l.created_at + p_window) as viewed,
      (select coalesce(sum(pi.dwell_time_seconds), 0) from public.post_interactions pi
        where pi.user_id = l.profile_id and pi.interaction_type = 'view' and pi.post_id = any (l.post_ids)
          and coalesce(pi.updated_at, pi.created_at) >= l.created_at and coalesce(pi.updated_at, pi.created_at) < l.created_at + p_window) as dwell,
      (select count(*) from public.likes k
        where k.user_id = l.profile_id and k.post_id = any (l.post_ids)
          and k.created_at >= l.created_at and k.created_at < l.created_at + p_window) as liked,
      (select count(*) from public.comments c
        where c.user_id = l.profile_id and c.post_id = any (l.post_ids)
          and c.created_at >= l.created_at and c.created_at < l.created_at + p_window) as commented,
      (select count(*) from public.saved_posts s
        where s.profile_id = l.profile_id and s.post_id = any (l.post_ids)
          and s.created_at >= l.created_at and s.created_at < l.created_at + p_window) as saved,
      (select count(*) from public.post_interactions pi
        where pi.user_id = l.profile_id and pi.interaction_type = 'not_interested' and pi.post_id = any (l.post_ids)
          and coalesce(pi.updated_at, pi.created_at) >= l.created_at and coalesce(pi.updated_at, pi.created_at) < l.created_at + p_window) as dismissed
    from lists l
  ),
  totals as (
    select
      ps.arm,
      count(distinct ps.profile_id) as viewers,
      count(*) as sessions,
      sum(ps.viewed)::bigint as views,
      sum(ps.dwell)::numeric as dwell,
      sum(ps.liked)::numeric as liked,
      sum(ps.commented)::numeric as commented,
      sum(ps.saved)::numeric as saved,
      sum(ps.dismissed)::numeric as dismissed,
      count(*) filter (where ps.liked > 0) as sessions_liked
    from per_session ps
    group by ps.arm
  )
  select
    t.arm,
    t.viewers,
    t.sessions,
    t.views,
    round(t.views::numeric / nullif(t.sessions, 0), 2),
    round(t.dwell / nullif(t.views, 0), 1),
    round(100 * t.liked / nullif(t.views, 0), 2),
    -- Normal approximation on likes per view (capped at 1 so a post liked twice can't break it).
    round(100 * 1.96 * sqrt(least(1, t.liked / nullif(t.views, 0)) * (1 - least(1, t.liked / nullif(t.views, 0))) / nullif(t.views, 0)), 2),
    round(100 * t.commented / nullif(t.views, 0), 2),
    round(100 * t.saved / nullif(t.views, 0), 2),
    round(100 * t.dismissed / nullif(t.views, 0), 2),
    round(100.0 * t.sessions_liked / nullif(t.sessions, 0), 1)
  from totals t
  order by t.arm;
end;
$$;
revoke all on function public.foryou_experiment_results_v1(text, timestamptz, text, interval) from public, anon;
grant execute on function public.foryou_experiment_results_v1(text, timestamptz, text, interval) to authenticated;

-- Every experiment (running first, then most recent) with its results per variant, one row per
-- variant: the admin dashboard's Feed experiments table (Engagement section).
create or replace function public.admin_foryou_experiments_v1()
returns table (
  key text, description text, active boolean, started_at timestamptz, ended_at timestamptz,
  variant text, viewers bigint, sessions bigint, views bigint, views_per_session numeric,
  avg_dwell_seconds numeric, likes_per_100_views numeric, likes_per_100_ci95 numeric,
  comments_per_100_views numeric, saves_per_100_views numeric, not_interested_per_100_views numeric,
  sessions_with_a_like_pct numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
  select e.key, e.description, e.active, e.started_at, e.ended_at,
         r.variant, r.viewers, r.sessions, r.views, r.views_per_session, r.avg_dwell_seconds,
         r.likes_per_100_views, r.likes_per_100_ci95, r.comments_per_100_views,
         r.saves_per_100_views, r.not_interested_per_100_views, r.sessions_with_a_like_pct
  from private.foryou_experiments e
  left join lateral public.foryou_experiment_results_v1(e.key) r on true
  order by e.active desc, coalesce(e.started_at, e.created_at) desc, r.variant;
end;
$$;
revoke all on function public.admin_foryou_experiments_v1() from public, anon;
grant execute on function public.admin_foryou_experiments_v1() to authenticated;
