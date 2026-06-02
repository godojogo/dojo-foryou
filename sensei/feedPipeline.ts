// ─── SENSEI ──────────────────────────────────────────────────────────────────
// The orchestrator. Sensei assembles the feed: it hydrates the user, gathers
// candidates from both sides (Kata + Mushin), then runs them through the shared
// pipeline — gate (filters) → judge (scoring) → selection — with intensity
// deciding the Kata/Mushin mix. Reads like the architecture; rarely changes.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { hydrateUser } from './queryHydration.ts';
import { gatherCandidates } from './registry.ts';
import { hydrateCandidates } from './candidateHydration.ts';
import { applyPreScoringFilters } from '../filters/chain.ts';
import { runScorers } from '../scoring/stack.ts';
import { select } from '../selection/selector.ts';
import { dedupe } from '../filters/dedupeFilter.ts';

export interface FeedResult {
  postIds: string[];
  meta: { filters: number; trendingOn: boolean; candidates: number; eligible: number };
}

export async function assembleFeed(
  supabase: SupabaseClient,
  profileId: string,
  seed: number,
): Promise<FeedResult> {
  // 1. Query Hydration
  const ctx = await hydrateUser(supabase, profileId);
  if (ctx.filters.length === 0 && !ctx.trendingOn) {
    return { postIds: [], meta: { filters: 0, trendingOn: false, candidates: 0, eligible: 0 } };
  }

  // 2. Candidate Sources — Kata + Mushin, merged/deduped
  const candidates = await gatherCandidates(ctx, { supabase });

  // 3. Candidate Hydration
  const features = await hydrateCandidates(supabase, profileId, candidates.map((c) => c.postId));

  // 4. Pre-Scoring Filters (the gate)
  const eligible = applyPreScoringFilters(candidates, features, ctx);

  // 5. Scoring (the judge)
  const scored = runScorers(eligible, features);

  // 6. Selection (intensity allocation + seeded exploration)
  const ordered = select(scored, ctx, seed);

  // 7. Post-Selection (dedupe)
  const postIds = dedupe(ordered);

  return {
    postIds,
    meta: {
      filters: ctx.filters.length,
      trendingOn: ctx.trendingOn,
      candidates: candidates.length,
      eligible: eligible.length,
    },
  };
}
