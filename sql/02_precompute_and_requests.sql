-- Dojo For You — precomputation and the per-request reads.
--
-- Request time does only bounded, indexed reads; vector search stays in Pinecone (it scales out
-- and keeps ANN load off the primary); everything expensive is precomputed:
--   * the user model (interest seeds, avoid vector, taste neighbours) is rebuilt when the user
--     acts — a cron sweep over the last minutes of likes/saves/comments/interactions — and read
--     at request time as a handful of vectors (private.user_taste_vectors);
--   * the global discovery pools (rising, exploration) are rebuilt every minute from bounded
--     inputs (private.foryou_pools);
--   * per-post counters the scorers read (saves, negative actions) are kept by triggers;
--   * the topic-name match reads a full-text index, not a regex over every analysis.
-- Per request: foryou_context_v3 (one read) → Pinecone queries (one parallel wave) →
-- foryou_features_v3 (one read) → foryou_store_v3 (off the response path). Pages 2+:
-- foryou_page_v3 (one read).

-- ── Indexes the bounded reads need ───────────────────────────────────────────
create index if not exists likes_post_created_idx on public.likes (post_id, created_at desc);
create index if not exists likes_user_created_idx on public.likes (user_id, created_at desc);
create index if not exists likes_created_idx on public.likes (created_at desc);
create index if not exists posts_author_created_idx on public.posts (author_id, created_at desc);

-- ── Author-written text, label-free, full-text indexed ───────────────────────
-- Topic-name matching runs on what the author wrote (or chose: the dojo), never on what the
-- vision model or a transcript said about it. Labels are process-post-ai's; keep them in step.
create or replace function private.author_written_text(p_analysis text)
returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select string_agg(regexp_replace(line, '^[^:]+:\s*', ''), ' ')
  from regexp_split_to_table(coalesce(p_analysis, ''), E'\n\n') line
  where line ~ '^(Dojo|Title|Caption|Poll|Poll options|Challenge|Challenge details|Canvas text):'
$$;

alter table public.post_ai_analysis
  add column if not exists author_tsv tsvector
  generated always as (to_tsvector('simple', coalesce(private.author_written_text(analysis_text), ''))) stored;
create index if not exists post_ai_analysis_author_tsv_idx on public.post_ai_analysis using gin (author_tsv);

-- ── Per-post counters the scorers read ───────────────────────────────────────
create table if not exists private.post_feed_counters (
  post_id uuid primary key,
  saves integer not null default 0,
  negatives integer not null default 0
);
alter table private.post_feed_counters enable row level security;

create or replace function private.bump_post_feed_counter()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post uuid := coalesce(new.post_id, old.post_id);
  v_delta int := case tg_op when 'INSERT' then 1 else -1 end;
begin
  if tg_table_name = 'saved_posts' then
    insert into private.post_feed_counters as c (post_id, saves) values (v_post, greatest(v_delta, 0))
    on conflict (post_id) do update set saves = greatest(c.saves + v_delta, 0);
  elsif coalesce(new.interaction_type, old.interaction_type) in ('not_interested', 'hide', 'report') then
    insert into private.post_feed_counters as c (post_id, negatives) values (v_post, greatest(v_delta, 0))
    on conflict (post_id) do update set negatives = greatest(c.negatives + v_delta, 0);
  end if;
  return null;
end;
$$;

drop trigger if exists post_feed_counter_saves on public.saved_posts;
create trigger post_feed_counter_saves after insert or delete on public.saved_posts
  for each row execute function private.bump_post_feed_counter();
drop trigger if exists post_feed_counter_negatives on public.post_interactions;
create trigger post_feed_counter_negatives after insert or delete on public.post_interactions
  for each row execute function private.bump_post_feed_counter();

insert into private.post_feed_counters (post_id, saves, negatives)
select post_id, sum(s)::int, sum(n)::int from (
  select post_id, 1 as s, 0 as n from public.saved_posts
  union all
  select post_id, 0, 1 from public.post_interactions where interaction_type in ('not_interested', 'hide', 'report')
) x group by post_id
on conflict (post_id) do update set saves = excluded.saves, negatives = excluded.negatives;

