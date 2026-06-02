// Rising — what's gaining engagement velocity right now (the zeitgeist /
// freshness injection). Backed by mushin_rising.

import { RecSignal, RecCandidate } from './types.ts';

export const rising: RecSignal = {
  name: 'rising',
  run: async (_ctx, _yomi, { supabase }) => {
    const { data } = await supabase.rpc('mushin_rising', { p_limit: 60, p_hours: 72 });
    return ((data ?? []) as { post_id: string; score: number }[]).map((r): RecCandidate => ({
      postId: r.post_id,
      score: Number(r.score) || 0,
    }));
  },
};
