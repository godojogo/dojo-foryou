-- ─── The signal model: "happy to see more" vs "one-off / discomfort" ─────────
-- The heart of recommendation quality. These two functions classify a user's
-- behavior into a POSITIVE taste profile and a NEGATIVE profile, applying a
-- TRUST HIERARCHY:
--   * explicit actions (save > comment > like) are trustworthy endorsements
--   * raw dwell is NOT a direction — it only counts as corroboration on a post
--     the user ALSO acted on (a long stare can be discomfort, not love)
--   * durability/seeking (engaging an author across multiple days) boosts
--   * fast-skip, "not interested", and open-then-bounce are negatives
--
-- Returns embeddings (pgvector, ::text) + a weight; the engine builds the
-- multi-interest and "avoid" vectors from these.

create or replace function public.get_user_taste_profile(p_profile_id uuid, p_limit int default 50)
returns table(post_id uuid, embedding text, weight numeric)
language sql stable security definer set search_path = public as $$
  with
  positives as (
    select post_id, 3.0::numeric as w, saved_at as ts from saved_posts where profile_id = p_profile_id
    union all
    select post_id, 2.0, created_at from comments where user_id = p_profile_id
    union all
    select post_id, 1.5, created_at from likes where user_id = p_profile_id
  ),
  -- Dwell counts ONLY as corroboration on a post that also got a positive
  -- action: a feed view >=8s, or a detail-open read >=15s.
  corroborating_dwell as (
    select pi.post_id, 0.5::numeric as w, pi.created_at as ts
    from post_interactions pi
    where pi.user_id = p_profile_id
      and ((pi.interaction_type = 'view'  and coalesce(pi.dwell_time_seconds,0) >= 8)
        or (pi.interaction_type = 'click' and coalesce(pi.dwell_time_seconds,0) >= 15))
      and exists (select 1 from positives po where po.post_id = pi.post_id)
  ),
  signals as (select * from positives union all select * from corroborating_dwell),
  per_post as (
    select s.post_id, sum(s.w * exp(-extract(epoch from (now() - s.ts)) / (21 * 86400.0))) as base_weight
    from signals s group by s.post_id
  ),
  durable_authors as (
    select p.author_id from positives po join posts p on p.id = po.post_id
    group by p.author_id having count(distinct date_trunc('day', po.ts)) >= 2
  )
  select pp.post_id, p.post_embedding::text,
    (pp.base_weight * case when p.author_id in (select author_id from durable_authors) then 1.4 else 1.0 end)::numeric
  from per_post pp join posts p on p.id = pp.post_id
  where p.post_embedding is not null and p.is_public = true
  order by 3 desc limit p_limit;
$$;

create or replace function public.get_user_negative_profile(p_profile_id uuid, p_limit int default 30)
returns table(post_id uuid, embedding text, weight numeric)
language sql stable security definer set search_path = public as $$
  with neg as (
    select pi.post_id, 2.0::numeric as base, pi.created_at as ts
    from post_interactions pi
    where pi.user_id = p_profile_id and pi.interaction_type in ('not_interested', 'hide', 'report')
    union all
    -- feed fast-skip: saw it, bounced under 2s, never acted
    select pi.post_id, 0.5, pi.created_at
    from post_interactions pi
    where pi.user_id = p_profile_id and pi.interaction_type = 'view'
      and coalesce(pi.dwell_time_seconds,0) < 2 and coalesce(pi.viewport_percentage,0) >= 60
      and not exists (select 1 from likes l where l.user_id = p_profile_id and l.post_id = pi.post_id)
      and not exists (select 1 from saved_posts s where s.profile_id = p_profile_id and s.post_id = pi.post_id)
    union all
    -- opened the detail but bounced fast (<4s) with no positive action:
    -- the "stare then leave" discomfort/curiosity tell.
    select pi.post_id, 0.8, pi.created_at
    from post_interactions pi
    where pi.user_id = p_profile_id and pi.interaction_type = 'click'
      and coalesce(pi.dwell_time_seconds,0) < 4
      and not exists (select 1 from likes l where l.user_id = p_profile_id and l.post_id = pi.post_id)
      and not exists (select 1 from saved_posts s where s.profile_id = p_profile_id and s.post_id = pi.post_id)
      and not exists (select 1 from comments c where c.user_id = p_profile_id and c.post_id = pi.post_id)
  ),
  weighted as (
    select n.post_id, sum(n.base * exp(-extract(epoch from (now() - n.ts)) / (14 * 86400.0))) as weight
    from neg n group by n.post_id
  )
  select w.post_id, p.post_embedding::text, w.weight
  from weighted w join posts p on p.id = w.post_id
  where p.post_embedding is not null
  order by w.weight desc limit p_limit;
$$;
