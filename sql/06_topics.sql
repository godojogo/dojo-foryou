-- Topics for feed diversity (dojo-foryou-v3 scoring/topicDiversityScorer.ts).
--
-- The ranker already spreads authors; this lets it spread subjects too, so a feed doesn't serve
-- ten near-identical posts in a row. Posts have no topic label, and topic tabs come from each
-- viewer's own filters, so the topics are learned: k-means over post embeddings.
--
--   private.topic_centroids   the cluster centres, refit weekly from a bounded random sample
--   private.post_topics       each post's nearest centre: set by trigger when a post's embedding
--                             is written (32 distance checks), and for every post at each refit
--   foryou_features_v4        foryou_features_v3 plus each candidate's topic
--
-- The number of clusters scales with the data (one per ~10 posts, up to 32), so a small catalogue
-- isn't split into clusters of one. Topic ids are only compared within one ranking, so a refit
-- renumbering them is harmless; the refit replaces centres and assignments in one transaction.

set local lock_timeout = '5s';

create table if not exists private.topic_centroids (
  id smallint primary key,
  centroid public.vector(1536) not null,
  size integer not null,
  fitted_at timestamptz not null default now()
);
alter table private.topic_centroids enable row level security;

create table if not exists private.post_topics (
  post_id uuid primary key references public.posts(id) on delete cascade,
  topic smallint not null,
  assigned_at timestamptz not null default now()
);
alter table private.post_topics enable row level security;

create or replace function private.nearest_topic(p_embedding public.vector)
returns smallint
language sql
stable
set search_path = ''
as $$
  select c.id from private.topic_centroids c
  order by c.centroid operator(public.<=>) p_embedding
  limit 1;
$$;

-- Lloyd's k-means on a random sample, then every embedded post assigned to its nearest centre.
create or replace function private.fit_topic_centroids(p_k integer default 32, p_sample integer default 10000, p_iters integer default 8)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
  v_k integer;
begin
  drop table if exists pg_temp._topic_sample, pg_temp._topic_centres, pg_temp._topic_assign;
  create temp table _topic_sample as
    select p.id, p.post_embedding as v
    from public.posts p
    where p.post_embedding is not null
    order by random()
    limit greatest(p_sample, 1);
  select count(*) into v_n from pg_temp._topic_sample;
  v_k := least(p_k, v_n / 10);
  if v_k < 2 then
    return 0;
  end if;

  create temp table _topic_centres as
    select (row_number() over () - 1)::smallint as id, s.v as centroid
    from (select v from pg_temp._topic_sample order by random() limit v_k) s;

  for i in 1..greatest(p_iters, 1) loop
    drop table if exists pg_temp._topic_assign;
    create temp table _topic_assign as
      select s.id, s.v,
             (select c.id from pg_temp._topic_centres c order by c.centroid operator(public.<=>) s.v limit 1) as cid
      from pg_temp._topic_sample s;
    update pg_temp._topic_centres c
    set centroid = x.mean
    from (select a.cid, public.avg(a.v) as mean from pg_temp._topic_assign a group by a.cid) x
    where c.id = x.cid;
  end loop;

  delete from private.topic_centroids;
  insert into private.topic_centroids (id, centroid, size, fitted_at)
  select c.id, c.centroid, (select count(*) from pg_temp._topic_assign a where a.cid = c.id), now()
  from pg_temp._topic_centres c;

  insert into private.post_topics (post_id, topic, assigned_at)
  select p.id, private.nearest_topic(p.post_embedding), now()
  from public.posts p
  where p.post_embedding is not null
  on conflict (post_id) do update set topic = excluded.topic, assigned_at = excluded.assigned_at;

  drop table if exists pg_temp._topic_sample, pg_temp._topic_centres, pg_temp._topic_assign;
  return v_k;
end;
$$;
revoke all on function private.fit_topic_centroids(integer, integer, integer) from public, anon, authenticated;

-- A post's topic as soon as its embedding is written. Never blocks the post write.
create or replace function private.assign_post_topic()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.post_embedding is not null and exists (select 1 from private.topic_centroids) then
    begin
      insert into private.post_topics (post_id, topic, assigned_at)
      values (new.id, private.nearest_topic(new.post_embedding), now())
      on conflict (post_id) do update set topic = excluded.topic, assigned_at = excluded.assigned_at;
    exception when others then
      raise warning 'assign_post_topic % failed: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_assign_post_topic on public.posts;
create trigger trg_assign_post_topic
  after insert or update of post_embedding on public.posts
  for each row execute function private.assign_post_topic();

-- foryou_features_v3 plus the candidate's topic.
create or replace function public.foryou_features_v4(p_profile_id uuid, p_post_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
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
                                  else 1 - (v.post_embedding <=> v_avoid) end,
      'topic', t.topic
    )), '[]'::jsonb)
    from private.feed_visible_posts v
    left join private.post_feed_counters c on c.post_id = v.id
    left join private.post_topics t on t.post_id = v.id
    where v.id = any(p_post_ids) and v.author_id <> all(v_hidden)
  );
end;
$$;
revoke all on function public.foryou_features_v4(uuid, uuid[]) from public, anon;
grant execute on function public.foryou_features_v4(uuid, uuid[]) to authenticated;

-- Refit weekly (Sunday 04:20 UTC).
select cron.schedule('foryou-topics-weekly', '20 4 * * 0', $$select private.fit_topic_centroids()$$);
