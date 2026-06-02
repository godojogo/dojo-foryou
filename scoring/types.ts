// A scorer adjusts candidate scores in place. The stack runs them in order, so
// scorers compose: the weighted base, then the seen-cooldown subtraction, then
// author-diversity attenuation. A future learned ranker is just another Scorer.

import { ScoredCandidate } from '../lib/types.ts';

export interface Scorer {
  name: string;
  apply(candidates: ScoredCandidate[], now: number): void;
}
