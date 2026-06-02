// Scorer stack — the ordered scoring pipeline. Order matters: base relevance,
// then the seen-cooldown subtraction, then author-diversity attenuation. To add
// a learned ranker later, implement Scorer and insert it here.

import { Candidate, CandidateFeatures, ScoredCandidate } from '../lib/types.ts';
import { Scorer } from './types.ts';
import { weightedScorer } from './weightedScorer.ts';
import { seenCooldownScorer } from './seenCooldownScorer.ts';
import { authorDiversityScorer } from './authorDiversityScorer.ts';

export const SCORERS: Scorer[] = [weightedScorer, seenCooldownScorer, authorDiversityScorer];

export function runScorers(
  candidates: Candidate[],
  features: Map<string, CandidateFeatures>,
  now = Date.now(),
): ScoredCandidate[] {
  const scored: ScoredCandidate[] = candidates.map((c) => ({
    ...c,
    features: features.get(c.postId)!,
    score: 0,
  }));
  for (const s of SCORERS) s.apply(scored, now);
  return scored.sort((a, b) => b.score - a.score);
}
