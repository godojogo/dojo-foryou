// Blend — combines the signals into Mushin's candidate set:
//   1. normalize each signal to 0..1, weight by CONFIG.mushin.signalWeights
//   2. sum into a blended score per post
//   3. NEGATIVE PENALTY — push down anything close to Yomi's "avoid" vector
//      (the "I looked but it made me uncomfortable" defense)
//   4. EXPLORATION QUOTA — guarantee a slice of genuine discovery survives
//
// Output is Candidate[] with the blended score in `similarity`; the shared
// pipeline (hydrate → score → select) then applies the universal quality,
// recency, seen-cooldown and diversity layers on top.

import { CONFIG } from '../lib/config.ts';
import { Candidate } from '../lib/types.ts';
import { pineconeQuery } from '../lib/clients.ts';
import { Yomi } from './yomi.ts';
import { RecCandidate } from './signals/types.ts';

function normalize(cands: RecCandidate[]): Map<string, number> {
  const max = cands.reduce((m, c) => Math.max(m, c.score), 0) || 1;
  const out = new Map<string, number>();
  for (const c of cands) out.set(c.postId, c.score / max);
  return out;
}

export async function blend(
  signalResults: Map<string, RecCandidate[]>,
  yomi: Yomi,
): Promise<Candidate[]> {
  const weights = CONFIG.mushin.signalWeights as Record<string, number>;

  // 1 + 2: weighted sum of normalized signal scores.
  const blended = new Map<string, number>();
  const fromExploration = new Set<string>();
  for (const [name, cands] of signalResults) {
    const w = weights[name] ?? 0;
    if (w === 0 || cands.length === 0) continue;
    const norm = normalize(cands);
    for (const [postId, s] of norm) {
      blended.set(postId, (blended.get(postId) ?? 0) + w * s);
      if (name === 'exploration') fromExploration.add(postId);
    }
  }
  if (blended.size === 0) return [];

  // 3: negative penalty — anything near what you disliked gets pushed down.
  if (yomi.negativeVector) {
    const negMatches = await pineconeQuery(yomi.negativeVector, CONFIG.mushin.negativeTopK);
    for (const m of negMatches) {
      if (blended.has(m.id)) {
        blended.set(m.id, blended.get(m.id)! - CONFIG.mushin.negativeWeight * m.score);
      }
    }
  }

  // Normalize to 0..1 for the downstream weighted scorer.
  const entries = [...blended.entries()];
  const max = entries.reduce((m, [, s]) => Math.max(m, s), -Infinity);
  const min = entries.reduce((m, [, s]) => Math.min(m, s), Infinity);
  const range = max - min || 1;
  const ranked = entries
    .map(([postId, s]) => ({ postId, score: (s - min) / range }))
    .sort((a, b) => b.score - a.score);

  // 4: exploration quota — guarantee up to N discovery posts survive the cap,
  // then fill the rest by blended score.
  const out = CONFIG.mushin.outputSize;
  const quotaN = Math.floor(out * CONFIG.mushin.explorationQuota);
  const exploreTop = ranked.filter((r) => fromExploration.has(r.postId)).slice(0, quotaN);
  const exploreIds = new Set(exploreTop.map((e) => e.postId));
  const mainTop = ranked.filter((r) => !exploreIds.has(r.postId)).slice(0, out - exploreTop.length);

  return [...mainTop, ...exploreTop].map((r): Candidate => ({
    postId: r.postId,
    source: 'trending',
    intensity: 1,
    similarity: Math.max(0, r.score),
  }));
}
