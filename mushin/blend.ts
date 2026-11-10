// ─── MUSHIN ──────────────────────────────────────────────────────────────────
// mushin (無心, "no-mind") — the behavioural recommendation engine, opt-in per card. It learns
// from what the user genuinely endorses (not just what they stared at) and flows them toward
// more of it, plus real discovery. Its signals run in retrieval; this is the blend:
//   1. normalise each signal to 0..1, weight by cfg().mushin.signalWeights
//   2. sum into one score per post
//   3. EXPLORATION QUOTA — guarantee a slice of genuine discovery survives the cap
// The avoid-vector penalty is a scorer now (it applies to every source, not just Mushin).

import { cfg } from '../lib/config.ts';
import { Candidate, RawCandidate } from '../lib/types.ts';

export function mushinCandidates(raw: RawCandidate[]): Candidate[] {
  const weights = cfg().mushin.signalWeights as Record<string, number>;

  const bySignal = new Map<string, RawCandidate[]>();
  for (const c of raw) {
    if (c.source === 'filter') continue;
    let list = bySignal.get(c.source);
    if (!list) bySignal.set(c.source, (list = []));
    list.push(c);
  }

  // 1 + 2: weighted sum of normalised signal scores.
  const blended = new Map<string, number>();
  const fromExploration = new Set<string>();
  for (const [name, cands] of bySignal) {
    const w = weights[name] ?? 0;
    if (w === 0 || cands.length === 0) continue;
    const max = cands.reduce((m, c) => Math.max(m, c.score), 0) || 1;
    for (const c of cands) {
      blended.set(c.postId, (blended.get(c.postId) ?? 0) + w * (c.score / max));
      if (name === 'exploration') fromExploration.add(c.postId);
    }
  }
  if (blended.size === 0) return [];

  const max = Math.max(...blended.values()) || 1;
  const ranked = [...blended.entries()]
    .map(([postId, s]) => ({ postId, score: s / max }))
    .sort((a, b) => b.score - a.score);

  // 3: exploration quota — up to N discovery posts survive the cap, the rest by blended score.
  const out = cfg().mushin.outputSize;
  const quotaN = Math.floor(out * cfg().mushin.explorationQuota);
  const exploreTop = ranked.filter((r) => fromExploration.has(r.postId)).slice(0, quotaN);
  const exploreIds = new Set(exploreTop.map((e) => e.postId));
  const mainTop = ranked.filter((r) => !exploreIds.has(r.postId)).slice(0, out - exploreTop.length);

  return [...mainTop, ...exploreTop].map((r): Candidate => ({
    postId: r.postId,
    source: 'discovery',
    intensity: 1,
    similarity: r.score,
  }));
}
