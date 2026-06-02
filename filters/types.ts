// A filter is a named keep/drop predicate over a candidate + its features. The
// chain applies them all (AND). New eligibility rules = a new file + one line in
// chain.ts.

import { Candidate, CandidateFeatures, UserContext } from '../lib/types.ts';

export interface CandidateFilter {
  name: string;
  keep(c: Candidate, f: CandidateFeatures | undefined, ctx: UserContext): boolean;
}
