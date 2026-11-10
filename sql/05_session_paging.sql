-- For You paging that reacts within the session (dojo-foryou-v3 reads pages 2+ through this).
--
-- foryou_page_v3 serves the rest of a session from the list ranked at its start, so a "not
-- interested" took effect only at the next refresh (the avoid vector, user_taste_vectors). v4 is
-- v3 plus: anything the viewer marks not interested during the session leaves the remaining
-- pages — the post itself, the rest of its author's posts, and close look-alikes (cosine
-- similarity >= 0.85 to it, near-duplicates and the same subject, not merely the same topic:
-- on-topic posts sit at 0.41-0.51 to their topic).
--
-- Page boundaries stay where the stored order puts them: removals only shorten the page they fall
-- in, so a removal never shifts later offsets (which would skip posts the viewer hasn't seen).
-- p_exclude keeps v3's meaning (posts already on screen at a refresh, filtered before paging).

set local lock_timeout = '5s';

create or replace function public.foryou_page_v4(
  p_profile_id uuid,
  p_feed text,
  p_seed bigint,
  p_offset integer default 0,
  p_limit integer default 30,
  p_exclude uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_meta jsonb;
  v_ranked_at timestamptz;
  v_hidden uuid[];
  v_dismissed uuid[];
  v_dismissed_authors uuid[];
  v_out jsonb;
begin
  if p_profile_id is null or p_profile_id is distinct from private.current_profile_id() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select l.post_ids, l.meta, l.created_at into v_ids, v_meta, v_ranked_at
  from private.foryou_ranked_lists l
  where l.profile_id = p_profile_id and l.feed = p_feed and l.seed = p_seed
    and l.created_at > now() - interval '10 minutes';
  if v_ids is null then return null; end if;

  v_hidden := private.feed_hidden_authors(p_profile_id);

  -- Marked not interested since this session's list was ranked.
  select coalesce(array_agg(pi.post_id), '{}'), coalesce(array_agg(distinct p.author_id), '{}')
  into v_dismissed, v_dismissed_authors
  from public.post_interactions pi
  join public.posts p on p.id = pi.post_id
  where pi.user_id = p_profile_id
    and pi.interaction_type = 'not_interested'
    and coalesce(pi.updated_at, pi.created_at) >= v_ranked_at;

  with ranked as (
    select u.id, u.ord, v.author_id
    from unnest(v_ids) with ordinality u(id, ord)
    join private.feed_visible_posts v on v.id = u.id
    where v.author_id <> all(v_hidden)
      and u.id <> all(coalesce(p_exclude, '{}'::uuid[]))
  ),
  page as (
    select r.id, r.ord, r.author_id
    from ranked r
    order by r.ord
    offset greatest(p_offset, 0) limit least(greatest(p_limit, 1), 50)
  ),
  kept as (
    select pg.id, pg.ord
    from page pg
    where cardinality(v_dismissed) = 0
       or (pg.id <> all(v_dismissed)
           and pg.author_id <> all(v_dismissed_authors)
           and not exists (
             select 1
             from public.posts a, public.posts d
             where a.id = pg.id
               and d.id = any(v_dismissed)
               and a.post_embedding is not null and d.post_embedding is not null
               and (a.post_embedding operator(public.<=>) d.post_embedding) <= 0.15
           ))
  )
  select jsonb_build_object(
    'post_ids', coalesce((select jsonb_agg(k.id order by k.ord) from kept k), '[]'::jsonb),
    'total_found', (select count(*) from ranked),
    'meta', v_meta || jsonb_build_object('dismissed_in_session', cardinality(v_dismissed))
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.foryou_page_v4(uuid, text, bigint, integer, integer, uuid[]) from public, anon;
grant execute on function public.foryou_page_v4(uuid, text, bigint, integer, integer, uuid[]) to authenticated;
