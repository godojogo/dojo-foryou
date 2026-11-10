-- Dojo For You — paging stored lists, and topic tabs.

create or replace function public.foryou_store_v3(
  p_profile_id uuid, p_feed text, p_seed bigint, p_post_ids uuid[],
  p_scores jsonb default null, p_meta jsonb default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_profile_id is null or p_profile_id is distinct from private.current_profile_id() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cardinality(p_post_ids) > 2000 or length(p_feed) > 200 then
    raise exception 'too large' using errcode = '22023';
  end if;
  insert into private.foryou_ranked_lists as l (profile_id, feed, seed, post_ids, scores, meta, created_at)
  values (p_profile_id, p_feed, p_seed, p_post_ids, p_scores, p_meta, now())
  on conflict (profile_id, feed, seed) do update
    set post_ids = excluded.post_ids, scores = excluded.scores, meta = excluded.meta, created_at = now();
end;
$$;

-- One page of a stored list, or null when there is none fresh enough (the caller then ranks).
-- The visibility gate and hidden authors are re-applied, so a post taken down, made private or
-- from someone blocked since the list was ranked never comes back.
create or replace function public.foryou_page_v3(
  p_profile_id uuid, p_feed text, p_seed bigint,
  p_offset int default 0, p_limit int default 30, p_exclude uuid[] default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_meta jsonb;
  v_hidden uuid[];
  v_out jsonb;
begin
  if p_profile_id is null or p_profile_id is distinct from private.current_profile_id() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select l.post_ids, l.meta into v_ids, v_meta
  from private.foryou_ranked_lists l
  where l.profile_id = p_profile_id and l.feed = p_feed and l.seed = p_seed
    and l.created_at > now() - interval '10 minutes';
  if v_ids is null then return null; end if;

  v_hidden := private.feed_hidden_authors(p_profile_id);
  with ranked as (
    select u.id, u.ord
    from unnest(v_ids) with ordinality u(id, ord)
    join private.feed_visible_posts v on v.id = u.id
    where v.author_id <> all(v_hidden)
      and u.id <> all(coalesce(p_exclude, '{}'::uuid[]))
  )
  select jsonb_build_object(
    'post_ids', coalesce((
      select jsonb_agg(pg.id order by pg.ord)
      from (select id, ord from ranked order by ord
            offset greatest(p_offset, 0) limit least(greatest(p_limit, 1), 50)) pg), '[]'::jsonb),
    'total_found', (select count(*) from ranked),
    'meta', v_meta
  ) into v_out;
  return v_out;
end;
$$;

-- A topic tab's context: the viewer's filter of that name (trimmed, case-insensitive — names are
-- user-typed and several carry trailing spaces), its vector, hidden authors, and the posts that
-- name the topic in the author's own words, newest first.
create or replace function public.foryou_topic_context_v3(p_profile_id uuid, p_topic text, p_limit int default 300)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hidden uuid[];
  v_filter_id uuid;
  v_vector public.vector;
begin
  if p_profile_id is null or p_profile_id is distinct from private.current_profile_id() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_topic is null or btrim(p_topic) = '' then
    raise exception 'topic is required' using errcode = '22023';
  end if;
  if not public.consume_auth_rate_limit_v1(
       encode(extensions.digest('dojo-foryou-v3:' || auth.uid()::text, 'sha256'), 'hex'), 120, 300) then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  v_hidden := array_append(private.feed_hidden_authors(p_profile_id), p_profile_id);

  select f.id, f.filter_embedding into v_filter_id, v_vector
  from content_filters f
  where f.profile_id = p_profile_id and lower(btrim(f.filter_name)) = lower(btrim(p_topic))
  order by (f.filter_embedding is null), f.created_at
  limit 1;

  return jsonb_build_object(
    'filter_id', v_filter_id,
    'vector', case when v_vector is null then null else private.vec_b64(v_vector) end,
    'hidden_authors', to_jsonb(v_hidden),
    'named', (
      select coalesce(jsonb_agg(m.id), '[]'::jsonb)
      from (
        select v.id
        from post_ai_analysis pa
        join private.feed_visible_posts v on v.id = pa.post_id
        where pa.author_tsv @@ phraseto_tsquery('simple', p_topic)
          and v.author_id <> all(v_hidden)
        order by v.created_at desc
        limit least(greatest(p_limit, 1), 1000)
      ) m
    )
  );
end;
$$;

revoke all on function public.foryou_store_v3(uuid, text, bigint, uuid[], jsonb, jsonb) from public, anon;
revoke all on function public.foryou_page_v3(uuid, text, bigint, int, int, uuid[]) from public, anon;
revoke all on function public.foryou_topic_context_v3(uuid, text, int) from public, anon;
grant execute on function public.foryou_store_v3(uuid, text, bigint, uuid[], jsonb, jsonb) to authenticated;
grant execute on function public.foryou_page_v3(uuid, text, bigint, int, int, uuid[]) to authenticated;
grant execute on function public.foryou_topic_context_v3(uuid, text, int) to authenticated;
