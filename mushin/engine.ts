// Mushin engine — reads the user (Yomi), runs every signal in parallel, and
// blends them into a candidate set. One signal failing never sinks the feed.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Candidate, UserContext } from '../lib/types.ts';
import { buildYomi } from './yomi.ts';
import { SIGNALS } from './signals/registry.ts';
import { RecCandidate } from './signals/types.ts';
import { blend } from './blend.ts';

export async function runMushin(ctx: UserContext, supabase: SupabaseClient): Promise<Candidate[]> {
  const yomi = await buildYomi(supabase, ctx.profileId);
  const deps = { supabase };

  const results = new Map<string, RecCandidate[]>();
  await Promise.all(
    SIGNALS.map(async (sig) => {
      try {
        results.set(sig.name, await sig.run(ctx, yomi, deps));
      } catch (e) {
        console.warn(`mushin signal "${sig.name}" failed:`, (e as Error).message);
        results.set(sig.name, []);
      }
    }),
  );

  return blend(results, yomi);
}
