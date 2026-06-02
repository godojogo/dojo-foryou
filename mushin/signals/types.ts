// A recommendation signal is a named candidate stream inside Mushin. Each
// returns posts with a raw score; the blend normalizes and combines them by the
// weights in CONFIG.mushin.signalWeights. Add a signal here + in registry.ts.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { UserContext } from '../../lib/types.ts';
import { Yomi } from '../yomi.ts';

export interface RecCandidate {
  postId: string;
  score: number; // raw, per-signal — normalized in the blend
}

export interface SignalDeps {
  supabase: SupabaseClient;
}

export interface RecSignal {
  name: string; // must match a key in CONFIG.mushin.signalWeights
  run(ctx: UserContext, yomi: Yomi, deps: SignalDeps): Promise<RecCandidate[]>;
}
