// Pre-scoring filter chain — the named, ordered gates applied BEFORE scoring. Visibility (public,
// not dojo-only, not taken down, not an ad, dojo public) and hidden authors (both block
// directions) are enforced in retrieval, at the source, so nothing ineligible arrives here; what
// is left is the guarantee that every candidate was hydrated, and what the viewer steered out
// (a format turned off, a "never" mute). Note: "seen" is NOT here — it's a
// decaying downrank in the scorer, so the feed never empties.

import { Candidate, CandidateFeatures, UserContext } from '../lib/types.ts';
import { CandidateFilter } from './types.ts';
import { formatOff, hardMuted } from '../scoring/steeringScorer.ts';

const hydratedFilter: CandidateFilter = {
  name: 'hydrated',
  keep: (_c, f) => !!f,
};

// What the viewer asked never to see: a format they turned off, and posts squarely about a
// "never" mute. (Softer mutes and format dials are score adjustments, scoring/steeringScorer.ts.)
const steeringFilter: CandidateFilter = {
  name: 'steering',
  keep: (_c, f) => !formatOff(f) && !hardMuted(f),
};

export const PRE_SCORING_FILTERS: CandidateFilter[] = [hydratedFilter, steeringFilter];

export function applyPreScoringFilters(
  candidates: Candidate[],
  features: Map<string, CandidateFeatures>,
  ctx: UserContext,
): Candidate[] {
  return candidates.filter((c) => {
    const f = features.get(c.postId);
    return PRE_SCORING_FILTERS.every((filter) => filter.keep(c, f, ctx));
  });
}
