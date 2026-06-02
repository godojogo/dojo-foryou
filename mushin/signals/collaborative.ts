// Collaborative — "people whose taste overlaps yours loved these." Discovery
// beyond your own history. Backed by mushin_collaborative (neighbors by
// like-overlap → their likes you haven't engaged with).

import { RecSignal, RecCandidate } from './types.ts';

export const collaborative: RecSignal = {
  name: 'collaborative',
  run: async (ctx, _yomi, { supabase }) => {
    const { data } = await supabase.rpc('mushin_collaborative', {
      p_profile_id: ctx.profileId,
      p_limit: 60,
    });
    return ((data ?? []) as { post_id: string; score: number }[]).map((r): RecCandidate => ({
      postId: r.post_id,
      score: Number(r.score) || 0,
    }));
  },
};
