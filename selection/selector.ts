// Selector — produces the final ordered post IDs. Applies a light seeded jitter
// (so refreshes vary without overturning clear winners), buckets candidates by
// source, then fills slots via weighted round-robin to hit the allocator's
// intensity-proportional shares.

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

export function select(scored: ScoredCandidate[], ctx: UserContext, seed: number): string[] {
  if (scored.length === 0) return [];

  for (const s of scored) s.score += cfg().jitter * (seededRand(seed, s.postId) - 0.5);

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

  const out: string[] = [];
  for (let n = 0; n < scored.length; n++) {
    let bestKey: string | null = null;
    let bestDeficit = -Infinity;
    for (const k of buckets.keys()) {
      if (idx.get(k)! >= buckets.get(k)!.length) continue;
      const share = (shares.get(k) ?? 0) / shareSum;
      const deficit = share * (out.length + 1) - emitted.get(k)!;
      if (deficit > bestDeficit) { bestDeficit = deficit; bestKey = k; }
    }
    if (bestKey === null) break;
    const i = idx.get(bestKey)!;
    idx.set(bestKey, i + 1);
    emitted.set(bestKey, emitted.get(bestKey)! + 1);
    out.push(buckets.get(bestKey)![i].postId);
  }
  return out;
}
