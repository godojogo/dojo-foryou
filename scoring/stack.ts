// Scorer stack — the ordered scoring pipeline. Order matters: base relevance, then the
// avoid-vector, steering (formats, mutes) and seen-cooldown adjustments, then author- and
// topic-diversity attenuation. To add a learned ranker later, implement Scorer and insert it here
// (the served lists keep every candidate's parts as its training data).

import { Candidate, CandidateFeatures, ScoredCandidate } from '../lib/types.ts';
import { Scorer } from './types.ts';
import { engagementScorer } from './engagementScorer.ts';
import { negativeScorer } from './negativeScorer.ts';
import { steeringScorer } from './steeringScorer.ts';
import { seenCooldownScorer } from './seenCooldownScorer.ts';
import { authorDiversityScorer } from './authorDiversityScorer.ts';
import { topicDiversityScorer } from './topicDiversityScorer.ts';

export const SCORERS: Scorer[] = [engagementScorer, negativeScorer, steeringScorer, seenCooldownScorer, authorDiversityScorer, topicDiversityScorer];

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
    signals: {},
  }));
  for (const s of SCORERS) s.apply(scored, now);
  return scored.sort((a, b) => b.score - a.score);
}
