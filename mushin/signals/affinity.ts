// Affinity — recent unseen posts from people you're close to (follow or share a
// dojo with). The social-graph signal. Backed by mushin_affinity.

import { RecSignal, RecCandidate } from './types.ts';

export const affinity: RecSignal = {
  name: 'affinity',
  run: async (ctx, _yomi, { supabase }) => {
    const { data } = await supabase.rpc('mushin_affinity', {
      p_profile_id: ctx.profileId,
      p_limit: 40,
      p_days: 30,
    });
    return ((data ?? []) as { post_id: string; score: number }[]).map((r): RecCandidate => ({
      postId: r.post_id,
      score: Number(r.score) || 0,
    }));
  },
};
