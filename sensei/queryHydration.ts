// Stage 1 — Query Hydration.
// Loads the requesting user's content filters (with embeddings, for retrieval),
// follows, blocks, and recommendation toggle. Uses the read-through cache: if
// user_foryou_context_cache is stale/missing, rebuild_foryou_context() refreshes
// it first, so the cache can never strand us on old data.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG } from '../lib/config.ts';
import { UserContext, FilterContext } from '../lib/types.ts';

const CACHE_COLS = 'following_users, blocked_users, trending_mix_enabled, is_pro, last_updated';

export async function hydrateUser(supabase: SupabaseClient, profileId: string): Promise<UserContext> {
  let { data: ctx } = await supabase
    .from('user_foryou_context_cache')
    .select(CACHE_COLS)
    .eq('user_id', profileId)
    .maybeSingle();

  const stale =
    !ctx ||
    !ctx.last_updated ||
    Date.now() - new Date(ctx.last_updated as string).getTime() > CONFIG.contextTtlSeconds * 1000;

  if (stale) {
    await supabase.rpc('rebuild_foryou_context', { p_profile_id: profileId });
    const { data: fresh } = await supabase
      .from('user_foryou_context_cache')
      .select(CACHE_COLS)
      .eq('user_id', profileId)
      .maybeSingle();
    ctx = fresh ?? ctx;
  }

  // Embeddings are deliberately NOT cached (too large) — fetched fresh as text
  // to avoid float truncation, then parsed.
  const { data: filterRows } = await supabase
    .from('content_filters')
    .select('id, intensity, filter_embedding::text')
    .eq('profile_id', profileId)
    .gt('intensity', 0)
    .not('filter_embedding', 'is', null);

  const filters: FilterContext[] = (filterRows ?? [])
    .map((f: { id: string; intensity: number; filter_embedding: string }) => ({
      id: f.id,
      intensity: Number(f.intensity),
      embedding: JSON.parse(f.filter_embedding) as number[],
    }))
    .filter((f) => Array.isArray(f.embedding) && f.embedding.length === CONFIG.vectorDim);

  return {
    profileId,
    filters,
    following: (ctx?.following_users as string[]) ?? [],
    blocked: (ctx?.blocked_users as string[]) ?? [],
    trendingOn: Boolean(ctx?.trending_mix_enabled),
    isPro: Boolean(ctx?.is_pro),
  };
}
