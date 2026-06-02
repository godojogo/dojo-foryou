-- ─── Hydration ───────────────────────────────────────────────────────────────
-- Two pieces the pipeline leans on:
--   rebuild_foryou_context    — a read-through hydration cache (filters, follows,
--                               blocks, the recommendation toggle, seen posts).
--   hydrate_foryou_candidates — ranking features for a candidate set in one pass.

-- Read-through / event-driven rebuild of a user's hydration cache. Derived
-- fields are refreshed from the live tables; user-set preferences
-- (trending_mix_enabled, is_pro) are preserved so a rebuild never clobbers them.
create or replace function public.rebuild_foryou_context(p_profile_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into user_foryou_context_cache as c (
    user_id, content_filters, following_users, blocked_users, seen_post_ids,
    trending_mix_enabled, is_pro, last_updated
  )
  values (
    p_profile_id,
    coalesce((
      select jsonb_agg(jsonb_build_object('id', cf.id, 'intensity', cf.intensity) order by cf.intensity desc)
      from content_filters cf where cf.profile_id = p_profile_id and cf.intensity > 0
    ), '[]'::jsonb),
    coalesce((select array_agg(f.followee_id) from follows f where f.follower_id = p_profile_id), '{}'::uuid[]),
    coalesce((select array_agg(b.blocked_user_id) from blocked_users b where b.user_id = p_profile_id), '{}'::uuid[]),
    coalesce((
      select array_agg(s.post_id) from (
        select pi.post_id, max(pi.created_at) as last_seen
        from post_interactions pi
        where pi.user_id = p_profile_id and pi.interaction_type = 'view'
        group by pi.post_id order by last_seen desc limit 1000
      ) s
    ), '{}'::uuid[]),
    false, false, now()
  )
  on conflict (user_id) do update set
    content_filters = excluded.content_filters,
    following_users = excluded.following_users,
    blocked_users   = excluded.blocked_users,
    seen_post_ids   = excluded.seen_post_ids,
    trending_mix_enabled = c.trending_mix_enabled,  -- preserve user setting
    is_pro          = c.is_pro,
    last_updated    = now();
end;
$$;

-- Candidate Hydration: ranking features for a candidate set in one round-trip.
-- `eligible` encodes: post is public AND (no dojo OR the dojo is public).
create or replace function public.hydrate_foryou_candidates(p_profile_id uuid, p_post_ids uuid[])
returns table(
  post_id uuid, author_id uuid, dojo_id uuid, eligible boolean, is_ad boolean,
  likes_count int, comments_count int, view_count int,
  created_at timestamptz, last_seen_at timestamptz, author_blocked boolean
)
language sql stable security definer set search_path = public as $$
  select
    p.id, p.author_id, p.dojo_id,
    (p.is_public and (p.dojo_id is null or coalesce(d.is_public, false))) as eligible,
    coalesce(p.is_ad, false),
    coalesce(p.likes_count, 0), coalesce(p.comments_count, 0), coalesce(p.view_count, 0),
    p.created_at,
    (select max(pi.created_at) from post_interactions pi
       where pi.post_id = p.id and pi.user_id = p_profile_id and pi.interaction_type = 'view'),
    exists(select 1 from blocked_users b where b.user_id = p_profile_id and b.blocked_user_id = p.author_id)
  from posts p
  left join dojos d on d.id = p.dojo_id
  where p.id = any(p_post_ids);
$$;

-- Optional: keep the hydration cache fresh on the slow-changing inputs. (The
-- feed also rebuilds read-through on a TTL, so triggers are belt-and-suspenders.)
create or replace function public.trg_rebuild_ctx_filters()
returns trigger language plpgsql security definer as $$
begin perform public.rebuild_foryou_context(coalesce(NEW.profile_id, OLD.profile_id)); return coalesce(NEW, OLD); end; $$;
create or replace function public.trg_rebuild_ctx_follows()
returns trigger language plpgsql security definer as $$
begin perform public.rebuild_foryou_context(coalesce(NEW.follower_id, OLD.follower_id)); return coalesce(NEW, OLD); end; $$;
create or replace function public.trg_rebuild_ctx_blocks()
returns trigger language plpgsql security definer as $$
begin perform public.rebuild_foryou_context(coalesce(NEW.user_id, OLD.user_id)); return coalesce(NEW, OLD); end; $$;

drop trigger if exists rebuild_ctx_on_content_filters on public.content_filters;
create trigger rebuild_ctx_on_content_filters after insert or update or delete on public.content_filters
  for each row execute function public.trg_rebuild_ctx_filters();
drop trigger if exists rebuild_ctx_on_follows on public.follows;
create trigger rebuild_ctx_on_follows after insert or delete on public.follows
  for each row execute function public.trg_rebuild_ctx_follows();
drop trigger if exists rebuild_ctx_on_blocks on public.blocked_users;
create trigger rebuild_ctx_on_blocks after insert or delete on public.blocked_users
  for each row execute function public.trg_rebuild_ctx_blocks();
