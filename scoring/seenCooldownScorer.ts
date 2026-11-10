// Seen Cooldown Scorer — a decaying downrank for recently-seen posts (NOT a hard
// filter, so a small content pool never empties). Penalty is large right after
// viewing and fades to zero past the window, letting good posts resurface.
//   penalty = weight · exp(-daysSinceSeen / tau),  0 beyond windowDays

import { cfg } from '../lib/config.ts';
import { Scorer } from './types.ts';

const DAY_MS = 86_400_000;

export const seenCooldownScorer: Scorer = {
  name: 'seenCooldown',
  apply(candidates, now) {
    for (const c of candidates) {
      const last = c.features.lastSeenAt;
      if (!last) continue;
      const days = (now - new Date(last).getTime()) / DAY_MS;
      if (days < 0 || days > cfg().seen.windowDays) continue;
      const seen = Math.exp(-days / cfg().seen.tauDays);
      const penalty = cfg().seen.weight * seen;
      c.signals.seen = seen;
      c.parts.seen = -penalty;
      c.score -= penalty;
    }
  },
};