-- ── Precomputed user model (Yomi) ────────────────────────────────────────────
create table if not exists private.user_taste_vectors (
  profile_id uuid primary key,
  seeds public.vector[] not null default '{}',
  seed_weights double precision[] not null default '{}',
  avoid public.vector,
  neighbours uuid[] not null default '{}',
  neighbour_weights double precision[] not null default '{}',
  built_at timestamptz not null default now()
);
alter table private.user_taste_vectors enable row level security;

-- Interest seeds: greedy diverse pick over the endorsed posts (heaviest first, skipping any too
-- like a seed already taken), then each the weighted centroid of the endorsed posts nearest it —
-- several sharp interests, never one blurry average. Avoid: the weighted blend of everything
-- rejected. Neighbours: people who liked what you recently endorsed, by overlap; each post
-- contributes only its latest 200 likers so one viral post cannot make this unbounded.
create or replace function private.rebuild_user_taste(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_seed_k constant int := 4;
  c_seed_diversity constant double precision := 0.72;
  v_t_emb public.vector[];
  v_t_w double precision[];
  v_seeds public.vector[] := '{}';
  v_seed_w double precision[] := '{}';
  v_avoid public.vector;
  v_nb uuid[];
  v_nb_w double precision[];
  r record;
begin
  select coalesce(array_agg(t.emb order by t.weight desc), '{}'), coalesce(array_agg(t.weight order by t.weight desc), '{}')
    into v_t_emb, v_t_w
  from private.foryou_taste(p_profile_id) t;

  for r in select u.e from unnest(v_t_emb) u(e) loop
    exit when coalesce(array_length(v_seeds, 1), 0) >= c_seed_k;
    if coalesce(array_length(v_seeds, 1), 0) = 0
       or (select min(r.e <=> s) from unnest(v_seeds) s) > 1 - c_seed_diversity then
      v_seeds := array_append(v_seeds, r.e);
    end if;
  end loop;

  if coalesce(array_length(v_seeds, 1), 0) > 0 then
    select array_agg(c.centroid order by c.i), array_agg(c.w order by c.i) into v_seeds, v_seed_w
    from (
      select a.i, sum(private.vec_scale(t.e, t.w)) as centroid, sum(t.w) as w
      from unnest(v_t_emb, v_t_w) t(e, w)
      cross join lateral (
        select i from generate_subscripts(v_seeds, 1) i order by t.e <=> v_seeds[i] limit 1
      ) a
      group by a.i
    ) c;
  end if;

  select sum(private.vec_scale(n.emb, n.weight)) into v_avoid from private.foryou_negative(p_profile_id) n;

  select coalesce(array_agg(n.uid order by n.overlap desc), '{}'), coalesce(array_agg(n.overlap order by n.overlap desc), '{}')
    into v_nb, v_nb_w
  from (
    select l2.user_id as uid, count(*)::float8 as overlap
    from (
      (select l.post_id from likes l where l.user_id = p_profile_id order by l.created_at desc limit 200)
      union
      (select s.post_id from saved_posts s where s.profile_id = p_profile_id order by s.saved_at desc limit 100)
    ) mine
    cross join lateral (
      select l.user_id from likes l
      where l.post_id = mine.post_id and l.user_id <> p_profile_id
      order by l.created_at desc limit 200
    ) l2
    group by l2.user_id
    order by count(*) desc
    limit 50
  ) n;

  insert into private.user_taste_vectors as t
    (profile_id, seeds, seed_weights, avoid, neighbours, neighbour_weights, built_at)
  values (p_profile_id, coalesce(v_seeds, '{}'), coalesce(v_seed_w, '{}'), v_avoid, v_nb, v_nb_w, now())
  on conflict (profile_id) do update set
    seeds = excluded.seeds, seed_weights = excluded.seed_weights, avoid = excluded.avoid,
    neighbours = excluded.neighbours, neighbour_weights = excluded.neighbour_weights, built_at = now();
end;
$$;

-- Rebuild everyone who acted since their model was built. Runs every minute over a 5-minute
-- window (overlap absorbs a missed run); bounded per run.
create or replace function private.refresh_user_tastes(p_max int default 500)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n int := 0;
  r record;
begin
  for r in
    with active as (
      select l.user_id as pid, max(l.created_at) as at from likes l
        where l.created_at > now() - interval '5 minutes' group by 1
      union all
      select s.profile_id, max(s.saved_at) from saved_posts s
        where s.saved_at > now() - interval '5 minutes' group by 1
      union all
      select c.user_id, max(c.created_at) from comments c
        where c.created_at > now() - interval '5 minutes' group by 1
      union all
      select pi.user_id, max(pi.created_at) from post_interactions pi
        where pi.created_at > now() - interval '5 minutes' group by 1
    )
    select a.pid
    from active a
    left join private.user_taste_vectors t on t.profile_id = a.pid
    where a.pid is not null
    group by a.pid, t.built_at
    having t.built_at is null or max(a.at) > t.built_at
    order by max(a.at)
    limit p_max
  loop
    perform private.rebuild_user_taste(r.pid);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ── Global discovery pools ───────────────────────────────────────────────────
create table if not exists private.foryou_pools (
  pool text not null,
  post_id uuid not null,
  author_id uuid not null,
  score double precision not null,
  primary key (pool, post_id)
);
alter table private.foryou_pools enable row level security;
create index if not exists foryou_pools_rank_idx on private.foryou_pools (pool, score desc);

-- rising (the Trending card): engagement velocity of posts from the last 72 hours, computed
--   over posts that drew engagement in that window plus the newest 2,000 — bounded by activity,
--   not by how many posts exist.
-- exploration: the newest 5,000 visible posts from the last 14 days, scored recent and
--   under-exposed; each viewer's unseen filter applies at read time.
create or replace function private.refresh_foryou_pools()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from private.foryou_pools where pool in ('rising', 'exploration');

  insert into private.foryou_pools (pool, post_id, author_id, score)
  select 'rising', v.id, v.author_id,
         (v.likes_count * 3 + v.comments_count * 5 + v.view_count * 0.2)
           / (extract(epoch from (now() - v.created_at)) / 3600.0 + 2)
  from (
    (select l.post_id from likes l where l.created_at > now() - interval '72 hours')
    union
    (select c.post_id from comments c where c.created_at > now() - interval '72 hours')
    union
    (select p.id from posts p
      where p.is_public and not coalesce(p.is_ad, false) and p.created_at > now() - interval '72 hours'
      order by p.created_at desc limit 2000)
  ) e
  join private.feed_visible_posts v on v.id = e.post_id
  where v.created_at > now() - interval '72 hours'
  order by 4 desc
  limit 500;

  insert into private.foryou_pools (pool, post_id, author_id, score)
  select 'exploration', x.id, x.author_id,
         exp(-extract(epoch from (now() - x.created_at)) / (7 * 86400.0)) / (x.view_count + 3)
  from (
    select v.id, v.author_id, v.created_at, v.view_count
    from private.feed_visible_posts v
    where v.created_at > now() - interval '14 days'
    order by v.created_at desc
    limit 5000
  ) x
  order by 4 desc
  limit 1000;
end;
$$;

-- vector → compact base64 (pgvector's binary form: int16 dim, int16 unused, float4 big-endian).
-- ~2.5x smaller than its text form and nothing to parse but bytes.
create or replace function private.vec_b64(v public.vector)
returns text
language sql immutable parallel safe
set search_path = public, pg_temp
as $$ select replace(encode(vector_send(v), 'base64'), E'\n', '') $$;

-- ── Request: the viewer + every candidate that does not need vector search ───
create or replace function public.foryou_context_v3(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trending boolean;
  v_recommend boolean;
  v_hidden uuid[];
  v_taste private.user_taste_vectors;
begin
  if p_profile_id is null or p_profile_id is distinct from private.current_profile_id() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.consume_auth_rate_limit_v1(
       encode(extensions.digest('dojo-foryou-v3:' || auth.uid()::text, 'sha256'), 'hex'), 120, 300) then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  select c.trending_mix_enabled, c.recommended_enabled into v_trending, v_recommend
  from user_foryou_context_cache c where c.user_id = p_profile_id;
  v_trending := coalesce(v_trending, false);
  v_recommend := coalesce(v_recommend, false);
  -- Hidden: authors the viewer blocked, authors who blocked them, and the viewer themself.
  v_hidden := array_append(private.feed_hidden_authors(p_profile_id), p_profile_id);

  if v_recommend then
    select * into v_taste from private.user_taste_vectors t where t.profile_id = p_profile_id;
    if not found then
      perform private.rebuild_user_taste(p_profile_id);
      select * into v_taste from private.user_taste_vectors t where t.profile_id = p_profile_id;
    end if;
  end if;

  return (
    with
    filters as (
      select f.id, f.intensity::float8 as intensity, f.filter_name, f.filter_embedding
      from content_filters f
      where f.profile_id = p_profile_id and f.intensity > 0 and f.filter_embedding is not null
    ),
    -- Kata, named: posts that name the filter in the author's own words (its vector side is
    -- the Pinecone query). Newest first, per filter.
    kata_named as (
      select 'filter'::text as source, f.id as filter_id, f.intensity, m.id as post_id, null::float8 as score
      from filters f
      cross join lateral (
        select v.id
        from post_ai_analysis pa
        join private.feed_visible_posts v on v.id = pa.post_id
        where pa.author_tsv @@ phraseto_tsquery('simple', f.filter_name)
          and v.author_id <> all(v_hidden)
        order by v.created_at desc
        limit 60
      ) m
    ),
    rising as (
      select 'rising'::text as source, null::uuid as filter_id, 1::float8 as intensity, p.post_id, p.score
      from private.foryou_pools p
      where v_trending and p.pool = 'rising' and p.author_id <> all(v_hidden)
      order by p.score desc
      limit 60
    ),
    exploration as (
      select 'exploration'::text as source, null::uuid as filter_id, 1::float8 as intensity, p.post_id, p.score
      from private.foryou_pools p
      where v_recommend and p.pool = 'exploration' and p.author_id <> all(v_hidden)
        and not exists (select 1 from post_interactions pi
                        where pi.user_id = p_profile_id and pi.post_id = p.post_id and pi.interaction_type = 'view')
      order by p.score desc
      limit 40
    ),
    -- affinity: recent unseen posts from people you follow (1.0) and from your dojos (0.5).
    -- Bounded: your 1,000 most recent follows × their 3 newest posts; your dojos × 5 newest.
    affine as (
      select m.id, m.created_at, 1.0::float8 as w
      from (select f.followee_id from follows f
            where v_recommend and f.follower_id = p_profile_id
            order by f.created_at desc limit 1000) fo
      cross join lateral (
        select p.id, p.created_at from posts p
        where p.author_id = fo.followee_id and p.created_at > now() - interval '30 days'
        order by p.created_at desc limit 3
      ) m
      union all
      select m.id, m.created_at, 0.5
      from (select dm.dojo_id from dojo_members dm
            where v_recommend and dm.profile_id = p_profile_id limit 200) dj
      cross join lateral (
        select p.id, p.created_at from posts p
        where p.dojo_id = dj.dojo_id and p.created_at > now() - interval '30 days'
        order by p.created_at desc limit 5
      ) m
    ),
    affinity as (
      select 'affinity'::text as source, null::uuid as filter_id, 1::float8 as intensity, a.id as post_id,
             max(a.w) * exp(-extract(epoch from (now() - a.created_at)) / (7 * 86400.0)) as score
      from affine a
      join private.feed_visible_posts v on v.id = a.id
      where v.author_id <> all(v_hidden)
        and not exists (select 1 from post_interactions pi
                        where pi.user_id = p_profile_id and pi.post_id = a.id and pi.interaction_type = 'view')
      group by a.id, a.created_at
      order by 5 desc
      limit 40
    ),
    -- collaborative: what your taste neighbours liked lately, weighted by overlap, minus what
    -- you already endorsed. Bounded: 50 neighbours × their 20 newest likes.
    collaborative as (
      select 'collaborative'::text as source, null::uuid as filter_id, 1::float8 as intensity, l.post_id,
             sum(n.w) as score
      from unnest(coalesce(v_taste.neighbours, '{}'), coalesce(v_taste.neighbour_weights, '{}')) n(uid, w)
      cross join lateral (
        select l.post_id from likes l where l.user_id = n.uid order by l.created_at desc limit 20
      ) l
      join private.feed_visible_posts v on v.id = l.post_id
      where v_recommend and v.author_id <> all(v_hidden)
        and not exists (select 1 from likes x where x.user_id = p_profile_id and x.post_id = l.post_id)
        and not exists (select 1 from saved_posts x where x.profile_id = p_profile_id and x.post_id = l.post_id)
      group by l.post_id
      order by 5 desc
      limit 60
    ),
    seeds as (
      select s.vec, s.w / nullif(sum(s.w) over (), 0) as share
      from unnest(coalesce(v_taste.seeds, '{}'), coalesce(v_taste.seed_weights, '{}')) s(vec, w)
    )
    select jsonb_build_object(
      'trending_on', v_trending,
      'recommend_on', v_recommend,
      'hidden_authors', to_jsonb(v_hidden),
      'filters', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', id, 'intensity', intensity, 'vector', private.vec_b64(filter_embedding))), '[]') from filters),
      'interest_seeds', (select coalesce(jsonb_agg(jsonb_build_object(
          'share', share, 'vector', private.vec_b64(vec))), '[]') from seeds where v_recommend),
      'candidates', (select coalesce(jsonb_agg(jsonb_build_object(
          'post_id', post_id, 'source', source, 'filter_id', filter_id, 'intensity', intensity, 'score', score)), '[]')
        from (
          select * from kata_named
          union all select * from rising
          union all select * from exploration
          union all select * from affinity
          union all select * from collaborative
        ) c)
    )
  );
end;
$$;

-- ── Request: features for the merged candidate set (the authoritative gate) ──
-- Pinecone's copy can lag a privacy change by the post-AI queue's minute; this read applies the
-- live visibility rule and hidden authors, so a candidate that is no longer visible drops here.
create or replace function public.foryou_features_v3(p_profile_id uuid, p_post_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_hidden uuid[];
  v_avoid public.vector;
begin
  if p_profile_id is null or p_profile_id is distinct from private.current_profile_id() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cardinality(p_post_ids) > 1000 then
    raise exception 'too many posts' using errcode = '22023';
  end if;
  v_hidden := array_append(private.feed_hidden_authors(p_profile_id), p_profile_id);
  select t.avoid into v_avoid from private.user_taste_vectors t where t.profile_id = p_profile_id;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'post_id', v.id,
      'author_id', v.author_id,
      'created_at', v.created_at,
      'likes_count', v.likes_count,
      'comments_count', v.comments_count,
      'view_count', v.view_count,
      'saves_count', coalesce(c.saves, 0),
      'negative_count', coalesce(c.negatives, 0),
      'last_seen_at', (select greatest(pi.created_at, coalesce(pi.updated_at, pi.created_at)) from post_interactions pi
                        where pi.user_id = p_profile_id and pi.post_id = v.id and pi.interaction_type = 'view'),
      'in_network', exists (select 1 from follows f where f.follower_id = p_profile_id and f.followee_id = v.author_id),
      'negative_similarity', case when v_avoid is null or v.post_embedding is null then null
                                  else 1 - (v.post_embedding <=> v_avoid) end
    )), '[]'::jsonb)
    from private.feed_visible_posts v
    left join private.post_feed_counters c on c.post_id = v.id
    where v.id = any(p_post_ids) and v.author_id <> all(v_hidden)
  );
end;
$$;

revoke all on function public.foryou_context_v3(uuid) from public, anon;
revoke all on function public.foryou_features_v3(uuid, uuid[]) from public, anon;
grant execute on function public.foryou_context_v3(uuid) to authenticated;
grant execute on function public.foryou_features_v3(uuid, uuid[]) to authenticated;
revoke all on function private.rebuild_user_taste(uuid) from public, anon, authenticated;
revoke all on function private.refresh_user_tastes(int) from public, anon, authenticated;
revoke all on function private.refresh_foryou_pools() from public, anon, authenticated;
revoke all on function private.vec_b64(public.vector) from public, anon, authenticated;
revoke all on function private.bump_post_feed_counter() from public, anon, authenticated;

select private.refresh_foryou_pools();

select cron.schedule('foryou-pools-1m', '* * * * *', $$select private.refresh_foryou_pools()$$);
select cron.schedule('foryou-user-taste-1m', '* * * * *', $$select private.refresh_user_tastes(500)$$);
