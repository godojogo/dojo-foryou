// ─── SENSEI ──────────────────────────────────────────────────────────────────
// The orchestrator. Sensei assembles the feed: retrieval (the viewer, candidates from both
// sides and their features: Postgres → Pinecone → Postgres), then the shared pipeline — gate
// (filters) → judge (scoring) → selection — with intensity deciding the Kata/Mushin mix. Reads
// like the architecture; rarely changes.

import { Db } from '../lib/clients.ts';
import { anySourceOn, Candidate, ScoredCandidate } from '../lib/types.ts';
import { retrieve, Retrieved, retrieveTopic } from './retrieval.ts';
import { kataCandidates } from '../kata/kata.ts';
import { mushinCandidates } from '../mushin/blend.ts';
import { applyPreScoringFilters } from '../filters/chain.ts';
import { runScorers } from '../scoring/stack.ts';
import { select } from '../selection/selector.ts';
import { dedupe } from '../filters/dedupeFilter.ts';

export interface FeedResult {
  postIds: string[];
  scored: ScoredCandidate[];
  meta: {
    filters: number;
    trendingOn: boolean;
    recommendOn: boolean;
    interestSeeds: number;
    candidates: number;
    eligible: number;
  };
}

// A post found by several sources keeps the strongest (similarity·intensity) provenance, so the
// allocator assigns it to the source that "wanted" it most.
function merge(lists: Candidate[][]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const c of lists.flat()) {
    const cur = best.get(c.postId);
    if (!cur || c.similarity * c.intensity > cur.similarity * cur.intensity) best.set(c.postId, c);
  }
  return [...best.values()];
}

/** For You: every filter by intensity, plus discovery when a card is on. */
export async function assembleFeed(db: Db, profileId: string, seed: number): Promise<FeedResult> {
  // 1-3. Query hydration, candidate sources, candidate hydration
  return rank(await retrieve(db, profileId), seed);
}

/** A topic tab: one filter, ranked by the same gate, judge and selection. */
export async function assembleTopicFeed(db: Db, profileId: string, topic: string, seed: number): Promise<FeedResult> {
  return rank(await retrieveTopic(db, profileId, topic), seed);
}

function rank({ ctx, candidates: raw, features }: Retrieved, seed: number): FeedResult {
  const empty = { filters: ctx.filters.length, trendingOn: ctx.trendingOn, recommendOn: ctx.recommendOn,
    interestSeeds: ctx.interestSeeds, candidates: 0, eligible: 0 };
  if (ctx.filters.length === 0 && !anySourceOn(ctx)) return { postIds: [], scored: [], meta: empty };

  const candidates = merge([kataCandidates(raw), anySourceOn(ctx) ? mushinCandidates(raw) : []]);

  // 4. Pre-Scoring Filters (the gate)
  const eligible = applyPreScoringFilters(candidates, features, ctx);

  // 5. Scoring (the judge)
  const scored = runScorers(eligible, features);

  // 6. Selection (intensity allocation + seeded jitter)
  const ordered = select(scored, ctx, seed);

  // 7. Post-Selection (dedupe; the visibility gate re-runs on every page read)
  const postIds = dedupe(ordered);

  return { postIds, scored, meta: { ...empty, candidates: candidates.length, eligible: eligible.length } };
}
