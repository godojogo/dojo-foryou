// ─── KATA ───────────────────────────────────────────────────────────────────
// kata (型) — "form". The content-filter side: the user's deliberate, declared discipline.
// Retrieval ran one query PER filter (never an averaged vector, so "basketball" and "cooking"
// stay sharp); here each candidate is tagged with its owning filter + intensity so the
// allocator can give each filter its share of slots.

import { Candidate, RawCandidate } from '../lib/types.ts';

export function kataCandidates(raw: RawCandidate[]): Candidate[] {
  return raw
    .filter((c) => c.source === 'filter' && c.filterId)
    .map((c) => ({
      postId: c.postId,
      source: 'filter',
      filterId: c.filterId!,
      intensity: c.intensity,
      similarity: c.score,
    }));
}
