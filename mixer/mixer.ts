// ─── MIXER ───────────────────────────────────────────────────────────────────
// Turns the scored candidates into the feed's order. Applies a light seeded jitter
// (so refreshes vary without overturning clear winners), buckets candidates by
// source, then fills slots via weighted round-robin to hit the shares (allocator.ts):
// intensity-proportional shares. The order comes in tiers, each keeping the slider mix:
// unseen posts the ranker rates at least `qualityFloor`, then the weaker unseen ones, then
// posts seen in the last day (dropped entirely while a page of unseen posts remains), so a
// filter's share never pulls a poor or just-seen post above a good one from another filter.

import { ScoredCandidate, UserContext } from '../lib/types.ts';
import { cfg } from '../lib/config.ts';
import { computeShares, DISCOVERY_KEY, filterKey } from './allocator.ts';

// Deterministic [0,1) from (seed, postId).
function seededRand(seed: number, key: string): number {
  let h = (seed >>> 0) || 1;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
  h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

export interface Mix {
  postIds: string[];
  /** How many leading posts are unseen; anything after is "caught up" (seen in the last day). */
  unseen: number;
  /** Recently seen posts left out because enough unseen ones remained. */
  seenDropped: number;
}

export function mix(scored: ScoredCandidate[], ctx: UserContext, seed: number, now = Date.now()): Mix {
  if (scored.length === 0) return { postIds: [], unseen: 0, seenDropped: 0 };

  for (const s of scored) s.score += cfg().jitter * (seededRand(seed, s.postId) - 0.5);

  const freshMs = cfg().seen.freshHours * 3_600_000;
  const seenRecently = (s: ScoredCandidate) => {
    const last = s.features.lastSeenAt ? new Date(s.features.lastSeenAt).getTime() : NaN;
    return Number.isFinite(last) && now - last < freshMs;
  };
  const unseen = scored.filter((s) => !seenRecently(s));
  const seen = scored.filter(seenRecently);

  const floor = cfg().qualityFloor;
  const ranked = [
    ...rotate(unseen.filter((s) => s.score >= floor), ctx),
    ...rotate(unseen.filter((s) => s.score < floor), ctx),
  ];
  if (unseen.length >= cfg().seen.excludeWhenUnseen) {
    return { postIds: ranked, unseen: unseen.length, seenDropped: seen.length };
  }
  return { postIds: [...ranked, ...rotate(seen, ctx)], unseen: unseen.length, seenDropped: 0 };
}

/** The allocator's weighted round-robin over source buckets, best first within each. */
function rotate(scored: ScoredCandidate[], ctx: UserContext): string[] {
  if (scored.length === 0) return [];

  // Bucket by source: each filter its own bucket, discovery one bucket.
  const buckets = new Map<string, ScoredCandidate[]>();
  for (const s of scored) {
    const key = s.source === 'discovery' ? DISCOVERY_KEY : filterKey(s.filterId);
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    arr.push(s);
  }
  for (const arr of buckets.values()) arr.sort((a, b) => b.score - a.score);

  const shares = computeShares(ctx, new Set(buckets.keys()));
  let shareSum = 0;
  for (const k of buckets.keys()) shareSum += shares.get(k) ?? 0;

  // No share info (e.g. no filters) -> plain global score order.
  if (shareSum === 0) return scored.sort((a, b) => b.score - a.score).map((s) => s.postId);

  const idx = new Map<string, number>();
  const emitted = new Map<string, number>();
  for (const k of buckets.keys()) { idx.set(k, 0); emitted.set(k, 0); }

  // Each slot goes to the best next post among the sources within `shareSlack` slots of their
  // share, so quality orders the feed and the sliders still set its mix. A pure quota rotation
  // put a source's weak post (even a negative score) above another's strong one just because it
  // was that source's turn. A source further behind than the slack is served first regardless.
  const slack = cfg().shareSlack;
  const out: string[] = [];
  for (let n = 0; n < scored.length; n++) {
    let bestKey: string | null = null;
    let bestDeficit = -Infinity;
    let pickKey: string | null = null;
    let pickScore = -Infinity;
    for (const k of buckets.keys()) {
      const i = idx.get(k)!;
      if (i >= buckets.get(k)!.length) continue;
      const share = (shares.get(k) ?? 0) / shareSum;
      const deficit = share * (out.length + 1) - emitted.get(k)!;
      if (deficit > bestDeficit) { bestDeficit = deficit; bestKey = k; }
      const head = buckets.get(k)![i].score;
      if (share > 0 && deficit > -slack && head > pickScore) { pickScore = head; pickKey = k; }
    }
    if (bestKey === null) break;
    if (bestDeficit < slack && pickKey !== null) bestKey = pickKey;
    const i = idx.get(bestKey)!;
    idx.set(bestKey, i + 1);
    emitted.set(bestKey, emitted.get(bestKey)! + 1);
    out.push(buckets.get(bestKey)![i].postId);
  }
  return out;
}
