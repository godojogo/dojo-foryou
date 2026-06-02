// Ad filter — keep ads out of the organic ranking. Ads are injected by a
// separate placement path, not ranked as For You candidates.

import { CandidateFilter } from './types.ts';

export const adFilter: CandidateFilter = {
  name: 'ad',
  keep: (_c, f) => !!f && !f.isAd,
};
