// Author Diversity Scorer — attenuates each additional post from an author that
// already appears higher in the ranking, so one prolific author can't flood the
// feed. Sorts by current score first to establish "above", then ×decay^n per
// repeat.

import { cfg } from '../lib/config.ts';
import { Scorer } from './types.ts';

export const authorDiversityScorer: Scorer = {
  name: 'authorDiversity',
  apply(candidates) {
    candidates.sort((a, b) => b.score - a.score);
    const countByAuthor = new Map<string, number>();
    for (const c of candidates) {
      const n = countByAuthor.get(c.features.authorId) ?? 0;
      if (n > 0) {
        // Attenuate toward zero from either side: a repeat must never gain from a negative score.
        const factor = Math.pow(cfg().authorDiversityDecay, n);
        const next = c.score >= 0 ? c.score * factor : c.score / factor;
        c.parts.authorRepeat = next - c.score;
        c.score = next;
      }
      countByAuthor.set(c.features.authorId, n + 1);
    }
  },
};
