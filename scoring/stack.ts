// Scorer stack — the ordered scoring pipeline. Order matters: base relevance, then the
// avoid-vector and seen-cooldown subtractions, then author-diversity attenuation. To add a
// learned ranker later, implement Scorer and insert it here (the served lists keep every
// candidate's parts as its training data).

import { Candidate, CandidateFeatures, ScoredCandidate } from '../lib/types.ts';
import { Scorer } from './types.ts';
import { engagementScorer } from './engagementScorer.ts';
import { negativeScorer } from './negativeScorer.ts';
import { seenCooldownScorer } from './seenCooldownScorer.ts';
import { authorDiversityScorer } from './authorDiversityScorer.ts';

export const SCORERS: Scorer[] = [engagementScorer, negativeScorer, seenCooldownScorer, authorDiversityScorer];

export function runScorers(
  candidates: Candidate[],
  features: Map<string, CandidateFeatures>,
  now = Date.now(),
): ScoredCandidate[] {
  const scored: ScoredCandidate[] = candidates.map((c) => ({
    ...c,
    features: features.get(c.postId)!,
    score: 0,
    parts: {},
  }));
  for (const s of SCORERS) s.apply(scored, now);
  return scored.sort((a, b) => b.score - a.score);
}
