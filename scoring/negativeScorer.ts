// Negative Scorer — pushes down candidates like what the viewer rejected (not interested, hide,
// report, fast skips), from every source. Relative, not absolute: the avoid vector is a blend of
// everything rejected, so it sits near the average post (measured: median candidate 0.72). Only
// candidates closer to it than most of this set lose score, scaled from the median (0) to the
// 95th percentile (full weight).

import { cfg } from '../lib/config.ts';
import { Scorer } from './types.ts';

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export const negativeScorer: Scorer = {
  name: 'negative',
  apply(candidates) {
    const sims = candidates
      .map((c) => c.features.negativeSimilarity)
      .filter((s): s is number => s != null)
      .sort((a, b) => a - b);
    if (sims.length < 2) return;
    const mid = quantile(sims, 0.5);
    const top = quantile(sims, 0.95);
    const span = top - mid;
    if (span <= 0) return;
    for (const c of candidates) {
      const s = c.features.negativeSimilarity;
      if (s == null || s <= mid) continue;
      const avoid = Math.min(1, (s - mid) / span);
      const penalty = cfg().negative.weight * avoid;
      c.signals.avoid = avoid;
      c.parts.negative = -penalty;
      c.score -= penalty;
    }
  },
};
