// Steering Scorer — what the viewer asked for, per post: formats and mutes (lib/steering.ts).
//
//   format  cfg().steering.formatWeight x ln(multiplier): 2 lifts a format by ~0.28, 0.5 lowers
//           it by as much (a format at 0 never gets here: the gate drops it)
//   muted   cfg().steering.muteWeight x strength x closeness, for the closest of the viewer's
//           mutes, closeness ramping from muteNear to muteFar cosine. A "never" mute on a post
//           about the topic is dropped by the gate instead.
//
// Recorded as parts (and signals.muted) like every other scorer, so a fit can see them.

import { cfg } from '../lib/config.ts';
import { formatOf } from '../lib/steering.ts';
import { CandidateFeatures } from '../lib/types.ts';
import { Scorer } from './types.ts';

/** 0..1: how squarely the post sits in the mute's topic. */
export function muteCloseness(sim: number): number {
  const S = cfg().steering;
  return Math.min(1, Math.max(0, (sim - S.muteNear) / (S.muteFar - S.muteNear)));
}

/** A "never show me" mute the post is squarely about: the gate drops it. */
export function hardMuted(f: CandidateFeatures | undefined): boolean {
  if (!f) return false;
  const S = cfg().steering;
  return (f.muteHits ?? []).some((h) => h.strength >= S.hardMuteStrength && h.sim >= S.muteFar);
}

/** A format the viewer turned off: the gate drops it. */
export function formatOff(f: CandidateFeatures | undefined): boolean {
  if (!f) return false;
  const m = (cfg().formats as Record<string, number>)[formatOf(f.postType)];
  return typeof m === 'number' && m <= 0;
}

export const steeringScorer: Scorer = {
  name: 'steering',
  apply(candidates) {
    const S = cfg().steering;
    const formats = cfg().formats as Record<string, number>;
    for (const c of candidates) {
      const m = formats[formatOf(c.features.postType)];
      if (typeof m === 'number' && m > 0 && m !== 1) {
        const part = S.formatWeight * Math.log(m);
        c.parts.format = part;
        c.score += part;
      }
      let muted = 0;
      for (const h of c.features.muteHits ?? []) muted = Math.max(muted, h.strength * muteCloseness(h.sim));
      if (muted > 0) {
        const penalty = S.muteWeight * muted;
        c.signals.muted = muted;
        c.parts.muted = -penalty;
        c.score -= penalty;
      }
    }
  },
};
