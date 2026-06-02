// Taste match — the core "more of what you genuinely love" signal. Queries the
// vector index once PER interest seed from Yomi (multi-interest, not one blurry
// average), weighting each seed by how much endorsement it represents.

import { CONFIG } from '../../lib/config.ts';
import { pineconeQuery } from '../../lib/clients.ts';
import { RecSignal, RecCandidate } from './types.ts';

export const tasteMatch: RecSignal = {
  name: 'tasteMatch',
  run: async (_ctx, yomi) => {
    if (yomi.interestSeeds.length === 0) return [];
    const totalW = yomi.interestSeeds.reduce((s, x) => s + x.weight, 0) || 1;

    const lists = await Promise.all(
      yomi.interestSeeds.map(async (seed) => {
        const matches = await pineconeQuery(seed.vector, CONFIG.mushin.perSeedTopK);
        const share = seed.weight / totalW; // stronger interests weigh more
        return matches.map((m): RecCandidate => ({ postId: m.id, score: m.score * share }));
      }),
    );

    // Merge across seeds, keeping the best match per post.
    const best = new Map<string, number>();
    for (const c of lists.flat()) best.set(c.postId, Math.max(best.get(c.postId) ?? 0, c.score));
    return [...best.entries()].map(([postId, score]) => ({ postId, score }));
  },
};
