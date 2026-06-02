// ─── KATA ───────────────────────────────────────────────────────────────────
// kata (型) — "form". The content-filter side: the user's deliberate, declared
// discipline. One vector query PER content filter (never an averaged vector, so
// "basketball" and "cooking" stay sharp), each candidate tagged with its owning
// filter + intensity so the allocator can give each filter its share of slots.

import { CONFIG } from '../lib/config.ts';
import { Candidate } from '../lib/types.ts';
import { pineconeQuery } from '../lib/clients.ts';
import { CandidateSource } from '../lib/source.ts';

export const kataSource: CandidateSource = {
  name: 'kata',
  enabled: (ctx) => ctx.filters.length > 0,
  retrieve: async (ctx) => {
    const perFilter = await Promise.all(
      ctx.filters.map(async (f) => {
        const matches = await pineconeQuery(f.embedding, CONFIG.perFilterTopK);
        return matches.map((m): Candidate => ({
          postId: m.id,
          source: 'filter',
          filterId: f.id,
          intensity: f.intensity,
          similarity: m.score,
        }));
      }),
    );
    return perFilter.flat();
  },
};
