-- Dojo For You — foundation: the one visibility rule, hidden authors, the user-model inputs
-- (endorsements and rejections, by trust), and the stored ranked lists.
-- Postgres 15+, pgvector 0.8+, pgcrypto, pg_cron. Assumes Dojo's tables (posts, dojos, likes,
-- comments, saved_posts, post_interactions, follows, dojo_members, blocked_users,
-- content_filters, user_foryou_context_cache, post_ai_analysis) and private.current_profile_id().

-- ── One visibility rule ──────────────────────────────────────────────────────
create or replace view private.feed_visible_posts as
select p.id, p.author_id, p.dojo_id, p.post_embedding, p.created_at,
       coalesce(p.likes_count, 0)    as likes_count,
       coalesce(p.comments_count, 0) as comments_count,
       coalesce(p.view_count, 0)     as view_count
from public.posts p
where p.is_public
  and not coalesce(p.dojo_only, false)
  and not coalesce(p.taken_down, false)
  and not coalesce(p.is_ad, false)
  and (p.dojo_id is null or exists (
        select 1 from public.dojos d where d.id = p.dojo_id and coalesce(d.is_public, false)));

revoke all on private.feed_visible_posts from public, anon, authenticated;

-- Authors hidden from a viewer: ones they blocked AND ones who blocked them.
create or replace function private.feed_hidden_authors(p_profile_id uuid)
returns uuid[]
language sql stable
set search_path = ''
as $$
  select coalesce(array_agg(x), '{}'::uuid[]) from (
    select b.blocked_user_id as x from public.blocked_users b where b.user_id = p_profile_id
    union
    select b.user_id from public.blocked_users b where b.blocked_user_id = p_profile_id
  ) h
$$;

-- ── The user model (Yomi) inputs ─────────────────────────────────────────────
-- Posts the viewer genuinely endorsed. Same trust hierarchy as get_user_taste_profile, plus
-- shares, and returning the vector itself rather than its text form.
create or replace function private.foryou_taste(p_profile_id uuid, p_limit int default 50)
returns table(post_id uuid, emb public.vector, weight double precision)
language sql stable
set search_path = public, pg_temp
as $$
  with positives as (
    select s.post_id, 3.0::float8 as w, s.saved_at as ts from saved_posts s where s.profile_id = p_profile_id
    union all
    select pi.post_id, 2.5, pi.created_at from post_interactions pi
      where pi.user_id = p_profile_id and pi.interaction_type = 'share'
    union all
    select c.post_id, 2.0, c.created_at from comments c where c.user_id = p_profile_id
    union all
    select l.post_id, 1.5, l.created_at from likes l where l.user_id = p_profile_id
  ),
  -- Dwell only corroborates a post that also got a positive action: volume, not direction.
  corroborating_dwell as (
    select pi.post_id, 0.5::float8 as w, pi.created_at as ts
    from post_interactions pi
    where pi.user_id = p_profile_id
      and ((pi.interaction_type = 'view'  and coalesce(pi.dwell_time_seconds, 0) >= 8)
        or (pi.interaction_type = 'click' and coalesce(pi.dwell_time_seconds, 0) >= 15))
      and exists (select 1 from positives po where po.post_id = pi.post_id)
  ),
  per_post as (
    select s.post_id, sum(s.w * exp(-extract(epoch from (now() - s.ts)) / (21 * 86400.0))) as w
    from (select * from positives union all select * from corroborating_dwell) s
    group by s.post_id
  ),
  durable_authors as (
    select p.author_id from positives po join posts p on p.id = po.post_id
    group by p.author_id having count(distinct date_trunc('day', po.ts)) >= 2
  )
  select pp.post_id, p.post_embedding,
         pp.w * case when p.author_id in (select author_id from durable_authors) then 1.4 else 1.0 end
  from per_post pp join posts p on p.id = pp.post_id
  where p.post_embedding is not null and p.is_public
  order by 3 desc
  limit p_limit
$$;

-- Posts the viewer rejected: explicit (not interested / hide / report), feed fast-skips and
-- detail opens they bounced from without acting.
create or replace function private.foryou_negative(p_profile_id uuid, p_limit int default 80)
returns table(post_id uuid, emb public.vector, weight double precision)
language sql stable
set search_path = public, pg_temp
as $$
  with neg as (
    select pi.post_id, 2.0::float8 as base, pi.created_at as ts
    from post_interactions pi
    where pi.user_id = p_profile_id and pi.interaction_type in ('not_interested', 'hide', 'report')
    union all
    select pi.post_id, 0.5, pi.created_at
    from post_interactions pi
    where pi.user_id = p_profile_id and pi.interaction_type = 'view'
      and coalesce(pi.dwell_time_seconds, 0) < 2 and coalesce(pi.viewport_percentage, 0) >= 60
      and not exists (select 1 from likes l where l.user_id = p_profile_id and l.post_id = pi.post_id)
      and not exists (select 1 from saved_posts s where s.profile_id = p_profile_id and s.post_id = pi.post_id)
    union all
    select pi.post_id, 0.8, pi.created_at
    from post_interactions pi
    where pi.user_id = p_profile_id and pi.interaction_type = 'click'
      and coalesce(pi.dwell_time_seconds, 0) < 4
      and not exists (select 1 from likes l where l.user_id = p_profile_id and l.post_id = pi.post_id)
      and not exists (select 1 from saved_posts s where s.profile_id = p_profile_id and s.post_id = pi.post_id)
      and not exists (select 1 from comments c where c.user_id = p_profile_id and c.post_id = pi.post_id)
  )
  select n.post_id, p.post_embedding, sum(n.base * exp(-extract(epoch from (now() - n.ts)) / (14 * 86400.0)))
  from neg n join posts p on p.id = n.post_id
  where p.post_embedding is not null
  group by n.post_id, p.post_embedding
  order by 3 desc
  limit p_limit
$$;

-- vector × scalar (pgvector multiplies element-wise only). Cosine is scale-invariant, so a
-- weighted SUM is as good as a weighted mean for every use below.
create or replace function private.vec_scale(v public.vector, s double precision)
returns public.vector
language sql immutable parallel safe
set search_path = public, pg_temp
as $$ select v * array_fill(s::real, array[vector_dims(v)])::vector $$;

-- ── Ranked lists: rank once per (viewer, feed, seed), page from the stored order ──
create table if not exists private.foryou_ranked_lists (
  profile_id uuid not null,
  feed text not null default 'foryou',   -- 'foryou' or 'topic:<name>'
  seed bigint not null,
  post_ids uuid[] not null,
  -- What was ranked, with each candidate's score parts: training data for a learned ranker.
  scores jsonb,
  meta jsonb,
  created_at timestamptz not null default now(),
  primary key (profile_id, feed, seed)
);
alter table private.foryou_ranked_lists enable row level security;
create index if not exists foryou_ranked_lists_created_at_idx on private.foryou_ranked_lists (created_at);

revoke all on function private.foryou_taste(uuid, int) from public, anon, authenticated;
revoke all on function private.foryou_negative(uuid, int) from public, anon, authenticated;
revoke all on function private.feed_hidden_authors(uuid) from public, anon, authenticated;

-- Served lists are kept 30 days (training window), then dropped.
select cron.schedule('foryou-ranked-lists-trim', '17 4 * * *',
  $$delete from private.foryou_ranked_lists where created_at < now() - interval '30 days'$$);
