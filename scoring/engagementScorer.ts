// Engagement Scorer — the base relevance score:
//   similarity (dominant) + quality + recency + in-network
// where quality is the expected value of showing the post, Σ value × P(action) — the form X's
// open-source ranker uses. X learns P(action) with a transformer; with no training data yet,
// each P is the post's own rate per impression, smoothed toward a prior so small counts don't
// swing it: P = (count + prior·k) / (impressions + k). A post with 1 like from 1 view is close
// to average, not perfect; 30 likes from 3,000 views ranks below 10 from 20.
// Intensity is intentionally absent; it drives slot ALLOCATION, not score.

import { cfg } from '../lib/config.ts';
import { CandidateFeatures } from '../lib/types.ts';
import { Scorer } from './types.ts';

const HOUR_MS = 3_600_000;
// 0..1, 0.5 for an average post.
export function qualityFactor(f: CandidateFeatures): number {
  const E = cfg().engagement;
  const A = E.actions;
  // What an average post is worth; quality is measured against it.
  const BASELINE =
    A.like.value * A.like.prior +
    A.comment.value * A.comment.prior +
    A.save.value * A.save.prior +
    A.negative.value * A.negative.prior;
  const rate = (count: number, prior: number, impressions: number) =>
    (count + prior * E.priorImpressions) / (impressions + E.priorImpressions);
  const impressions = Math.max(f.viewCount, f.likesCount + f.commentsCount + f.savesCount + f.negativeCount);
  const value =
    A.like.value * rate(f.likesCount, A.like.prior, impressions) +
    A.comment.value * rate(f.commentsCount, A.comment.prior, impressions) +
    A.save.value * rate(f.savesCount, A.save.prior, impressions) +
    A.negative.value * rate(f.negativeCount, A.negative.prior, impressions);
  const relative = Math.max(0, value) / BASELINE;
  return relative / (relative + 1);
}

export const engagementScorer: Scorer = {
  name: 'engagement',
  apply(candidates, now) {
    const w = cfg().weights;
    for (const c of candidates) {
      const ageHours = Math.max(0, (now - new Date(c.features.createdAt).getTime()) / HOUR_MS);
      const signals = {
        similarity: c.similarity,
        quality: qualityFactor(c.features),
        recency: Math.exp(-ageHours / cfg().recencyTauHours),
        inNetwork: c.features.inNetwork ? 1 : 0,
      };
      // Calibrated relevance is always recorded (so a fit can compare it with the raw cosine);
      // it scores only when the relevance_calibration experiment turns it on.
      const R = cfg().relevance;
      const relevance = c.source === 'filter'
        ? Math.min(1, Math.max(0, (c.similarity - R.low) / (R.high - R.low)))
        : c.similarity;
      const parts = {
        similarity: w.similarity * (R.calibrate ? relevance : signals.similarity),
        quality: w.quality * signals.quality,
        recency: w.recency * signals.recency,
        inNetwork: w.inNetwork * signals.inNetwork,
      };
      Object.assign(c.signals, signals, { relevance });
      Object.assign(c.parts, parts);
      c.score += parts.similarity + parts.quality + parts.recency + parts.inNetwork;
    }
  },
};
