// Author Diversity Scorer — attenuates each additional post from an author that
// already appears higher in the ranking, so one prolific author can't flood the
// feed. Sorts by current score first to establish "above", then ×decay^n per
// repeat.

import { cfg } from '../lib/config.ts';
import { repeatPenalty, Scorer } from './types.ts';

export const authorDiversityScorer: Scorer = {
  name: 'authorDiversity',
  apply(candidates) {
    candidates.sort((a, b) => b.score - a.score);
    const countByAuthor = new Map<string, number>();
    for (const c of candidates) {
      const n = countByAuthor.get(c.features.authorId) ?? 0;
      if (n > 0) {
        const penalty = repeatPenalty(c.score, Math.pow(cfg().authorDiversityDecay, n), cfg().diversityFloor);
        c.parts.authorRepeat = -penalty;
        c.score -= penalty;
      }
      countByAuthor.set(c.features.authorId, n + 1);
    }
  },
};
