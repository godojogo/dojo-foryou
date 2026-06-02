// Blocked-author filter — drop posts from authors the user has blocked.

import { CandidateFilter } from './types.ts';

export const blockedAuthorFilter: CandidateFilter = {
  name: 'blockedAuthor',
  keep: (_c, f) => !!f && !f.authorBlocked,
};
