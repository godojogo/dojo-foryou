// A scorer adjusts candidate scores in place. The stack runs them in order, so
// scorers compose: the weighted base, then the seen-cooldown subtraction, then
// author-diversity attenuation. A future learned ranker is just another Scorer.

import { ScoredCandidate } from '../lib/types.ts';

export interface Scorer {
  name: string;
  apply(candidates: ScoredCandidate[], now: number): void;
}

/**
 * The diversity penalty for a repeat that keeps `factor` of its standing: `(1 - factor)` of its
 * score, measured against at least `floor`, so it is bounded and the same whatever the score's sign.
 *
 * It used to multiply a positive score by the factor and DIVIDE a negative one by it, so each
 * repeat of an already-penalised post grew its penalty exponentially (2^n for authors): a seed
 * author's 20th post scored -241 and was buried for good. Strong posts lose the same share as
 * before; a weak or negative one moves down by at most `floor·(1 - factor)`.
 */
export function repeatPenalty(score: number, factor: number, floor: number): number {
  return (1 - factor) * Math.max(score, floor);
}
