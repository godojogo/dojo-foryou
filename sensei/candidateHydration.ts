// Stage 3 — Candidate Hydration.
// Pulls ranking features for the whole candidate set in one Postgres round-trip
// (engagement, recency, author, dojo eligibility, last-seen, block status) via
// the hydrate_foryou_candidates RPC.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CandidateFeatures } from '../lib/types.ts';

export async function hydrateCandidates(
  supabase: SupabaseClient,
  profileId: string,
  postIds: string[],
): Promise<Map<string, CandidateFeatures>> {
  const out = new Map<string, CandidateFeatures>();
  if (postIds.length === 0) return out;

  const { data, error } = await supabase.rpc('hydrate_foryou_candidates', {
    p_profile_id: profileId,
    p_post_ids: postIds,
  });
  if (error) {
    console.error('hydrate_foryou_candidates failed:', error.message);
    return out;
  }

  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    out.set(r.post_id as string, {
      postId: r.post_id as string,
      authorId: r.author_id as string,
      dojoId: (r.dojo_id as string) ?? null,
      eligible: Boolean(r.eligible),
      isAd: Boolean(r.is_ad),
      likesCount: Number(r.likes_count) || 0,
      commentsCount: Number(r.comments_count) || 0,
      viewCount: Number(r.view_count) || 0,
      createdAt: r.created_at as string,
      lastSeenAt: (r.last_seen_at as string) ?? null,
      authorBlocked: Boolean(r.author_blocked),
    });
  }
  return out;
}
