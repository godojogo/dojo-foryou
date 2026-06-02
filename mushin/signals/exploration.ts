// Exploration — recent, under-exposed, unseen posts. The anti-filter-bubble
// signal: gives new posts and creators a fair shot and keeps the feed alive
// instead of a hall of mirrors. Backed by mushin_exploration; the blend reserves
// a guaranteed slice of the output for it.

import { RecSignal, RecCandidate } from './types.ts';

export const exploration: RecSignal = {
  name: 'exploration',
  run: async (ctx, _yomi, { supabase }) => {
    const { data } = await supabase.rpc('mushin_exploration', {
      p_profile_id: ctx.profileId,
      p_limit: 40,
      p_days: 14,
    });
    return ((data ?? []) as { post_id: string; score: number }[]).map((r): RecCandidate => ({
      postId: r.post_id,
      score: Number(r.score) || 0,
    }));
  },
};
