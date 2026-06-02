// Weighted Scorer — the base relevance score:
//   similarity (dominant) + engagement velocity + recency.
// Intensity is intentionally absent here; it drives slot ALLOCATION, not score
// (putting it in both would double-count the slider).

import { CONFIG } from '../lib/config.ts';
import { CandidateFeatures } from '../lib/types.ts';
import { Scorer } from './types.ts';

const HOUR_MS = 3_600_000;

function recencyFactor(ageHours: number): number {
  return Math.exp(-ageHours / CONFIG.recencyTauHours);
}

// Engagement velocity ≈ engagement per hour, soft-saturated to 0..1 so a viral
// post can't dwarf the similarity term. Rewards posts gaining traction fast.
function velocityFactor(f: CandidateFeatures, ageHours: number): number {
  const raw =
    f.likesCount * CONFIG.velocity.like +
    f.commentsCount * CONFIG.velocity.comment +
    f.viewCount * CONFIG.velocity.view;
  const perHour = raw / (ageHours + 2);
  return perHour / (perHour + 8);
}

export const weightedScorer: Scorer = {
  name: 'weighted',
  apply(candidates, now) {
    const w = CONFIG.weights;
    for (const c of candidates) {
      const ageHours = Math.max(0, (now - new Date(c.features.createdAt).getTime()) / HOUR_MS);
      c.score +=
        w.similarity * c.similarity +
        w.velocity * velocityFactor(c.features, ageHours) +
        w.recency * recencyFactor(ageHours);
    }
  },
};
