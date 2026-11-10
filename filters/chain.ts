// Pre-scoring filter chain — the named, ordered gates applied BEFORE scoring. Visibility (public,
// not dojo-only, not taken down, not an ad, dojo public) and hidden authors (both block
// directions) are enforced in retrieval, at the source, so nothing ineligible arrives here; what
// is left is the guarantee that every candidate was hydrated. Note: "seen" is NOT here — it's a
// decaying downrank in the scorer, so the feed never empties.

import { Candidate, CandidateFeatures, UserContext } from '../lib/types.ts';
import { CandidateFilter } from './types.ts';

const hydratedFilter: CandidateFilter = {
  name: 'hydrated',
  keep: (_c, f) => !!f,
};

export const PRE_SCORING_FILTERS: CandidateFilter[] = [hydratedFilter];

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
