// Eligibility filter — drop anything that wasn't hydrated, or that isn't
// publicly visible. `eligible` already encodes the rule "post is public AND
// (no dojo OR the dojo is public)" from the hydration RPC.

import { CandidateFilter } from './types.ts';

export const eligibilityFilter: CandidateFilter = {
  name: 'eligibility',
  keep: (_c, f) => !!f && f.eligible,
};
