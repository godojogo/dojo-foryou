// Pre-scoring filter chain — the named, ordered eligibility gates applied
// BEFORE scoring. Note: "seen" is NOT here — it's a decaying downrank in the
// scorer, so the feed never empties.

import { Candidate, CandidateFeatures, UserContext } from '../lib/types.ts';
import { CandidateFilter } from './types.ts';
import { eligibilityFilter } from './eligibilityFilter.ts';
import { blockedAuthorFilter } from './blockedAuthorFilter.ts';
import { adFilter } from './adFilter.ts';

export const PRE_SCORING_FILTERS: CandidateFilter[] = [
  eligibilityFilter,
  blockedAuthorFilter,
  adFilter,
];

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
