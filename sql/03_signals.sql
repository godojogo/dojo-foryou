-- ─── Mushin discovery signals ────────────────────────────────────────────────
-- Beyond taste-match (vector search in the edge function), Mushin blends several
-- discovery signals. Each returns post_id + a raw score; the engine normalizes
-- and combines them. All degrade gracefully to zero rows while data is thin.

-- Collaborative: neighbors by like-overlap; recommend their likes you haven't
-- engaged with. "People whose taste overlaps yours loved these."
create or replace function public.mushin_collaborative(p_profile_id uuid, p_limit int default 60)
returns table(post_id uuid, score numeric)
language sql stable security definer set search_path = public as $$
  with my_posts as (
    select distinct post_id from (
      select post_id from likes where user_id = p_profile_id
      union select post_id from comments where user_id = p_profile_id
      union select post_id from saved_posts where profile_id = p_profile_id
      union select post_id from post_interactions
        where user_id = p_profile_id and interaction_type = 'view' and coalesce(dwell_time_seconds,0) >= 5
    ) t
  ),
  neighbors as (
    select l.user_id as uid, count(*)::numeric as overlap
    from likes l join my_posts m on m.post_id = l.post_id
    where l.user_id <> p_profile_id group by l.user_id
  ),
  recs as (
    select l.post_id, sum(n.overlap) as score
    from likes l join neighbors n on n.uid = l.user_id
    where l.post_id not in (select post_id from my_posts) group by l.post_id
  )
  select r.post_id, r.score from recs r join posts p on p.id = r.post_id
  where p.is_public = true and p.is_ad = false
  order by r.score desc limit p_limit;
$$;

-- Rising: recent posts by engagement velocity (engagement per hour since posting).
create or replace function public.mushin_rising(p_limit int default 60, p_hours int default 72)
returns table(post_id uuid, score numeric)
language sql stable security definer set search_path = public as $$
  select p.id,
    ((coalesce(p.likes_count,0)*3 + coalesce(p.comments_count,0)*5 + coalesce(p.view_count,0)*0.2)
      / (extract(epoch from (now() - p.created_at)) / 3600.0 + 2))::numeric
  from posts p
  where p.is_public = true and p.is_ad = false
    and p.created_at > now() - (p_hours || ' hours')::interval
  order by 2 desc limit p_limit;
$$;

-- Exploration: recent, under-exposed, unseen posts (fights the filter bubble,
-- gives new posts a fair shot). score = freshness / (views + k).
create or replace function public.mushin_exploration(p_profile_id uuid, p_limit int default 40, p_days int default 14)
returns table(post_id uuid, score numeric)
language sql stable security definer set search_path = public as $$
  select p.id,
    (exp(-extract(epoch from (now() - p.created_at)) / (7 * 86400.0)) / (coalesce(p.view_count,0) + 3))::numeric
  from posts p
  where p.is_public = true and p.is_ad = false and p.author_id <> p_profile_id
    and p.created_at > now() - (p_days || ' days')::interval
    and not exists (select 1 from post_interactions pi
                    where pi.user_id = p_profile_id and pi.post_id = p.id and pi.interaction_type = 'view')
  order by 2 desc limit p_limit;
$$;

-- Affinity: recent unseen posts from people you follow or share a dojo with.
create or replace function public.mushin_affinity(p_profile_id uuid, p_limit int default 40, p_days int default 30)
returns table(post_id uuid, score numeric)
language sql stable security definer set search_path = public as $$
  with affine_authors as (
    select followee_id as author_id, 1.0::numeric as w from follows where follower_id = p_profile_id
    union
    select dm2.profile_id, 0.5 from dojo_members dm1
      join dojo_members dm2 on dm2.dojo_id = dm1.dojo_id and dm2.profile_id <> p_profile_id
    where dm1.profile_id = p_profile_id
  ),
  scored as (
    select p.id as post_id,
      max(aa.w) * exp(-extract(epoch from (now() - p.created_at)) / (7 * 86400.0)) as score
    from posts p join affine_authors aa on aa.author_id = p.author_id
    where p.is_public = true and p.is_ad = false
      and p.created_at > now() - (p_days || ' days')::interval
      and not exists (select 1 from post_interactions pi
                      where pi.user_id = p_profile_id and pi.post_id = p.id and pi.interaction_type = 'view')
    group by p.id, p.created_at
  )
  select post_id, score::numeric from scored order by score desc limit p_limit;
$$;
