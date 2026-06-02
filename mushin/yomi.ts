// ─── YOMI ────────────────────────────────────────────────────────────────────
// yomi (読み) — "reading" the user. Mushin's user model. It does NOT average
// everything the user looked at (that would conflate love with discomfort).
// Instead it consumes the trust-hierarchy RPCs:
//   get_user_taste_profile   -> posts the user genuinely endorsed (save/like/
//                               comment, corroborated dwell, durable interest)
//   get_user_negative_profile-> posts they rejected (not-interested, fast-skip)
//
// From the positive set it builds MULTIPLE interest vectors (a user who likes
// fitness AND finance keeps both, sharp). From the negative set it builds one
// "avoid" vector. These drive retrieval (tasteMatch) and the negative penalty.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG } from '../lib/config.ts';

export interface InterestSeed {
  vector: number[];
  weight: number; // total endorsement mass this interest represents
}

export interface Yomi {
  interestSeeds: InterestSeed[];
  negativeVector: number[] | null;
  hasSignal: boolean;
}

interface WeightedVec {
  vec: number[];
  weight: number;
}

function parseVec(s: unknown): number[] | null {
  if (typeof s !== 'string') return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) && v.length === CONFIG.vectorDim ? v : null;
  } catch {
    return null;
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function weightedCentroid(items: WeightedVec[]): number[] | null {
  if (items.length === 0) return null;
  const dim = items[0].vec.length;
  const sum = new Array<number>(dim).fill(0);
  let w = 0;
  for (const it of items) {
    for (let d = 0; d < dim; d++) sum[d] += it.vec[d] * it.weight;
    w += it.weight;
  }
  if (w === 0) return null;
  return sum.map((x) => x / w);
}

// Multi-interest seeds via greedy diverse selection + one assignment/centroid
// pass — a lightweight clustering that keeps distinct interests apart.
function deriveSeeds(taste: WeightedVec[]): InterestSeed[] {
  if (taste.length === 0) return [];
  const K = CONFIG.mushin.interestSeeds;
  const TH = CONFIG.mushin.diversityThreshold;
  const sorted = [...taste].sort((a, b) => b.weight - a.weight);

  // 1. Seed init: take high-weight posts that are dissimilar to existing seeds.
  const seeds: number[][] = [];
  for (const t of sorted) {
    if (seeds.length >= K) break;
    const maxSim = seeds.length ? Math.max(...seeds.map((s) => cosine(s, t.vec))) : 0;
    if (maxSim < TH) seeds.push(t.vec);
  }
  if (seeds.length === 0) seeds.push(sorted[0].vec);

  // 2. Assign every endorsed post to its nearest seed, then take the weighted
  //    centroid of each cluster as the interest vector (cleaner than one post).
  const dim = seeds[0].length;
  const clusters = seeds.map(() => ({ sum: new Array<number>(dim).fill(0), w: 0 }));
  for (const t of taste) {
    let best = 0, bestSim = -Infinity;
    for (let i = 0; i < seeds.length; i++) {
      const s = cosine(seeds[i], t.vec);
      if (s > bestSim) { bestSim = s; best = i; }
    }
    const c = clusters[best];
    for (let d = 0; d < dim; d++) c.sum[d] += t.vec[d] * t.weight;
    c.w += t.weight;
  }
  return clusters
    .filter((c) => c.w > 0)
    .map((c) => ({ vector: c.sum.map((x) => x / c.w), weight: c.w }));
}

export async function buildYomi(supabase: SupabaseClient, profileId: string): Promise<Yomi> {
  const [tasteRes, negRes] = await Promise.all([
    supabase.rpc('get_user_taste_profile', { p_profile_id: profileId, p_limit: 50 }),
    supabase.rpc('get_user_negative_profile', { p_profile_id: profileId, p_limit: CONFIG.mushin.negativeTopK }),
  ]);

  const taste: WeightedVec[] = ((tasteRes.data ?? []) as { embedding: string; weight: number }[])
    .map((r) => ({ vec: parseVec(r.embedding), weight: Number(r.weight) || 0 }))
    .filter((t): t is WeightedVec => !!t.vec && t.weight > 0);

  const negatives: WeightedVec[] = ((negRes.data ?? []) as { embedding: string; weight: number }[])
    .map((r) => ({ vec: parseVec(r.embedding), weight: Number(r.weight) || 0 }))
    .filter((t): t is WeightedVec => !!t.vec && t.weight > 0);

  const interestSeeds = deriveSeeds(taste);
  return {
    interestSeeds,
    negativeVector: weightedCentroid(negatives),
    hasSignal: interestSeeds.length > 0,
  };
}

export { cosine };
